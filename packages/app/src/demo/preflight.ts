import type { AirwallexClient } from '@sk/airwallex';
import { AirwallexApiError, AirwallexResponseError } from '@sk/airwallex';
import { redactValue, signedDecimalToMinor } from '@sk/ledger';
import { ServiceError } from '../server/service.js';

export function describeDemoFailure(error: unknown, step: string): string {
  if (error instanceof ServiceError && error.provider) {
    const p = error.provider;
    return `${p.step}: status=${p.status} code=${p.code} message=${p.message}`;
  }
  if (error instanceof AirwallexApiError) {
    const p = redactValue({ code: error.code, message: error.message }) as { code: string; message: string };
    return `${step}: status=${error.status} code=${p.code} message=${p.message}`;
  }
  if (error instanceof AirwallexResponseError) return `${step}: invalid Airwallex response shape`;
  if (error instanceof ServiceError) return `${step}: ${error.code}`;
  if (error instanceof Error && /^(approval_store_(stale_lock|locked):|demo_[a-z_]+$)/.test(error.message)) return `${step}: ${error.message}`;
  return `${step}: failed; inspect the local ledger and recover/freeze any unconfirmed issuance`;
}

/** Read-only: authenticate, balances, issuing configuration, existing cardholder. */
export async function runPreflight(client: AirwallexClient, cardholderId: string, log: (line: string) => void): Promise<boolean> {
  let ok = true;
  log('Check | Result | Detail');
  const checks: [string, () => Promise<string>][] = [
    ['USD balance', async () => {
      const usd = (await client.getBalances()).find(balance => balance.currency === 'USD');
      if (!usd || signedDecimalToMinor(usd.available_amount, 'USD') < 16_000) throw new Error('demo_requires_usd_sandbox_funds');
      return 'at least 160.00 USD available';
    }],
    ['Issuing config', async () => {
      const config = await client.getIssuingConfig();
      if (config.primary_currency !== 'USD') throw new Error('demo_requires_usd_issuing');
      return 'primary currency USD';
    }],
    ['Cardholder', async () => {
      const holder = await client.getCardholder(cardholderId);
      if (!['ACTIVE', 'READY'].includes(holder.status)) throw new Error('demo_cardholder_not_usable');
      return 'usable status';
    }],
  ];
  for (const [name, check] of checks) {
    try { log(`${name} | PASS | ${await check()}`); }
    catch (error) { ok = false; log(`${name} | FAIL | ${describeDemoFailure(error, name)}`); }
  }
  return ok;
}
