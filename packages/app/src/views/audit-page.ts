// 审计页：哈希链是否完好，以及按最近一次 run_started 标注每条授权。

import { consoleBody, escapeHtml, renderDocument, runModeBlock } from './html.js';
import type { AuditEventRow, AuditPageModel, ConsoleRunMode } from './models.js';
import { authorizationSourceLabel } from './run-mode.js';

/** 渲染审计页。链完整与链断裂使用不同的徽章文案。 */
export function renderAuditPage(model: AuditPageModel): string {
  const main = `<h1>Audit log</h1>
${runModeBlock(model.runMode)}
${policySection(model)}
<p>${chainBadge(model)}</p>
${verifyLine(model)}
${eventsSection(model)}
${cardsSection(model)}`;
  return renderDocument('Audit log', consoleBody(main, 'audit', model.runMode));
}

/** 链状态只用文字徽章表达，不单靠颜色。 */
function chainBadge(model: AuditPageModel): string {
  if (model.chainValid) return '<strong class="badge badge-ok" role="status">Chain valid</strong>';
  return '<strong class="badge badge-bad" role="status">Chain BROKEN</strong>';
}

/** 链完整时忽略校验错误。链断裂且有错误文本时才展示。空字符串不占一行。 */
function verifyLine(model: AuditPageModel): string {
  if (model.chainValid) return '';
  if (model.verifyError === undefined || model.verifyError === '') return '';
  return `<p class="error" role="alert">${escapeHtml(model.verifyError)}</p>`;
}

/** 最近一条 run_started 带来的政策说明。没有就不渲染这一节。 */
function policySection(model: AuditPageModel): string {
  const notes = model.policyNotes;
  if (notes === undefined || notes.length === 0) return '';
  const items = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  return `<section aria-labelledby="policy-notes"><h2 id="policy-notes">Policy notes</h2><ul>${items}</ul></section>`;
}

/** 事件表。来源列的措辞跟运行模式走，离线图例不出现 sandbox。 */
function eventsSection(model: AuditPageModel): string {
  const legend = `<p class="hint">${escapeHtml(sourceLegend(model.runMode))}</p>`;
  if (model.events.length === 0) {
    return `<section aria-labelledby="events"><h2 id="events">Events</h2>${legend}<p>No ledger events.</p></section>`;
  }
  const rows = model.events.map((event) => eventRow(event, model.runMode)).join('');
  return `<section aria-labelledby="events"><h2 id="events">Events</h2>
${legend}
<div class="table-wrap"><table>
<caption>Ledger events</caption>
<thead><tr>
<th scope="col">Seq</th>
<th scope="col">Time</th>
<th scope="col">Kind</th>
<th scope="col">Summary</th>
<th scope="col">Source</th>
<th scope="col">Hash</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div></section>`;
}

/** 图例跟模式走。未知模式和离线模式都不把当前运行称作 sandbox。 */
function sourceLegend(mode: ConsoleRunMode | undefined): string {
  if (mode === 'offline_emulator') {
    return 'Authorizations in this run are marked emulated (offline). This run made no Airwallex calls.';
  }
  if (mode === 'sandbox' || mode === 'console_sandbox') {
    return 'Sandbox authorizations created by the simulator are marked sandbox simulation. Sandbox authorizations reported back to the console are marked sandbox event (observed).';
  }
  return 'mode unknown. Authorization rows stay unlabelled as a named run until run_started is recorded.';
}

/** 渲染一条账本事件。未确认发卡和控制项不一致都用警告样式，不单靠颜色。 */
function eventRow(event: AuditEventRow, mode: ConsoleRunMode | undefined): string {
  const unconfirmed = event.kind === 'card_issue_unconfirmed';
  const mismatch = event.warning === true;
  const summary = unconfirmed
    ? `<strong class="warning">Unconfirmed</strong> ${escapeHtml(event.summary)}`
    : mismatch
      ? `<strong class="warning">${escapeHtml(event.summary)}</strong>`
      : escapeHtml(event.summary);
  const rowClass = unconfirmed ? ' class="unconfirmed"' : mismatch ? ' class="mismatch"' : '';
  return `<tr${rowClass}>
<td class="num">${escapeHtml(String(event.seq))}</td>
<td><time datetime="${escapeHtml(event.at)}">${escapeHtml(event.at)}</time></td>
<td><code>${escapeHtml(event.kind)}</code></td>
<td>${summary}</td>
<td>${escapeHtml(authorizationSourceLabel(mode, event.source, event.kind))}</td>
<td><code class="hash">${escapeHtml(event.hashShort)}</code></td>
</tr>`;
}

/** 卡片摘要表。没有卡时给出空状态。 */
function cardsSection(model: AuditPageModel): string {
  if (model.cards.length === 0) {
    return `<section aria-labelledby="cards"><h2 id="cards">Cards</h2><p>No cards.</p></section>`;
  }
  const rows = model.cards.map((card) => `<tr>
<th scope="row">${escapeHtml(card.cardId)}</th>
<td>${escapeHtml(card.status)}</td>
<td class="num">${escapeHtml(card.limit)}</td>
<td>${escapeHtml(card.currency)}</td>
</tr>`).join('');
  return `<section aria-labelledby="cards"><h2 id="cards">Cards</h2>
<div class="table-wrap"><table>
<caption>Cards</caption>
<thead><tr>
<th scope="col">Card</th>
<th scope="col">Status</th>
<th scope="col">Limit</th>
<th scope="col">Currency</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div></section>`;
}
