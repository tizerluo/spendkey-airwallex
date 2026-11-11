import { signedDecimalToMinor } from '@sk/ledger';

/** Shared, synthetic demo scenario: leave $400 after the $100 obligation. */
export const DEMO_POLICY_NOTES = [
  'reserve floor = max(0, available USD balance - 500.00 USD) must remain after upfront charges (demo policy)',
  'known obligation 100.00 USD within 30 days',
];

export function demoReserveFloorMinor(balances: readonly { currency: string; available_amount: string | number }[]): number {
  const usd = balances.find(balance => balance.currency === 'USD');
  return Math.max(0, (usd ? signedDecimalToMinor(usd.available_amount, 'USD') : 0) - 50_000);
}
