// Offline examples only. Addresses, hashes, body hashes and signature bytes are synthetic.
import type { Network, AtomicAmount } from './common.js';
import type { PlanReq, PaymentPlan, PlanStep, Approval, GuardReq, GuardResult, Receipt, CallSpec, PaymentSpec, Attribution, GuardQuote } from './payment.js';
import type { Decider, Decision } from './decision.js';
import type { Quote, CatalogItem, CatalogPrice } from './catalog.js';
import type { AuditRecord } from './audit.js';
import type { Stats, ProviderStats } from './stats.js';

export const mockNetwork: Network = "eip155:42220";

export const mockAtomicAmount: AtomicAmount = "9007199254740993123456789";

export const mockPlanReq: PlanReq = {
  "intent": "Look up a mock record",
  "tool": "lookup",
  "input": {
    "query": "mock"
  },
  "maxSpend": "0.025",
  "payer": "0x1111111111111111111111111111111111111111",
  "prefer": {
    "celoOnly": true,
    "providers": [
      "buy",
      "agent402"
    ]
  },
  "budgetKey": "mock-budget"
};

export const mockPaymentPlan: PaymentPlan = {
  "id": "mock-plan",
  "action": "pay",
  "reasons": [
    "Within the mock budget"
  ],
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "steps": [
    {
      "call": {
        "url": "https://mock.example/tools/lookup",
        "method": "POST",
        "body": {
          "query": "mock"
        },
        "source": "buy",
        "toolId": "lookup",
        "bodyHash": "0x" + "0".repeat(64)
      },
      "pay": {
        "x402Version": 1,
        "network": "celo",
        "asset": "0x1111111111111111111111111111111111111111",
        "payTo": "0x2222222222222222222222222222222222222222",
        "maxAmountAtomic": "5000",
        "scoreable": true
      }
    }
  ],
  "attribution": {
    "erc8021": [
      "spend-router-mock"
    ]
  },
  "expiresAt": "2026-10-12T12:00:00Z",
  "auditHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "sig": "0x4444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444",
  "payer": "0x1111111111111111111111111111111111111111",
  "nonce": "0x" + "0".repeat(64)
};

export const mockPlanStep: PlanStep = {
  "call": {
    "url": "https://mock.example/tools/lookup",
    "method": "POST",
    "body": {
      "query": "mock"
    },
    "source": "buy",
    "toolId": "lookup",
    "bodyHash": "0x" + "0".repeat(64)
  },
  "pay": {
    "x402Version": 1,
    "network": "celo",
    "asset": "0x1111111111111111111111111111111111111111",
    "payTo": "0x2222222222222222222222222222222222222222",
    "maxAmountAtomic": "5000",
    "scoreable": true
  }
};

export const mockApproval: Approval = {
  "required": true,
  "approveUrl": "https://mock.example/v1/plans/mock-plan/approve"
};

export const mockDecider: Decider = {
  "provider": "rules",
  "model": "rules-v1",
  "transport": "rules",
  "probs": {
    "spend": {
      "pay": 0.8,
      "refuse": 0.1,
      "ask": 0.1
    },
    "route": 0.9,
    "risk": 0.05
  },
  "fallback": true
};

export const mockGuardReq: GuardReq = {
  "url": "https://mock.example/tools/lookup",
  "quote": {
    "amountAtomic": "5000",
    "asset": "0x1111111111111111111111111111111111111111",
    "network": "eip155:42220",
    "payTo": "0x2222222222222222222222222222222222222222"
  },
  "intent": "Look up a mock record",
  "maxSpend": "0.025",
  "payer": "0x1111111111111111111111111111111111111111"
};

export const mockGuardResult: GuardResult = {
  "action": "pay",
  "reasons": [
    "Within the mock budget"
  ],
  "maxAmountAtomic": "5000",
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "auditHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "id": "mock-guard",
  "expiresAt": "2026-10-12T12:00:00Z"
};

export const mockReceipt: Receipt = {
  "planId": "mock-plan",
  "tx": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "network": "eip155:42220"
};

