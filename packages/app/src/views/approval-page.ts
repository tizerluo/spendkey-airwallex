// Approval terms and script-free approve/reject forms.

import { consoleBody, escapeHtml, renderDocument, runModeBlock, segmentPath } from './html.js';
import type {
  ApprovalChosenTerms,
  ApprovalComparisonRow,
  ApprovalPageModel,
  ApprovalRenderOptions,
  ApprovalStatus,
  PaymentRail,
} from './models.js';

const PRICE_UNVERIFIED_CHIP = 'Price not verified \u2014 no savings claim';

/** Render the approval page with an empty nonce input and only the nonce hint. */
export function renderApprovalPage(model: ApprovalPageModel, options: ApprovalRenderOptions): string {
  const title = `Spendkey \u00b7 ${model.intent}`;
  const main = `${banner(model)}${runModeBlock(model.runMode)}${heading(model)}${chosenSection(model)}${reasonSection(model)}${comparisonSection(model)}${excludedSection(model)}${cardSection(model)}${decisionSection(model, options)}${operatorSection(model, options)}`;
  return renderDocument(title, consoleBody(main, 'approvals', model.runMode));
}

/** Every operator form asks for the terminal token; it is never passed into the renderer. */
function operatorSection(model: ApprovalPageModel, options: ApprovalRenderOptions): string {
  const cardId = model.card?.cardId;
  const form = (action: string, label: string, extra = '') => `<form method="post" action="${escapeHtml(action)}" autocomplete="off">
<fieldset><legend>${escapeHtml(label)}</legend>
<input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}">
<label>Operator token (paste from operator terminal)
<input name="operatorToken" type="password" required autocomplete="off" spellcheck="false"></label>
${extra}<button type="submit">${escapeHtml(label)}</button></fieldset></form>`;
  const forms: string[] = [];
  if (cardId !== undefined) {
    if (model.status === 'issued') {
      forms.push(form(segmentPath(['cards', cardId, 'simulate']), 'Simulate authorization',
        '<label>Amount<input name="amount" required></label><label>Currency<input name="currency" required pattern="[A-Z]{3}"></label><label>Merchant category<input name="mcc" required pattern="[0-9]{4}"></label>'));
      forms.push(form('/reconcile', 'Reconcile', `<input type="hidden" name="cardId" value="${escapeHtml(cardId)}">`));
    }
    forms.push(form(segmentPath(['cards', cardId, 'freeze']), 'Freeze card'));
  }
  if (model.status === 'failed' || model.status === 'issuing') {
    forms.push(form(segmentPath(['approvals', model.approvalRequestId, 'recover']), 'Recover issuance (lookup only)'));
  }
  return forms.length === 0 ? '' : `<section aria-labelledby="operator"><h2 id="operator">Operator actions</h2>${forms.join('')}</section>`;
}

/** Explain demo auto-approval and its audit trail. */
function banner(model: ApprovalPageModel): string {
  if (!model.demoMode) return '';
  return `<p class="banner" role="note">Demo: auto-approval by demo-operator is labelled in the audit log</p>`;
}

/** Page title, intent, and current status. */
function heading(model: ApprovalPageModel): string {
  return `<h1>Approve exact terms</h1>
<p>Intent: ${escapeHtml(model.intent)}</p>
<p>Request <code>${escapeHtml(model.approvalRequestId)}</code></p>
<p id="request-status">Status: ${escapeHtml(statusText(model.status))} (${escapeHtml(model.status)})</p>`;
}

/** Map status codes to short display labels. */
function statusText(status: ApprovalStatus): string {
  switch (status) {
    case 'requested':
      return 'Waiting for approval';
    case 'approved':
      return 'Approved';
    case 'issuing':
      return 'Issuing';
    case 'issued':
      return 'Issued';
    case 'failed':
      return 'Failed';
    case 'rejected':
      return 'Rejected';
    case 'expired':
      return 'Expired';
    default:
      return status;
  }
}

/** Highlight the chosen terms and display the hash in monospace. */
function chosenSection(model: ApprovalPageModel): string {
  const chosen = model.chosen;
  const category = merchantCategoryText(model);
  return `<section class="terms" aria-labelledby="chosen-terms">
<h2 id="chosen-terms">Chosen terms</h2>
<p class="product">${escapeHtml(chosen.vendor)} \u00b7 ${escapeHtml(chosen.product)}</p>
<p class="amount"><span class="num">${escapeHtml(chosen.amount)}</span> ${escapeHtml(chosen.currency)}</p>
<dl>
<dt>Offer</dt><dd>${escapeHtml(chosen.offerId)}</dd>
<dt>Rail</dt><dd>${escapeHtml(railText(chosen.rail))}</dd>
<dt>Plan</dt><dd>${escapeHtml(chosen.plan)}</dd>
<dt>Amount</dt><dd>${escapeHtml(chosen.amount)} ${escapeHtml(chosen.currency)}</dd>
<dt>Interval</dt><dd>${escapeHtml(intervalText(chosen.interval))}</dd>
<dt>Charges</dt><dd>${escapeHtml(chargeText(chosen.allowedTransactionCount))}</dd>
<dt>Merchant category</dt><dd>${escapeHtml(category)}</dd>
<dt>Commitment</dt><dd>${escapeHtml(commitmentText(chosen.commitmentMonths))}</dd>
<dt>Price status</dt><dd>${escapeHtml(chosen.priceStatus)}</dd>
<dt>Expires</dt><dd><time datetime="${escapeHtml(model.expiresAt)}">${escapeHtml(model.expiresAt)}</time></dd>
<dt>Terms hash</dt><dd><code class="hash">${escapeHtml(model.presentedTermsHash)}</code></dd>
</dl>
<p class="hint">what this binds is the offer, vendor, plan, rail, currency, amount, interval, single or multiple charges, merchant category, commitment, and expiry. Approving submits this hash unchanged.</p>
</section>`;
}

