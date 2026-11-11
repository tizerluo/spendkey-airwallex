import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_VERSION } from './index.js';
import { schemaRegistry, standaloneSchema } from './json-schema.js';
import { decisionChainOpenApiDocument, openApiDocument } from './openapi.js';

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Deterministic artifacts, generated only from source contracts; no filesystem or clock inputs. */
export function generateArtifacts(): Record<string, string> {
  return {
    ...Object.fromEntries(Object.keys(schemaRegistry).map(name => [
      `generated/json-schema/${name}.json`, serialize(standaloneSchema(name)),
    ])),
    'generated/openapi.json': serialize(openApiDocument()),
    'generated/decision-chain.openapi.json': serialize(decisionChainOpenApiDocument()),
  };
}

export function generateLock(artifacts: Record<string, string>): string {
  return serialize({ schemaVersion: SCHEMA_VERSION, algorithm: 'sha256', files: Object.fromEntries(
    Object.keys(artifacts).sort().map(path => [path, createHash('sha256').update(artifacts[path]!).digest('hex')]),
  ) });
}

function filesWithin(root: string, prefix: string): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Generated artifact must not be a symlink: ${path}`);
    return entry.isDirectory() ? filesWithin(root, path) : [path];
  }).sort();
}

export function writeArtifacts(root: string, artifacts = generateArtifacts()): void {
  // Remove obsolete generated files, too. This directory is owned exclusively by gen.
  rmSync(join(root, 'generated'), { recursive: true, force: true });
  for (const [path, content] of Object.entries(artifacts)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeFileSync(join(root, 'schema.lock'), generateLock(artifacts));
}

/** Regenerate in memory and compare both lock hashes and actual committed artifact bytes. */
export function checkArtifacts(root: string, artifacts = generateArtifacts()): void {
  if (readFileSync(join(root, 'schema.lock'), 'utf8') !== generateLock(artifacts)) {
    throw new Error('schema.lock differs from source contracts; run pnpm --filter @sr/schema gen');
  }
  const actualPaths = filesWithin(root, 'generated');
  if (serialize(actualPaths) !== serialize(Object.keys(artifacts).sort())) {
    throw new Error('Generated file inventory differs from source contracts');
  }
  for (const [path, expected] of Object.entries(artifacts)) {
    if (readFileSync(join(root, path), 'utf8') !== expected) throw new Error(`Generated artifact mismatch: ${path}`);
  }
}
