import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface VerifyWebhookSignatureInput {
  rawBody: string | Uint8Array;
  timestamp: string;
  signature: string;
  secret: string;
  nowMs?: number;
  toleranceMs?: number;
}

/** HMAC uses the original timestamp spelling and raw body bytes, before JSON parsing. */
export function verifyWebhookSignature({
  rawBody, timestamp, signature, secret, nowMs = Date.now(), toleranceMs = 300_000,
}: VerifyWebhookSignatureInput): boolean {
  const expected = createHmac('sha256', secret).update(timestamp).update(rawBody).digest();
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const received = Buffer.from(signature, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) return false;
  if (!/^\d{1,13}$/.test(timestamp) || !Number.isFinite(nowMs) || !Number.isFinite(toleranceMs) || toleranceMs < 0) return false;
  // Contemporary seconds epochs have <=10 digits; milliseconds have 13.
  const timestampMs = Number(timestamp) * (timestamp.length <= 10 ? 1_000 : 1);
  return Math.abs(nowMs - timestampMs) <= toleranceMs;
}

/** Subscriptions of interest; parsing also accepts new event names for forward compatibility. */
export const ISSUING_EVENT_NAMES = [
  'issuing.card.active', 'issuing.card.inactive', 'issuing.card.closed', 'issuing.card.modified',
  'issuing.card.low_remaining_transaction_limit', 'issuing.transaction.succeeded', 'issuing.transaction.failed',
] as const;
export type IssuingEventName = typeof ISSUING_EVENT_NAMES[number];
export const webhookEventSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), account_id: z.string().optional(),
  data: z.record(z.unknown()), created_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/** Call only after verifying the signature against this exact raw body. */
export function parseWebhookEvent(rawBody: string | Uint8Array): WebhookEvent {
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  return webhookEventSchema.parse(JSON.parse(text));
}
