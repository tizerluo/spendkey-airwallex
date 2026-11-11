import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJsonl, verifyChain } from './chain.js';

/** Outcome of one CLI invocation, returned instead of touching `process`. */
export interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

function errorOutput(error: unknown): string {
  return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

/**
 * Offline audit-chain verifier.
 *
 * Usage: `audit-cli <records.jsonl>`. Reads a JSONL export, validates each
 * record against the schema and verifies the hash chain. Prints
 * `{ "ok": true }` or `{ "ok": false, "firstBadIndex": <n> }` and exits 0/1;
 * usage and I/O errors exit 2. No network access.
 */
export function runAuditCli(argv: readonly string[]): CliResult {
  const file = argv.find((argument) => !argument.startsWith('--'));
  if (file === undefined) {
    return { exitCode: 2, output: JSON.stringify({ ok: false, error: 'usage: audit-cli <records.jsonl>' }) };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { exitCode: 2, output: errorOutput(error) };
  }
  try {
    const result = verifyChain(parseJsonl(text));
    return { exitCode: result.ok ? 0 : 1, output: JSON.stringify(result) };
  } catch (error) {
    return { exitCode: 2, output: errorOutput(error) };
  }
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const { exitCode, output } = runAuditCli(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exitCode = exitCode;
}