export const mockQuote: Quote = {
  "source": "buy",
  "id": "lookup",
  "url": "https://mock.example/tools/lookup",
  "method": "POST",
  "asset": "0x1111111111111111111111111111111111111111",
  "payTo": "0x2222222222222222222222222222222222222222",
  "scheme": "exact",
  "scoreable": true,
  "maxTimeoutSeconds": 60,
  "x402Version": 1,
  "network": "celo",
  "maxAmountRequired": "5000"
};

export const mockCatalogItem: CatalogItem = {
  "source": "buy",
  "id": "lookup",
  "url": "https://mock.example/tools/lookup",
  "method": "POST",
  "name": "Mock lookup",
  "description": "Offline example",
  "inputSchema": {
    "type": "object"
  },
  "x402Version": 1,
  "celoAssets": [
    "USDC",
    "USDT",
    "USAT"
  ],
  "price": {
    "amountAtomic": "5000",
    "asset": "0x1111111111111111111111111111111111111111",
    "network": "eip155:42220"
  },
  "payRail": "x402",
  "celo": true,
  "scoreable": true,
  "trust": {
    "payers30d": 0
  },
  "requiresSelf": false,
  "async": false,
  "updatedAt": "2026-10-12T12:00:00Z"
};

export const mockDecision: Decision = {
  "action": "pay",
  "reasons": [
    "Within the mock budget"
  ],
  "probs": {
    "spend": {
      "pay": 0.8,
      "refuse": 0.1,
      "ask": 0.1
    },
    "route": 0.9,
    "risk": 0.05
  }
};

export const mockAuditRecord: AuditRecord = {
  "id": "mock-audit",
  "planId": "mock-plan",
  "budgetKey": "mock-budget",
  "timestamp": "2026-10-12T12:00:00Z",
  "hash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "stateHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "decision": {
    "action": "pay",
    "reasons": [
      "Within the mock budget"
    ],
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    }
  },
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "rules": [
    "budget-ok"
  ],
  "savedAmountAtomic": "0",
  "kind": "plan",
  "seq": 0,
  "payer": "0x1111111111111111111111111111111111111111"
};

export const mockStats: Stats = {
  "uniquePayers": 4,
  "plans": 10,
  "executionRate": 0.8,
  "refusalRate": 0.1,
  "savedAmountAtomic": "10000",
  "providers": [
    {
      "provider": "rules",
      "calls": 10,
      "latencyMs": 1.5,
      "fallbackRate": 0.1
    }
  ],
  "updatedAt": "2026-10-12T12:00:00Z"
};

export const mockCallSpec: CallSpec = {
  "url": "https://mock.example/tools/lookup",
  "method": "POST",
  "body": {
    "query": "mock"
  },
  "source": "buy",
  "toolId": "lookup",
  "bodyHash": "0x" + "0".repeat(64)
};

export const mockPaymentSpec: PaymentSpec = {
  "x402Version": 1,
  "network": "celo",
  "asset": "0x1111111111111111111111111111111111111111",
  "payTo": "0x2222222222222222222222222222222222222222",
  "maxAmountAtomic": "5000",
  "scoreable": true
};

export const mockAttribution: Attribution = {
  "erc8021": [
    "spend-router-mock"
  ]
};

export const mockGuardQuote: GuardQuote = {
  "amountAtomic": "5000",
  "asset": "0x1111111111111111111111111111111111111111",
  "network": "eip155:42220",
  "payTo": "0x2222222222222222222222222222222222222222"
};

export const mockCatalogPrice: CatalogPrice = {
  "amountAtomic": "5000",
  "asset": "0x1111111111111111111111111111111111111111",
  "network": "eip155:42220"
};

export const mockProviderStats: ProviderStats = {
  "provider": "rules",
  "calls": 10,
  "latencyMs": 1.5,
  "fallbackRate": 0.1
};

