/**
 * Renders the HTML page written by scripts/report.ts. Self-contained: inline CSS and JS, works
 * offline (fonts fall back to system faces), light and dark themes.
 */
import type { RiskReport } from '../src/services/risk-analyzer.js';

export type CheckGroup =
  'Discovery' | 'Pull requests' | 'Repository' | 'Resources & prompts' | 'Error handling';

export interface CheckResult {
  group: CheckGroup;
  call: string;
  args: string;
  /** What a correct server does: return data, or fail cleanly with a typed error. */
  expect: 'success' | 'error';
  /** True when the server behaved as expected. */
  ok: boolean;
  detail: string;
  ms: number;
}

export interface Note {
  severity: 'medium' | 'low' | 'info';
  title: string;
  body: string;
  where: string;
}

export interface PrCard {
  number: number;
  url: string;
  title: string;
  state: string;
  date: string;
  files: number;
  additions: number;
  deletions: number;
  commits: number;
  risk: RiskReport;
  configMissed: string[];
}

export interface ReportData {
  repo: string;
  repoUrl: string;
  serverVersion: string;
  viewer: string;
  generatedAt: Date;
  releaseFrom: string;
  checks: CheckResult[];
  prs: PrCard[];
  notes: Note[];
  releaseMarkdown: string;
}

const esc = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const num = (n: number) => n.toLocaleString('en-US');
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// One colour per signal, in order of appearance on the bar.
const SEGMENTS = ['var(--seg-1)', 'var(--seg-2)', 'var(--seg-3)', 'var(--seg-4)', 'var(--seg-5)'];

function prCard(card: PrCard): string {
  const { risk } = card;
  const weighted = risk.signals.filter((signal) => signal.weight > 0);
  const segments = weighted
    .map(
      (signal, i) =>
        `<span style="width:${Math.min(100, signal.weight)}%;background:${SEGMENTS[i % SEGMENTS.length] ?? ''}"></span>`,
    )
    .join('');
  const signals = risk.signals
    .map((signal) => {
      const i = weighted.indexOf(signal);
      const swatch = i >= 0 ? (SEGMENTS[i % SEGMENTS.length] ?? '') : 'var(--line)';
      return `<li><i style="background:${swatch}"></i><span><code>${esc(signal.id)}</code> ${esc(signal.message)}</span><span class="w">+${signal.weight}</span></li>`;
    })
    .join('');
  const focus = risk.focusFiles.map((path) => `<li>${esc(path)}</li>`).join('');
  const missed = card.configMissed.length
    ? `<span class="gap">Not scored: ${card.configMissed.map(esc).join(', ')}</span>`
    : '';
  const levelClass = risk.level === 'high' ? 'fail' : risk.level === 'medium' ? 'warn' : 'pass';
  const aria = weighted.map((signal) => `${signal.weight} from ${signal.id}`).join(', ');

  return `<article class="risk">
    <div class="risk-top">
      <div class="t">
        <a href="${esc(card.url)}">#${card.number} · ${esc(card.state)} ${esc(day(card.date))}</a>
        <h3>${esc(card.title)}</h3>
      </div>
      <div class="score">
        <div class="n">${risk.score}<small>/100</small></div>
        <span class="pill ${levelClass}">${esc(risk.level)}</span>
      </div>
    </div>
    <div>
      <div class="bar" role="img" aria-label="Score ${risk.score} of 100${aria ? `: ${esc(aria)}` : ''}">${segments}</div>
      <div class="scale"><span>0</span><span>20 medium</span><span>50 high</span><span>100</span></div>
    </div>
    ${signals ? `<ul class="signals">${signals}</ul>` : '<p class="muted">No risk signals.</p>'}
    <div class="focus">
      <span class="eyebrow">Suggested reading order</span>
      ${focus ? `<ol>${focus}</ol>` : '<p class="muted">No source files.</p>'}
      ${missed}
    </div>
    <div class="stats">
      <div><b>${num(card.files)}</b><span>files</span></div>
      <div><b>+${num(card.additions)}</b><span>added</span></div>
      <div><b>−${num(card.deletions)}</b><span>removed</span></div>
      <div><b>${num(card.commits)}</b><span>commits</span></div>
    </div>
  </article>`;
}

