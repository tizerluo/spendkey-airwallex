// View-local types for run_started and controls_readback.
// Narrow additive events by kind and tolerate older ledgers without them.

import type { CardAuditEvent } from '@sk/ledger';
import type { ConsoleRunMode } from './models.js';

/** Run start; mode controls whether pages may use a sandbox label. */
export interface RunStartedViewEvent {
  kind: 'run_started';
  mode: ConsoleRunMode;
  policyNotes: readonly string[];
}

/** Controls read back through getCard; keep actual values in the ledger only. */
export interface ControlsReadbackViewEvent {
  kind: 'controls_readback';
  cardId: string;
  matches: boolean;
  expected: unknown;
  actual: unknown;
}

/** View-local type for a system auto-freeze. */
export interface SystemCardFrozenViewEvent {
  kind: 'card_frozen';
  cardId: string;
  by: 'system';
  reason: string;
}

/** Events accepted by builders, including additive view contracts. */
export type ViewAuditEvent =
  | CardAuditEvent
  | RunStartedViewEvent
  | ControlsReadbackViewEvent
  | SystemCardFrozenViewEvent;

/** Latest run_started mode; an invalid mode must not fall back to an earlier run. */
export interface ResolvedRun {
  mode: ConsoleRunMode;
  policyNotes: readonly string[];
}

export function isConsoleRunMode(value: unknown): value is ConsoleRunMode {
  return value === 'offline_emulator' || value === 'sandbox' || value === 'console_sandbox';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Latest run_started by sequence; break sequence ties using the later array entry. */
export function latestRun(
  events: readonly { seq: number; event: { kind: string } }[],
): ResolvedRun | undefined {
  let best: { seq: number; index: number; event: { kind: string } } | undefined;
  for (let index = 0; index < events.length; index += 1) {
    const record = events[index];
    if (record === undefined || record.event.kind !== 'run_started') continue;
    if (
      best === undefined
      || record.seq > best.seq
      || (record.seq === best.seq && index > best.index)
    ) {
      best = { seq: record.seq, index, event: record.event };
    }
  }
  if (best === undefined) return undefined;
  const mode = (best.event as { mode?: unknown }).mode;
  if (!isConsoleRunMode(mode)) return undefined;
  const notes = (best.event as { policyNotes?: unknown }).policyNotes;
  return { mode, policyNotes: isStringArray(notes) ? notes : [] };
}

/** Shared header/footer label; missing run_started means mode unknown. */
export function runModeLabel(mode: ConsoleRunMode | undefined): string {
  if (mode === 'offline_emulator') return 'Offline emulator (no Airwallex calls)';
  if (mode === 'sandbox' || mode === 'console_sandbox') return 'Airwallex sandbox';
  return 'mode unknown';
}

/** Authorization source label; offline runs always say emulated (offline). */
export function authorizationSourceLabel(
  mode: ConsoleRunMode | undefined,
  source: 'simulated' | 'observed' | undefined,
  kind: string,
): string {
  if (kind !== 'authorization') return '\u2014';
  if (source !== 'simulated' && source !== 'observed') return 'source missing';
  if (mode === 'offline_emulator') return 'emulated (offline)';
  if (mode === 'sandbox' || mode === 'console_sandbox') {
    return source === 'simulated' ? 'sandbox simulation' : 'sandbox event (observed)';
  }
  return 'mode unknown';
}

/** Freeze actor; system means automatic action, not a person. */
export function freezeActorLabel(by: string): string {
  return by === 'system' ? 'system (auto)' : by;
}

/** Short run_started summary; invalid modes use mode unknown. */
export function runStartedSummary(event: { kind: string }): string {
  const mode = (event as { mode?: unknown }).mode;
  return `Run started: ${runModeLabel(isConsoleRunMode(mode) ? mode : undefined)}`;
}

/** Missing or false matches values produce MISMATCH. */
export function isControlsMismatch(event: { kind: string }): boolean {
  if (event.kind !== 'controls_readback') return false;
  return (event as { matches?: unknown }).matches !== true;
}

/** Summarize controls readback without printing expected or actual objects. */
export function controlsReadbackSummary(event: { kind: string }): string {
  return isControlsMismatch(event) ? 'controls read back: MISMATCH' : 'controls read back: match';
}
