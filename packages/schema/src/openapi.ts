import { SCHEMA_VERSION } from './index.js';
import { convertSchema, JSON_SCHEMA_DIALECT, schemaRegistry } from './json-schema.js';
import type { JsonSchema } from './json-schema.js';

const ref = (name: string): JsonSchema => {
  if (!schemaRegistry[name]) throw new Error(`Unknown OpenAPI contract: ${name}`);
  return { $ref: `#/components/schemas/${name}` };
};
const response = (name: string, description: string, array = false) => ({
  description, content: { 'application/json': { schema: array ? { type: 'array', items: ref(name) } : ref(name) } },
});
const request = (name: string) => ({ required: true, content: { 'application/json': { schema: ref(name) } } });
const idParameter = { name: 'id', in: 'path', required: true, schema: ref('Identifier') };

export function openApiDocument(): JsonSchema {
  return {
    openapi: '3.1.0', jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: { title: 'spendkey API', version: SCHEMA_VERSION,
      description: 'v1.0.0 frozen after the Opus K1 blocking fixes; see docs/adr/0001-schema-v1.md.' },
    externalDocs: { description: 'Public decision chain discovery endpoint', url: './decision-chain.openapi.json' },
    paths: {
      '/v1/plan': { post: { operationId: 'createPlan', requestBody: request('PlanReq'),
        responses: { '200': response('PaymentPlan', 'Signed payment plan') } } },
      '/v1/guard': { post: { operationId: 'guardPayment', requestBody: request('GuardReq'),
        responses: { '200': response('GuardResult', 'Guard decision') } } },
      '/v1/quote': { post: { operationId: 'getQuote', requestBody: {
        required: true, content: { 'application/json': { schema: {
          type: 'object', properties: { url: ref('HttpUrl') }, required: ['url'], additionalProperties: false,
        } } },
      }, responses: { '200': response('Quote', 'Candidate native x402 v1 or v2 quotes', true) } } },
      '/v1/catalog': { get: { operationId: 'getCatalog', parameters: [
        { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'celo', in: 'query', required: false, schema: { type: 'boolean' } },
      ], responses: { '200': response('CatalogItem', 'Catalog entries', true) } } },
      '/v1/receipts': { post: { operationId: 'reportReceipt', requestBody: request('Receipt'),
        responses: { '200': response('Receipt', 'Recorded payment receipt') } } },
      '/v1/stats': { get: { operationId: 'getStats', responses: { '200': response('Stats', 'Aggregate metrics') } } },
      '/v1/plans/{id}/approve': { post: { operationId: 'approvePlan', parameters: [idParameter],
        description: 'Approve the identified plan; returns the resulting signed plan. Authentication is defined by the API implementation.',
        responses: { '200': response('PaymentPlan', 'Approved payment plan') } } },
      '/v1/audit/{id}': { get: { operationId: 'getAuditRecord', parameters: [idParameter], responses: { '200': response('AuditRecord', 'Audit record') } } },
    },
    components: { schemas: Object.fromEntries(Object.entries(schemaRegistry).map(([name, schema]) => [
      name, convertSchema(schema, ref, true),
    ])) },
  };
}

/** Additive discovery contract, leaving the frozen eight-path consumer inventory intact. */
export function decisionChainOpenApiDocument(): JsonSchema {
  return {
    openapi: '3.1.0', jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: { title: 'spendkey decision chain discovery', version: SCHEMA_VERSION },
    paths: {
      '/v1/decision-chain': { get: { operationId: 'getDecisionChain',
        description: 'Public configured provider order. Does not disclose credential availability or quota.',
        responses: { '200': response('DecisionChain', 'Configured decision chain'),
          '503': { description: 'Decision configuration unavailable' } } } },
    },
    components: { schemas: Object.fromEntries(['DecisionProviderId', 'DecisionChain'].map((name) => [
      name, convertSchema(schemaRegistry[name]!, ref, true),
    ])) },
  };
}
