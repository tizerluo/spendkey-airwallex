import type { AirwallexClient } from '@sk/airwallex';
import { AirwallexApiError, AirwallexResponseError } from '@sk/airwallex';
import { redactValue, signedDecimalToMinor } from '@sk/ledger';
import { ServiceError } from '../server/service.js';

/** Accept only short enum-style values. Overlong values, values with spaces, or 13+ consecutive digits (card-number shape) are not printed. */
const OBSERVED_ENUM = /^[A-Za-z0-9_]{1,32}$/;
const PRINTABLE_FAILURE = /^(approval_store_(stale_lock|locked):|demo_[a-z_]+(?: observed_(?:primary_currency|cardholder_status)=[A-Za-z0-9_]{1,32})?$)/;

function observedEnum(value: unknown): string | undefined {
  if (typeof value !== 'string' || !OBSERVED_ENUM.test(value) || /\d{13,}/.test(value)) return undefined;
  return value;
}

function mismatch(code: string, field: 'primary_currency' | 'cardholder_status', value: unknown): Error {
  const observed = observedEnum(value);
  return new Error(observed === undefined ? code : `${code} observed_${field}=${observed}`);
}

function responseShapeDetail(error: AirwallexResponseError): string {
  const parts: string[] = [];
  if (error.endpoint) parts.push(`endpoint=${error.endpoint}`);
  if (error.issues.length > 0) {
    parts.push(`issues=${error.issues.map(issue => issue.path ? `${issue.path}:${issue.code}` : issue.code).join(',')}`);
  }
  return parts.join(' ');
}

export function describeDemoFailure(error: unknown, step: string): string {
  if (error instanceof ServiceError && error.provider) {
    const p = error.provider;
    return `${p.step}: status=${p.status} code=${p.code} message=${p.message}`;
  }
  if (error instanceof AirwallexApiError) {
    const p = redactValue({ code: error.code, message: error.message }) as { code: string; message: string };
    return `${step}: status=${error.status} code=${p.code} message=${p.message}`;
  }
  if (error instanceof AirwallexResponseError) {
    const detail = responseShapeDetail(error);
    return detail ? `${step}: invalid Airwallex response shape ${detail}` : `${step}: invalid Airwallex response shape`;
  }
  if (error instanceof ServiceError) return `${step}: ${error.code}`;
  // Never print 13+ digit numbers, so the observed-value channel cannot bring a card number back to the terminal.
  if (error instanceof Error && PRINTABLE_FAILURE.test(error.message) && !/\d{13,}/.test(error.message)) return `${step}: ${error.message}`;
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
      if (config.primary_currency !== 'USD') throw mismatch('demo_requires_usd_issuing', 'primary_currency', config.primary_currency);
      return 'primary currency USD';
    }],
    ['Cardholder', async () => {
      const holder = await client.getCardholder(cardholderId);
      if (!['ACTIVE', 'READY'].includes(holder.status)) throw mismatch('demo_cardholder_not_usable', 'cardholder_status', holder.status);
      return 'usable status';
    }],
  ];
  for (const [name, check] of checks) {
    try { log(`${name} | PASS | ${await check()}`); }
    catch (error) { ok = false; log(`${name} | FAIL | ${describeDemoFailure(error, name)}`); }
  }
  return ok;
}
