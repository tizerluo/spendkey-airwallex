import { appendFileSync, closeSync, constants, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openJsonlLedger } from './store.js';
import type { CardAuditEvent } from './events.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), appendFileSync: vi.fn(fs.appendFileSync), fsyncSync: vi.fn(fs.fsyncSync),
    closeSync: vi.fn(fs.closeSync), unlinkSync: vi.fn(fs.unlinkSync), readFileSync: vi.fn(fs.readFileSync) };
});

const event: CardAuditEvent = { kind: 'webhook_received', eventId: 'event_test_01', name: 'test', deduped: false };
const directories: string[] = [];
function file(): string {
  const directory = mkdtempSync(join(tmpdir(), 'spendkey-ledger-io-'));
  directories.push(directory);
  return join(directory, 'ledger.jsonl');
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('durability and uncertain writes', () => {
  it('opens with O_APPEND and fsyncs after writing a complete JSONL record', () => {
    const path = file();
    const ledger = openJsonlLedger(path);
    const record = ledger.append(event);
    expect(openSync).toHaveBeenLastCalledWith(path, constants.O_APPEND | constants.O_RDWR);
    expect(appendFileSync).toHaveBeenCalledWith(expect.any(Number), `${JSON.stringify(record)}\n`, 'utf8');
    expect(fsyncSync).toHaveBeenCalledWith(expect.any(Number));
    const writes = vi.mocked(appendFileSync).mock.invocationCallOrder;
    const syncs = vi.mocked(fsyncSync).mock.invocationCallOrder;
    expect(syncs.at(-1)!).toBeGreaterThan(writes.at(-1)!);
  });

  it('fails closed after a partial write without truncating or repairing history', () => {
    const path = file();
    const ledger = openJsonlLedger(path);
    ledger.append(event);
    const before = readFileSync(path, 'utf8');
    vi.mocked(appendFileSync).mockImplementationOnce(fd => {
      if (typeof fd !== 'number') throw new Error('expected_file_descriptor');
      writeSync(fd, '{"seq":');
      throw new Error('synthetic_io_failure');
    });
    expect(() => ledger.append(event)).toThrow('ledger_write_unconfirmed');
    expect(readFileSync(path, 'utf8')).toBe(`${before}{"seq":`);
    expect(() => ledger.append(event)).toThrow('ledger_closed');
    expect(() => openJsonlLedger(path)).toThrow('ledger_incomplete_final_line');
  });

  it('preserves the operation error when both lock cleanup steps fail', async () => {
    const path = file();
    const ledger = openJsonlLedger(path);
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('synthetic_read_failure'); });
    vi.mocked(closeSync).mockImplementationOnce(fd => { fs.closeSync(fd); throw new Error('synthetic_close_failure'); });
    vi.mocked(unlinkSync).mockImplementationOnce(lock => { fs.unlinkSync(lock); throw new Error('synthetic_unlink_failure'); });
    expect(() => ledger.read()).toThrow(/^synthetic_read_failure$/);
    expect(ledger.read()).toEqual([]);
  });

  it('reports cleanup failure after a successful operation', async () => {
    const ledger = openJsonlLedger(file());
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(closeSync).mockImplementationOnce(fd => { fs.closeSync(fd); throw new Error('synthetic_close_failure'); });
    expect(() => ledger.read()).toThrow(/^ledger_lock_cleanup_failed$/);
    expect(ledger.read()).toEqual([]);
  });

  it('requires reopening after an fsync failure and retains the written event', () => {
    const path = file();
    const ledger = openJsonlLedger(path);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('synthetic_fsync_failure'); });
    expect(() => ledger.append(event)).toThrow('ledger_write_unconfirmed');
    expect(() => ledger.append(event)).toThrow('ledger_closed');
    const reopened = openJsonlLedger(path);
    expect(reopened.read()).toHaveLength(1);
    expect(reopened.read()[0]!.event).toEqual(event);
    expect(reopened.append(event).seq).toBe(1);
  });
});