export const mockQuoteV2: Quote = {
  "source": "agent402",
  "id": "lookup",
  "url": "https://mock.example/tools/lookup",
  "method": "POST",
  "asset": "0x1111111111111111111111111111111111111111",
  "payTo": "0x2222222222222222222222222222222222222222",
  "scheme": "exact",
  "scoreable": true,
  "maxTimeoutSeconds": 60,
  "x402Version": 2,
  "network": "eip155:42220",
  "amount": "5000"
};

export const mockPaymentPlanAsk: PaymentPlan = {
  "id": "mock-plan",
  "action": "ask",
  "reasons": [
    "Within the mock budget"
  ],
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "attribution": {
    "erc8021": [
      "spend-router-mock"
    ]
  },
  "expiresAt": "2026-10-12T12:00:00Z",
  "auditHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "sig": "0x4444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444",
  "approval": {
    "required": true,
    "approveUrl": "https://mock.example/v1/plans/mock-plan/approve"
  },
  "payer": "0x1111111111111111111111111111111111111111",
  "nonce": "0x" + "0".repeat(64)
};

export const mockPaymentPlanRefuse: PaymentPlan = {
  "id": "mock-plan",
  "action": "refuse",
  "reasons": [
    "Mock budget exhausted"
  ],
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "attribution": {
    "erc8021": [
      "spend-router-mock"
    ]
  },
  "expiresAt": "2026-10-12T12:00:00Z",
  "auditHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "sig": "0x4444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444",
  "payer": "0x1111111111111111111111111111111111111111",
  "nonce": "0x" + "0".repeat(64)
};

export const mockPaymentPlanFallback: PaymentPlan = {
  "id": "mock-plan",
  "action": "pay",
  "reasons": [
    "Within the mock budget"
  ],
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "steps": [
    {
      "call": {
        "url": "https://mock.example/tools/lookup",
        "method": "POST",
        "body": {
          "query": "mock"
        },
        "source": "buy",
        "toolId": "lookup",
        "bodyHash": "0x" + "0".repeat(64)
      },
      "pay": {
        "x402Version": 1,
        "network": "celo",
        "asset": "0x1111111111111111111111111111111111111111",
        "payTo": "0x2222222222222222222222222222222222222222",
        "maxAmountAtomic": "5000",
        "scoreable": true
      }
    },
    {
      "call": {
        "url": "https://mock.example/tools/lookup",
        "method": "POST",
        "body": {
          "query": "mock"
        },
        "source": "agent402",
        "toolId": "lookup",
        "bodyHash": "0x" + "0".repeat(64)
      },
      "pay": {
        "x402Version": 2,
        "network": "eip155:42220",
        "asset": "0x1111111111111111111111111111111111111111",
        "payTo": "0x2222222222222222222222222222222222222222",
        "maxAmountAtomic": "5000",
        "scoreable": true
      },
      "fallbackOf": 0
    }
  ],
  "attribution": {
    "erc8021": [
      "spend-router-mock"
    ]
  },
  "expiresAt": "2026-10-12T12:00:00Z",
  "auditHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "sig": "0x4444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444",
  "payer": "0x1111111111111111111111111111111111111111",
  "nonce": "0x" + "0".repeat(64)
};

export const mockCatalogItemAgent402: CatalogItem = {
  "source": "agent402",
  "id": "lookup",
  "url": "https://mock.example/tools/lookup",
  "method": "POST",
  "name": "Mock lookup",
  "description": "Offline example",
  "inputSchema": {
    "type": "object"
  },
  "x402Version": 2,
  "celoAssets": [
    "USDC"
  ],
  "price": {
    "amountAtomic": "5000",
    "asset": "0x1111111111111111111111111111111111111111",
    "network": "eip155:42220"
  },
  "payRail": "x402",
  "celo": true,
  "scoreable": true,
  "trust": {
    "payers30d": 0
  },
  "requiresSelf": false,
  "async": false,
  "updatedAt": "2026-10-12T12:00:00Z"
};

