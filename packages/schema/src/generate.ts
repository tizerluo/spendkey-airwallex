import { fileURLToPath } from 'node:url';
import { checkArtifacts, generateArtifacts, writeArtifacts } from './artifacts.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node dist/generate.js [--check]');
}
const artifacts = generateArtifacts();
if (args[0] === '--check') {
  checkArtifacts(root, artifacts);
  console.log(`Schema lock passed (${Object.keys(artifacts).length} generated files; regenerated in memory).`);
} else {
  writeArtifacts(root, artifacts);
  console.log(`Generated ${Object.keys(artifacts).length} files and schema.lock.`);
}
