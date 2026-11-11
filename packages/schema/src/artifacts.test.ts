import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkArtifacts, generateArtifacts, generateLock, serialize, writeArtifacts } from './artifacts.js';
import { fixtureManifest } from './fixture-manifest.js';
import { SCHEMA_VERSION } from './index.js';
import { convertSchema, schemaRegistry } from './json-schema.js';
import type { JsonSchema } from './json-schema.js';
import { decisionChainOpenApiDocument, openApiDocument } from './openapi.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ajv = new Ajv({ allErrors: true, strictKeywords: true, strictNumbers: true });
const validators = Object.fromEntries(Object.keys(schemaRegistry).map(name => [
  name, ajv.compile(JSON.parse(readFileSync(join(root, `generated/json-schema/${name}.json`), 'utf8'))),
]));

it('freezes package and source version at 1.0.0', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(pkg.version).toBe('1.0.0');
  expect(SCHEMA_VERSION).toBe(pkg.version);
});

it('accounts for every generated contract and every fixture', () => {
  expect(readdirSync(join(root, 'generated/json-schema')).sort())
    .toEqual(Object.keys(schemaRegistry).map(name => `${name}.json`).sort());
  expect(readdirSync(join(root, 'fixtures')).sort()).toEqual(Object.keys(fixtureManifest).sort());
});

describe('C1: Zod and Ajv validate the same committed fixtures', () => {
  for (const [filename, name] of Object.entries(fixtureManifest)) {
    it(`${filename} agrees across both validators`, () => {
      const input: unknown = JSON.parse(readFileSync(join(root, 'fixtures', filename), 'utf8'));
      const valid = filename.endsWith('.valid.json');
      expect(schemaRegistry[name]!.safeParse(input).success).toBe(valid);
      const validate = validators[name]!;
      expect(validate(input), ajv.errorsText(validate.errors)).toBe(valid);
    });
  }
});

it('rejects unknown fields and enforces earlier-step fallbacks at every bounded position', () => {
  const plan = JSON.parse(readFileSync(join(root, 'fixtures/payment-plan.valid.json'), 'utf8'));
  expect(validators.PaymentPlan!({ ...plan, approved: true })).toBe(false);
  const primary = plan.steps[0];
  for (let index = 0; index < 10; index++) {
    const steps = Array.from({ length: index + 1 }, (_, position) => ({
      ...primary, ...(position > 0 ? { fallbackOf: position - 1 } : {}),
    }));
    expect(validators.PaymentPlan!({ ...plan, steps })).toBe(true);
    steps[index] = { ...primary, fallbackOf: index };
    expect(validators.PaymentPlan!({ ...plan, steps })).toBe(false);
  }
});

it('fails instead of silently discarding unsupported constructs or refinements', () => {
  const reference = () => ({});
  expect(() => convertSchema(z.string().trim(), reference)).toThrow('Unsupported string check');
  expect(() => convertSchema(z.coerce.number(), reference)).toThrow('coercion');
  expect(() => convertSchema(z.object({}).passthrough(), reference)).toThrow('Only strict objects');
  expect(() => convertSchema(z.string().refine(() => true), reference)).toThrow('Unmapped refinement');
  expect(() => convertSchema(z.string().transform(value => value), reference)).toThrow('Transforms');
});

it('generates OpenAPI 3.1 with all eight frozen routes and resolvable schema references', () => {
  const doc = JSON.parse(readFileSync(join(root, 'generated/openapi.json'), 'utf8'));
  expect(doc).toEqual(openApiDocument());
  expect(doc.openapi).toBe('3.1.0');
  expect(doc.info.version).toBe('1.0.0');
  const routes = [
    ['/v1/plan', 'post', 'PlanReq', 'PaymentPlan'],
    ['/v1/guard', 'post', 'GuardReq', 'GuardResult'],
    ['/v1/quote', 'post', undefined, 'Quote'],
    ['/v1/catalog', 'get', undefined, 'CatalogItem'],
    ['/v1/receipts', 'post', 'Receipt', 'Receipt'],
    ['/v1/stats', 'get', undefined, 'Stats'],
    ['/v1/plans/{id}/approve', 'post', undefined, 'PaymentPlan'],
    ['/v1/audit/{id}', 'get', undefined, 'AuditRecord'],
  ] as const;
  expect(Object.keys(doc.paths).sort()).toEqual(routes.map(([path]) => path).sort());
  expect(Object.keys(doc.components.schemas).sort()).toEqual(Object.keys(schemaRegistry).sort());
  const operationIds = new Set<string>();
  for (const [path, method, input, output] of routes) {
    const operation = doc.paths[path][method];
    expect(Object.keys(doc.paths[path])).toEqual([method]);
    operationIds.add(operation.operationId);
    if (input) expect(operation.requestBody.content['application/json'].schema.$ref)
      .toBe(`#/components/schemas/${input}`);
    const response = operation.responses['200'].content['application/json'].schema;
    expect(((path === '/v1/catalog' || path === '/v1/quote') ? response.items : response).$ref).toBe(`#/components/schemas/${output}`);
    if (path.includes('{id}')) expect(operation.parameters).toContainEqual({
      name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/Identifier' },
    });
  }
  expect(operationIds.size).toBe(8);
  expect(doc.paths['/v1/quote'].post.requestBody.content['application/json'].schema).toEqual({
    type: 'object', properties: { url: { $ref: '#/components/schemas/HttpUrl' } },
    required: ['url'], additionalProperties: false,
  });
  expect(doc.paths['/v1/catalog'].get.parameters).toEqual([
    { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
    { name: 'celo', in: 'query', required: false, schema: { type: 'boolean' } },
  ]);
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const object = value as JsonSchema;
    if (typeof object.$ref === 'string') {
      expect(object.$ref.startsWith('#/components/schemas/')).toBe(true);
      expect(doc.components.schemas[object.$ref.slice('#/components/schemas/'.length)]).toBeDefined();
    }
    Object.values(object).forEach(visit);
  };
  visit(doc);
  // Compile the OpenAPI component graph in isolation, with local references.
  const components = JSON.parse(JSON.stringify(doc.components.schemas).replaceAll('#/components/schemas/', '#/definitions/'));
  for (const name of Object.keys(schemaRegistry)) {
    expect(ajv.compile({ definitions: components, $ref: `#/definitions/${name}` })).toBeTypeOf('function');
  }
});

