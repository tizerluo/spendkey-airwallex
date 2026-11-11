import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { configApiKey, isSandboxUrl } from './config.js';
import type { AirwallexConfig } from './config.js';
import { AirwallexApiError, AirwallexResponseError, AirwallexSafetyError } from './errors.js';
import {
  authorizationControlsInputSchema, balancesSchema, cardholderInputSchema, cardholderSchema,
  cardLimitsSchema, cardSchema, cardStatusSchema, createCardInputSchema, issuingConfigSchema,
  loginSchema, simulationInputSchema, simulationSchema, transactionsSchema,
} from './schemas.js';
import type {
  AuthorizationControls, CardStatus, CreateCardholderInput, CreateCardInput,
  ListTransactionsInput, SimulateAuthorizationInput,
} from './schemas.js';

export interface AirwallexClientOptions {
  fetch: typeof globalThis.fetch;
  /** Injectable clock for deterministic offline token-expiry tests. */
  now?: () => number;
}

/** Stable card idempotency key: reuse this approval's ID across createCard calls. */
export function cardRequestIdFromApproval(approvalId: string): string {
  return `sk-${createHash('sha256').update(approvalId).digest('hex').slice(0, 40)}`;
}

function controlsForRequest(input: AuthorizationControls) {
  const controls = authorizationControlsInputSchema.parse(input);
  return {
    ...controls,
    transaction_limits: {
      ...controls.transaction_limits,
      limits: controls.transaction_limits.limits.map(limit => ({ ...limit, amount: Number(limit.amount) })),
    },
  };
}

/** Defense in depth: card PAN/CVV details paths must never reach fetch. */
export function assertSafeCardPath(path: string): void {
  let decoded = path;
  let stable = false;
  // Bound decoding work, but never inspect a partially decoded path as safe.
  for (let i = 0; i < 16; i++) {
    let next: string;
    try { next = decodeURIComponent(decoded); }
    catch { throw new AirwallexSafetyError('Invalid API path'); }
    if (next === decoded) {
      stable = true;
      break;
    }
    decoded = next;
  }
  if (!stable || decoded.includes('%')) throw new AirwallexSafetyError('Invalid API path');
  decoded = decoded.replaceAll('\\', '/').toLowerCase();
  if (/\/issuing\/cards(?:\/|$)/.test(decoded) && decoded.includes('/details')) {
    throw new AirwallexSafetyError('Card details access is forbidden');
  }
}

export class AirwallexClient {
  #config: AirwallexConfig;
  #apiKey: string;
  #fetch: typeof globalThis.fetch;
  #now: () => number;
  #session: { token: string; expiresAt: number } | undefined;
  /** Retain the most recently replaced or invalidated token for error redaction. */
  #lastToken: string | undefined;
  #loginPromise: Promise<string> | undefined;

  constructor(config: AirwallexConfig, options: AirwallexClientOptions) {
    this.#apiKey = configApiKey(config);
    this.#config = config;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
  }

  #redact(value: string): string {
    let result = value;
    for (const secret of [this.#apiKey, this.#config.clientId, this.#session?.token, this.#lastToken]) {
      if (secret) result = result.replaceAll(secret, '[redacted]');
    }
    return result;
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    assertSafeCardPath(path);
    try {
      // Never follow a redirect carrying credentials to a different destination.
      return await this.#fetch(`${this.#config.baseUrl}${path}`, { ...init, redirect: 'error' });
    } catch {
      throw new AirwallexApiError(0, 'NETWORK_ERROR', 'Airwallex request failed');
    }
  }

