export { GENESIS_PREV_HASH, ZERO_HASH, auditRecordHash, canonicalize, sha256Hex } from './canonical.js';
export {
  assertUniqueBudgetSeq,
  importJsonl,
  parseJsonl,
  toJsonl,
  verifyChain,
} from './chain.js';
export type { ChainVerification } from './chain.js';
export { InMemoryAuditStore, budgetSeqKey } from './store.js';
export type { AuditStore } from './store.js';
export { AuditLog } from './log.js';
export { runAuditCli } from './cli.js';
export type { CliResult } from './cli.js';
export type {
  AuditRecordInput,
  DecisionAuditRecord,
  DecisionAuditRecordInput,
  DistributiveOmit,
  HashableAuditRecord,
} from './types.js';
