import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Hex } from '@sr/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendEvent, assertRedacted, CardAuditEventSchema, openInMemoryLedger, openJsonlLedger,
  redactValue, signedDecimalToMinor, verifyChain, verifyJsonl,
} from './index.js';
import type { CardAuditEvent } from './index.js';
import { runLedgerCli } from './cli.js';

const AT = '2030-01-01T00:00:00.000Z';
const basic: CardAuditEvent = { kind: 'webhook_received', eventId: 'event_test_01', name: 'test', deduped: false };
const panGroups = ['4111', '1111', '1111', '1111']; // Published synthetic test PAN.
const directories: string[] = [];
function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-regression-'));
  directories.push(directory);
  return join(directory, 'ledger.jsonl');
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const sensitiveCases = [
  { secret: 'test-value' }, { password: 'test-value' }, { passwd: 'test-value' },
  { authorization: 'test-value' }, { cookie: 'test-value' }, { 'set-cookie': 'test-value' },
  { id_token: 'test-value' }, { auth_token: 'test-value' }, { api_secret: 'test-value' },
  { secret_key: 'test-value' }, { 'x-api-key': 'test-value' }, { private_key: 'test-value' },
  { cvc: '000' }, { full_pan: 'test-value' }, { card_number: panGroups.join('') }, { cardNumber: panGroups.join('') },
  { security_code: '999' }, { securityCode: '999' }, { card_security: '999' }, { cardSecurity: '999' },
  { card_expiry: '12/30' }, { cardExpiry: '12/30' }, { card_expiration: '12/30' }, { expiration_card: '12/30' },
  { number: '999' },
  { note: ['sk', '_live_', 'a'.repeat(24)].join('') },
  { note: ['sk', '_test_', 'b'.repeat(24)].join('') },
  { note: ['xoxb-', 'c'.repeat(24)].join('') },
  { note: ['AKIA', 'D'.repeat(16)].join('') },
  { note: ['ghp', '_', 'e'.repeat(36)].join('') },
  { note: `Authorization: Basic ${Buffer.from('test-user:test-password').toString('base64')}` },
  { note: `Basic ${Buffer.from('test-user:test-value').toString('base64')}` },
  { note: ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') },
  { note: ['eyJ' + 'a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)].join('.') },
  ...[' ', '-', ''].map(separator => ({ nested: [{ note: panGroups.join(separator) }] })),
];

describe('PAN and secret regressions', () => {
  it('accepts 500 real SHA-256 digests in approvals, IDs and raw payloads', () => {
    for (let index = 0; index < 500; index += 1) {
      const hash = createHash('sha256').update(`synthetic-terms-${index}`).digest('hex');
      const requestId = `spk_${hash.slice(0, 40)}`;
      expect(requestId).toHaveLength(44);
      expect(requestId.length).toBeLessThanOrEqual(50);
      expect(() => assertRedacted({ termsHash: hash, presentedTermsHash: `0x${hash}`, requestId,
        transactionIds: [hash], cardId: requestId, raw_response: { nested: [hash] } })).not.toThrow();
      expect(() => appendEvent([], { kind: 'approval_granted', approvalRequestId: 'request_test_01',
        approvalId: 'approval_test_01', termsHash: hash, presentedTermsHash: hash,
        approver: { kind: 'human', id: 'operator_test_01' }, merchantCategoryCode: '7372',
        approvedAt: AT, demoAutoApproved: false }, AT)).not.toThrow();
    }
  });

  it.each([
    '00000000-0000-4000-8000-000000000000', '2030-01-01T00:00:00.000Z',
    '1731300000000', 1731300000000, '1731300000006', // Last epoch example passes Luhn.
    `spk_${'1234567890'.repeat(4)}`, `id_${panGroups.join('')}`, `${panGroups.join('')}-suffix`,
    '9'.repeat(16), '9'.repeat(20), // Non-Luhn runs and overlong groups.
  ])('accepts safe identifiers and non-PAN value %#', value => {
    expect(() => assertRedacted({ value })).not.toThrow();
    expect(redactValue(value)).toBe(value);
  });

  it.each(sensitiveCases.map((value, index) => [index, value] as const))('rejects and sanitizes secret case %i', (_index, value) => {
    expect(() => assertRedacted(value)).toThrow(/^ledger_redaction_required$/);
    const safe = redactValue(value);
    expect(() => assertRedacted(safe)).not.toThrow();
    expect(safe).not.toEqual(value);
    expect(() => appendEvent([], { ...basic, hidden: value } as CardAuditEvent, AT)).toThrow('invalid_card_audit_event');
  });

  it('deep clones, preserves masked_card_number, and removes unsafe keys without prototype mutation', () => {
    const input = JSON.parse('{"masked_card_number":"****0000","__proto__":{"safe":true},"nested":[{"token":"test-value"}]}') as Record<string, unknown>;
    const result = redactValue(input);
    expect(result).toEqual({ ...input, nested: [{}] });
    expect(result).not.toBe(input);
    expect((result as Record<string, unknown>)['nested']).not.toBe(input['nested']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(input['nested']).toEqual([{ token: 'test-value' }]);
    expect(redactValue({ masked_card_number: panGroups.join('') })).toEqual({ masked_card_number: '[REDACTED]' });
  });

  it.each(['issued', 'unconfirmed'])('retains a created-card response and its %s event despite flagged payloads', outcome => {
    const file = tempFile();
    const stores = [openInMemoryLedger(), openJsonlLedger(file)];
    const response = { card_id: 'card_test_01', masked_card_number: '****0000', token: 'test-value',
      controls: { currency: 'USD', note: panGroups.join(' '), secret: 'test-value' } };
    const before = structuredClone(response);
    for (const store of stores) {
      store.append({ kind: 'raw_response', ref: 'response_test_01', endpoint: '/test/cards/create', status: 200, body: response }, AT);
      store.append(outcome === 'issued' ? { kind: 'card_issued', approvalId: 'approval_test_01', requestId: 'spk_test_01',
        cardId: response.card_id, maskedNumber: response.masked_card_number, controls: response.controls, rawResponseRef: 'response_test_01' }
        : { kind: 'card_issue_unconfirmed', approvalId: 'approval_test_01', requestId: 'spk_test_01',
          reason: 'response_shape_unconfirmed', rawResponseRef: 'response_test_01' }, AT);
      const records = store.read();
      expect(records[0]!.event).toMatchObject({ body: { card_id: 'card_test_01', masked_card_number: '****0000',
        controls: { currency: 'USD', note: '[REDACTED]' } } });
      expect(records[0]!.event).not.toHaveProperty('body.token');
      expect(records[0]!.event).not.toHaveProperty('body.controls.secret');
      if (outcome === 'issued') expect(records[1]!.event).toMatchObject({ controls: { currency: 'USD', note: '[REDACTED]' } });
      expect(records[1]!.event.kind).toBe(outcome === 'issued' ? 'card_issued' : 'card_issue_unconfirmed');
      expect(verifyChain(records)).toEqual({ ok: true });
      store.close();
    }
    expect(response).toEqual(before);
    expect(readFileSync(file, 'utf8')).not.toContain(panGroups.join(' '));
    expect(openJsonlLedger(file).read()).toHaveLength(2);
  });

  it.each([
    { note: 'secret' }, { note: 'password: test-password' }, { note: 'bearer' },
    { note: 'authorization' }, { note: 'cookie' }, { note: 'id_token' }, { note: 'auth_token' },
    { note: 'api_secret' }, { note: 'secret_key' }, { note: 'x-api-key' }, { note: 'cvv must be removed' },
    { note: 'Authorization declined' }, { note: 'Secret Garden Cafe' }, { note: 'PAN AM CAFE' },
    { note: 'Cookie jar' }, { note: 'Authorization limit token exceeded' },
    { expiry: '12/30' }, { card_experiment: 'control' }, { account_number: '999' },
  ])('keeps ordinary free text %#', value => {
    expect(() => assertRedacted(value)).not.toThrow();
    expect(redactValue(value)).toEqual(value);
  });

  it('drops extra card-secret keys and still redacts a PAN stored under a plain key', () => {
    expect(redactValue({ x: { security_code: '999', card_security: '999', card_expiry: '12/30', number: '999' } })).toEqual({ x: {} });
    expect(redactValue({ account_number: panGroups.join('') })).toEqual({ account_number: '[REDACTED]' });
  });
});

describe('ordinary free text is stored and high-confidence secrets are redacted before hashing', () => {
  const bearer = 'Bearer abc123def456ghi789';
  const pan = panGroups.join('');
  const spaced = panGroups.join(' ');
  const dashed = panGroups.join('-');
  const offer = {
    offerId: 'offer_test_01', vendor: 'Test Vendor', product: 'Test Product', plan: 'one_time' as const, rail: 'card' as const,
    price: { amount: '1.00', currency: 'USD', unit: 'one_time' as const },
    priceStatus: 'price_unverified' as const, availability: 'available' as const,
  };
  const ordinary: CardAuditEvent[] = [
    { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '1.00', currency: 'USD',
      merchantName: 'Secret Garden Cafe', processResult: 'Approved', failureReason: 'Authorization declined', mapped: 'other' },
    { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '1.00', currency: 'USD',
      merchantName: 'PAN AM CAFE', processResult: 'Cookie jar', failureReason: 'Cookie jar', mapped: 'other' },
    { kind: 'card_frozen', cardId: 'card_test_01', by: 'agent', reason: 'Authorization limit token exceeded' },
    { kind: 'offers_snapshot', intent: 'Secret Garden Cafe', offers: [offer] },
    { kind: 'comparison', candidates: [{ offerId: 'offer_test_01', rail: 'card', upfrontMinor: 100, perChargeMinor: 100,
      horizonLowMinor: 100, horizonHighMinor: 100, notes: ['Cookie jar', 'Secret Garden Cafe'] }],
      excluded: [{ offerId: 'offer_test_02', reason: 'PAN AM CAFE' }] },
    { kind: 'decision', action: 'ask', reasons: ['Authorization limit token exceeded'],
      ruleResults: [{ offerId: 'offer_test_01', rule: 'Secret Garden Cafe', pass: true, code: 'cookie_jar' }] },
    { kind: 'approval_rejected', approvalRequestId: 'request_test_01', code: 'Authorization declined' },
    { kind: 'card_issue_unconfirmed', approvalId: 'approval_test_01', requestId: 'spk_test_01', reason: 'Cookie jar' },
  ];
  const secrets: CardAuditEvent[] = [
    { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '1.00', currency: 'USD',
      merchantName: 'Secret Garden Cafe', failureReason: bearer, mapped: 'other' },
    { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '1.00', currency: 'USD',
      failureReason: spaced, processResult: bearer, mapped: 'other' },
    { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: '1.00', currency: 'USD',
      failureReason: dashed, mapped: 'other' },
    { kind: 'card_frozen', cardId: 'card_test_01', by: 'agent', reason: pan },
    { kind: 'comparison', candidates: [{ offerId: 'offer_test_01', rail: 'card', upfrontMinor: 100, perChargeMinor: 100,
      horizonLowMinor: 100, horizonHighMinor: 100, notes: ['Authorization declined', bearer] }],
      excluded: [{ offerId: 'offer_test_02', reason: spaced }] },
  ];

  function digest(record: { seq: number; at: string; prevHash: string; event: unknown }): string {
    return `0x${sha256Hex(canonicalize({ seq: record.seq, at: record.at, prevHash: record.prevHash, event: record.event }))}`;
  }

  it.each(['memory', 'jsonl'])('keeps the reviewed phrases and redacts bearer and PAN on %s', mode => {
    const file = tempFile();
    const store = mode === 'memory' ? openInMemoryLedger() : openJsonlLedger(file);
    for (const event of ordinary) expect(store.append(event, AT).event).toEqual(event);
    const bearerRecord = store.append(secrets[0]!, AT);
    expect(bearerRecord.event).toMatchObject({ merchantName: 'Secret Garden Cafe', failureReason: '[REDACTED]' });
    expect(bearerRecord.hash).toBe(digest(bearerRecord));
    expect(bearerRecord.hash).not.toBe(digest({ ...bearerRecord, event: secrets[0] }));
    expect(() => assertRedacted(secrets[0])).toThrow(/^ledger_redaction_required$/);
    expect(() => assertRedacted(bearerRecord.event)).not.toThrow();
    const spacedRecord = store.append(secrets[1]!, AT);
    expect(spacedRecord.event).toMatchObject({ failureReason: '[REDACTED]', processResult: '[REDACTED]' });
    expect(store.append(secrets[2]!, AT).event).toMatchObject({ failureReason: '[REDACTED]' });
    expect(store.append(secrets[3]!, AT).event).toMatchObject({ reason: '[REDACTED]' });
    const notes = store.append(secrets[4]!, AT).event;
    expect(notes).toMatchObject({ candidates: [{ notes: ['Authorization declined', '[REDACTED]'] }],
      excluded: [{ reason: '[REDACTED]' }] });
    const records = store.read();
    expect(verifyChain(records)).toEqual({ ok: true });
    for (const record of records) expect(record.hash).toBe(digest(record));
    store.close();
    if (mode === 'jsonl') {
      const text = readFileSync(file, 'utf8');
      for (const phrase of ['Authorization declined', 'Secret Garden Cafe', 'PAN AM CAFE', 'Cookie jar', 'Authorization limit token exceeded']) {
        expect(text).toContain(phrase);
      }
      expect(text).not.toContain(bearer);
      expect(text).not.toContain('abc123def456ghi789');
      expect(text).not.toContain(pan);
      expect(text).not.toContain(spaced);
      expect(text).not.toContain(dashed);
    }
  });
});

describe('timestamp order', () => {
  it('rejects an earlier instant and allows equal instants written with another offset', () => {
    const first = appendEvent([], basic, AT);
    expect(() => appendEvent([first], basic, '2030-01-01T00:30:00.000+02:00')).toThrow(/^non_monotonic_timestamp$/);
    const sameInstant = appendEvent([first], basic, '2029-12-31T23:00:00.000-01:00');
    expect(verifyChain([first, sameInstant])).toEqual({ ok: true });
    const payload = { seq: 1, at: '2029-12-31T22:00:00.000Z', prevHash: first.hash, event: basic };
    const earlier = { ...payload, hash: `0x${sha256Hex(canonicalize(payload))}` };
    expect(verifyChain([first, earlier])).toEqual({ ok: false, brokenAt: 1, error: 'non_monotonic_timestamp' });
    expect(appendEvent([first], basic, AT).seq).toBe(1);
  });
});

describe('currency exponents and terms binding', () => {
  it.each([
    ['JPY', '100', 100], ['JPY', '-100', -100], ['JPY', '-0', 0],
    ['KWD', '1.234', 1234], ['KWD', '-1.234', -1234], ['KWD', '0.001', 1], ['KWD', '-0.001', -1],
    ['KWD', '1.2', 1200], ['USD', '-1.23', -123],
  ])('converts and records %s %s exactly', (currency, value, expected) => {
    expect(signedDecimalToMinor(value, currency as string)).toBe(expected);
    const event = { kind: 'authorization', source: 'observed', cardId: 'card_test_01', amount: value, currency, mapped: 'approved' };
    expect(CardAuditEventSchema.safeParse(event).success).toBe(true);
    expect(() => appendEvent([], event as CardAuditEvent, AT)).not.toThrow();
  });

  it.each([
    ['JPY', '1.0'], ['JPY', '-0.01'], ['JPY', '1.234'], ['KWD', '1.2345'], ['KWD', '-0.0001'],
    ['KWD', '9007199254740.992'], ['USD', '1.234'],
  ])('rejects excess precision or overflow for %s %s', (currency, amount) => {
    expect(() => signedDecimalToMinor(amount, currency)).toThrow(RangeError);
    expect(CardAuditEventSchema.safeParse({ kind: 'authorization', source: 'observed', cardId: 'card_test_01',
      amount, currency, mapped: 'approved' }).success).toBe(false);
  });

  it.each(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])('uses zero decimals for %s', currency => {
    expect(signedDecimalToMinor('-2', currency)).toBe(-2);
    expect(() => signedDecimalToMinor('2.01', currency)).toThrow();
  });
  it.each(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD'])('uses three decimals for %s', currency => {
    expect(signedDecimalToMinor('-2.001', currency)).toBe(-2001);
  });

  it.each(['usd', '', 'US', 'USDD'])('rejects invalid currency %s', currency => {
    expect(() => signedDecimalToMinor('1', currency)).toThrow('invalid_currency');
  });

  it.each([['JPY', '100', true], ['JPY', '100.01', true], ['KWD', '1.234', true], ['KWD', '1.2345', true],
    ['USD', '0.000001', true], ['USD', '0.0000001', false], ['USD', '-0.000001', false]] as const)(
    'validates offer price precision for %s %s', (currency, amount, valid) => {
      const result = CardAuditEventSchema.safeParse({ kind: 'offers_snapshot', intent: 'test purchase', offers: [{
        offerId: 'offer_test_01', vendor: 'Test Vendor', product: 'Test Product', plan: 'one_time', rail: 'card',
        price: { amount, currency, unit: 'one_time' }, priceStatus: 'price_unverified', availability: 'available',
      }] });
      expect(result.success).toBe(valid);
      if (!result.success) expect(result.error.issues[0]!.path).toEqual(['offers', 0, 'price', 'amount']);
    },
  );

  it.each(['termsHash', 'presentedTermsHash'] as const)('binds approval_granted %s to the record hash', field => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const event: CardAuditEvent = { kind: 'approval_granted', approvalRequestId: 'request_test_01', approvalId: 'approval_test_01',
      termsHash: digest('test-final'), presentedTermsHash: digest('test-presented'),
      approver: { kind: 'human', id: 'operator_test_01' }, merchantCategoryCode: '7372', approvedAt: AT, demoAutoApproved: false };
    expect(appendEvent([], event, AT).hash).not.toBe(appendEvent([], { ...event, [field]: digest('test-altered') }, AT).hash);
  });
});

describe('verification diagnostics and external anchors', () => {
  it('prints the head and detects tail truncation against an external anchor', () => {
    const file = tempFile();
    const store = openJsonlLedger(file);
    store.append(basic, AT);
    const last = store.append(basic, AT);
    const options = ['--expect-head', last.hash, '--expect-seq', String(last.seq)];
    expect(JSON.parse(runLedgerCli(['verify', file, ...options]).output)).toEqual({ ok: true, head: { seq: last.seq, hash: last.hash } });
    const firstLine = readFileSync(file, 'utf8').split('\n')[0]! + '\n';
    writeFileSync(file, firstLine);
    expect(runLedgerCli(['verify', file]).exitCode).toBe(0);
    expect(JSON.parse(runLedgerCli(['verify', file, ...options]).output)).toMatchObject({ ok: false, error: 'head_mismatch', brokenAt: 1 });
    expect(JSON.parse(runLedgerCli(['verify', file, '--expect-seq', '1']).output)).toMatchObject({ ok: false, error: 'head_sequence_mismatch' });
    expect(runLedgerCli(['verify', file, '--head', store.read()[0]!.hash]).exitCode).toBe(0);
  });

  it.each([0, 1, 2])('reports incomplete final line at %i through verifier and built CLI', complete => {
    const file = tempFile();
    const store = openJsonlLedger(file);
    for (let i = 0; i < complete; i += 1) store.append(basic, AT);
    const contents = readFileSync(file, 'utf8') + '{"seq":';
    writeFileSync(file, contents);
    const expected = { ok: false, error: 'incomplete_final_line', brokenAt: complete };
    expect(verifyJsonl(contents)).toEqual(expected);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'verify', file], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.stderr).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(contents);
  });

  it.each([
    ['--expect-head'], ['--expect-head', 'bad'], ['--expect-seq', '1.5'], ['--expect-seq', '-2'],
    ['--expect-seq', '9007199254740992'], ['--expect-seq', '0', '--expect-seq', '0'],
  ].map(options => [options] as const))('rejects malformed anchor options %#', options => {
    expect(runLedgerCli(['verify', tempFile(), ...options]).output).toContain('usage:');
  });
});

