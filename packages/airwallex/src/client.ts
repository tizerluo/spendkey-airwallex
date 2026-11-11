import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { configApiKey } from './config.js';
import type { AirwallexConfig } from './config.js';
import { AirwallexApiError, AirwallexResponseError, AirwallexSafetyError } from './errors.js';
import { redactBody } from './redact.js';
import {
  authorizationControlsInputSchema, balancesSchema, cardholderInputSchema, cardholderSchema,
  cardLimitsSchema, cardSchema, cardStatusSchema, createCardInputSchema, issuingConfigSchema,
  loginSchema, simulationInputSchema, simulationSchema, transactionsSchema,
  cardsPageSchema, CARD_NICKNAME_MAX_LENGTH, cardNicknameFromRequestId, parseCardLenient,
} from './schemas.js';
import type {
  AuthorizationControls, CardStatus, CreateCardholderInput, CreateCardInput,
  CardsResponse, CreateCardResult, ListCardsInput, ListTransactionsInput, SimulateAuthorizationInput,
} from './schemas.js';

export interface AirwallexClientOptions {
  fetch: typeof globalThis.fetch;
  /** Injectable clock for deterministic offline token-expiry tests. */
  now?: () => number;
}

/** Stable card idempotency key: reuse this approval's ID across createCard calls. */
export function cardRequestIdFromApproval(approvalId: string): string {
  return `spk_${createHash('sha256').update(approvalId).digest('hex').slice(0, 40)}`;
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

  async #read<T>(response: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
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
    // Schemas redact unknown data; additionally scrub credential echoes in diagnostics.
    const scrubDiagnostics = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'extra' || key === 'unparsed') {
          (value as Record<string, unknown>)[key] = redactBody(item, text => this.#redact(text));
        } else scrubDiagnostics(item);
      }
    };
    scrubDiagnostics(parsed.data);
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

  async #requestResponse(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
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
    return response;
  }

  async #request<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body?: unknown): Promise<T> {
    return this.#read(await this.#requestResponse(method, path, body), schema);
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
    return this.#createCard({
      ...body,
      authorization_controls: controlsForRequest(body.authorization_controls),
    });
  }

  async #createCard(body: unknown): Promise<CreateCardResult> {
    const response = await this.#requestResponse('POST', '/api/v1/issuing/cards/create', body);
    if (!response.ok) {
      await this.#read(response, cardSchema);
      throw new AirwallexResponseError();
    }
    let received: unknown;
    try {
      const text = await response.text();
      try { received = JSON.parse(text) as unknown; }
      catch { received = text; }
    } catch { received = { bodyReadFailed: true }; }
    const raw = redactBody(received, text => this.#redact(text));
    const strict = cardSchema.safeParse(received);
    if (strict.success) return { ok: true, unconfirmed: false, card: strict.data, raw };
    const card = parseCardLenient(received);
    return { ok: true, unconfirmed: true, ...(card === undefined ? {} : { card }), raw };
  }

  /** Collect every page; malformed individual cards remain available as redacted diagnostics. */
  async listCards(input: ListCardsInput = {}): Promise<CardsResponse> {
    const pageSize = input.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 10 || pageSize > 200) throw new AirwallexSafetyError('Invalid card page size');
    const query = new URLSearchParams({ page_size: String(pageSize) });
    const names = { cardholderId: 'cardholder_id', createdAfter: 'from_created_at', createdBefore: 'to_created_at',
      updatedAfter: 'from_updated_at', updatedBefore: 'to_updated_at', status: 'card_status', nickName: 'nick_name' } as const;
    for (const key of Object.keys(names) as (keyof typeof names)[]) {
      if (input[key] !== undefined) query.set(names[key], input[key]);
    }
    const result: CardsResponse = { items: [], unparsed: [] };
    // 硬上限：服务端一直声称还有下一页时必须停，不能无限翻页。
    const maxPages = 200;
    for (let page = 0; page < maxPages; page++) {
      query.set('page_num', String(page));
      const response = await this.#request('GET', `/api/v1/issuing/cards?${query.toString()}`, cardsPageSchema);
      for (const item of response.items) {
        const card = parseCardLenient(item);
        if (card) result.items.push(card);
        else result.unparsed.push(redactBody(item, text => this.#redact(text)));
      }
      const fullPage = response.items.length >= pageSize;
      const more = response.has_more === true || (response.has_more === undefined && fullPage);
      if (!more || response.items.length === 0) return result;
    }
    throw new AirwallexSafetyError('Card list page cap exceeded');
  }

  async findCardByRequestId(requestId: string, input: Pick<ListCardsInput, 'cardholderId' | 'createdAfter'> = {}) {
    const cards = await this.listCards({ ...input,
      ...(input.createdAfter === undefined ? {} : { createdBefore: new Date(this.#now()).toISOString() }),
    });
    const explicit = cards.items.find(card => card.request_id === requestId);
    if (explicit) return explicit;
    // 昵称会被截到 50 字符。截断后不同 requestId 会撞车，这时只认明确的 request_id。
    if (`spk ${requestId}`.length > CARD_NICKNAME_MAX_LENGTH) return undefined;
    return cards.items.find(card => card.request_id === undefined && card.nick_name === cardNicknameFromRequestId(requestId));
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
    const body = simulationInputSchema.parse(input);
    return this.#request('POST', '/api/v1/simulation/issuing/create', simulationSchema, {
      ...body, transaction_amount: Number(body.transaction_amount),
    });
  }
}
