import { mkdirSync } from 'node:fs';
import { openJsonlLedger } from '@sk/ledger';
import { JsonApprovalStore } from '../server/store.js';
import { AirwallexClient, loadAirwallexConfig } from '@sk/airwallex';
import { runDemo } from './run.js';

try {
  if (process.argv[2] === 'sandbox') {
    if (!process.env['AIRWALLEX_CLIENT_ID']?.trim() || !process.env['AIRWALLEX_API_KEY']?.trim()) {
      throw new Error('demo:sandbox requires AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY at runtime.');
    }
    if (!process.env['AIRWALLEX_CARDHOLDER_ID']) throw new Error('demo:sandbox requires an existing AIRWALLEX_CARDHOLDER_ID.');
    mkdirSync('./demo-output/sandbox', { recursive: true, mode: 0o700 });
    const store = new JsonApprovalStore('./demo-output/sandbox/approvals.json');
    try {
      const ledger = openJsonlLedger('./demo-output/sandbox/service-ledger.jsonl');
      try {
        await runDemo({ store, ledger, outputDir: './demo-output/sandbox',
          client: new AirwallexClient(loadAirwallexConfig(), { fetch: globalThis.fetch }),
          cardholderId: process.env['AIRWALLEX_CARDHOLDER_ID'], log: console.log });
      } finally { ledger.close(); }
    } finally { store.close(); }
  } else if (process.argv[2] === 'offline') await runDemo({ log: console.log });
  else throw new Error('Choose offline or sandbox.');
} catch (error) {
  // Do not print provider exceptions, request/response bodies, or configuration values.
  let message = 'Demo failed; inspect the local ledger and recover/freeze any unconfirmed issuance.';
  if (error instanceof Error && error.message === 'demo_requires_usd_sandbox_funds') {
    message = 'Demo requires at least 160 USD of available sandbox funds for the synthetic reserve scenario.';
  } else if (error instanceof Error && /^(demo:sandbox requires|Choose )/.test(error.message)) message = error.message;
  console.error(message); process.exitCode = 1;
}
