// 审批列表。每一行链到对应的审批页，审计页从页头进入。

import { consoleBody, escapeHtml, renderDocument, segmentPath } from './html.js';
import type { IndexPageModel } from './models.js';

/** 渲染审批列表页。没有请求时给出空状态，而不是一张空表。 */
export function renderIndexPage(model: IndexPageModel): string {
  const body = model.approvals.length === 0
    ? '<p>No approval requests.</p>'
    : approvalTable(model);
  const main = `<h1>Approvals</h1>
<p>A person approves the exact terms before a card is issued.</p>
${body}`;
  return renderDocument('Approvals', consoleBody(main, 'approvals'));
}

/** 列表保持调用方给出的顺序。 */
function approvalTable(model: IndexPageModel): string {
  const rows = model.approvals.map((row) => `<tr>
<th scope="row"><a href="${escapeHtml(segmentPath(['approvals', row.id]))}">${escapeHtml(row.id)}</a></th>
<td>${escapeHtml(row.status)}</td>
<td>${escapeHtml(row.vendor)}</td>
<td class="num">${escapeHtml(row.amount)}</td>
<td>${escapeHtml(row.currency)}</td>
</tr>`).join('');
  return `<div class="table-wrap"><table>
<caption>Approval requests</caption>
<thead><tr>
<th scope="col">Request</th>
<th scope="col">Status</th>
<th scope="col">Vendor</th>
<th scope="col">Amount</th>
<th scope="col">Currency</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}
