/** Reject sensitive content without ever echoing the offending key or value. */
export function assertRedacted(value: unknown): void {
  const ancestors = new Set<object>();
  function visit(item: unknown): void {
    if (typeof item === 'number' && Number.isFinite(item)) { visit(String(item)); return; }
    if (typeof item === 'string') {
      if (/\d(?:[ -]?\d){12,}/.test(item)
        || /cvv|\bpan\b|bearer\s+\S+|api[\s_-]?key|client[\s_-]?secret|webhook[\s_-]?secret|\btoken\b|(?:access|refresh)[\s_-]?token|private[\s_-]?key/i.test(item)
        || /\bsk-[a-z0-9_-]{16,}|\bAKIA[a-z0-9]{16}|\bgh[pousr]_[a-z0-9]{20,}|\bgithub_pat_[a-z0-9_]{20,}|\beyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}/i.test(item)) {
        throw new Error('ledger_redaction_required');
      }
    } else if (item !== null && typeof item === 'object') {
      if (ancestors.has(item)) throw new Error('ledger_requires_json');
      const prototype: unknown = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
        throw new Error('ledger_requires_json');
      }
      ancestors.add(item);
      for (const [key, child] of Object.entries(item)) { visit(key); visit(child); }
      ancestors.delete(item);
    } else if (typeof item === 'number' ? !Number.isFinite(item)
      : item !== undefined && item !== null && typeof item !== 'boolean') {
      throw new Error('ledger_requires_json');
    }
  }
  visit(value);
}
