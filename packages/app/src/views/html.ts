// Shared document shell with inline styles and no external assets.

import type { ConsoleRunMode } from './models.js';
import { runModeLabel } from './run-mode.js';

/** Escape text and attribute values; replace ampersands first to avoid double escaping. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Encode each path segment so slashes in approval IDs cannot change routing. */
export function segmentPath(segments: readonly string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

const PAGE_CSS = `
:root { color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, sans-serif;
  line-height: 1.5;
  color: #1c1917;
  background: #fafaf9;
}
a { color: #134e4a; }
a:focus-visible, button:focus-visible, input:focus-visible {
  outline: 2px solid #134e4a;
  outline-offset: 2px;
}
.skip {
  position: absolute;
  left: 0.5rem;
  top: -3rem;
  background: #fff;
  padding: 0.4rem 0.6rem;
}
.skip:focus { top: 0.5rem; }
.top, main, footer {
  max-width: 60rem;
  margin: 0 auto;
  padding: 0 1.25rem;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding-top: 1rem;
  padding-bottom: 1rem;
}
.brand { margin: 0; font-weight: 700; }
.brand a { color: inherit; text-decoration: none; }
nav a { margin-left: 1rem; }
main { padding-bottom: 2rem; }
footer { padding-bottom: 2rem; color: #57534e; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 0.4rem; }
h2 { font-size: 1.15rem; margin: 0 0 0.6rem; }
section { margin-top: 1.5rem; }
.hint { color: #57534e; margin: 0.25rem 0 0; }
.banner {
  background: #fffbeb;
  color: #92400e;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  padding: 0.75rem 0.9rem;
}
.terms {
  background: #fff;
  border: 1px solid #e7e5e4;
  border-left: 4px solid #134e4a;
  border-radius: 12px;
  padding: 1rem 1.1rem;
}
.product { margin: 0.2rem 0; font-size: 1.05rem; }
.amount { margin: 0.15rem 0 0.4rem; font-size: 2.4rem; line-height: 1.1; font-weight: 700; }
.num { font-variant-numeric: tabular-nums; }
dl { display: grid; grid-template-columns: minmax(8rem, 14rem) minmax(0, 1fr); gap: 0.35rem 1rem; margin: 0.8rem 0 0; }
dt { color: #57534e; }
dd { margin: 0; overflow-wrap: anywhere; }
.hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
  background: #f5f5f4;
  border-radius: 8px;
  padding: 0.55rem 0.7rem;
}
.chips { display: flex; flex-wrap: wrap; gap: 0.4rem; list-style: none; padding: 0; margin: 0; }
.chips li { background: #f5f5f4; border: 1px solid #e7e5e4; border-radius: 999px; padding: 0.15rem 0.7rem; }
.table-wrap { overflow-x: auto; border: 1px solid #e7e5e4; border-radius: 10px; background: #fff; }
table { width: 100%; border-collapse: collapse; }
caption { text-align: left; font-weight: 700; padding: 0.65rem; }
th, td { text-align: left; vertical-align: top; padding: 0.55rem 0.65rem; border-bottom: 1px solid #e7e5e4; }
th { font-size: 0.8rem; color: #57534e; }
td ul { margin: 0; padding-left: 1.1rem; }
tr.x402 { background: #fff7ed; }
.flag { display: block; font-weight: 700; }
.badge { display: inline-block; border-radius: 999px; padding: 0.2rem 0.7rem; font-weight: 700; }
.badge-ok { background: #ecfdf5; color: #065f46; }
.badge-bad { background: #fff1f2; color: #9f1239; }
.error { color: #9f1239; font-weight: 700; }
.decision { display: grid; gap: 0.75rem; max-width: 32rem; }
fieldset { border: 0; margin: 0; padding: 0; min-inline-size: 0; }
fieldset:disabled { opacity: 0.55; }
.warning { color: #92400e; font-weight: 700; }
tr.unconfirmed, tr.mismatch { background: #fffbeb; }
label { display: block; font-weight: 600; margin-top: 0.8rem; }
input[type="text"] {
  width: 100%;
  max-width: 28rem;
  margin-top: 0.25rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid #d6d3d1;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}
button { font: inherit; }
.approve, .reject { width: 100%; min-height: 3rem; border-radius: 10px; padding: 0.75rem 1rem; cursor: pointer; }
.approve { margin-top: 0.9rem; background: #134e4a; color: #fff; border: 1px solid #134e4a; font-weight: 700; font-size: 1.05rem; }
.reject { background: #fff; color: #9f1239; border: 1px solid #9f1239; }
button:disabled { opacity: 0.55; cursor: not-allowed; }
@media (max-width: 40rem) {
  .top { flex-direction: column; align-items: flex-start; }
  nav a { margin-left: 0; margin-right: 1rem; }
  dl { grid-template-columns: 1fr; }
}
`;

/** Content-Security-Policy for these documents.
 * Inline styles require style-src 'unsafe-inline'.
 * No scripts or external assets are used; default-src 'none' blocks scripts.
 * Servers must send this policy unchanged. */
export const CONSOLE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Build the complete script-free document; callers must not append content. */
export function renderDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Shared run-mode heading; runModeLabel keeps offline pages free of sandbox labels. */
export function runModeBlock(mode: ConsoleRunMode | undefined): string {
  return `<p id="run-mode">${escapeHtml(runModeLabel(mode))}</p>`;
}

/** Shared header, main region, and footer; repeat the actual run-mode label. */
export function consoleBody(
  main: string,
  current: 'approvals' | 'audit',
  runMode: ConsoleRunMode | undefined,
): string {
  return `<a class="skip" href="#content">Skip to content</a>
<header class="top">
<p class="brand"><a href="/">Spendkey for Cards</a></p>
<nav aria-label="Console">
<a href="/"${current === 'approvals' ? ' aria-current="page"' : ''}>Approvals</a>
<a href="/audit"${current === 'audit' ? ' aria-current="page"' : ''}>Audit</a>
</nav>
</header>
<main id="content">
${main}
</main>
<footer>
<p>${escapeHtml(runModeLabel(runMode))}. Card numbers on these pages are masked.</p>
</footer>`;
}