/** Show the existing merchant category or mark it as required. */
function merchantCategoryText(model: ApprovalPageModel): string {
  const code = model.chosen.merchantCategoryCode;
  if (code !== undefined) return code;
  if (model.needsMcc) return 'Required at approval';
  return 'Not set';
}

/** Show readable billing intervals alongside their original codes. */
function intervalText(interval: string): string {
  switch (interval) {
    case 'MONTHLY':
      return 'Monthly (MONTHLY)';
    case 'PER_TRANSACTION':
      return 'Per transaction (PER_TRANSACTION)';
    case 'ALL_TIME':
      return 'All time (ALL_TIME)';
    default:
      return interval;
  }
}

/** SINGLE and MULTIPLE indicate one or multiple charges. */
function chargeText(count: string): string {
  switch (count) {
    case 'SINGLE':
      return 'Single charge (SINGLE)';
    case 'MULTIPLE':
      return 'Multiple charges (MULTIPLE)';
    default:
      return count;
  }
}

/** Express commitments in months; zero means no minimum term. */
function commitmentText(months: number): string {
  if (months === 0) return 'No commitment (0 months)';
  if (months === 1) return '1 month';
  return `${months} months`;
}

/** List decision reasons as chips; escape unknown codes. */
function reasonSection(model: ApprovalPageModel): string {
  const items = model.reasons.length === 0
    ? '<p>No reason codes.</p>'
    : `<ul class="chips" aria-label="Decision reasons">${model.reasons.map((reason) => `<li>${escapeHtml(reasonText(reason))}</li>`).join('')}</ul>`;
  return `<section aria-labelledby="reasons"><h2 id="reasons">Reasons</h2>${items}</section>`;
}

/** Map known reason codes to fixed approval-page labels. */
function reasonText(code: string): string {
  switch (code) {
    case 'price_unverified':
      return PRICE_UNVERIFIED_CHIP;
    case 'mcc_required_at_approval':
      return 'Merchant category is required at approval';
    case 'human_approval_required':
      return 'Human approval required';
    default:
      return code.replaceAll('_', ' ');
  }
}

/** Comparison table; mark x402 offers as not payable by card. */
function comparisonSection(model: ApprovalPageModel): string {
  if (model.comparison.length === 0) {
    return `<section aria-labelledby="comparison"><h2 id="comparison">Comparison</h2><p>No offers in the comparison.</p></section>`;
  }
  const rows = model.comparison.map((row) => comparisonRow(row)).join('');
  return `<section aria-labelledby="comparison"><h2 id="comparison">Comparison</h2>
<div class="table-wrap"><table>
<caption>Offer comparison</caption>
<thead><tr>
<th scope="col">Offer</th>
<th scope="col">Vendor</th>
<th scope="col">Plan</th>
<th scope="col">Rail</th>
<th scope="col">Upfront</th>
<th scope="col">Per charge</th>
<th scope="col">Horizon</th>
<th scope="col">Notes</th>
<th scope="col">Result</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div></section>`;
}

/** Render one comparison row. */
function comparisonRow(row: ApprovalComparisonRow): string {
  const x402 = row.rail === 'x402';
  const rail = x402
    ? `${escapeHtml(row.rail)}<span class="flag">not payable by card (x402)</span>`
    : escapeHtml(row.rail);
  return `<tr${x402 ? ' class="x402"' : ''}>
<th scope="row">${escapeHtml(row.offerId)}</th>
<td>${escapeHtml(row.vendor)}</td>
<td>${escapeHtml(row.plan)}</td>
<td>${rail}</td>
<td class="num">${escapeHtml(row.upfront)}</td>
<td class="num">${escapeHtml(row.perCharge)}</td>
<td class="num">${escapeHtml(row.horizon)}</td>
<td>${notesCell(row.notes)}</td>
<td>${resultCell(row)}</td>
</tr>`;
}

/** Escape each note before adding it to the list. */
function notesCell(notes: readonly string[]): string {
  if (notes.length === 0) return '\u2014';
  return `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`;
}

