import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadAirwallexConfig } from '@sk/airwallex';
import { openJsonlLedger } from '@sk/ledger';
import { createFakeAirwallex } from '../demo/fake-airwallex.js';
import { DEMO_POLICY_NOTES } from '../demo/policy.js';
import { createConsoleServer } from './http.js';
import { ApprovalService } from './service.js';
import { JsonApprovalStore } from './store.js';
import { seedDesignCoRequest } from './seed.js';
import { createAppAirwallexClient } from './airwallex-client.js';

/** No client/transport override: this entry point can only use the local emulator. */
export async function startOfflineConsole(options: {
  port?: number; dataRoot?: string; now?: () => Date; log?: (line: string) => void;
} = {}) {
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_console_port');
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.log;
  const root = resolve(options.dataRoot ?? './console-data-offline');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Keep prior recordings intact; emulator card state must never reuse approvals from a prior start.
  const dataDir = mkdtempSync(join(root, 'run-'));
  const ledgerPath = join(dataDir, 'ledger.jsonl');
  const store = new JsonApprovalStore(join(dataDir, 'approvals.json'));
  try {
    const ledger = openJsonlLedger(ledgerPath);
    try {
      ledger.append({ kind: 'run_started', mode: 'offline_emulator', policyNotes: DEMO_POLICY_NOTES }, now().toISOString());
      const fake = createFakeAirwallex({ now });
      const client = createAppAirwallexClient(loadAirwallexConfig({
        AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key',
      }), fake.fetch);
      const service = new ApprovalService({ client, ledger, store, now, cardholderId: 'cardholder_test_01',
        printNonce: log, printOperatorToken: log });
      await seedDesignCoRequest(service);
      const server = createConsoleServer(service, { auditFile: ledgerPath });
      server.once('close', () => { ledger.close(); store.close(); });
      await new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('console_address_unavailable');
      const url = `http://127.0.0.1:${address.port}`;
      log(`Offline emulator (no Airwallex calls): ${url}`);
      log(`Offline ledger: ${ledgerPath}`);
      return { server, service, dataDir, ledgerPath, url };
    } catch (error) { ledger.close(); throw error; }
  } catch (error) { store.close(); throw error; }
}
