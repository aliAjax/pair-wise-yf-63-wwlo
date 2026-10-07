import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v1';
/** 区组大小：每个区组内 A/B 各半，区组满后才开新区组 */
const BLOCK_SIZE = 4;
const SEQUENCE_BASE = 1000;

const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[] } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
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
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    conflictCount: (state) => state.pending.filter((item) => item.status === 'conflict').length
  },
  actions: {
    persist() { writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending }); },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    /** 分配下一个中央随机号：基于已用（受试者表 + 待提交）的最大值递增，保证离线多条排队也不撞号 */
    allocateSequence(): number {
      const used = [
        ...this.participants.map((p) => p.sequence),
        ...this.pending.map((p) => p.sequence)
      ];
      return Math.max(SEQUENCE_BASE, ...used) + 1;
    },
    /**
     * 按中心 + 年龄分层做区组随机。
     * 区组内 A/B 各半，当前区组未满时在剩余位置中随机，区组满后自动开新区组。
     * 统计范围包含已入库受试者与待提交（含离线排队）记录，保证顺序与审计一致。
     */
    nextArmForStratum(site: string, ageBand: Participant['ageBand']): Arm {
      const inStratum: { arm: Arm }[] = [
        ...this.participants
          .filter((p) => p.site === site && p.ageBand === ageBand && p.arm !== undefined)
          .map((p) => ({ arm: p.arm as Arm })),
        ...this.pending
          .filter((p) => p.status === 'pending' && p.payload.site === site && p.payload.ageBand === ageBand)
          .map((p) => ({ arm: p.arm }))
      ];
      const posInBlock = inStratum.length % BLOCK_SIZE;
      const currentBlock = inStratum.slice(inStratum.length - posInBlock);
      const aInBlock = currentBlock.filter((r) => r.arm === 'A').length;
      const bInBlock = currentBlock.filter((r) => r.arm === 'B').length;
      const aRemaining = BLOCK_SIZE / 2 - aInBlock;
      const bRemaining = BLOCK_SIZE / 2 - bInBlock;
      if (aRemaining > 0 && bRemaining > 0) {
        return Math.random() < 0.5 ? 'A' : 'B';
      }
      return aRemaining > 0 ? 'A' : 'B';
    },
    /** 入库前核对：身份标识与受试者编号是否与已入库受试者或其他待提交记录冲突 */
    findConflict(input: { identityKey: string; participantNo: string }, excludePendingId?: string): { kind: 'participant' | 'pending'; label: string } | null {
      const participant = this.participants.find(
        (p) => p.identityKey === input.identityKey || p.participantNo === input.participantNo
      );
      if (participant) return { kind: 'participant', label: participant.participantNo };
      const pending = this.pending.find(
        (p) => p.id !== excludePendingId
          && p.status === 'pending'
          && (p.payload.identityKey === input.identityKey || p.payload.participantNo === input.participantNo)
      );
      if (pending) return { kind: 'pending', label: pending.payload.participantNo };
      return null;
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      const conflict = this.findConflict(input);
      if (conflict) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}（与${conflict.kind === 'participant' ? '已入库受试者' : '其他待提交记录'} ${conflict.label} 冲突）`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      // 随机号与治疗组在进入队列时即固定，入库时不再重新分配
      const sequence = this.allocateSequence();
      const arm = this.nextArmForStratum(input.site, input.ageBand);
      if (offline) {
        const queued: PendingRandomization = {
          id: crypto.randomUUID(),
          payload: input,
          createdAt: new Date().toISOString(),
          status: 'pending',
          sequence,
          arm
        };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}，预分配中央随机号 ${sequence}（${arm}组）`, input.actor, input.participantNo);
        return { ok: true, message: `已加入待提交队列，预分配随机号 ${sequence}` };
      }
      const participant: Participant = {
        id: crypto.randomUUID(),
        participantNo: input.participantNo,
        identityKey: input.identityKey,
        site: input.site,
        ageBand: input.ageBand,
        status: 'randomized',
        sequence,
        arm
      };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层区组随机，中央随机号 ${sequence}（${arm}组）`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央序列号 ${sequence}`, arm };
    },
    commitPending(id: string, actor: string) {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      // 入库前按受试者表和其他待提交记录重新核对身份标识与受试者编号
      const conflict = this.findConflict(pending.payload, id);
      if (conflict) {
        pending.status = 'conflict';
        pending.conflictReason = `与${conflict.kind === 'participant' ? '已入库受试者' : '其他待提交记录'} ${conflict.label} 冲突`;
        this.addAudit('pending-conflict', `待提交记录入库前核对冲突：${pending.payload.participantNo}，${pending.conflictReason}；随机号 ${pending.sequence} 作废，不写入受试者表`, actor, pending.payload.participantNo);
        this.persist();
        return;
      }
      // 核对通过：随机号与治疗组沿用进入队列时固定的值，不重新分配
      pending.status = 'committed';
      const participant: Participant = {
        id: crypto.randomUUID(),
        participantNo: pending.payload.participantNo,
        identityKey: pending.payload.identityKey,
        site: pending.payload.site,
        ageBand: pending.payload.ageBand,
        status: 'randomized',
        sequence: pending.sequence,
        arm: pending.arm
      };
      this.participants.unshift(participant);
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}，中央随机号 ${pending.sequence}（${pending.arm}组）`, actor, pending.payload.participantNo);
      this.persist();
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