it('links a generated supplemental OpenAPI document for public decision chain discovery', () => {
  const doc = JSON.parse(readFileSync(join(root, 'generated/decision-chain.openapi.json'), 'utf8'));
  expect(doc).toEqual(decisionChainOpenApiDocument());
  expect(openApiDocument().externalDocs).toEqual({
    description: 'Public decision chain discovery endpoint', url: './decision-chain.openapi.json',
  });
  expect(doc.openapi).toBe('3.1.0');
  expect(Object.keys(doc.paths)).toEqual(['/v1/decision-chain']);
  const operation = doc.paths['/v1/decision-chain'].get;
  expect(operation.operationId).toBe('getDecisionChain');
  expect(operation.responses['503']).toBeDefined();
  const components = JSON.parse(JSON.stringify(doc.components.schemas).replaceAll('#/components/schemas/', '#/definitions/'));
  const output = JSON.parse(JSON.stringify(operation.responses['200'].content['application/json'].schema)
    .replaceAll('#/components/schemas/', '#/definitions/'));
  const validate = ajv.compile({ ...output, definitions: components });
  expect(validate(JSON.parse(readFileSync(join(root, 'fixtures/decision-chain.valid.json'), 'utf8')))).toBe(true);
});

it('generates stable bytes and records the sha256 of every artifact', () => {
  const artifacts = generateArtifacts();
  expect(generateArtifacts()).toEqual(artifacts);
  checkArtifacts(root, artifacts);
  const lock = JSON.parse(generateLock(artifacts));
  expect(lock.schemaVersion).toBe('1.0.0');
  expect(lock.algorithm).toBe('sha256');
  expect(Object.keys(lock.files)).toEqual(Object.keys(artifacts).sort());
  for (const [path, content] of Object.entries(artifacts)) {
    expect(lock.files[path]).toBe(createHash('sha256').update(content).digest('hex'));
    expect(readFileSync(join(root, path), 'utf8')).toBe(content);
  }
});

it('fails read-only checks on artifact, lock, source-output or inventory drift', () => {
  const directory = mkdtempSync(join(root, '.schema-test-'));
  const artifacts = generateArtifacts();
  try {
    writeArtifacts(directory, artifacts);
    checkArtifacts(directory, artifacts);
    const path = 'generated/openapi.json';
    const modified = { ...artifacts, [path]: serialize({ changed: true }) };
    expect(() => checkArtifacts(directory, modified)).toThrow('schema.lock differs');
    writeFileSync(join(directory, path), modified[path]);
    expect(() => checkArtifacts(directory, artifacts)).toThrow('artifact mismatch');
    expect(readFileSync(join(directory, path), 'utf8')).toBe(modified[path]);
    // Rehashing a tampered artifact cannot make it match source regeneration.
    writeFileSync(join(directory, 'schema.lock'), generateLock(modified));
    expect(() => checkArtifacts(directory, artifacts)).toThrow('schema.lock differs');
    writeArtifacts(directory, artifacts);
    writeFileSync(join(directory, 'schema.lock'), '{}\n');
    expect(() => checkArtifacts(directory, artifacts)).toThrow('schema.lock differs');
    writeArtifacts(directory, artifacts);
    writeFileSync(join(directory, 'generated/extra.json'), '{}\n');
    expect(() => checkArtifacts(directory, artifacts)).toThrow('inventory differs');
    writeArtifacts(directory, artifacts);
    rmSync(join(directory, path));
    expect(() => checkArtifacts(directory, artifacts)).toThrow('inventory differs');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
