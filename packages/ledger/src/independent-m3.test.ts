import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryLedgerStore,
  appendEvent,
  assertRedacted,
  currencyExponent,
  openJsonlLedger,
  parseJsonl,
  redactValue,
  signedDecimalToMinor,
  verifyChain,
  verifyJsonl,
} from './index.js';
import type { CardAuditEvent, LedgerEvent } from './index.js';
import { runLedgerCli } from './cli.js';

const AT = '2026-11-11T10:00:00.000Z';
const AT2 = '2026-11-11T10:00:01.000Z';
const AT3 = '2026-11-11T10:00:02.000Z';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'spk-independent-m3-'));
  temporaryDirectories.push(directory);
  const file = join(directory, 'ledger.jsonl');
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function clone(records: readonly LedgerEvent[]): LedgerEvent[] {
  return structuredClone([...records]);
}

function jsonl(records: readonly LedgerEvent[]): string {
  return records.map(record => `${JSON.stringify(record)}\n`).join('');
}

function cliVerification(contents: string, options: readonly string[] = []) {
  const file = tempFile(contents);
  const result = runLedgerCli(['verify', file, ...options]);
  return {
    exitCode: result.exitCode,
    body: JSON.parse(result.output) as { ok: boolean; error?: string; brokenAt?: number; head?: { seq: number; hash: string } },
    file,
  };
}

function fixtureChain() {
  const store = new InMemoryLedgerStore();
  const first = store.append({ kind: 'webhook_received', eventId: 'event_test_01',
    name: 'issuing.card.active', deduped: false }, AT);
  const second = store.append({ kind: 'authorization', source: 'simulated', cardId: 'card_test_01',
    amount: '12.34', currency: 'USD', mapped: 'approved', merchantName: 'Synthetic Shop' }, AT2);
  const third = store.append({ kind: 'card_frozen', cardId: 'card_test_01', by: 'agent',
    reason: 'independent test freeze' }, AT3);
  return { first, second, third, records: store.read(), text: jsonl(store.read()) };
}

describe('independent ledger chain tampering', () => {
  it('accepts the genuine chain through verify, strict parse and CLI exit code', () => {
    const { records, text, second } = fixtureChain();
    expect(verifyChain(records)).toEqual({ ok: true });
    expect(verifyJsonl(text)).toEqual({ ok: true, head: { seq: second.seq + 1, hash: records[2]!.hash } });
    expect(parseJsonl(text)).toHaveLength(3);
    const cli = cliVerification(text);
    expect(cli.exitCode).toBe(0);
    expect(cli.body).toEqual({ ok: true, head: { seq: 2, hash: records[2]!.hash } });
    expect(readFileSync(cli.file, 'utf8')).toBe(text);
  });

  it('detects an edited line with a retained hash through verify and the CLI', () => {
    const { records, text } = fixtureChain();
    const edited = clone(records);
    const event = edited[1]!.event;
    if (event.kind !== 'authorization') throw new Error('fixture_mismatch');
    event.merchantName = 'Tampered Shop';
    expect(verifyChain(edited)).toEqual({ ok: false, brokenAt: 1, error: 'hash_mismatch' });
    expect(verifyJsonl(jsonl(edited))).toEqual({ ok: false, brokenAt: 1, error: 'hash_mismatch' });
    const cli = cliVerification(jsonl(edited));
    expect(cli.exitCode).toBe(1);
    expect(cli.body).toEqual({ ok: false, brokenAt: 1, error: 'hash_mismatch' });
    expect(cli.body).not.toHaveProperty('head');
    expect(text).not.toContain('Tampered Shop');
  });

  it('detects an inserted duplicate record and a reordered record', () => {
    const { records } = fixtureChain();
    const inserted = clone(records);
    inserted.splice(1, 0, structuredClone(inserted[0]!));
    expect(verifyChain(inserted)).toEqual({ ok: false, brokenAt: 1, error: 'invalid_sequence' });
    const insertedCli = cliVerification(jsonl(inserted));
    expect(insertedCli.exitCode).toBe(1);
    expect(insertedCli.body).toMatchObject({ ok: false, error: 'invalid_sequence', brokenAt: 1 });

    const reordered = [clone(records)[0]!, clone(records)[2]!, clone(records)[1]!];
    expect(verifyChain(reordered)).toEqual({ ok: false, brokenAt: 1, error: 'invalid_sequence' });
    const reorderedCli = cliVerification(jsonl(reordered));
    expect(reorderedCli.exitCode).toBe(1);
    expect(reorderedCli.body).toMatchObject({ ok: false, error: 'invalid_sequence', brokenAt: 1 });
  });

  it('detects deletion of a middle line through verify and the CLI', () => {
    const { records } = fixtureChain();
    const deleted = clone(records);
    deleted.splice(1, 1);
    expect(verifyChain(deleted)).toEqual({ ok: false, brokenAt: 1, error: 'invalid_sequence' });
    const cli = cliVerification(jsonl(deleted));
    expect(cli.exitCode).toBe(1);
    expect(cli.body).toMatchObject({ ok: false, error: 'invalid_sequence', brokenAt: 1 });
  });

  it('reports a truncated partial final line and refuses strict parsing', () => {
    const { text } = fixtureChain();
    const truncated = text.slice(0, -17);
    expect(truncated.endsWith('\n')).toBe(false);
    expect(verifyJsonl(truncated)).toEqual({ ok: false, brokenAt: 2, error: 'incomplete_final_line' });
    expect(() => parseJsonl(truncated)).toThrow('ledger_incomplete_final_line');
    const cli = cliVerification(truncated);
    expect(cli.exitCode).toBe(1);
    expect(cli.body).toEqual({ ok: false, brokenAt: 2, error: 'incomplete_final_line' });
    const storeOpenFile = tempFile(truncated);
    expect(() => openJsonlLedger(storeOpenFile)).toThrow('ledger_incomplete_final_line');
  });

  it('detects a deleted complete suffix only with an external head or sequence anchor', () => {
    const { records, text, third } = fixtureChain();
    const firstLine = text.slice(0, text.indexOf('\n') + 1);
    expect(verifyJsonl(firstLine)).toMatchObject({ ok: true, head: { seq: 0 } });
    expect(cliVerification(firstLine).exitCode).toBe(0);
    const anchored = cliVerification(firstLine, ['--expect-seq', String(third.seq)]);
    expect(anchored.exitCode).toBe(1);
    expect(anchored.body).toMatchObject({ ok: false, error: 'head_sequence_mismatch', brokenAt: 1 });
    const headAnchored = cliVerification(firstLine, ['--expect-head', records[2]!.hash]);
    expect(headAnchored.exitCode).toBe(1);
    expect(headAnchored.body).toMatchObject({ ok: false, error: 'head_mismatch', brokenAt: 1 });
  });
});