function noteItem(note: Note): string {
  const pill = note.severity === 'medium' ? 'warn' : 'info';
  return `<div class="item sev-${note.severity}">
    <div class="ih"><h3>${esc(note.title)}</h3><span class="pill ${pill}">${esc(note.severity)}</span></div>
    <p>${esc(note.body)}</p>
    <span class="loc">${esc(note.where)}</span>
  </div>`;
}

// The repo is in the page header, so drop it from arguments: "owner/repo#2" → "#2".
function shortArgs(args: string, repo: string): string {
  return args
    .split(`https://github.com/${repo}/pull/`)
    .join('…/pull/')
    .split(`https://github.com/${repo}`)
    .join('repo URL')
    .split(`devflow://repos/${repo}/`)
    .join('devflow://repos/…/')
    .split(`${repo}#`)
    .join('#')
    .split(`repo ${repo}`)
    .join('this repo');
}

function logRow(check: CheckResult, index: number, repo: string): string {
  const kind = !check.ok ? 'fail' : check.expect === 'error' ? 'err' : 'ok';
  const pill = !check.ok
    ? '<span class="pill fail">fail</span>'
    : check.expect === 'error'
      ? '<span class="pill info">expected error</span>'
      : '<span class="pill pass">pass</span>';
  return `<tr data-k="${kind}">
    <td class="num">${index + 1}</td>
    <td class="call">${esc(check.call)}<span class="grp">${esc(check.group)}</span></td>
    <td class="args" title="${esc(check.args)}">${esc(shortArgs(check.args, repo))}</td>
    <td class="result">${esc(check.detail)}</td>
    <td class="ms">${num(check.ms)}</td>
    <td>${pill}</td>
  </tr>`;
}

