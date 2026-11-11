import { DecisionSchema, GuardResultSchema, mockGuardReq, mockGuardResult, type Decision, type Probs } from '@sr/schema';
import { describe, expect, it } from 'vitest';
import { budgetWindow, InMemoryBudgetStore, type BudgetSnapshot } from '../budget/index.js';
import { evaluateGuard, evaluateHardRules, spendCapToAtomic, synthesize, type HardRulePolicy, type HardRuleRequest } from '../index.js';

const asset = mockGuardReq.quote.asset;
const policy: HardRulePolicy = { allowedTokens: [{ asset, decimals: 6 }] };
const request: HardRuleRequest = { ...mockGuardReq, quote: { ...mockGuardReq.quote } };
const budget: BudgetSnapshot = {
  scope: 'wallet', id: request.payer, asset, windowMs: 1000,
  windowStartMs: 0, windowEndMs: 1000, limitAtomic: '10000', spentAtomic: '5000', calls: 1,
};

describe('hard rules', () => {
  const cases: { name: string; req?: Partial<HardRuleRequest>; quote?: Partial<HardRuleRequest['quote']>; policy?: Partial<HardRulePolicy>; reason?: string }[] = [
    { name: 'allows a valid Celo quote' },
    { name: 'accepts the v1 Celo alias', quote: { network: 'celo' } },
    { name: 'accepts alias in chain policy', policy: { allowedChains: ['celo'] } },
    { name: 'denies an empty chain allowlist', policy: { allowedChains: [] }, reason: 'chain_not_allowed' },
    { name: 'rejects another chain', quote: { network: 'eip155:1' }, reason: 'chain_not_allowed' },
    { name: 'cannot enable another chain accidentally', quote: { network: 'eip155:1' }, policy: { allowedChains: ['eip155:1'] }, reason: 'chain_not_allowed' },
    { name: 'denies an empty token allowlist', policy: { allowedTokens: [] }, reason: 'token_not_allowed' },
    { name: 'rejects an unknown asset', quote: { asset: '0x' + '3'.repeat(40) }, reason: 'token_not_allowed' },
    { name: 'compares address casing', quote: { asset: '0x' + 'a'.repeat(40) }, policy: { allowedTokens: [{ asset: '0x' + 'A'.repeat(40), decimals: 6 }] } },
    { name: 'allows exact maxSpend', req: { maxSpend: '0.005' } },
    { name: 'rejects maxSpend overrun', req: { maxSpend: '0.004999' }, reason: 'max_spend_exceeded' },
    { name: 'floors a subatomic cap', req: { maxSpend: '0.00499999' }, reason: 'max_spend_exceeded' },
    { name: 'allows an exact policy cap', policy: { maxSpend: '0.005' } },
    { name: 'rejects policy cap overrun', policy: { maxSpend: '0.004' }, reason: 'policy_max_spend_exceeded' },
    { name: 'zero cap denies a paid call', req: { maxSpend: '0' }, reason: 'max_spend_exceeded' },
    { name: 'zero cost fits zero cap', req: { maxSpend: '0' }, quote: { amountAtomic: '0' } },
    { name: 'rejects malformed request cap', req: { maxSpend: 'NaN' }, reason: 'invalid_spend_cap' },
    { name: 'rejects malformed policy cap', policy: { maxSpend: '-1' }, reason: 'invalid_spend_cap' },
    { name: 'rejects invalid token precision', policy: { allowedTokens: [{ asset, decimals: -1 }] }, reason: 'invalid_spend_cap' },
    { name: 'rejects conflicting token entries', policy: { allowedTokens: [{ asset, decimals: 6 }, { asset, decimals: 18 }] }, reason: 'invalid_spend_cap' },
    { name: 'rejects a blacklisted recipient', policy: { blacklistedPayTo: [request.quote.payTo] }, reason: 'recipient_blacklisted' },
    { name: 'accepts a different recipient', policy: { blacklistedPayTo: [request.payer] } },
    { name: 'rejects exact host', policy: { blacklistedHosts: ['MOCK.EXAMPLE'] }, reason: 'host_blacklisted' },
    { name: 'rejects child host', req: { url: 'https://api.mock.example/path' }, policy: { blacklistedHosts: ['mock.example'] }, reason: 'host_blacklisted' },
    { name: 'rejects a trailing-dot hostname', req: { url: 'https://mock.example./path' }, policy: { blacklistedHosts: ['mock.example'] }, reason: 'host_blacklisted' },
    { name: 'normalizes a trailing dot in host policy', policy: { blacklistedHosts: ['MOCK.EXAMPLE.'] }, reason: 'host_blacklisted' },
    { name: 'does not blacklist a suffix lookalike', req: { url: 'https://notmock.example/path' }, policy: { blacklistedHosts: ['mock.example'] } },
    { name: 'rejects forbidden category', req: { category: 'Personal-Contact' }, policy: { forbiddenCategories: ['personal-contact'] }, reason: 'category_forbidden' },
    { name: 'normalizes category whitespace', req: { category: ' personal-contact ' }, policy: { forbiddenCategories: ['personal-contact'] }, reason: 'category_forbidden' },
    { name: 'requires category when restrictions exist', policy: { forbiddenCategories: ['personal-contact'] }, reason: 'category_required' },
    { name: 'accepts an allowed category', req: { category: 'work-contact' }, policy: { forbiddenCategories: ['personal-contact'] } },
    { name: 'requires merchant Self proof', req: { requiresSelf: true }, reason: 'self_proof_required' },
    { name: 'requires policy Self proof', policy: { requireSelfProof: true }, reason: 'self_proof_required' },
    { name: 'false proof cannot satisfy requirement', req: { requiresSelf: true, selfProofVerified: false }, reason: 'self_proof_required' },
    { name: 'accepts verified Self proof', req: { requiresSelf: true, selfProofVerified: true }, policy: { requireSelfProof: true } },
    { name: 'allows exact remaining budget', policy: { budgets: [budget] } },
    { name: 'rejects budget overrun', policy: { budgets: [{ ...budget, spentAtomic: '5001' }] }, reason: 'budget_exceeded:wallet' },
    { name: 'rejects exhausted call allowance', policy: { budgets: [{ ...budget, maxCalls: 1 }] }, reason: 'budget_calls_exceeded:wallet' },
    { name: 'rejects mismatched asset snapshot', policy: { budgets: [{ ...budget, asset: request.quote.payTo }] }, reason: 'invalid_budget' },
    { name: 'rejects mismatched payer snapshot', policy: { budgets: [{ ...budget, id: request.quote.payTo }] }, reason: 'invalid_budget' },
    { name: 'rejects corrupt budget accounting', policy: { budgets: [{ ...budget, spentAtomic: '-1' }] }, reason: 'invalid_budget' },
    { name: 'rejects malformed quote amount', quote: { amountAtomic: '0.5' }, reason: 'invalid_request' },
    { name: 'rejects insecure URL', req: { url: 'http://mock.example' }, reason: 'invalid_request' },
    { name: 'rejects URL credentials', req: { url: 'https://user:pass@mock.example' }, reason: 'invalid_request' },
    { name: 'rejects malformed payer', req: { payer: 'not-an-address' }, reason: 'invalid_request' },
  ];
  it.each(cases)('$name', ({ req, quote, policy: override, reason }) => {
    const input = { ...request, ...req, quote: { ...request.quote, ...quote } };
    const decision = evaluateHardRules(input, { ...policy, ...override });
    expect(decision.action).toBe(reason ? 'refuse' : 'pay');
    expect(decision.reasons).toContain(reason ?? 'hard_rules_passed');
    expect(decision.maxAmountAtomic).toBe(reason ? '0' : input.quote.amountAtomic);
    const { maxAmountAtomic: cap, ...schemaDecision } = decision;
    expect(DecisionSchema.parse(schemaDecision)).toEqual(schemaDecision);
    expect(cap).toMatch(/^\d+$/);
  });

  it('collects every applicable veto without mutating inputs', () => {
    const input = structuredClone(request);
    const rules: HardRulePolicy = { ...policy, requireSelfProof: true, maxSpend: '0.001', blacklistedPayTo: [request.quote.payTo], budgets: [{ ...budget, limitAtomic: '1' }] };
    const before = structuredClone({ input, rules });
    expect(evaluateHardRules(input, rules).reasons).toEqual(['policy_max_spend_exceeded', 'recipient_blacklisted', 'self_proof_required', 'budget_exceeded:wallet']);
    expect({ input, rules }).toEqual(before);
  });

  it('keeps amounts above 2^53 exact', () => {
    const quote = { ...request.quote, amountAtomic: '9007199254740993' };
    const input = { ...request, quote, maxSpend: '9007199254.740992' };
    expect(evaluateHardRules(input, policy).action).toBe('refuse');
    expect(evaluateHardRules({ ...input, maxSpend: '9007199254.740993' }, policy).action).toBe('pay');
  });

  const hostCases = ['bücher.example', 'xn--bcher-kva.example', 'BÜCHER.Example.', 'XN--BCHER-KVA.EXAMPLE.']
    .flatMap((entry) => ['bücher.example', 'xn--bcher-kva.example', 'BÜCHER.Example.', 'XN--BCHER-KVA.EXAMPLE.',
      'api.bücher.example', 'api.xn--bcher-kva.example', 'API.BÜCHER.Example.', 'API.XN--BCHER-KVA.EXAMPLE.']
      .map((host) => ({ entry, host })));
  it.each(hostCases)('blacklists $host using $entry', ({ entry, host }) => {
    const input = { ...request, url: `https://${host}/resource` };
    const rules = { ...policy, blacklistedHosts: [entry] };
    expect(evaluateHardRules(input, rules)).toMatchObject({ action: 'refuse', reasons: ['host_blacklisted'], maxAmountAtomic: '0' });
    expect(evaluateGuard(input, rules, { spend: 1 }).action).toBe('refuse');
  });

  it.each(['', ' ', 'bücher.example ', 'https://bücher.example', 'bücher.example/path', 'bücher.example?x',
    'bücher.example#x', 'user@bücher.example', 'bücher.example:443', 'bücher.example\\path',
    '%62ücher.example', '.', 'bücher..example', 'bücher.example..', '-invalid.example', 'invalid-.example',
    'bad_host.example', 'xn--.example', '[invalid]', 'a'.repeat(64) + '.example'])('fails closed on invalid blacklist entry %s', (entry) => {
    // Validate every entry even when another entry already matches the request.
    for (const entries of [[entry], ['mock.example', entry]]) {
      const decision = evaluateHardRules(request, { ...policy, blacklistedHosts: entries });
      expect(decision.action).toBe('refuse');
      expect(decision.maxAmountAtomic).toBe('0');
      expect(decision.reasons).toContain('invalid_host_blacklist');
    }
  });

  it.each(['notbücher.example', 'bücher.example.attacker.example'])('allows Unicode suffix lookalike %s', (host) => {
    expect(evaluateHardRules({ ...request, url: `https://${host}/` }, { ...policy, blacklistedHosts: ['bücher.example'] }).action).toBe('pay');
  });
});

