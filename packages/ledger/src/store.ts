import { appendFileSync, closeSync, constants, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendEvent, assertValidChain, parseJsonl } from './chain.js';
import type { CardAuditEvent, LedgerEvent } from './events.js';

export interface LedgerStore {
  /** Detached snapshot; callers cannot rewrite stored history. */
  read(): LedgerEvent[];
  /** Append an event, returning its durable hashed envelope. */
  append(event: CardAuditEvent, at?: string): LedgerEvent;
  close(): void;
}

export class InMemoryLedgerStore implements LedgerStore {
  readonly #events: LedgerEvent[];
  #closed = false;

  constructor(events: readonly LedgerEvent[] = []) {
    assertValidChain(events);
    this.#events = structuredClone([...events]);
  }

  #assertOpen(): void { if (this.#closed) throw new Error('ledger_closed'); }

  read(): LedgerEvent[] {
    this.#assertOpen();
    return structuredClone(this.#events);
  }

  append(event: CardAuditEvent, at?: string): LedgerEvent {
    this.#assertOpen();
    const record = appendEvent(this.#events, event, at);
    this.#events.push(record);
    return structuredClone(record);
  }

  close(): void { this.#closed = true; }
}

export function openInMemoryLedger(events: readonly LedgerEvent[] = []): LedgerStore {
  return new InMemoryLedgerStore(events);
}

/**
 * Synchronous, local-filesystem store. Every operation uses an exclusive sibling
 * lock and rereads the chain, so separate processes never append a stale head.
 * Lock acquisition retries for at most 200ms, recovering dead/expired owners.
 * No history is repaired or truncated.
 */
export function openJsonlLedger(path: string): LedgerStore {
  const file = resolve(path);
  const lock = `${file}.lock`;
  let closed = false;

  function acquireLock(): number {
    for (let attempt = 0; attempt <= 40; attempt += 1) {
      let fd: number | undefined;
      try {
        fd = openSync(lock, 'wx', 0o600);
        writeSync(fd, `${process.pid}\n`);
        return fd;
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* Preserve acquisition failure. */ }
          try { unlinkSync(lock); } catch { /* Preserve acquisition failure. */ }
          throw new Error('ledger_lock_unavailable');
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('ledger_lock_unavailable');
      }
      try {
        const before = statSync(lock);
        const owner = readFileSync(lock, 'utf8').trim();
        let stale = Date.now() - before.mtimeMs > 30_000;
        if (!stale && /^[1-9]\d*$/.test(owner) && Number.isSafeInteger(Number(owner))) {
          try { process.kill(Number(owner), 0); }
          catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
        const current = statSync(lock);
        if (stale && before.ino === current.ino && before.mtimeMs === current.mtimeMs) {
          unlinkSync(lock);
          continue;
        }
      } catch { /* Another process may have released the lock; retry below. */ }
      if (attempt < 40) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    throw new Error('ledger_lock_unavailable');
  }

  function withLock<T>(operation: () => T): T {
    if (closed) throw new Error('ledger_closed');
    const lockFd = acquireLock();
    let failed = false;
    let operationError: unknown;
    let result!: T;
    try { result = operation(); }
    catch (error) { failed = true; operationError = error; }
    // Cleanup failure must not mask a successful append, or the caller will retry and write a second record.
    try { closeSync(lockFd); } catch { /* Leftover lock is reclaimed after expiry. */ }
    try { unlinkSync(lock); } catch { /* Same as above. */ }
    if (failed) throw operationError;
    return result;
  }

  // a+ creates the file if absent and sets O_APPEND without truncation.
  withLock(() => {
    const fd = openSync(file, 'a+', 0o600);
    try { parseJsonl(readFileSync(fd, 'utf8')); }
    finally { closeSync(fd); }
  });

  return {
    read() { return withLock(() => parseJsonl(readFileSync(file, 'utf8'))); },
    append(event, at) {
      return withLock(() => {
        // r+ is not used: O_APPEND is required even though the lock serializes us.
        const fd = openSync(file, constants.O_APPEND | constants.O_RDWR);
        try {
          const record = appendEvent(parseJsonl(readFileSync(fd, 'utf8')), event, at);
          try {
            appendFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
            fsyncSync(fd);
          } catch {
            // A write/fsync failure has an uncertain outcome. Reopen and verify
            // before retrying; never risk appending after a partial write here.
            closed = true;
            throw new Error('ledger_write_unconfirmed');
          }
          return record;
        } finally { closeSync(fd); }
      });
    },
    close() { closed = true; },
  };
}