describe('bounded lock recovery and process coordination', () => {
  it.each(['dead', 'expired'])('recovers a %s owner without altering existing history', mode => {
    const file = tempFile();
    const store = openJsonlLedger(file);
    store.append(basic, AT);
    const before = readFileSync(file, 'utf8');
    if (mode === 'dead') {
      const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      expect(child.status).toBe(0);
      writeFileSync(`${file}.lock`, child.stdout + '\n');
    } else {
      writeFileSync(`${file}.lock`, `${process.pid}\n`);
      const old = new Date(Date.now() - 31_000);
      utimesSync(`${file}.lock`, old, old);
    }
    expect(store.append(basic, AT).seq).toBe(1);
    expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('retries a live lock until its owner releases it', async () => {
    const file = tempFile();
    const store = openJsonlLedger(file);
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1], String(process.pid));
      process.stdout.write('ready');
      setTimeout(() => fs.unlinkSync(process.argv[1]), 50);
    `, `${file}.lock`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('test_child_failed')));
    });
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
    expect(store.append(basic, AT).seq).toBe(0);
    await exited;
  });

  it('serializes two real processes appending to the same chain', async () => {
    const file = tempFile();
    const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
    const script = `
      import { openJsonlLedger } from ${JSON.stringify(moduleUrl)};
      const store = openJsonlLedger(process.argv[1]);
      process.stdout.write('ready');
      process.stdin.once('data', () => {
        for (let i = 0; i < 12; i += 1) store.append(${JSON.stringify(basic)}, ${JSON.stringify(AT)});
        store.close();
        process.stdin.destroy();
      });
    `;
    const workers = [0, 1].map(() => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['pipe', 'pipe', 'pipe'] });
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('test_child_failed')));
      });
      const ready = new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
      return { child, done, ready };
    });
    await Promise.all(workers.map(worker => worker.ready));
    for (const worker of workers) worker.child.stdin.end('go');
    await Promise.all(workers.map(worker => worker.done));
    const records = openJsonlLedger(file).read();
    expect(records).toHaveLength(24);
    expect(records.map(record => record.seq)).toEqual(Array.from({ length: 24 }, (_, index) => index));
    expect(verifyChain(records)).toEqual({ ok: true });
    expect(statSync(file).size).toBeGreaterThan(0);
  });
});
