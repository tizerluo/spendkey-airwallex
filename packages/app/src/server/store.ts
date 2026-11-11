import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { approvalRequestSchema, termsHash, type Approval, type ApprovalRequest } from '@sk/policy';
import { z } from 'zod';
import type { CreateCardInput } from '@sk/airwallex';
import type { ApprovalCardSummary, ApprovalStatus } from '../views/models.js';

export interface ApprovalRecord {
  request: ApprovalRequest;
  status: ApprovalStatus;
  nonceHash: string;
  csrf: string;
  approval?: Approval;
  input?: CreateCardInput;
  card?: ApprovalCardSummary;
  attempted?: boolean;
}
const savedRecordSchema = z.object({
  request: approvalRequestSchema,
  status: z.enum(['requested', 'approved', 'issuing', 'issued', 'failed', 'rejected', 'expired']),
  nonceHash: z.union([z.literal(''), z.string().regex(/^[0-9a-f]{64}$/)]),
  csrf: z.string().regex(/^[0-9a-f]{48}$/),
  approval: z.object({ approvalId: z.string().min(1), request: approvalRequestSchema, termsHash: z.string(),
    approvedBy: z.object({ kind: z.literal('human'), id: z.string().min(1) }), approvedAt: z.string().datetime() }).optional(),
  input: z.unknown().optional(),
  card: z.object({ cardId: z.string().optional(), status: z.string().optional(),
    maskedNumber: z.string().regex(/[*xX•●#]/).refine(value => !/\d{13,}/.test(value)).optional() }).strict().optional(),
  attempted: z.boolean().optional(),
}).strict();

export interface ApprovalStore {
  get(id: string): ApprovalRecord | undefined;
  list(): ApprovalRecord[];
  save(record: ApprovalRecord): void;
  close(): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  protected records = new Map<string, ApprovalRecord>();
  get(id: string): ApprovalRecord | undefined {
    const value = this.records.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
  list(): ApprovalRecord[] { return structuredClone([...this.records.values()]); }
  save(record: ApprovalRecord): void { this.records.set(record.request.approvalRequestId, structuredClone(record)); }
  close(): void { /* no resources */ }
}

/** One process owns the store for its lifetime. Fail closed on a stale lock; never replay issuance. */
export class JsonApprovalStore extends MemoryApprovalStore {
  readonly #lock: number;
  #closed = false;
  constructor(readonly path: string) {
    super();
    this.#lock = openSync(`${path}.lock`, 'wx', 0o600);
    try {
      if (existsSync(path)) {
        const records: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!Array.isArray(records)) throw new Error('invalid_approval_store');
        for (const item of records) {
          const parsed = savedRecordSchema.parse(item) as ApprovalRecord;
          if (parsed.approval && parsed.approval.termsHash !== termsHash(parsed.approval.request)) throw new Error('invalid_approval');
          if (['approved', 'issuing', 'issued', 'failed'].includes(parsed.status) && (!parsed.approval || !parsed.input)) throw new Error('invalid_approval');
          super.save(parsed);
        }
      }
    } catch {
      this.close();
      throw new Error('invalid_approval_store');
    }
  }
  override save(record: ApprovalRecord): void {
    if (this.#closed) throw new Error('approval_store_closed');
    const records = this.list().filter(item => item.request.approvalRequestId !== record.request.approvalRequestId);
    records.push(structuredClone(record));
    const temp = `${this.path}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(records)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.path);
    super.save(record);
  }
  override close(): void {
    if (!this.#closed) { closeSync(this.#lock); unlinkSync(`${this.path}.lock`); this.#closed = true; }
  }
}
