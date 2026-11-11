// Approval list with links to each request and audit navigation in the header.

import { consoleBody, escapeHtml, renderDocument, runModeBlock, segmentPath } from './html.js';
import type { IndexPageModel } from './models.js';

/** Render the approval list, or an empty state when no requests exist. */
export function renderIndexPage(model: IndexPageModel): string {
  const body = model.approvals.length === 0
    ? '<p>No approval requests.</p>'
    : approvalTable(model);
  const main = `<h1>Approvals</h1>
${runModeBlock(model.runMode)}
<p>A person approves the exact terms before a card is issued.</p>
${body}`;
  return renderDocument('Approvals', consoleBody(main, 'approvals', model.runMode));
}

/** Preserve caller order. */
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