describe('independent redaction boundaries', () => {
  it.each([
    ['bare', '4111111111111111'],
    ['spaced', '4111 1111 1111 1111'],
    ['dashed', '4111-1111-1111-1111'],
  ])('rejects a %s PAN in free text', (_name, pan) => {
    expect(() => assertRedacted(pan)).toThrow('ledger_redaction_required');
    expect(redactValue(pan)).toBe('[REDACTED]');
  });

  it('rejects PANs nested inside arrays and objects, including numeric values', () => {
    const nested = { note: ['clean text', { inner: '4111 1111 1111 1111' }] };
    expect(() => assertRedacted(nested)).toThrow('ledger_redaction_required');
    expect(redactValue(nested)).toEqual({ note: ['clean text', { inner: '[REDACTED]' }] });
    expect(() => assertRedacted({ amount: 4111111111111111 })).toThrow('ledger_redaction_required');
  });

  it('drops sensitive keys recursively while retaining the masked-card key', () => {
    const redacted = redactValue({
      card_number: '4111111111111111',
      cvv: '123',
      authorization: 'Bearer synthetic-value',
      masked_card_number: '****0000',
      nested: { token: 'synthetic-token', secret: 'synthetic-secret', api_key: 'test-api-key' },
      number: '42',
      label: 'Synthetic Shop',
    });
    expect(redacted).toEqual({
      masked_card_number: '****0000',
      nested: {},
      label: 'Synthetic Shop',
    });
    expect(() => assertRedacted({ nested: { password: 'synthetic-password' } })).toThrow('ledger_redaction_required');
  });

  it('rejects high-confidence secrets in free text', () => {
    const secrets = [
      `sk-${'a'.repeat(20)}`,
      `sk_live_${'b'.repeat(12)}`,
      `AKIA${'C'.repeat(16)}`,
      `ghp_${'d'.repeat(20)}`,
      `eyJ${'a'.repeat(8)}.${'b'.repeat(8)}.${'c'.repeat(8)}`,
      `Bearer ${'e'.repeat(12)}`,
      ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' '),
    ];
    for (const secret of secrets) {
      expect(() => assertRedacted(secret)).toThrow('ledger_redaction_required');
      expect(redactValue(secret)).toBe('[REDACTED]');
    }
  });

  it('accepts hashes, UUIDs, spk ids, epoch milliseconds and ordinary wording', () => {
    const accepted: Record<string, string> = {
      hash: `0x${'ab'.repeat(32)}`,
      bareHash: 'cd'.repeat(32),
      uuid: '123e4567-e89b-42d3-a456-426614174000',
      requestId: `spk_${'0123456789abcdef'.repeat(2)}`,
      epochMs: '1731234567890',
      iso: AT,
      masked: '****0000',
      merchant: 'Secret Garden Cafe',
      decline: 'Authorization declined',
      panName: 'PAN AM CAFE',
      snack: 'Cookie jar',
    };
    for (const value of Object.values(accepted)) {
      expect(() => assertRedacted(value)).not.toThrow();
    }
    expect(redactValue(accepted)).toEqual(accepted);
  });

  it('stores PAN-bearing free text as [REDACTED] and keeps the chain valid', () => {
    const store = new InMemoryLedgerStore();
    const record = store.append({ kind: 'authorization', source: 'simulated', cardId: 'card_test_01',
      amount: '1.00', currency: 'USD', mapped: 'approved', merchantName: '4111 1111 1111 1111' }, AT);
    const event = record.event;
    expect(event.kind === 'authorization' && event.merchantName).toBe('[REDACTED]');
    expect(verifyChain(store.read()).ok).toBe(true);
    expect(JSON.stringify(store.read())).not.toContain('4111 1111 1111 1111');
  });
});

