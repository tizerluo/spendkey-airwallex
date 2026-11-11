import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyJsonl } from './chain.js';
import type { VerificationOptions } from './chain.js';

export interface CliResult { exitCode: 0 | 1; output: string }

/** Read-only and offline. Does not create, lock or change the file. */
export function runLedgerCli(argv: readonly string[]): CliResult {
  const usage: CliResult = { exitCode: 1, output: JSON.stringify({ ok: false,
    error: 'usage: node dist/cli.js verify <file> [--expect-head <hash>] [--expect-seq <seq>]' }) };
  if (argv[0] !== 'verify' || !argv[1]) return usage;
  const options: VerificationOptions = {};
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === '--expect-head' || flag === '--head') && value !== undefined
      && /^0x[0-9a-f]{64}$/.test(value) && options.expectHead === undefined) options.expectHead = value;
    else if (flag === '--expect-seq' && value !== undefined && /^(?:-1|0|[1-9]\d*)$/.test(value)
      && Number.isSafeInteger(Number(value)) && options.expectSeq === undefined) options.expectSeq = Number(value);
    else return usage;
  }
  try {
    const result = verifyJsonl(readFileSync(argv[1], 'utf8'), options);
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
