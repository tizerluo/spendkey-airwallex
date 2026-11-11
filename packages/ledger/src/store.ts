import { appendFileSync, closeSync, constants, fsyncSync, openSync, readFileSync, unlinkSync } from 'node:fs';
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
 * Lock contention fails immediately; a crashed writer's lock requires operator
 * recovery after verifying the ledger. No history is repaired or truncated.
 */
export function openJsonlLedger(path: string): LedgerStore {
  const file = resolve(path);
  const lock = `${file}.lock`;
  let closed = false;

  function withLock<T>(operation: () => T): T {
    if (closed) throw new Error('ledger_closed');
    let lockFd: number;
    try { lockFd = openSync(lock, 'wx', 0o600); }
    catch { throw new Error('ledger_lock_unavailable'); }
    try { return operation(); }
    finally {
      try { closeSync(lockFd); } finally { unlinkSync(lock); }
    }
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
