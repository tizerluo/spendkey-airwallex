import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ISSUING_EVENT_NAMES, parseWebhookEvent, verifyWebhookSignature } from './index.js';

const nowMs = Date.parse('2030-01-01T00:00:00Z');
const secret = 'test-secret';
const rawBody = '{ "id":"event_test_01", "name":"issuing.card.inactive", "account_id":"account_test_01", "data":{"id":"card_test_01"}, "created_at":"2030-01-01T00:00:00Z" }';
function sign(timestamp: string, body: string | Uint8Array = rawBody) {
  return createHmac('sha256', secret).update(timestamp).update(body).digest('hex');
}
function verify(timestamp: string, options: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) {
  return verifyWebhookSignature({ rawBody, timestamp, signature: sign(timestamp), secret, nowMs, ...options });
}

describe('webhook signature', () => {
  it('accepts a valid millisecond signature without changing the raw body', () => {
    expect(verify(String(nowMs))).toBe(true);
    expect(verify(String(nowMs), { signature: sign(String(nowMs)).toUpperCase() })).toBe(true);
    expect(verify(String(nowMs), { rawBody: JSON.stringify(JSON.parse(rawBody)) })).toBe(false);
  });

  it('accepts clearly second timestamps using their original spelling in the HMAC', () => {
    expect(verify(String(nowMs / 1000))).toBe(true);
  });

  it('supports the original raw bytes', () => {
    const bytes = Buffer.from(rawBody, 'utf8');
    expect(verify(String(nowMs), { rawBody: bytes, signature: sign(String(nowMs), bytes) })).toBe(true);
  });

  it.each(['0'.repeat(64), '00', '', 'a'.repeat(66), 'z'.repeat(64), '0'.repeat(63)])('rejects invalid or wrong-length signature #%#', signature => {
    expect(verify(String(nowMs), { signature })).toBe(false);
  });

  it('rejects a different secret', () => {
    expect(verify(String(nowMs), { secret: 'other-test-secret' })).toBe(false);
  });

  it.each([-300_001, 300_001, -600_000, 600_000])('rejects stale or future timestamps offset by %s ms', offset => {
    expect(verify(String(nowMs + offset))).toBe(false);
  });

  it.each([-300_000, 300_000])('accepts the tolerance boundary at %s ms', offset => {
    expect(verify(String(nowMs + offset))).toBe(true);
  });

  it('honors a custom tolerance, including zero', () => {
    expect(verify(String(nowMs - 100), { toleranceMs: 99 })).toBe(false);
    expect(verify(String(nowMs), { toleranceMs: 0 })).toBe(true);
    expect(verify(String(nowMs - 1), { toleranceMs: 0 })).toBe(false);
  });

  it.each(['NaN', 'Infinity', '', '-1', '1.5', '2030-01-01', '1e12'])('rejects malformed timestamp %s even if signed', timestamp => {
    expect(verify(timestamp)).toBe(false);
  });

  it('rejects invalid clock and tolerance values', () => {
    expect(verify(String(nowMs), { nowMs: NaN })).toBe(false);
    expect(verify(String(nowMs), { toleranceMs: -1 })).toBe(false);
    expect(verify(String(nowMs), { toleranceMs: Infinity })).toBe(false);
  });
});

describe('webhook parsing', () => {
  it('parses signed event envelopes and preserves event data', () => {
    expect(parseWebhookEvent(rawBody)).toEqual({
      id: 'event_test_01', name: 'issuing.card.inactive', account_id: 'account_test_01',
      data: { id: 'card_test_01' }, created_at: '2030-01-01T00:00:00Z',
    });
    expect(parseWebhookEvent(Buffer.from(rawBody))).toEqual(parseWebhookEvent(rawBody));
  });

  it('accepts an absent account_id and new event names', () => {
    expect(parseWebhookEvent(JSON.stringify({ id: 'event_test_02', name: 'future.event', data: {}, created_at: '2030-01-01T00:00:00Z' }))).not.toHaveProperty('account_id');
  });

  it.each(['not json', '{}', '{"id":1}', '{"id":"event_test","name":"test","data":{},"created_at":"invalid"}'])('rejects malformed events #%#', input => {
    expect(() => parseWebhookEvent(input)).toThrow();
  });

  it('exports the required issuing card and transaction subscriptions', () => {
    expect(ISSUING_EVENT_NAMES).toEqual(expect.arrayContaining([
      'issuing.card.active', 'issuing.card.inactive', 'issuing.card.closed', 'issuing.card.modified',
      'issuing.card.low_remaining_transaction_limit', 'issuing.transaction.succeeded', 'issuing.transaction.failed',
    ]));
  });
});