  async #read<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try { body = await response.json(); }
    catch {
      if (!response.ok) throw new AirwallexApiError(response.status, 'UNKNOWN', 'Airwallex API request failed');
      throw new AirwallexResponseError();
    }
    if (!response.ok) {
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
      throw new AirwallexApiError(
        response.status,
        typeof record['code'] === 'string' ? this.#redact(record['code']) : 'UNKNOWN',
        typeof record['message'] === 'string' ? this.#redact(record['message']) : 'Airwallex API request failed',
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AirwallexResponseError();
    return parsed.data;
  }

  async #login(): Promise<string> {
    const response = await this.#send('/api/v1/authentication/login', {
      method: 'POST', headers: { 'x-client-id': this.#config.clientId, 'x-api-key': this.#apiKey },
    });
    const result = await this.#read(response, loginSchema);
    this.#lastToken = this.#session?.token ?? this.#lastToken;
    this.#session = { token: result.token, expiresAt: Date.parse(result.expires_at) };
    return result.token;
  }

  #token(): Promise<string> {
    if (this.#loginPromise) return this.#loginPromise;
    if (this.#session && this.#now() < this.#session.expiresAt - 60_000) {
      return Promise.resolve(this.#session.token);
    }
    this.#loginPromise = this.#login().finally(() => { this.#loginPromise = undefined; });
    return this.#loginPromise;
  }

  async #request<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    assertSafeCardPath(path);
    let token = await this.#token();
    const send = () => this.#send(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let response = await send();
    if (response.status === 401) {
      // A delayed 401 for an old token must not discard a newer session.
      if (this.#session?.token === token) {
        this.#lastToken = token;
        this.#session = undefined;
      }
      token = await this.#token();
      response = await send();
    }
    return this.#read(response, schema);
  }

  #cardPath(id: string, suffix = ''): string {
    const path = `/api/v1/issuing/cards/${id}${suffix}`;
    assertSafeCardPath(path);
    this.#checkId(id);
    return path;
  }

  #checkId(id: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new AirwallexSafetyError('Invalid resource ID');
  }

  getBalances() { return this.#request('GET', '/api/v1/balances/current', balancesSchema); }
  getIssuingConfig() { return this.#request('GET', '/api/v1/issuing/config', issuingConfigSchema); }
  createCardholder(input: CreateCardholderInput) {
    return this.#request('POST', '/api/v1/issuing/cardholders/create', cardholderSchema, cardholderInputSchema.parse(input));
  }
  getCardholder(id: string) {
    this.#checkId(id);
    return this.#request('GET', `/api/v1/issuing/cardholders/${id}`, cardholderSchema);
  }
  /** Callers must pass a stable request_id (see cardRequestIdFromApproval) for retries across calls. */
  createCard(input: CreateCardInput) {
    const body = createCardInputSchema.parse(input);
    return this.#request('POST', '/api/v1/issuing/cards/create', cardSchema, {
      ...body, request_id: body.request_id ?? randomUUID(),
      authorization_controls: controlsForRequest(body.authorization_controls),
    });
  }
  getCard(id: string) { return this.#request('GET', this.#cardPath(id), cardSchema); }
  getCardLimits(id: string) { return this.#request('GET', this.#cardPath(id, '/limits'), cardLimitsSchema); }

  updateCardStatus(id: string, status: 'ACTIVE' | 'INACTIVE', options?: { irreversible?: boolean }): ReturnType<AirwallexClient['getCard']>;
  updateCardStatus(id: string, status: 'CLOSED', options: { irreversible: true }): ReturnType<AirwallexClient['getCard']>;
  updateCardStatus(id: string, status: CardStatus, options?: { irreversible?: boolean }) {
    cardStatusSchema.parse(status);
    if (status === 'CLOSED' && options?.irreversible !== true) {
      throw new AirwallexSafetyError('Closing a card requires irreversible: true');
    }
    return this.#request('POST', this.#cardPath(id, '/update'), cardSchema, { card_status: status });
  }
  freezeCard(id: string) { return this.updateCardStatus(id, 'INACTIVE'); }
  unfreezeCard(id: string) { return this.updateCardStatus(id, 'ACTIVE'); }
  updateCardControls(id: string, authorizationControls: AuthorizationControls) {
    return this.#request('POST', this.#cardPath(id, '/update'), cardSchema, {
      authorization_controls: controlsForRequest(authorizationControls),
    });
  }
  listTransactions(input: ListTransactionsInput = {}) {
    const query = new URLSearchParams();
    const queryNames = { card_id: 'card_id', from: 'from_created_at', to: 'to_created_at' } as const;
    for (const key of ['card_id', 'from', 'to'] as const) {
      const value = input[key];
      if (value !== undefined) query.set(queryNames[key], value);
    }
    if (input.page !== undefined) {
      if (!Number.isSafeInteger(input.page) || input.page < 0) throw new AirwallexSafetyError('Invalid transaction page');
      query.set('page_num', String(input.page));
    }
    const suffix = query.size ? `?${query.toString()}` : '';
    return this.#request('GET', `/api/v1/issuing/transactions${suffix}`, transactionsSchema);
  }
  simulateAuthorization(input: SimulateAuthorizationInput) {
    if (!isSandboxUrl(this.#config.baseUrl)) throw new AirwallexSafetyError('Simulation requires the sandbox host');
    const body = simulationInputSchema.parse(input);
    return this.#request('POST', '/api/v1/simulation/issuing/create', simulationSchema, {
      ...body, transaction_amount: Number(body.transaction_amount),
    });
  }
}
