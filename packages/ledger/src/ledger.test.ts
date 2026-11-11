import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, ZERO_HASH } from '@sr/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendEvent, assertRedacted, CardAuditEventSchema, InMemoryLedgerStore, openInMemoryLedger,
  openJsonlLedger, parseJsonl, signedDecimalToMinor, verifyChain,
} from './index.js';
import type { CardAuditEvent, LedgerEvent, LedgerStore } from './index.js';
import { runLedgerCli } from './cli.js';

const AT = '2030-01-01T00:00:00.000Z';
const LATER = '2030-02-01T00:00:00.000Z';
const events: CardAuditEvent[] = [
  { kind: 'offers_snapshot', intent: 'design tool', offers: [{
    offerId: 'offer_test_monthly', vendor: 'DesignCo', product: 'design tool', plan: 'monthly', rail: 'card',
    price: { amount: '25.00', currency: 'USD', unit: 'per_month' }, priceStatus: 'price_unverified', availability: 'available',
  }] },
  { kind: 'comparison', candidates: [{
    offerId: 'offer_test_monthly', rail: 'card', upfrontMinor: 2500, perChargeMinor: 2500,
    horizonLowMinor: 30000, horizonHighMinor: 30000, notes: ['monthly charge'],
  }], excluded: [{ offerId: 'offer_test_other', reason: 'region_unavailable' }] },
  { kind: 'decision', action: 'ask', chosenOfferId: 'offer_test_monthly', reasons: ['human_approval_required'],
    ruleResults: [{ offerId: 'offer_test_monthly', rule: 'reserve', pass: true, code: 'reserve_ok' }] },
  { kind: 'approval_requested', approvalRequestId: 'request_test_01', offerId: 'offer_test_monthly',
    presentedTermsHash: 'a'.repeat(64), amountMinor: 2500, currency: 'USD', interval: 'MONTHLY',
    allowedTransactionCount: 'MULTIPLE', merchantCategoryCode: '7372', expiresAt: LATER },
  { kind: 'approval_granted', approvalRequestId: 'request_test_01', approvalId: 'approval_test_01',
    termsHash: 'b'.repeat(64), presentedTermsHash: 'a'.repeat(64), approver: { kind: 'human', id: 'demo-operator' },
    merchantCategoryCode: '7372', approvedAt: AT, demoAutoApproved: true },
  { kind: 'approval_rejected', approvalRequestId: 'request_test_02', code: 'human_rejected' },
  { kind: 'card_issued', approvalId: 'approval_test_01', requestId: 'spk_test_request_01',
    cardId: 'card_test_01', cardStatus: 'ACTIVE', maskedNumber: '424242******0000',
    controls: { currency: 'USD', amount: '25.00', allowedMcc: ['7372'] }, rawResponseRef: 'response_test_01' },
  { kind: 'card_issue_unconfirmed', approvalId: 'approval_test_02', requestId: 'spk_test_request_02',
    reason: 'response_shape_unconfirmed', rawResponseRef: 'response_test_02' },
  { kind: 'authorization', source: 'simulated', cardId: 'card_test_01', amount: '-2.50', currency: 'USD',
    merchantCategoryCode: '7372', merchantName: 'Test Merchant', processResult: 'APPROVED',
    failureReason: '', mapped: 'approved', transactionId: 'transaction_test_01' },
  { kind: 'card_frozen', cardId: 'card_test_01', by: 'agent', reason: 'demo_complete' },
  { kind: 'reconciliation', cardId: 'card_test_01', window: { from: AT, to: LATER },
    settledMinor: -250, pendingMinor: 2500, failedCount: 1, transactionIds: ['transaction_test_01'] },
  { kind: 'webhook_received', eventId: 'event_test_01', name: 'issuing.card.updated', deduped: false },
  { kind: 'raw_response', ref: 'response_test_01', endpoint: '/api/v1/issuing/cards/create', status: 200,
    body: { card_id: 'card_test_01', masked_card_number: '****0000', nested: [null, true, 25] } },
];
const basic: CardAuditEvent = { kind: 'webhook_received', eventId: 'event_test_basic', name: 'test', deduped: false };
const directories: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spendkey-ledger-test-'));
  directories.push(dir);
  return join(dir, 'ledger.jsonl');
}
function chain(): LedgerEvent[] {
  const store = openInMemoryLedger();
  for (const event of events) store.append(event, AT);
  return store.read();
}
function jsonl(records: readonly LedgerEvent[]): string {
  return records.map(record => `${JSON.stringify(record)}\n`).join('');
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('M3 event contract and hashing', () => {
  it.each(events.map(event => [event.kind, event] as const))('round-trips %s through both stores and JSONL', (_kind, event) => {
    const stores: LedgerStore[] = [openInMemoryLedger(), openJsonlLedger(tempFile())];
    for (const store of stores) {
      const record = store.append(event, AT);
      expect(record.event).toEqual(event);
      expect(CardAuditEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
      expect(parseJsonl(jsonl(store.read()))).toEqual([record]);
      expect(verifyChain(store.read())).toEqual({ ok: true });
      store.close();
    }
  });

  it('uses the core canonical digest, zero-based sequence and genesis hash', () => {
    const first = appendEvent([], basic, AT);
    const payload = { seq: 0, at: AT, prevHash: ZERO_HASH, event: basic };
    const expected = `0x${createHash('sha256').update(canonicalize(payload)).digest('hex')}`;
    expect(first).toEqual({ ...payload, hash: expected });
    expect(appendEvent([first], basic, AT).prevHash).toBe(first.hash);
    expect(verifyChain([])).toEqual({ ok: true });
    expect(verifyChain(chain())).toEqual({ ok: true });
  });

  it('produces the same digest regardless of object insertion order', () => {
    expect(appendEvent([], basic, AT).hash).toBe(appendEvent([], {
      name: 'test', deduped: false, eventId: 'event_test_basic', kind: 'webhook_received',
    }, AT).hash);
  });

  // Every envelope field on every line, and every event's payload, must be bound.
  it.each(events.map((event, index) => [event.kind, index] as const))('detects changes to every envelope field in %s', (_kind, index) => {
    const originals = chain();
    const changes: Record<string, unknown> = {
      seq: 99, at: LATER, prevHash: `0x${'c'.repeat(64)}`, hash: `0x${'d'.repeat(64)}`,
      event: { ...originals[index]!.event, extra: 'tampered' },
    };
    for (const [field, value] of Object.entries(changes)) {
      const modified = structuredClone(originals);
      Object.assign(modified[index]!, { [field]: value });
      expect(verifyChain(modified), field).toMatchObject({ ok: false, brokenAt: index });
    }
    const modified = structuredClone(originals);
    const target = modified[index]!.event as unknown as Record<string, unknown>;
    // Remove each required or optional fixture field in turn, then change every
    // primitive recursively (including nested terms, controls and raw payloads).
    for (const key of Object.keys(target)) {
      const copy = structuredClone(originals);
      delete (copy[index]!.event as unknown as Record<string, unknown>)[key];
      expect(verifyChain(copy), key).toMatchObject({ ok: false, brokenAt: index });
    }
    function changeLeaves(value: unknown, path: (string | number)[] = []): void {
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) changeLeaves(child, [...path, key]);
      } else {
        const copy = structuredClone(originals);
        let cursor: unknown = copy[index]!.event;
        for (const key of path.slice(0, -1)) cursor = (cursor as Record<string, unknown>)[key];
        (cursor as Record<string, unknown>)[path.at(-1)!] = typeof value === 'string' ? `${value}x`
          : typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : 'changed';
        expect(verifyChain(copy), path.join('.')).toMatchObject({ ok: false, brokenAt: index });
      }
    }
    changeLeaves(target);
  });

  it.each(Array.from({ length: events.length - 1 }, (_, i) => i))('detects deletion or reordering at line %i', index => {
    const deleted = chain();
    deleted.splice(index, 1);
    expect(verifyChain(deleted)).toMatchObject({ ok: false, brokenAt: index });
    const reordered = chain();
    [reordered[index], reordered[index + 1]] = [reordered[index + 1]!, reordered[index]!];
    expect(verifyChain(reordered)).toMatchObject({ ok: false, brokenAt: index });
  });

  it('detects duplicate insertion and refuses to extend a broken history', () => {
    const records = chain();
    records.splice(1, 0, records[0]!);
    expect(verifyChain(records)).toMatchObject({ ok: false, brokenAt: 1 });
    expect(() => appendEvent(records, basic, AT)).toThrow('ledger_broken_at_1');
    expect(() => new InMemoryLedgerStore(records)).toThrow('ledger_broken_at_1');
  });

  it.each([
    { kind: 'decision', action: 'pay', reasons: [], ruleResults: [] },
    { kind: 'approval_granted', approvalRequestId: 'r', approvalId: 'a', termsHash: 'a', presentedTermsHash: 'a',
      approver: { kind: 'agent', id: 'agent_test_01' }, merchantCategoryCode: '7372', approvedAt: AT, demoAutoApproved: false },
    { kind: 'authorization', source: 'live', cardId: 'card_test_01', amount: '1.00', currency: 'USD', mapped: 'approved' },
    { kind: 'card_issued', approvalId: 'a', requestId: 'r' },
    { kind: 'raw_response', ref: 'r', endpoint: '/test', status: 200 },
    { ...basic, extra: true },
  ])('rejects contract violations', value => {
    expect(CardAuditEventSchema.safeParse(value).success).toBe(false);
    expect(() => appendEvent([], value as CardAuditEvent, AT)).toThrow('invalid_card_audit_event');
  });
});