export function renderReport(data: ReportData): string {
  const total = data.checks.length;
  const passed = data.checks.filter((check) => check.ok).length;
  const failed = total - passed;
  const errorCases = data.checks.filter((check) => check.expect === 'error');
  const errorsOk = errorCases.filter((check) => check.ok).length;
  const toolNames = new Set(
    data.checks
      .filter((check) => !check.call.includes('/') && check.group !== 'Discovery')
      .map((check) => check.call),
  );
  const resourceReads = data.checks.filter((check) => check.call === 'resources/read').length;
  const totalMs = data.checks.reduce((sum, check) => sum + check.ms, 0);
  const allGood = failed === 0;
  const counts = {
    ok: data.checks.filter((check) => check.ok && check.expect === 'success').length,
    err: errorCases.length,
    fail: failed,
  };
  const generated = data.generatedAt.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DevFlow Report · ${esc(data.repo)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
:root {
  --bg: #f5f7f9; --surface: #ffffff; --ink: #142028; --muted: #5b6b77; --line: #dde4ea;
  --accent: #1d5fa8; --accent-soft: #e4eef9;
  --pass: #1d7a4c; --pass-soft: #e2f3ea; --warn: #9a6200; --warn-soft: #fbf0d9;
  --fail: #b3362b; --fail-soft: #fbe6e3; --code-bg: #eef2f5;
  --seg-1: #d08a1a; --seg-2: #7f93a3; --seg-3: #b3362b; --seg-4: #1d5fa8; --seg-5: #6a5aa8;
  --font-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1519; --surface: #172026; --ink: #e3eaef; --muted: #93a3ae; --line: #26323a;
    --accent: #6fa8e8; --accent-soft: #1a2c40;
    --pass: #5cc48f; --pass-soft: #15301f; --warn: #e2ab4c; --warn-soft: #33270f;
    --fail: #ef7d71; --fail-soft: #3a1c19; --code-bg: #1d2830;
    --seg-1: #e2a043; --seg-2: #6d8191; --seg-3: #ef7d71; --seg-4: #6fa8e8; --seg-5: #a497e0;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-sans); font-size: 15px; line-height: 1.55; padding: 0 16px; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 40px 0 64px; display: grid; gap: 40px; }
h1, h2, h3 { margin: 0; text-wrap: balance; line-height: 1.2; }
h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.01em; }
h2 { font-size: 19px; font-weight: 600; }
h3 { font-size: 15px; font-weight: 600; }
p { margin: 0; }
code { font-family: var(--font-mono); font-size: 0.88em; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.muted { color: var(--muted); font-size: 14px; }
.eyebrow { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.section { display: grid; gap: 16px; }
.section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; }
.section-head p { color: var(--muted); font-size: 14px; }
header { display: grid; gap: 12px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 22px; color: var(--muted); font-size: 14px; }
.meta b { color: var(--ink); font-weight: 500; }

.verdict { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; display: grid; grid-template-columns: minmax(220px, 1.3fr) repeat(4, 1fr); overflow: hidden; }
.verdict > div { padding: 18px 20px; display: grid; gap: 4px; align-content: start; border-left: 1px solid var(--line); min-width: 0; }
.verdict > div:first-child { border-left: 0; }
.verdict .first.good { background: var(--pass-soft); }
.verdict .first.bad { background: var(--fail-soft); }
.verdict .big { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.verdict .good .big { color: var(--pass); }
.verdict .bad .big { color: var(--fail); }
.verdict .lbl { font-size: 13px; color: var(--muted); }
@media (max-width: 820px) {
  .verdict { grid-template-columns: 1fr 1fr; }
  .verdict > div { border-left: 0; border-top: 1px solid var(--line); }
  .verdict > div:first-child { grid-column: 1 / -1; border-top: 0; }
  .verdict > div:nth-child(odd):not(:first-child) { border-left: 1px solid var(--line); }
}

.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; font-family: var(--font-mono); }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.pass { color: var(--pass); background: var(--pass-soft); }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.fail { color: var(--fail); background: var(--fail-soft); }
.pill.info { color: var(--accent); background: var(--accent-soft); }

.risk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.risk { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 20px; display: grid; gap: 16px; align-content: start; min-width: 0; }
.risk-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.risk-top .t { display: grid; gap: 2px; min-width: 0; }
.risk-top .t a { font-family: var(--font-mono); font-size: 13px; text-decoration: none; }
.score { text-align: right; flex-shrink: 0; display: grid; justify-items: end; gap: 4px; }
.score .n { font-size: 32px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; }
.score .n small { font-size: 14px; color: var(--muted); font-weight: 400; }
.bar { height: 10px; background: var(--code-bg); border-radius: 5px; display: flex; overflow: hidden; }
.bar span { height: 100%; }
.scale { position: relative; height: 16px; margin-top: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
.scale span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.scale span:nth-child(1) { left: 0; transform: none; }
.scale span:nth-child(2) { left: 20%; }
.scale span:nth-child(3) { left: 50%; }
.scale span:nth-child(4) { right: 0; transform: none; }
.signals { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.signals li { display: grid; grid-template-columns: 12px 1fr auto; gap: 10px; align-items: baseline; font-size: 14px; }
.signals li i { width: 10px; height: 10px; border-radius: 2px; display: block; transform: translateY(1px); }
.signals li .w { font-family: var(--font-mono); font-size: 13px; color: var(--muted); }
.focus { display: grid; gap: 6px; }
.focus ol { margin: 0; padding-left: 22px; font-family: var(--font-mono); font-size: 12.5px; display: grid; gap: 2px; }
.focus ol li { overflow-wrap: anywhere; }
.focus .gap { font-size: 13px; color: var(--warn); overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; border-top: 1px solid var(--line); padding-top: 14px; }
.stats div { display: grid; }
.stats b { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stats span { font-size: 12px; color: var(--muted); }

.items { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.item { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--line); border-radius: 8px; padding: 14px 16px; display: grid; gap: 6px; align-content: start; min-width: 0; }
.item.sev-medium { border-left-color: var(--warn); }
.item.sev-low { border-left-color: var(--seg-2); }
.item.sev-info { border-left-color: var(--accent); }
.item .ih { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.item p { font-size: 14px; color: var(--muted); overflow-wrap: anywhere; }
.item .loc { font-family: var(--font-mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }

.filters { display: flex; flex-wrap: wrap; gap: 6px; }
.filters button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
.filters button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.filters button:disabled { opacity: 0.45; cursor: default; }
.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; min-width: 860px; font-size: 13.5px; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-family: var(--font-mono); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 500; background: var(--bg); }
tr:last-child td { border-bottom: 0; }
tr[data-k="fail"] td { background: var(--fail-soft); }
td.num, td.ms { font-family: var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
td.ms { text-align: right; }
td.call { font-family: var(--font-mono); font-size: 12.5px; white-space: nowrap; }
td.call .grp { display: block; font-family: var(--font-sans); font-size: 12px; color: var(--muted); }
td.args { font-family: var(--font-mono); font-size: 12px; color: var(--muted); max-width: 280px; overflow-wrap: anywhere; }
td.result { min-width: 280px; overflow-wrap: anywhere; }

details { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
summary { cursor: pointer; padding: 14px 18px; font-weight: 600; }
details pre { margin: 0; padding: 0 18px 18px; font-family: var(--font-mono); font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); }
footer { color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">DevFlow MCP test run · ${esc(generated)}</div>
    <h1>${esc(data.repo)}</h1>
    <div class="meta">
      <span>Server <b>${esc(data.serverVersion)}</b></span>
      <span>Repository <b><a href="${esc(data.repoUrl)}">${esc(data.repoUrl)}</a></b></span>
      <span>Authenticated as <b>${esc(data.viewer)}</b></span>
    </div>
  </header>

  <section class="verdict" aria-label="Run summary">
    <div class="first ${allGood ? 'good' : 'bad'}">
      <span class="lbl">Overall</span>
      <span class="big">${passed} / ${total}</span>
      <span class="lbl">${allGood ? 'checks behaved as expected' : `${failed} check${failed === 1 ? '' : 's'} failed`}</span>
    </div>
    <div><span class="lbl">Tools covered</span><span class="big">${toolNames.size} / 6</span><span class="lbl">across ${data.prs.length} PR${data.prs.length === 1 ? '' : 's'}</span></div>
    <div><span class="lbl">Resources read</span><span class="big">${resourceReads}</span><span class="lbl">checklists and guidelines</span></div>
    <div><span class="lbl">Bad inputs</span><span class="big">${errorsOk} / ${errorCases.length}</span><span class="lbl">clean typed errors</span></div>
    <div><span class="lbl">Total time</span><span class="big">${(totalMs / 1000).toFixed(1)}s</span><span class="lbl">live GitHub calls</span></div>
  </section>

  ${
    data.prs.length
      ? `<section class="section" aria-labelledby="risk-h">
    <div class="section-head"><h2 id="risk-h">Pull request risk</h2><p>From analyze_pr_risk, checked against get_pr_context</p></div>
    <div class="risk-grid">${data.prs.map(prCard).join('')}</div>
  </section>`
      : ''
  }

  ${
    data.notes.length
      ? `<section class="section" aria-labelledby="notes-h">
    <div class="section-head"><h2 id="notes-h">Observations</h2><p>Gaps and context found during the run</p></div>
    <div class="items">${data.notes.map(noteItem).join('')}</div>
  </section>`
      : ''
  }

  <section class="section" aria-labelledby="log-h">
    <div class="section-head">
      <h2 id="log-h">Call log</h2>
      <div class="filters" role="group" aria-label="Filter calls">
        <button type="button" data-f="all" aria-pressed="true">All ${total}</button>
        <button type="button" data-f="ok" aria-pressed="false">Passed ${counts.ok}</button>
        <button type="button" data-f="err" aria-pressed="false">Error cases ${counts.err}</button>
        <button type="button" data-f="fail" aria-pressed="false"${counts.fail ? '' : ' disabled'}>Failed ${counts.fail}</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Call</th><th>Arguments</th><th>Result</th><th style="text-align:right">ms</th><th>Status</th></tr></thead>
        <tbody id="log">${data.checks.map((check, i) => logRow(check, i, data.repo)).join('')}</tbody>
      </table>
    </div>
  </section>

  ${
    data.releaseMarkdown
      ? `<details><summary>Release notes Markdown (from ${esc(data.releaseFrom)})</summary><pre>${esc(data.releaseMarkdown)}</pre></details>`
      : ''
  }

  <footer>Generated by <code>npm run report</code>. The server was started over stdio exactly as an MCP host starts it; every result above came from live GitHub data.</footer>
</div>
<script>
(function () {
  var buttons = document.querySelectorAll('.filters button');
  var rows = document.querySelectorAll('#log tr');
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      var f = b.getAttribute('data-f');
      buttons.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      rows.forEach(function (r) { r.hidden = !(f === 'all' || r.getAttribute('data-k') === f); });
    });
  });
})();
</script>
</body>
</html>
`;
}
