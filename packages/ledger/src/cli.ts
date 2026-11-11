import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJsonl, verifyChain } from './chain.js';

export interface CliResult { exitCode: 0 | 1; output: string }

/** Read-only and offline. Does not create, lock or change the file. */
export function runLedgerCli(argv: readonly string[]): CliResult {
  if (argv.length !== 2 || argv[0] !== 'verify' || !argv[1]) {
    return { exitCode: 1, output: JSON.stringify({ ok: false, error: 'usage: node dist/cli.js verify <file>' }) };
  }
  try {
    const result = verifyChain(parseJsonl(readFileSync(argv[1], 'utf8')));
    return { exitCode: result.ok ? 0 : 1, output: JSON.stringify(result) };
  } catch {
    // Never include input, filesystem paths or exception messages in output.
    return { exitCode: 1, output: JSON.stringify({ ok: false, error: 'ledger_verification_failed' }) };
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runLedgerCli(process.argv.slice(2));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