describe('probability synthesis', () => {
  it.each([
    [0, 'refuse'], [0.399999999, 'refuse'], [0.4, 'ask'], [0.699999999, 'ask'], [0.7, 'pay'], [1, 'pay'],
  ] as const)('spend=%s produces %s at the specified boundaries', (spend, action) => {
    const decision = synthesize({ spend });
    expect(decision.action).toBe(action);
    expect(DecisionSchema.parse(decision)).toEqual(decision);
  });
  const cases: { name: string; probs: Probs; action: Decision['action']; reason?: string }[] = [
    { name: 'named true outcome', probs: { spend: { true: 0.8, false: 0.2 } }, action: 'pay' },
    { name: 'named pay outcome', probs: { spend: { pay: 0.8, refuse: 0.1, ask: 0.1 } }, action: 'pay' },
    { name: 'larger false outcome still asks in approval band', probs: { spend: { true: 0.4, false: 0.6 } }, action: 'ask' },
    { name: 'spend tie asks', probs: { spend: { true: 0.5, false: 0.5 } }, action: 'ask' },
    { name: 'route confidence never gates spend', probs: { spend: 0.8, route: { a: 0.68, b: 0.32 }, risk: { low: 0.1, mid: 0.8, high: 0.1 } }, action: 'pay' },
    { name: 'high risk vetoes pay', probs: { spend: 0.9, risk: { low: 0.1, mid: 0.1, high: 0.8 } }, action: 'refuse', reason: 'risk_high' },
    { name: 'high risk tie vetoes', probs: { spend: 0.9, risk: { low: 0.4, mid: 0.2, high: 0.4 } }, action: 'refuse' },
    { name: 'scalar low risk allows', probs: { spend: 0.9, risk: 0.05 }, action: 'pay' },
    { name: 'scalar high risk vetoes', probs: { spend: 0.9, risk: 0.5 }, action: 'refuse' },
    { name: 'risk missing labels refuses', probs: { spend: 0.9, risk: { high: 0.2 } }, action: 'refuse' },
    { name: 'risk inconsistent distribution refuses', probs: { spend: 0.9, risk: { low: 0.8, mid: 0.8, high: 0.1 } }, action: 'refuse' },
    { name: 'spend inconsistent distribution refuses', probs: { spend: { true: 0.8, false: 0.4 } }, action: 'refuse' },
    { name: 'mixed spend labels refuse', probs: { spend: { true: 0.8, false: 0.1, pay: 0.1 } }, action: 'refuse' },
    { name: 'missing spend refuses', probs: { route: 1 }, action: 'refuse' },
    { name: 'unrecognized spend refuses', probs: { spend: { yes: 1 } }, action: 'refuse' },
    { name: 'negative probability refuses', probs: { spend: -0.1 }, action: 'refuse' },
    { name: 'probability above one refuses', probs: { spend: 1.1 }, action: 'refuse' },
    { name: 'NaN refuses', probs: { spend: Number.NaN }, action: 'refuse' },
    { name: 'infinity refuses', probs: { spend: Infinity }, action: 'refuse' },
    { name: 'invalid route probability refuses', probs: { spend: 0.9, route: -1 }, action: 'refuse' },
  ];
  it.each(cases)('$name', ({ probs, action, reason }) => {
    const decision = synthesize(probs);
    expect(decision.action).toBe(action);
    if (reason) expect(decision.reasons).toContain(reason);
    expect(DecisionSchema.safeParse(decision).success).toBe(true);
  });
  it('returns independent probability snapshots', () => {
    const probs = { spend: { true: 0.8, false: 0.2 } };
    const decision = synthesize(probs);
    probs.spend.true = 0;
    expect(decision.probs.spend).toEqual({ true: 0.8, false: 0.2 });
  });

  it.each([
    [0, 'refuse'], [0.399999999, 'refuse'], [0.4, 'ask'], [0.45, 'ask'], [0.5, 'ask'],
    [0.500001, 'ask'], [0.699999999, 'ask'], [0.7, 'pay'], [1, 'pay'],
  ] as const)('preserves scalar/named parity at spend=%s (%s)', (p, action) => {
    const forms: Probs[] = [
      { spend: p }, { spend: { true: p, false: 1 - p } },
      { spend: { pay: p, refuse: 1 - p, ask: 0 } }, { spend: { pay: p, refuse: 0, ask: 1 - p } },
    ];
    const scalar = synthesize(forms[0]!);
    const scalarGuard = evaluateGuard(request, policy, forms[0]!);
    for (const probs of forms) {
      expect(synthesize(probs)).toMatchObject({ action, reasons: scalar.reasons });
      expect(evaluateGuard(request, policy, probs)).toMatchObject({
        action, reasons: scalarGuard.reasons, maxAmountAtomic: action === 'pay' ? request.quote.amountAtomic : '0',
      });
      expect(evaluateGuard(request, { ...policy, requireSelfProof: true }, probs)).toMatchObject({
        action: 'refuse', reasons: ['self_proof_required'], maxAmountAtomic: '0',
      });
      for (const risk of [0.5, { low: 0.4, mid: 0.2, high: 0.4 }]) {
        expect(synthesize({ ...probs, risk })).toMatchObject({ action: 'refuse', reasons: ['risk_high'] });
        expect(evaluateGuard(request, policy, { ...probs, risk })).toMatchObject({
          action: 'refuse', maxAmountAtomic: '0', reasons: ['hard_rules_passed', 'risk_high'],
        });
      }
    }
  });
});

