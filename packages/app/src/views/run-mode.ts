// 视图自己认识 run_started / controls_readback。
// 账本 schema 尚未导出这两种 kind 时，页面仍然能按 kind 字符串收窄，缺了也不抛错。

import type { CardAuditEvent } from '@sk/ledger';
import type { ConsoleRunMode } from './models.js';

/** 一次运行开始。mode 决定页面上能不能出现 sandbox 字样。 */
export interface RunStartedViewEvent {
  kind: 'run_started';
  mode: ConsoleRunMode;
  policyNotes: readonly string[];
}

/** 发卡后用 getCard 回读的控制项。actual 只在账本里，页面不展开。 */
export interface ControlsReadbackViewEvent {
  kind: 'controls_readback';
  cardId: string;
  matches: boolean;
  expected: unknown;
  actual: unknown;
}

/** 系统自动冻结。当前账本的 by 还没有 system，视图先单独认这个值。 */
export interface SystemCardFrozenViewEvent {
  kind: 'card_frozen';
  cardId: string;
  by: 'system';
  reason: string;
}

/** 构建器接受的事件。在 @sk/ledger 的联合上追加尚未落地的 kind。 */
export type ViewAuditEvent =
  | CardAuditEvent
  | RunStartedViewEvent
  | ControlsReadbackViewEvent
  | SystemCardFrozenViewEvent;

/** 最近一条可用的 run_started。无效 mode 不当成更早一次运行。 */
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

/** 最近一条 kind 为 run_started 的记录。按 seq 取最大，同 seq 取数组里更靠后的。 */
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

/** 页眉、页脚共用的模式句子。没有 run_started 时固定写 mode unknown。 */
export function runModeLabel(mode: ConsoleRunMode | undefined): string {
  if (mode === 'offline_emulator') return 'Offline emulator (no Airwallex calls)';
  if (mode === 'sandbox' || mode === 'console_sandbox') return 'Airwallex sandbox';
  return 'mode unknown';
}

/** 授权行的来源列。离线运行一律 emulated (offline)，不能写成 sandbox。 */
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

/** 冻结执行者。system 表示自动冻结，不写成某个人。 */
export function freezeActorLabel(by: string): string {
  return by === 'system' ? 'system (auto)' : by;
}

/** run_started 行的短摘要。mode 读不出来时跟页面一样写 mode unknown。 */
export function runStartedSummary(event: { kind: string }): string {
  const mode = (event as { mode?: unknown }).mode;
  return `Run started: ${runModeLabel(isConsoleRunMode(mode) ? mode : undefined)}`;
}

/** 回读不一致，或 matches 缺失，都写成 MISMATCH。 */
export function isControlsMismatch(event: { kind: string }): boolean {
  if (event.kind !== 'controls_readback') return false;
  return (event as { matches?: unknown }).matches !== true;
}

/** 控制项回读只留一句结论，不把 expected / actual 对象印到页面上。 */
export function controlsReadbackSummary(event: { kind: string }): string {
  return isControlsMismatch(event) ? 'controls read back: MISMATCH' : 'controls read back: match';
}
