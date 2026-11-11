import process from 'node:process';
import { runLedgerCli } from '../packages/ledger/dist/cli.js';
const args = process.argv.slice(2);
const result = runLedgerCli(['verify', ...(args.length ? args : ['demo-output/ledger.jsonl'])]);
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;
