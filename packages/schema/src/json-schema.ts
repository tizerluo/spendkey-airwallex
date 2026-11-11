import { z } from 'zod';
import * as contracts from './index.js';

/** Draft-07 is also an explicit, supported dialect in our OpenAPI 3.1 document. */
export const JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';
export type JsonSchema = Record<string, unknown>;

export const schemaRegistry: Record<string, z.ZodTypeAny> = Object.fromEntries(
  Object.entries(contracts as Record<string, unknown>)
    .filter((entry): entry is [string, z.ZodTypeAny] => entry[0].endsWith('Schema') && entry[1] instanceof z.ZodType)
    .map(([name, schema]) => [name.slice(0, -6), schema])
    .sort(([left], [right]) => String(left).localeCompare(String(right), 'en')),
);
const names = new Map(Object.entries(schemaRegistry).map(([name, schema]) => [schema, name]));

/** Only the constructs used by the pinned contracts are supported; never silently drop a check. */
export function convertSchema(schema: z.ZodTypeAny, reference: (name: string) => JsonSchema, inline = false): JsonSchema {
  const name = names.get(schema);
  if (name && !inline) return reference(name);
  if (schema instanceof z.ZodOptional) return convertSchema(schema.unwrap(), reference);
  if (schema instanceof z.ZodUnknown) return {};
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodLiteral) return { type: typeof schema.value, const: schema.value };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodString) {
    if (schema._def.coerce) throw new Error('String coercion has no JSON Schema equivalent');
    const result: JsonSchema = { type: 'string' };
    const patterns: string[] = [];
    for (const check of schema._def.checks) {
      switch (check.kind) {
        case 'min': result.minLength = check.value; break;
        case 'max': result.maxLength = check.value; break;
        case 'url': result.format = 'uri'; break;
        case 'datetime':
          result.format = 'date-time';
          patterns.push(z.datetimeRegex(check).source);
          break;
        case 'regex': {
          // JSON Schema patterns cannot carry flags; expand the HTTP(S) schemes explicitly.
          if (check.regex.flags === 'i' && check.regex.source === '^https?:\\/\\/') {
            patterns.push('^[hH][tT][tT][pP][sS]?://');
          } else if (check.regex.flags === 'i' && check.regex.source === '^https:\\/\\/') {
            patterns.push('^[hH][tT][tT][pP][sS]://');
          } else {
            if (check.regex.flags) throw new Error(`Unsupported regex flags: ${check.regex.flags}`);
            patterns.push(check.regex.source);
          }
          break;
        }
        default: throw new Error(`Unsupported string check: ${check.kind}`);
      }
    }
    if (patterns.length === 1) result.pattern = patterns[0];
    else if (patterns.length > 1) result.allOf = patterns.map(pattern => ({ pattern }));
    return result;
  }
  if (schema instanceof z.ZodNumber) {
    if (schema._def.coerce) throw new Error('Number coercion has no JSON Schema equivalent');
    const result: JsonSchema = { type: 'number' };
    for (const check of schema._def.checks) {
      switch (check.kind) {
        case 'int': result.type = 'integer'; break;
        case 'min': result[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value; break;
        case 'max': result[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value; break;
        case 'finite': break; // JSON numbers are finite.
        default: throw new Error(`Unsupported number check: ${check.kind}`);
      }
    }
    return result;
  }
  if (schema instanceof z.ZodArray) {
    if (schema._def.exactLength) throw new Error('Unsupported exact array length check');
    return {
      type: 'array', items: convertSchema(schema.element, reference),
      ...(schema._def.minLength ? { minItems: schema._def.minLength.value } : {}),
      ...(schema._def.maxLength ? { maxItems: schema._def.maxLength.value } : {}),
    };
  }
  if (schema instanceof z.ZodObject) {
    if (schema._def.unknownKeys !== 'strict' || !(schema._def.catchall instanceof z.ZodNever)) {
      throw new Error('Only strict objects without catchalls are supported');
    }
    const shape: Record<string, z.ZodTypeAny> = schema.shape;
    const required = Object.entries(shape).filter(([, child]) => !child.isOptional()).map(([key]) => key);
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, convertSchema(child, reference)])),
      ...(required.length ? { required } : {}), additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodRecord) {
    if (!(schema.keySchema instanceof z.ZodString) || schema.keySchema._def.checks.length) {
      throw new Error('Only unconstrained string record keys are supported');
    }
    return { type: 'object', additionalProperties: convertSchema(schema.valueSchema, reference) };
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema.options.map((option: z.ZodTypeAny) => convertSchema(option, reference)) };
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return { oneOf: schema.options.map((option: z.ZodTypeAny) => convertSchema(option, reference)) };
  }
  if (schema instanceof z.ZodEffects) {
    if (schema._def.effect.type !== 'refinement') throw new Error('Transforms/preprocessors are not JSON contracts');
    const base = convertSchema(schema.innerType(), reference);
    if (schema === contracts.CallSpecSchema) {
      return { ...base, allOf: [
        { if: { required: ['body'] }, then: { required: ['bodyHash'] } },
      ] };
    }
    if (schema === contracts.PaymentPlanSchema) {
      return { ...base, allOf: [
        { if: { properties: { action: { const: 'pay' } }, required: ['action'] }, then: { required: ['steps'] }, else: { not: { required: ['steps'] } } },
        { if: { properties: { action: { const: 'ask' } }, required: ['action'] }, then: {
          required: ['approval'], properties: { approval: { properties: { required: { const: true } }, required: ['required'] } },
        }, else: { not: { required: ['approval'] } } },
        // Bounded tuple checks express fallbackOf < the current step index.
        { properties: { steps: { items: Array.from({ length: 10 }, (_, index) => ({
          properties: { fallbackOf: index === 0 ? false : { type: 'integer', minimum: 0, maximum: index - 1 } },
        })) } } },
      ] };
    }
    if (schema === contracts.CatalogItemSchema) {
      return { ...base, allOf: [
        { if: { properties: { price: { properties: { network: { const: 'eip155:42220' } }, required: ['network'] } }, required: ['price'] },
          then: { properties: { celo: { const: true } } }, else: { properties: { celo: { const: false }, scoreable: { const: false } } } },
      ] };
    }
    throw new Error(`Unmapped refinement: ${name ?? schema._def.typeName}`);
  }
  throw new Error(`Unsupported Zod construct: ${schema._def.typeName}`);
}

export function standaloneSchema(name: string): JsonSchema {
  const schema = schemaRegistry[name];
  if (!schema) throw new Error(`Unknown schema: ${name}`);
  const pending = new Set<string>();
  const definitions: Record<string, JsonSchema> = {};
  const reference = (target: string): JsonSchema => {
    pending.add(target);
    return { $ref: `#/definitions/${target}` };
  };
  const root = convertSchema(schema, reference, true);
  for (const target of pending) {
    const dependency = schemaRegistry[target];
    if (!dependency) throw new Error(`Unknown dependency: ${target}`);
    definitions[target] = convertSchema(dependency, reference, true);
  }
  return {
    $schema: JSON_SCHEMA_DIALECT, $id: `urn:sr:schema:${contracts.SCHEMA_VERSION}:${name}`, title: name,
    ...root, ...(pending.size ? { definitions } : {}),
  };
}