describe('independent currency-exact amounts', () => {
  it('uses zero, three and two decimal exponents for JPY, KWD and USD', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('jpy')).toBe(0);
    expect(signedDecimalToMinor('500', 'JPY')).toBe(500);
    expect(signedDecimalToMinor('-500', 'JPY')).toBe(-500);
    expect(signedDecimalToMinor('1.234', 'KWD')).toBe(1234);
    expect(signedDecimalToMinor('-1.234', 'KWD')).toBe(-1234);
    expect(signedDecimalToMinor('1.23', 'KWD')).toBe(1230);
    expect(signedDecimalToMinor('12.34', 'USD')).toBe(1234);
    expect(signedDecimalToMinor('-2.50', 'USD')).toBe(-250);
    expect(signedDecimalToMinor('-0.00', 'USD')).toBe(0);
  });

  it('rejects excess precision, bad signs, lowercase currencies and unsafe magnitudes', () => {
    for (const [value, currency] of [['1.5', 'JPY'], ['1.234', 'USD'], ['1.2345', 'KWD'],
      ['+1.00', 'USD'], [' 1.00', 'USD'], ['1.00 ', 'USD'], ['1e2', 'USD'],
      ['90071992547409.92', 'USD']] as const) {
      expect(() => signedDecimalToMinor(value, currency)).toThrow(RangeError);
    }
    expect(() => signedDecimalToMinor('1.00', 'usd')).toThrow('invalid_currency');
    expect(() => currencyExponent('US')).toThrow('invalid_currency');
  });

  it('validates authorization amounts against their currency and allows negative refunds', () => {
    const authorization = (amount: string, currency: string): CardAuditEvent => ({
      kind: 'authorization', source: 'simulated', cardId: 'card_test_01', amount, currency, mapped: 'approved',
    });
    expect(appendEvent([], authorization('1.234', 'KWD'), AT).event).toMatchObject({ amount: '1.234' });
    expect(appendEvent([], authorization('-2.50', 'USD'), AT).event).toMatchObject({ amount: '-2.50' });
    expect(() => appendEvent([], authorization('1.234', 'USD'), AT)).toThrow('invalid_card_audit_event');
    expect(() => appendEvent([], authorization('1.5', 'JPY'), AT)).toThrow('invalid_card_audit_event');
    expect(appendEvent([], authorization('1.5', 'KWD'), AT).event).toMatchObject({ amount: '1.5' });
  });

  it('accepts signed reconciliation totals', () => {
    const event: CardAuditEvent = { kind: 'reconciliation', cardId: 'card_test_01',
      window: { from: AT, to: AT3 }, settledMinor: -250, pendingMinor: -100, failedCount: 0, transactionIds: [] };
    expect(appendEvent([], event, AT).event).toMatchObject({ settledMinor: -250, pendingMinor: -100 });
  });
});
