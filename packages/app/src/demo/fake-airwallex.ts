import type { Card, CreateCardInput, IssuingTransaction } from '@sk/airwallex';
import { signedDecimalToMinor } from '@sk/ledger';

/** Synthetic sandbox emulator. Every request goes through the real client serializers/parsers. */
export function createFakeAirwallex(options: { now?: () => Date; unconfirmedCreate?: boolean } = {}) {
  const now = options.now ?? (() => new Date());
  const cards = new Map<string, Card>();
  const inputs = new Map<string, CreateCardInput>();
  const transactions: IssuingTransaction[] = [];
  let createCalls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch: typeof globalThis.fetch = async (target, init) => {
    const url = new URL(String(target));
    if (url.origin !== 'https://api-demo.airwallex.com') throw new Error('fake_host_rejected');
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === '/api/v1/authentication/login') return json({ token: 'test-session', expires_at: '2099-01-01T00:00:00.000Z' });
    if (path === '/api/v1/balances/current') return json([{
      currency: 'USD', available_amount: '1000.00', pending_amount: '0.00', reserved_amount: '0.00',
      total_amount: '1000.00', prepayment_amount: '0.00', account_type: 'WALLET',
    }]);
    if (path === '/api/v1/issuing/cardholders/cardholder_test_01') return json({ cardholder_id: 'cardholder_test_01', status: 'ACTIVE' });
    if (path === '/api/v1/issuing/config') return json({ primary_currency: 'USD' });
    if (path === '/api/v1/issuing/cards/create') {
      createCalls++;
      const input = body as unknown as CreateCardInput;
      const existing = [...cards.values()].find(card => card.request_id === input.request_id);
      if (existing) return json(existing);
      const cardId = `card_test_${cards.size + 1}`;
      const card: Card = { card_id: cardId, card_status: 'ACTIVE', card_number: '****0001',
        request_id: input.request_id, nick_name: input.nick_name,
        authorization_controls: input.authorization_controls, created_at: now().toISOString() };
      cards.set(cardId, card); inputs.set(cardId, input);
      // Server-side effect succeeds, but the response has no recoverable card ID.
      return json(options.unconfirmedCreate ? { result: 'created_with_new_shape', token: 'test-session', api_key: 'test-api-key', cvv: 'test-cvv', card_number: 'synthetic-disallowed-field' } : card);
    }
    if (path === '/api/v1/issuing/cards') return json({ items: [...cards.values()], has_more: false });
    const cardRoute = /^\/api\/v1\/issuing\/cards\/([a-zA-Z0-9_-]+)(\/update)?$/.exec(path);
    if (cardRoute) {
      const card = cards.get(cardRoute[1]!);
      if (!card) return json({ code: 'NOT_FOUND' }, 404);
      if (cardRoute[2]) card.card_status = String(body['card_status']);
      return json(card);
    }
    if (path === '/api/v1/simulation/issuing/create') {
      const cardId = String(body['card_id']);
      const card = cards.get(cardId); const input = inputs.get(cardId);
      if (!card || !input) return json({ code: 'NOT_FOUND' }, 404);
      const amount = String(body['transaction_amount']); const currency = String(body['transaction_currency']);
      const mcc = String(body['merchant_category_code']);
      const controls = input.authorization_controls;
      let failure: string | undefined;
      if (card.card_status !== 'ACTIVE') failure = 'CARD_INACTIVE';
      else if (!controls.allowed_currencies.includes(currency)) failure = 'CURRENCY_NOT_ALLOWED';
      else if (!controls.allowed_merchant_categories.includes(mcc)) failure = 'MERCHANT_CATEGORY_NOT_ALLOWED';
      else {
        const approved = transactions.filter(transaction => transaction.card_id === cardId && transaction.status !== 'FAILED');
        if (controls.allowed_transaction_count === 'SINGLE' && approved.length > 0) failure = 'LIMIT_EXCEEDED';
        for (const limit of controls.transaction_limits.limits) {
          const used = approved.filter(transaction => limit.interval !== 'MONTHLY'
            || transaction.transaction_date?.slice(0, 7) === now().toISOString().slice(0, 7))
            .reduce((sum, transaction) => sum + signedDecimalToMinor(transaction.signedAmount, currency), 0);
          const total = signedDecimalToMinor(amount, currency) + (limit.interval === 'PER_TRANSACTION' ? 0 : used);
          if (total > signedDecimalToMinor(String(limit.amount), currency)) failure = 'LIMIT_EXCEEDED';
        }
      }
      const transactionId = `transaction_test_${transactions.length + 1}`;
      transactions.push({ transaction_id: transactionId, card_id: cardId, transaction_amount: amount, signedAmount: amount,
        transaction_currency: currency, transaction_date: now().toISOString(), status: failure ? 'FAILED' : 'SUCCEEDED',
        ...(failure === undefined ? {} : { failure_reason: failure }),
        merchant: { name: 'Synthetic DesignCo', category_code: mcc, extra: {} }, extra: {},
      });
      return json({ process_result: failure ? 'DECLINED' : 'APPROVED', failure_reason: failure ?? null, card_transaction_id: transactionId });
    }
    if (path === '/api/v1/issuing/transactions') return json({ has_more: false, items: transactions.filter(transaction => {
      const at = transaction.transaction_date!;
      return (!url.searchParams.get('card_id') || transaction.card_id === url.searchParams.get('card_id'))
        && (!url.searchParams.get('from_created_at') || at >= url.searchParams.get('from_created_at')!)
        && (!url.searchParams.get('to_created_at') || at <= url.searchParams.get('to_created_at')!);
    }) });
    throw new Error('fake_route_not_implemented');
  };
  return { fetch, cards, inputs, transactions, get createCalls() { return createCalls; } };
}
