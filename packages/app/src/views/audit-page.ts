// 审计页：哈希链是否完好，以及每条账本事件是模拟还是沙箱观测。

import { consoleBody, escapeHtml, renderDocument } from './html.js';
import type { AuditEventRow, AuditPageModel } from './models.js';

/** 渲染审计页。链完整与链断裂使用不同的徽章文案。 */
export function renderAuditPage(model: AuditPageModel): string {
  const main = `<h1>Audit log</h1>
<p>${chainBadge(model)}</p>
${verifyLine(model)}
${eventsSection(model)}
${cardsSection(model)}`;
  return renderDocument('Audit log', consoleBody(main, 'audit'));
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

/** 事件表。模拟与观测的标签写在列里，并在表前说明这两个词的含义。 */
function eventsSection(model: AuditPageModel): string {
  const legend = `<p class="hint">Sandbox authorizations created by the simulator are marked sandbox simulation. Sandbox authorizations reported back to the console are marked sandbox event (observed).</p>`;
  if (model.events.length === 0) {
    return `<section aria-labelledby="events"><h2 id="events">Events</h2>${legend}<p>No ledger events.</p></section>`;
  }
  const rows = model.events.map((event) => eventRow(event)).join('');
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

/** 渲染一条账本事件。发卡未确认的行用警告样式，不单靠颜色区分。 */
function eventRow(event: AuditEventRow): string {
  const unconfirmed = event.kind === 'card_issue_unconfirmed';
  const summary = unconfirmed
    ? `<strong class="warning">Unconfirmed</strong> ${escapeHtml(event.summary)}`
    : escapeHtml(event.summary);
  return `<tr${unconfirmed ? ' class="unconfirmed"' : ''}>
<td class="num">${escapeHtml(String(event.seq))}</td>
<td><time datetime="${escapeHtml(event.at)}">${escapeHtml(event.at)}</time></td>
<td><code>${escapeHtml(event.kind)}</code></td>
<td>${summary}</td>
<td>${escapeHtml(sourceLabel(event))}</td>
<td><code class="hash">${escapeHtml(event.hashShort)}</code></td>
</tr>`;
}

/** simulated 与 observed 使用合同里的固定标签。授权缺少来源时明确写成缺失。 */
function sourceLabel(event: AuditEventRow): string {
  if (event.source === 'simulated') return 'sandbox simulation';
  if (event.source === 'observed') return 'sandbox event (observed)';
  if (event.kind === 'authorization') return 'source missing';
  return '\u2014';
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
