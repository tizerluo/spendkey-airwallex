import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { createFakeAirwallex } from './fake-airwallex.js';
import { verifyJsonl } from '@sk/ledger';
import { runDemo } from './run.js';

it('runs the offline main line with exact ledger events, durable JSONL, controls and tamper proof', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spendkey-demo-'));
  try {
    const result = await runDemo({ now: () => new Date('2026-11-11T10:00:00.000Z'), outputDir: dir });
    expect(result.verification.ok).toBe(true); expect(result.tamperVerification.ok).toBe(false);
    expect(result.ledger.read().map(({ event }) => event.kind)).toEqual([
      'offers_snapshot', 'comparison', 'decision', 'approval_requested', 'approval_granted', 'card_issued',
      'authorization', 'authorization', 'authorization', 'card_frozen', 'authorization',
      'authorization', 'authorization', 'authorization', 'authorization', 'raw_response', 'reconciliation',
    ]);
    expect(result.ledger.read().filter(({ event }) => event.kind === 'authorization' && event.source === 'simulated').map(({ event }) => event)).toMatchObject([
      { mapped: 'approved' }, { mapped: 'limit_exceeded' }, { mapped: 'merchant_category_not_allowed' }, { mapped: 'card_inactive' },
    ]);
    expect(result.ledger.read().find(({ event }) => event.kind === 'approval_granted')?.event).toMatchObject({ demoAutoApproved: true, approver: { kind: 'human', id: 'demo-operator' } });
    expect([...result.fake.inputs.values()][0]?.authorization_controls).toMatchObject({
      allowed_currencies: ['USD'], allowed_merchant_categories: ['7372'],
      transaction_limits: { limits: [{ amount: 60, interval: 'MONTHLY' }] },
    });
    expect([...result.fake.cards.values()][0]?.card_status).toBe('INACTIVE');
    expect(verifyJsonl(readFileSync(join(dir, 'ledger.jsonl'), 'utf8')).ok).toBe(true);
    expect(result.transcript.join('\n')).toContain('OFFLINE sandbox simulation');
    expect(result.fake.createCalls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function injectedSandbox(balance: string) {
  const now = () => new Date('2026-11-11T10:00:00.000Z');
  const fake = createFakeAirwallex({ now });
  const fetch: typeof globalThis.fetch = async (target, init) => {
    if (new URL(String(target)).pathname === '/api/v1/balances/current') return new Response(JSON.stringify([{
      currency: 'USD', available_amount: balance, pending_amount: '0.00', reserved_amount: '0.00',
      total_amount: balance, prepayment_amount: '0.00', account_type: 'WALLET',
    }]));
    return fake.fetch(target, init);
  };
  const client = new AirwallexClient(loadAirwallexConfig({ AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' }), { fetch });
  return { client, fake, now };
}
it('uses a real-client transport injection and adapts the reserve scenario to a larger sandbox balance', async () => {
  const f = injectedSandbox('10000.00');
  const result = await runDemo({ client: f.client, now: f.now, cardholderId: 'cardholder_test_01', outputDir: false });
  expect(result.verification.ok).toBe(true); expect(f.fake.createCalls).toBe(1);
  expect(result.ledger.read()[2]?.event).toMatchObject({ kind: 'decision', action: 'ask', chosenOfferId: 'curated-designco-team-monthly' });
  expect([...f.fake.cards.values()][0]?.card_status).toBe('INACTIVE');
});
it('refuses insufficient sandbox USD funds before creating a card', async () => {
  const f = injectedSandbox('100.00');
  await expect(runDemo({ client: f.client, now: f.now, outputDir: false })).rejects.toThrow('demo_requires_usd_sandbox_funds');
  expect(f.fake.createCalls).toBe(0);
});
it('freezes a created card and exports cleanup history if the transaction loop fails', async () => {
  const f = injectedSandbox('1000.00');
  const simulation = vi.spyOn(f.client, 'simulateAuthorization').mockRejectedValueOnce(new Error('test_simulation_failure'));
  const dir = mkdtempSync(join(tmpdir(), 'spendkey-demo-cleanup-'));
  try {
    await expect(runDemo({ client: f.client, now: f.now, outputDir: dir })).rejects.toThrow('test_simulation_failure');
    expect([...f.fake.cards.values()][0]?.card_status).toBe('INACTIVE');
    const jsonl = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    expect(verifyJsonl(jsonl).ok).toBe(true); expect(JSON.parse(jsonl.trim().split('\n').at(-1)!).event.kind).toBe('card_frozen');
  } finally { simulation.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
