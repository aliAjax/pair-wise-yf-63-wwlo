export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction = 'randomized' | 'unblinded' | 'pending-queued' | 'pending-committed' | 'pending-conflict' | 'duplicate-blocked';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  unblindedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export type PendingStatus = 'pending' | 'committed' | 'conflict';

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  /** 随机号在进入队列时固定，入库时不再补发 */
  sequence: number;
  /** 入队时按中心 + 年龄分层区组预分配的治疗组 */
  arm: Arm;
  createdAt: string;
  status: PendingStatus;
  /** 入库前核对发现的冲突说明 */
  conflictReason?: string;
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}
