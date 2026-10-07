export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction = 'randomized' | 'unblinded' | 'pending-queued' | 'pending-committed' | 'duplicate-blocked' | 'pending-conflict';

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

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed' | 'conflict';
  /** 进入队列时即固定的中央随机号，入库时不再重新分配 */
  sequence: number;
  /** 进入队列时按区组随机固定的治疗组，入库时不再重新分配 */
  arm: Arm;
  /** 入库前核对发现冲突时的原因说明 */
  conflictReason?: string;
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}
