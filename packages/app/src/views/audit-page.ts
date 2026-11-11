// Audit chain integrity and authorization sources for the latest run.

import { consoleBody, escapeHtml, renderDocument, runModeBlock } from './html.js';
import type { AuditEventRow, AuditPageModel, ConsoleRunMode } from './models.js';
import { authorizationSourceLabel } from './run-mode.js';

/** Render distinct badges for valid and broken chains. */
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

/** Use text as well as color to communicate chain status. */
function chainBadge(model: AuditPageModel): string {
  if (model.chainValid) return '<strong class="badge badge-ok" role="status">Chain valid</strong>';
  return '<strong class="badge badge-bad" role="status">Chain BROKEN</strong>';
}

/** Show nonempty verification errors only when the chain is broken. */
function verifyLine(model: AuditPageModel): string {
  if (model.chainValid) return '';
  if (model.verifyError === undefined || model.verifyError === '') return '';
  return `<p class="error" role="alert">${escapeHtml(model.verifyError)}</p>`;
}

/** Show policy notes from the latest run_started when available. */
function policySection(model: AuditPageModel): string {
  const notes = model.policyNotes;
  if (notes === undefined || notes.length === 0) return '';
  const items = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  return `<section aria-labelledby="policy-notes"><h2 id="policy-notes">Policy notes</h2><ul>${items}</ul></section>`;
}

/** Event table with source labels determined by the run mode. */
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

/** Match the legend to the run mode; offline and unknown runs never say sandbox. */
function sourceLegend(mode: ConsoleRunMode | undefined): string {
  if (mode === 'offline_emulator') {
    return 'Authorizations in this run are marked emulated (offline). This run made no Airwallex calls.';
  }
  if (mode === 'sandbox' || mode === 'console_sandbox') {
    return 'Sandbox authorizations created by the simulator are marked sandbox simulation. Sandbox authorizations reported back to the console are marked sandbox event (observed).';
  }
  return 'mode unknown. Authorization rows stay unlabelled as a named run until run_started is recorded.';
}

/** Warn about unconfirmed issuance and control mismatches using text and styling. */
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

/** Card summary table with an empty state when no cards exist. */
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
