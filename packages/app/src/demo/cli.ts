import { mkdirSync } from 'node:fs';
import { openJsonlLedger } from '@sk/ledger';
import { JsonApprovalStore } from '../server/store.js';
import { ApprovalService } from '../server/service.js';
import { loadAirwallexConfig } from '@sk/airwallex';
import { createAppAirwallexClient } from '../server/airwallex-client.js';
import { describeDemoFailure, runPreflight } from './preflight.js';
import { cleanupDemoCards } from './safety.js';
import { runDemo } from './run.js';

let step = 'startup';
try {
  if (process.argv[2] === 'sandbox') {
    if (!process.env['AIRWALLEX_CLIENT_ID']?.trim() || !process.env['AIRWALLEX_API_KEY']?.trim()) {
      throw new Error('demo_configuration_required');
    }
    const cardholderId = process.env['AIRWALLEX_CARDHOLDER_ID'];
    if (!cardholderId) throw new Error('demo_cardholder_id_required');
    const client = createAppAirwallexClient(loadAirwallexConfig(), globalThis.fetch);
    if (process.argv.includes('--preflight')) {
      step = 'preflight';
      if (!await runPreflight(client, cardholderId, console.log)) process.exitCode = 1;
    } else {
      mkdirSync('./demo-output/sandbox', { recursive: true, mode: 0o700 });
      const store = new JsonApprovalStore('./demo-output/sandbox/approvals.json');
      try {
        const ledger = openJsonlLedger('./demo-output/sandbox/service-ledger.jsonl');
        try {
          if (process.argv.includes('cleanup')) {
            step = 'cleanup';
            const service = new ApprovalService({ client, store, ledger, cardholderId, demoMode: true, printNonce: () => {} });
            await cleanupDemoCards(service, console.log);
            console.log('Demo cleanup complete.');
          } else {
            step = 'sandbox demo';
            await runDemo({ store, ledger, outputDir: './demo-output/sandbox', client,
              cardholderId, log: console.log, handleSignals: true,
              signalClose: () => { ledger.close(); store.close(); } });
          }
        } finally { ledger.close(); }
      } finally { store.close(); }
    }
  } else if (process.argv[2] === 'offline') { step = 'offline demo'; await runDemo({ log: console.log }); }
  else throw new Error('demo_choose_offline_or_sandbox');
} catch (error) {
  console.error(describeDemoFailure(error, step)); process.exitCode = 1;
}