export const mockCatalogItemBazaar: CatalogItem = {
  "source": "bazaar",
  "id": "lookup",
  "url": "https://mock.example/tools/lookup",
  "method": "POST",
  "name": "Mock lookup",
  "description": "Offline example",
  "inputSchema": {
    "type": "object"
  },
  "x402Version": 2,
  "celoAssets": [],
  "price": {
    "amountAtomic": "5000",
    "asset": "0x1111111111111111111111111111111111111111",
    "network": "eip155:8453"
  },
  "payRail": "x402",
  "celo": false,
  "scoreable": false,
  "trust": {
    "payers30d": 0
  },
  "requiresSelf": false,
  "async": false,
  "updatedAt": "2026-10-12T12:00:00Z"
};

export const mockNetworkV2: Network = "eip155:42220";

export const mockAuditRecordGuard: AuditRecord = {
  "id": "mock-audit",
  "planId": "mock-plan",
  "budgetKey": "mock-budget",
  "timestamp": "2026-10-12T12:00:00Z",
  "hash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "stateHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "decision": {
    "action": "pay",
    "reasons": [
      "Within the mock budget"
    ],
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    }
  },
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "rules": [
    "budget-ok"
  ],
  "savedAmountAtomic": "0",
  "kind": "guard",
  "seq": 1,
  "payer": "0x1111111111111111111111111111111111111111"
};

export const mockAuditRecordApproval: AuditRecord = {
  "id": "mock-audit",
  "planId": "mock-plan",
  "budgetKey": "mock-budget",
  "timestamp": "2026-10-12T12:00:00Z",
  "hash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "stateHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "decision": {
    "action": "pay",
    "reasons": [
      "Within the mock budget"
    ],
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    }
  },
  "decider": {
    "provider": "rules",
    "model": "rules-v1",
    "transport": "rules",
    "probs": {
      "spend": {
        "pay": 0.8,
        "refuse": 0.1,
        "ask": 0.1
      },
      "route": 0.9,
      "risk": 0.05
    },
    "fallback": true
  },
  "rules": [
    "budget-ok"
  ],
  "savedAmountAtomic": "0",
  "kind": "approval",
  "seq": 2,
  "payer": "0x1111111111111111111111111111111111111111"
};

export const mockAuditRecordReceipt: AuditRecord = {
  "id": "mock-audit",
  "planId": "mock-plan",
  "budgetKey": "mock-budget",
  "timestamp": "2026-10-12T12:00:00Z",
  "hash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "prevHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "stateHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
  "kind": "receipt",
  "seq": 3,
  "payer": "0x1111111111111111111111111111111111111111",
  "receipt": {
    "planId": "mock-plan",
    "tx": "0x3333333333333333333333333333333333333333333333333333333333333333",
    "network": "eip155:42220"
  }
};

export const validMocks = {
  'network': mockNetwork,
  'atomic-amount': mockAtomicAmount,
  'plan-req': mockPlanReq,
  'payment-plan': mockPaymentPlan,
  'plan-step': mockPlanStep,
  'approval': mockApproval,
  'decider': mockDecider,
  'guard-req': mockGuardReq,
  'guard-result': mockGuardResult,
  'receipt': mockReceipt,
  'quote': mockQuote,
  'catalog-item': mockCatalogItem,
  'decision': mockDecision,
  'audit-record': mockAuditRecord,
  'stats': mockStats,
  'call-spec': mockCallSpec,
  'payment-spec': mockPaymentSpec,
  'attribution': mockAttribution,
  'guard-quote': mockGuardQuote,
  'catalog-price': mockCatalogPrice,
  'provider-stats': mockProviderStats,
  'quote-v2': mockQuoteV2,
  'payment-plan-ask': mockPaymentPlanAsk,
  'payment-plan-refuse': mockPaymentPlanRefuse,
  'payment-plan-fallback': mockPaymentPlanFallback,
  'catalog-item-agent402': mockCatalogItemAgent402,
  'catalog-item-bazaar': mockCatalogItemBazaar,
  'network-v2': mockNetworkV2,
  'audit-record-guard': mockAuditRecordGuard,
  'audit-record-approval': mockAuditRecordApproval,
  'audit-record-receipt': mockAuditRecordReceipt,
};
