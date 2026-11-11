import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** One process owns the store for its lifetime. Stale locks fail with actionable diagnostics. */
export class JsonApprovalStore extends MemoryApprovalStore {
  readonly #lock: number;
  #closed = false;
  constructor(readonly path: string) {
    super();
    const lockPath = `${path}.lock`;
    try { this.#lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (!existsSync(lockPath)) throw error;
      let alive = false;
      let age = Date.now() - statSync(lockPath).mtimeMs;
      try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; createdAt?: number };
        if (typeof lock.createdAt === 'number' && Number.isFinite(lock.createdAt)) age = Date.now() - lock.createdAt;
        if (Number.isSafeInteger(lock.pid) && lock.pid! > 0) {
          try { process.kill(lock.pid!, 0); alive = true; }
          catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
        }
      } catch { /* Old/invalid locks remain fail-closed and are reported as stale. */ }
      throw new Error(alive ? 'approval_store_locked: owner process is alive'
        : `approval_store_stale_lock: owner absent or unknown; age ${Math.max(0, Math.floor(age / 1000))}s; verify the owner stopped, remove approvals.json.lock, then run demo:sandbox cleanup`);
    }
    writeFileSync(this.#lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fsyncSync(this.#lock);
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