describe('guard composition', () => {
  it.each([0.3, 0.5, 0.9])('cannot override a hard veto with spend=%s', (spend) => {
    const result = evaluateGuard(request, { ...policy, requireSelfProof: true }, { spend });
    expect(result.action).toBe('refuse');
    expect(result.maxAmountAtomic).toBe('0');
    expect(result.reasons).toEqual(['self_proof_required']);
  });
  it.each([[0.3, 'refuse'], [0.5, 'ask'], [0.9, 'pay']] as const)('composes spend=%s into a schema-compatible %s guard', (spend, action) => {
    const { probs, ...result } = evaluateGuard(request, policy, { spend });
    const response = { ...mockGuardResult, ...result, decider: { ...mockGuardResult.decider, probs } };
    expect(response.action).toBe(action);
    expect(GuardResultSchema.parse(response)).toEqual(response);
    expect(result.maxAmountAtomic).toBe(action === 'pay' ? '5000' : '0');
  });
  it('uses all applicable store windows and shares Celo aliases', () => {
    const store = new InMemoryBudgetStore();
    const context = { payer: request.payer, asset, budgetKey: 'key', teamId: 'team' };
    const limits = [{ scope: 'team' as const, windowMs: 1000, limitAtomic: '6000' }];
    expect(store.reserve(context, limits, '5000', 0).allow).toBe(true);
    const rules = { ...policy, budgets: store.snapshot(context, limits, 0) };
    for (const network of ['celo', 'eip155:42220']) {
      expect(evaluateGuard({ ...request, quote: { ...request.quote, network } }, rules, { spend: 1 }).reasons).toContain('budget_exceeded:team');
    }
    expect(budgetWindow(1000, 1000).startMs).toBe(1000);
  });
  it('retains the global offline fetch guard', async () => {
    await expect(globalThis.fetch('https://rules.invalid')).rejects.toThrow('Network access is disabled');
  });
});

describe('spend cap conversion', () => {
  it.each([
    ['0.005', 6, 5000n], ['0.0000009', 6, 0n], ['1.999', 0, 1n],
    ['1.23', 2, 123n], ['1', 18, 10n ** 18n], ['0001.20', 6, 1200000n],
    ['9007199254740993', 0, 9007199254740993n],
  ] as const)('converts %s with %s decimals exactly', (cap, decimals, expected) => {
    expect(spendCapToAtomic(cap, decimals)).toBe(expected);
  });
  it.each(['', ' ', '-1', 'NaN', '1e3', '0x10', '1.2.3'])('rejects invalid cap %s', (cap) => {
    expect(() => spendCapToAtomic(cap, 6)).toThrow();
  });
  it.each([-1, 0.5, 37, NaN, Infinity])('rejects invalid decimals %s', (decimals) => {
    expect(() => spendCapToAtomic('1', decimals)).toThrow();
  });
});