/** Show rule results; x402 offers always say Not payable by card. */
function resultCell(row: ApprovalComparisonRow): string {
  if (row.rail === 'x402') return 'Not payable by card';
  if (row.passed) return 'Passed';
  if (row.failedCodes.length === 0) return 'Failed';
  return `Failed: ${row.failedCodes.map((code) => escapeHtml(code)).join(', ')}`;
}

/** List excluded offers with an explanation for region_unavailable. */
function excludedSection(model: ApprovalPageModel): string {
  if (model.excluded.length === 0) return '';
  const rows = model.excluded.map((item) => `<tr>
<th scope="row">${escapeHtml(item.offerId)}</th>
<td>${escapeHtml(item.reason)}</td>
<td>${escapeHtml(exclusionText(item.reason))}</td>
</tr>`).join('');
  return `<section aria-labelledby="excluded"><h2 id="excluded">Excluded offers</h2>
<div class="table-wrap"><table>
<caption>Excluded offers</caption>
<thead><tr>
<th scope="col">Offer</th>
<th scope="col">Reason</th>
<th scope="col">Explanation</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div></section>`;
}

/** Explain known exclusions and mark unknown reasons as excluded. */
function exclusionText(reason: string): string {
  if (reason === 'region_unavailable') {
    return 'Unavailable in the billing or card region, so this offer was excluded from comparison.';
  }
  return 'Excluded from comparison.';
}

/** Show masked card details only when a card exists. */
function cardSection(model: ApprovalPageModel): string {
  const card = model.card;
  if (card === undefined) return '';
  const lines = [
    pair('Card id', card.cardId),
    pair('Masked number', card.maskedNumber),
    pair('Card status', card.status),
  ].filter((line) => line !== '').join('');
  const body = lines === '' ? '<p>Card recorded without display fields.</p>' : `<dl>${lines}</dl>`;
  return `<section aria-labelledby="issued-card"><h2 id="issued-card">Card</h2>${body}</section>`;
}

/** Omit absent optional fields and escape present values. */
function pair(term: string, value: string | undefined): string {
  if (value === undefined) return '';
  return `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`;
}

/** Show the rail bound into the hash and flag x402 as not payable by card. */
function railText(rail: PaymentRail): string {
  if (rail === 'x402') return 'x402 (not payable by card)';
  return rail;
}

/** Keep approve and reject fields in separate forms; disable them unless requested. */
function decisionSection(model: ApprovalPageModel, options: ApprovalRenderOptions): string {
  const locked = model.status === 'requested' ? '' : ' disabled';
  const reject = `<form class="reject-form" method="post" action="${escapeHtml(segmentPath(['approvals', model.approvalRequestId, 'reject']))}" autocomplete="off">
<fieldset${locked}>
<input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}" autocomplete="off">
<button type="submit" class="reject" aria-describedby="request-status">Reject</button>
</fieldset>
</form>`;
  if (model.chosen.rail !== 'card') {
    return `<section aria-labelledby="decision"><h2 id="decision">Decision</h2>
<div class="decision">
<p class="warning">This rail is not payable by card, so the page has no approval form.</p>
${reject}
</div>
</section>`;
  }
  const summary = decisionSummary(model);
  return `<section aria-labelledby="decision"><h2 id="decision">Decision</h2>
<div class="decision">
<form class="approve-form" method="post" action="${escapeHtml(segmentPath(['approvals', model.approvalRequestId, 'approve']))}" autocomplete="off">
<fieldset${locked}>
<p>${escapeHtml(summary)}</p>
<label for="approval-nonce">Approval nonce</label>
<p id="nonce-hint" class="hint">${escapeHtml(model.nonceHint)}</p>
<input id="approval-nonce" name="nonce" type="text" required autocomplete="off" spellcheck="false" aria-describedby="nonce-hint">
${mccField(model)}
<input type="hidden" name="presentedTermsHash" value="${escapeHtml(model.presentedTermsHash)}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}" autocomplete="off">
<button type="submit" class="approve" aria-describedby="request-status">Approve exactly these terms</button>
</fieldset>
</form>
${reject}
</div>
</section>`;
}

/** Repeat the submitted terms next to the button. */
function decisionSummary(model: ApprovalPageModel): string {
  const chosen: ApprovalChosenTerms = model.chosen;
  const category = model.chosen.merchantCategoryCode !== undefined
    ? `merchant category ${model.chosen.merchantCategoryCode}`
    : model.needsMcc
      ? 'merchant category required at approval'
      : 'merchant category not set';
  return `Rail ${chosen.rail}, amount ${chosen.amount} ${chosen.currency}, ${intervalText(chosen.interval)}, ${chargeText(chosen.allowedTransactionCount)}, ${category}, commitment ${commitmentText(chosen.commitmentMonths)}.`;
}

/** Render the operator-supplied merchant category input only when needsMcc is true. */
function mccField(model: ApprovalPageModel): string {
  if (!model.needsMcc) return '';
  return `<label for="merchant-category-code">Merchant category code</label>
<p id="mcc-hint" class="hint">Four digits. Submitting this code binds it to the approval.</p>
<input id="merchant-category-code" name="merchantCategoryCode" type="text" required inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" aria-describedby="mcc-hint">`;
}
