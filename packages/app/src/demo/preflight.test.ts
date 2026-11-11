import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AirwallexClient, AirwallexResponseError, loadAirwallexConfig } from '@sk/airwallex';
import { describeDemoFailure, runPreflight } from './preflight.js';

const PAN = '4111111111111111';
const TOKEN = 'tok_test_secret_looking';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function client(routes: Record<string, unknown>): AirwallexClient {
  const fetchImpl: typeof globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/authentication/login') {
      return json({ token: 'test-token-01', expires_at: '2030-01-01T00:30:00Z' });
    }
    const body = routes[path];
    if (body === undefined) throw new Error(`Unexpected offline request: ${path}`);
    return json(body);
  };
  return new AirwallexClient(loadAirwallexConfig({
    AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key',
  }), { fetch: fetchImpl });
}

const funded = {
  '/api/v1/balances/current': [{
    currency: 'USD', available_amount: '1000.00', pending_amount: '0.00', reserved_amount: '0.00',
    total_amount: '1000.00', prepayment_amount: '0.00', account_type: 'CURRENT',
  }],
  '/api/v1/issuing/config': { primary_currency: 'USD' },
  '/api/v1/issuing/cardholders/cardholder_test_01': { cardholder_id: 'cardholder_test_01', status: 'READY' },
};

function leaked(value: unknown): string {
  return `${String(value)}\n${JSON.stringify(value) ?? ''}\n${inspect(value, { depth: null, showHidden: true })}`;
}

describe('preflight failure detail', () => {
  it('prints zod paths and codes for each failed check and never the body values', async () => {
    const secretBody = { pan: PAN, note: TOKEN, nested: { pan: PAN, token: TOKEN } };
    const lines: string[] = [];
    const ok = await runPreflight(client({
      '/api/v1/balances/current': secretBody,
      '/api/v1/issuing/config': { ...secretBody, primary_currency: { pan: PAN, token: TOKEN } },
      '/api/v1/issuing/cardholders/cardholder_test_01': { ...secretBody, cardholder_id: 'cardholder_test_01', status: { pan: PAN, token: TOKEN } },
    }), 'cardholder_test_01', line => lines.push(line));
    expect(ok).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('USD balance | FAIL | USD balance: invalid Airwallex response shape endpoint=/api/v1/balances/current issues=invalid_type');
    expect(text).toContain('Issuing config | FAIL | Issuing config: invalid Airwallex response shape endpoint=/api/v1/issuing/config issues=primary_currency:invalid_type');
    expect(text).toContain('Cardholder | FAIL | Cardholder: invalid Airwallex response shape endpoint=/api/v1/issuing/cardholders/cardholder_test_01 issues=status:invalid_type');
    expect(text).not.toContain(PAN);
    expect(text).not.toContain(TOKEN);
    const error = new AirwallexResponseError('/api/v1/issuing/config', [
      { path: 'primary_currency', code: 'invalid_type' },
    ]);
    const printed = describeDemoFailure(error, 'Issuing config');
    expect(printed).toBe('Issuing config: invalid Airwallex response shape endpoint=/api/v1/issuing/config issues=primary_currency:invalid_type');
    expect(leaked(error)).not.toContain(PAN);
    expect(printed).not.toContain(PAN);
  });

  it('records observed currency and cardholder status instead of guessing', async () => {
    const lines: string[] = [];
    const ok = await runPreflight(client({
      ...funded,
      '/api/v1/issuing/config': { primary_currency: 'EUR' },
      '/api/v1/issuing/cardholders/cardholder_test_01': { cardholder_id: 'cardholder_test_01', status: 'PENDING' },
    }), 'cardholder_test_01', line => lines.push(line));
    expect(ok).toBe(false);
    expect(lines).toContain('USD balance | PASS | at least 160.00 USD available');
    expect(lines).toContain('Issuing config | FAIL | Issuing config: demo_requires_usd_issuing observed_primary_currency=EUR');
    expect(lines).toContain('Cardholder | FAIL | Cardholder: demo_cardholder_not_usable observed_cardholder_status=PENDING');
  });

  it('drops observed values that are not short enum tokens', async () => {
    const lines: string[] = [];
    const ok = await runPreflight(client({
      ...funded,
      '/api/v1/issuing/config': { primary_currency: PAN },
      '/api/v1/issuing/cardholders/cardholder_test_01': { cardholder_id: 'cardholder_test_01', status: `PENDING ${TOKEN}` },
    }), 'cardholder_test_01', line => lines.push(line));
    expect(ok).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('Issuing config | FAIL | Issuing config: demo_requires_usd_issuing');
    expect(text).toContain('Cardholder | FAIL | Cardholder: demo_cardholder_not_usable');
    expect(text).not.toContain('observed_primary_currency=');
    expect(text).not.toContain('observed_cardholder_status=');
    expect(text).not.toContain(PAN);
    expect(text).not.toContain(TOKEN);
    expect(describeDemoFailure(new Error(`demo_requires_usd_issuing observed_primary_currency=${PAN}`), 'Issuing config')).not.toContain(PAN);
    expect(describeDemoFailure(new Error('demo_cardholder_not_usable observed_cardholder_status=INCOMPLETE'), 'Cardholder'))
      .toBe('Cardholder: demo_cardholder_not_usable observed_cardholder_status=INCOMPLETE');
  });
});