describe('append-only JSONL', () => {
  it('reopens verified history and appends exactly one complete line per event', () => {
    const file = tempFile();
    let store = openJsonlLedger(file);
    for (const event of events) store.append(event, AT);
    const before = readFileSync(file, 'utf8');
    expect(before.split('\n')).toHaveLength(events.length + 1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    store.close();
    store = openJsonlLedger(file);
    expect(store.read()).toEqual(chain());
    const appended = store.append(basic, LATER);
    expect(appended.seq).toBe(events.length);
    expect(readFileSync(file, 'utf8')).toBe(`${before}${JSON.stringify(appended)}\n`);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('rereads the head when independent handles append', () => {
    const file = tempFile();
    const first = openJsonlLedger(file);
    const second = openJsonlLedger(file);
    first.append(basic, AT);
    second.append(basic, AT);
    first.append(basic, AT);
    expect(first.read().map(event => event.seq)).toEqual([0, 1, 2]);
    expect(second.read()).toEqual(first.read());
    expect(verifyChain(first.read())).toEqual({ ok: true });
  });

  it('fails closed on lock contention without altering history', () => {
    const file = tempFile();
    const store = openJsonlLedger(file);
    store.append(basic, AT);
    const before = readFileSync(file, 'utf8');
    writeFileSync(`${file}.lock`, `${process.pid}\n`);
    expect(() => store.append(basic, AT)).toThrow('ledger_lock_unavailable');
    expect(() => openJsonlLedger(file)).toThrow('ledger_lock_unavailable');
    expect(readFileSync(file, 'utf8')).toBe(before);
    rmSync(`${file}.lock`);
    expect(() => store.append(basic, AT)).not.toThrow();
  });

  it('refuses a broken file on open and a file tampered with after opening', () => {
    const file = tempFile();
    const store = openJsonlLedger(file);
    store.append(basic, AT);
    const broken = store.read();
    broken[0]!.at = LATER;
    writeFileSync(file, jsonl(broken));
    const before = readFileSync(file, 'utf8');
    expect(() => openJsonlLedger(file)).toThrow('ledger_broken_at_0');
    expect(() => store.append(basic, AT)).toThrow('ledger_broken_at_0');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it.each(['not json\n', '{}\n', '\n', `${jsonl(chain())}\n`, jsonl(chain()).trimEnd()])('rejects malformed, blank and incomplete JSONL', text => {
    const file = tempFile();
    writeFileSync(file, text);
    expect(() => parseJsonl(text)).toThrow();
    expect(() => openJsonlLedger(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('does not recreate a file deleted after opening', () => {
    const file = tempFile();
    const store = openJsonlLedger(file);
    store.append(basic, AT);
    rmSync(file);
    expect(() => store.append(basic, AT)).toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it.each(['memory', 'jsonl'])('%s store isolates ingress, egress and append return values', mode => {
    const store = mode === 'memory' ? openInMemoryLedger() : openJsonlLedger(tempFile());
    const event = structuredClone(events[6]!);
    const record = store.append(event, AT);
    const expected = structuredClone(record);
    Object.assign(event, { controls: { changed: true } });
    Object.assign(record.event, { controls: { changed: true } });
    const snapshot = store.read();
    snapshot[0]!.at = LATER;
    Object.assign(snapshot[0]!.event, { controls: { changed: true } });
    expect(store.read()).toEqual([expected]);
    store.close();
    expect(() => store.read()).toThrow('ledger_closed');
    expect(() => store.append(basic)).toThrow('ledger_closed');
  });
});

describe('redaction before storage', () => {
  // Published synthetic test PAN, assembled to avoid resembling a real fixture.
  const syntheticDigits = ['4111', '1111', '1111', '1111'];
  const sensitive: unknown[] = [
    syntheticDigits.join(''), syntheticDigits.join(' '), syntheticDigits.join('-'),
    Number(syntheticDigits.join('')),
    { cvv: '000' }, { CVV: '000' },
    { auth: 'Bearer synthetic-value' }, { auth: 'bearer\nsynthetic-value' },
    { api_key: 'test-value' }, { apiKey: 'test-value' }, { 'x-api-key': 'test-value' },
    { access_token: 'test-value' }, { token: 'test-value' }, { client_secret: 'test-value' },
    { note: ['sk', '-'].join('') + 'synthetic'.repeat(3) },
  ];
  it.each(sensitive.map((value, i) => [i, value] as const))('rejects sensitive case %i without writing or echoing it', (_i, body) => {
    const file = tempFile();
    const stores = [openInMemoryLedger(), openJsonlLedger(file)];
    for (const store of stores) {
      expect(() => assertRedacted(body)).toThrow(/^ledger_redaction_required$/);
      const event = { ...basic, hidden: body } as CardAuditEvent;
      // An unknown container still fails the strict schema after redaction, so it is never persisted.
      expect(() => store.append(event, AT)).toThrow(/^invalid_card_audit_event$/);
      expect(store.read()).toEqual([]);
    }
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('checks unknown input properties before validation can strip them', () => {
    expect(() => appendEvent([], { ...basic, hidden: { cvv: '000' } } as CardAuditEvent, AT)).toThrow('invalid_card_audit_event');
  });

  it.each([NaN, Infinity, 1n, () => true, Symbol('test'), new Date(AT)])('rejects data that cannot be preserved as JSON', body => {
    expect(() => appendEvent([], { kind: 'raw_response', ref: 'r', endpoint: '/test', status: 200, body }, AT)).toThrow('ledger_requires_json');
  });

  it('rejects circular data with a safe error', () => {
    const body: Record<string, unknown> = {};
    body['self'] = body;
    expect(() => appendEvent([], { kind: 'raw_response', ref: 'r', endpoint: '/test', status: 200, body }, AT)).toThrow('ledger_requires_json');
  });

  it('allows masks, deterministic request IDs, hashes and nested null raw bodies', () => {
    expect(() => chain()).not.toThrow();
    expect(() => appendEvent([], { kind: 'raw_response', ref: 'r', endpoint: '/test', status: 200, body: null }, AT)).not.toThrow();
  });
});

describe('signed decimal minor units', () => {
  it.each([
    ['0', 0], ['-0.00', 0], ['000.07', 7], ['1', 100], ['12.3', 1230], ['-12.34', -1234],
    ['-0.01', -1], [-0.29, -29], [25, 2500], ['90071992547409.91', Number.MAX_SAFE_INTEGER],
    ['-90071992547409.91', -Number.MAX_SAFE_INTEGER],
  ] as const)('parses %s exactly', (value, expected) => { expect(signedDecimalToMinor(value, 'USD')).toBe(expected); });

  it.each(['', ' 1', '1 ', '+1', '1e2', '.5', '1.', '1.001', '--1', '1,000',
    '90071992547409.92', '-90071992547409.92', NaN, Infinity, -Infinity, 1e21, 0.1 + 0.2])('rejects %s', value => {
    expect(() => signedDecimalToMinor(value, 'USD')).toThrow(RangeError);
  });
});

describe('offline verify CLI', () => {
  it('exits zero for a valid file and never changes it', () => {
    const file = tempFile();
    const before = jsonl(chain());
    writeFileSync(file, before);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'verify', file], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual({ ok: true, head: { seq: events.length - 1, hash: chain().at(-1)!.hash } });
    expect(cli.stderr).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('exits one for tampering and reports no sensitive input', () => {
    const file = tempFile();
    const records = chain();
    records[1]!.at = LATER;
    writeFileSync(file, jsonl(records));
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'verify', file], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(JSON.parse(cli.stdout)).toEqual({ ok: false, error: 'hash_mismatch', brokenAt: 1 });
    expect(cli.stderr).toBe('');
  });

  it('returns one for usage, missing files, invalid JSON and invalid schema', () => {
    const file = tempFile();
    for (const args of [[], ['verify'], ['other', file], ['verify', file, 'extra'], ['verify', file]]) {
      expect(runLedgerCli(args).exitCode).toBe(1);
    }
    expect(existsSync(file)).toBe(false);
    for (const contents of ['invalid\n', '{}\n', jsonl(chain()).trimEnd()]) {
      writeFileSync(file, contents);
      expect(runLedgerCli(['verify', file]).exitCode).toBe(1);
    }
    writeFileSync(file, '');
    expect(runLedgerCli(['verify', file]).exitCode).toBe(0);
  });
});
