import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v2';
const SEQUENCE_BASE = 1000;
/** 区组大小：每个区组内治疗组 A/B 各半，区组填满才开新块 */
const BLOCK_SIZE = 4;
const BLOCK_HALF = BLOCK_SIZE / 2;

const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[] } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层区组随机，随机号 1002', participantNo: 'S01-002' }
  ],
  pending: []
};

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length
  },
  actions: {
    persist() { writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending }); },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    /** 随机号在入队/入组时分配并固定，取受试者表与待提交队列中的最大值递增 */
    nextSequence(): number {
      const used = [...this.participants.map((item) => item.sequence), ...this.pending.map((item) => item.sequence)];
      return (used.length ? Math.max(...used) : SEQUENCE_BASE) + 1;
    },
    /** 中心 × 年龄分层内做区组随机：当前区组内 A/B 各半，区组满了才开新块 */
    assignArm(site: string, ageBand: Participant['ageBand']): Arm {
      const stratum = [
        ...this.participants
          .filter((item) => item.site === site && item.ageBand === ageBand)
          .map((item) => ({ sequence: item.sequence, arm: item.arm as Arm })),
        ...this.pending
          .filter((item) => item.status === 'pending' && item.payload.site === site && item.payload.ageBand === ageBand)
          .map((item) => ({ sequence: item.sequence, arm: item.arm }))
      ].sort((a, b) => a.sequence - b.sequence);
      const filled = stratum.length % BLOCK_SIZE;
      const block = stratum.slice(stratum.length - filled);
      const countA = block.filter((item) => item.arm === 'A').length;
      const countB = block.length - countA;
      if (countA >= BLOCK_HALF) return 'B';
      if (countB >= BLOCK_HALF) return 'A';
      return Math.random() < 0.5 ? 'A' : 'B';
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string } {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      const sequence = this.nextSequence();
      const arm = this.assignArm(input.site, input.ageBand);
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, sequence, arm, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待提交队列：${input.participantNo}，随机号 ${sequence} 入队时固定`, input.actor, input.participantNo);
        return { ok: true, message: `已加入待提交队列，随机号 ${sequence} 已固定，联网后确认入库` };
      }
      this.insertParticipant(input, sequence, arm);
      this.addAudit('randomized', `${input.participantNo} 完成分层区组随机，随机号 ${sequence}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，随机号 ${sequence}` };
    },
    insertParticipant(input: RandomizeInput, sequence: number, arm: Arm) {
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.persist();
    },
    /** 入库前核对：与受试者表及更早进入队列的待提交记录比对身份标识与受试者编号 */
    findPendingConflict(pending: PendingRandomization): string | null {
      const { identityKey, participantNo } = pending.payload;
      const inTable = this.participants.find((item) => item.identityKey === identityKey || item.participantNo === participantNo);
      if (inTable) return `与受试者表 ${inTable.participantNo} 的${inTable.identityKey === identityKey ? '身份标识' : '受试者编号'}重复`;
      const earlier = this.pending.find((item) => item.id !== pending.id && item.status === 'pending'
        && (item.payload.identityKey === identityKey || item.payload.participantNo === participantNo)
        && (item.createdAt < pending.createdAt || (item.createdAt === pending.createdAt && item.id < pending.id)));
      if (earlier) return `与更早的待提交记录 ${earlier.payload.participantNo} 的${earlier.payload.identityKey === identityKey ? '身份标识' : '受试者编号'}重复`;
      return null;
    },
    commitPending(id: string, actor: string): { ok: boolean; message: string } {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return { ok: false, message: '记录不存在或已处理' };
      const conflict = this.findPendingConflict(pending);
      if (conflict) {
        pending.status = 'conflict';
        pending.conflictReason = conflict;
        this.addAudit('pending-conflict', `入库前核对发现冲突：${pending.payload.participantNo} ${conflict}，已标记冲突，未写入受试者表`, actor, pending.payload.participantNo);
        this.persist();
        return { ok: false, message: `入库前核对发现冲突：${conflict}，已标记冲突` };
      }
      pending.status = 'committed';
      this.insertParticipant(pending.payload, pending.sequence, pending.arm);
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}，随机号 ${pending.sequence}`, actor, pending.payload.participantNo);
      this.persist();
      return { ok: true, message: `已确认入库，随机号 ${pending.sequence}` };
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
    }
  }
});
