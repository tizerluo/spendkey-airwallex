import { AirwallexClient, type AirwallexConfig, type Card } from '@sk/airwallex';
import { z } from 'zod';

const readbacks = new WeakMap<AirwallexClient, Map<string, Record<string, unknown>>>();
const object = z.record(z.unknown());

/**
 * Keep getCard metadata validation in the provider client. Controls are evidence,
 * validated as an object here and compared against sent keys by the service.
 * The provider's stricter controls schema would strip extras or reject missing
 * sent keys before we could record a controls_readback mismatch.
 */
export function createAppAirwallexClient(config: AirwallexConfig, fetch: typeof globalThis.fetch): AirwallexClient {
  const controls = new Map<string, Record<string, unknown>>();
  const client = new AirwallexClient(config, { fetch: async (target, init) => {
    const response = await fetch(target, init);
    const route = /^\/api\/v1\/issuing\/cards\/([a-zA-Z0-9_-]+)$/.exec(new URL(String(target)).pathname);
    if (!route || init?.method !== 'GET' || !response.ok) return response;
    let received: unknown;
    try { received = await response.clone().json(); } catch { return response; }
    const parsed = object.safeParse(received);
    if (!parsed.success) return response;
    const { authorization_controls: raw, ...metadata } = parsed.data;
    const readback = object.safeParse(raw);
    controls.set(route[1]!, readback.success ? readback.data : {});
    // Only the metadata is parsed by cardSchema; never retain a raw card/PAN body.
    return new Response(JSON.stringify(metadata), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  } });
  readbacks.set(client, controls);
  return client;
}

export function cardControlsReadback(client: AirwallexClient, card: Card): Record<string, unknown> {
  return readbacks.get(client)?.get(card.card_id) ?? card.authorization_controls ?? {};
}
