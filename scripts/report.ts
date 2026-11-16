/**
 * Live test report: launches the built server over stdio (exactly as an MCP host would), runs
 * every tool, resource and prompt against a real repository, checks each answer, then writes an
 * HTML report and opens it in your browser.
 *
 *   npm run report -- <owner/repo | repository URL> [options]
 *
 *   --prs 1,2          Pull requests to test (default: the most recently updated ones)
 *   --max-prs 3        How many recent PRs to pick when --prs is not given (default 3)
 *   --from v1.2.0      Start for generate_release_notes: tag, branch, SHA or date
 *                      (default: the day before the oldest merged PR picked, else 30 days ago)
 *   --out file.html    Where to write the report (default: reports/devflow-<owner>-<repo>-<time>.html)
 *   --no-open          Don't open the report in a browser
 *
 * Uses GITHUB_TOKEN, else your GitHub CLI login. Exit code is 1 if any check fails.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Octokit } from '@octokit/rest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveGitHubToken } from '../src/config.js';
import type { PrContext } from '../src/services/pr-context.js';
import type { RiskReport } from '../src/services/risk-analyzer.js';
import type { PrDiff } from '../src/services/pr-diff.js';
import type { ReleaseNotes } from '../src/services/release-notes.js';
import type { ReviewQueue } from '../src/services/review-queue.js';
import type { Activity } from '../src/services/activity.js';
import {
  renderReport,
  type CheckGroup,
  type CheckResult,
  type Note,
  type PrCard,
} from './report-html.js';

/* eslint-disable no-console -- this script is a CLI, not the server; stdout is fine here. */

const EXPECTED_TOOLS = [
  'get_pr_context',
  'analyze_pr_risk',
  'get_pr_diff',
  'list_review_queue',
  'get_my_activity',
  'generate_release_notes',
];

const ALL_SIGNALS = [
  'LARGE_CHANGE',
  'MANY_FILES',
  'NO_TEST_CHANGES',
  'SENSITIVE_PATHS',
  'DEPENDENCY_CHANGES',
  'LOCKFILE_WITHOUT_MANIFEST',
  'LARGE_FILE_CHANGES',
  'MISSING_DESCRIPTION',
  'CI_FAILING',
  'CI_PENDING',
  'DRAFT',
  'PARTIAL_FILE_LIST',
];

// Build and tooling config that changes how code compiles, lints or ships.
const CONFIG_FILE =
  /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|(vite|vitest|webpack|rollup|tsup|jest|babel|next|nuxt|svelte|astro|tailwind|postcss|eslint|prettier)\.config\.[cm]?[jt]s|\.eslintrc[^/]*|\.prettierrc[^/]*|\.babelrc|\.npmrc|\.nvmrc|Dockerfile|docker-compose[^/]*\.ya?ml)$/;

// --- Arguments -----------------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prs: { type: 'string' },
    'max-prs': { type: 'string', default: '3' },
    from: { type: 'string' },
    out: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
  },
});

const target = positionals[0];
const repoMatch = target
  ? /^(?:https?:\/\/[^/]+\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(
      target.trim(),
    )
  : null;
if (!repoMatch) {
  console.error(
    'Usage: npm run report -- <owner/repo | https://github.com/owner/repo> [--prs 1,2] [--max-prs 3] [--from <tag|date>] [--out file.html] [--no-open]',
  );
  process.exit(2);
}
const owner = repoMatch[1] ?? '';
const repo = repoMatch[2] ?? '';
const fullName = `${owner}/${repo}`;

// --- Terminal output -----------------------------------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = paint('32');
const red = paint('31');
const dim = paint('2');
const bold = paint('1');

let currentGroup: CheckGroup | undefined;
function printCheck(result: CheckResult): void {
  if (result.group !== currentGroup) {
    currentGroup = result.group;
    console.log(`\n${bold(result.group)}`);
  }
  const mark = result.ok ? green('✓') : red('✗');
  const label = `${result.call} ${dim(result.args)}`;
  console.log(`  ${mark} ${label} ${dim(`${result.ms}ms`)}`);
  console.log(`    ${result.ok ? dim(result.detail) : red(result.detail)}`);
}

// --- Check helpers -------------------------------------------------------------------------------

const checks: CheckResult[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function check(
  group: CheckGroup,
  call: string,
  args: string,
  expect: 'success' | 'error',
  run: () => Promise<string>,
): Promise<void> {
  const startedAt = performance.now();
  let ok = true;
  let detail: string;
  try {
    detail = await run();
  } catch (error) {
    ok = false;
    detail = error instanceof Error ? error.message : String(error);
  }
  const result: CheckResult = {
    group,
    call,
    args,
    expect,
    ok,
    detail,
    ms: Math.round(performance.now() - startedAt),
  };
  checks.push(result);
  printCheck(result);
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env, DEVFLOW_LOG_LEVEL: process.env.DEVFLOW_LOG_LEVEL ?? 'silent' },
  stderr: 'inherit',
});
const client = new Client({ name: 'devflow-report', version: '0.0.0' });

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(textOf(result));
  assert(result.structuredContent, `${name} returned no structuredContent`);
  return result.structuredContent as T;
}

async function expectToolError(
  name: string,
  args: Record<string, unknown>,
  code: string,
): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  assert(result.isError, `Expected a [${code}] error, but the call succeeded`);
  const text = textOf(result);
  assert(text.startsWith(`[${code}]`), `Expected [${code}], got: ${text}`);
  return text;
}

async function readResourceText(uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const first = result.contents[0];
  return first && 'text' in first ? first.text : '';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const signed = (n: number) => n.toLocaleString('en-US');

// --- Discover pull requests ----------------------------------------------------------------------

const apiUrl = process.env.GITHUB_API_URL;
const { token } = await resolveGitHubToken({ token: process.env.GITHUB_TOKEN, apiUrl });
const octokit = new Octokit({ auth: token, ...(apiUrl ? { baseUrl: apiUrl } : {}) });

interface PickedPr {
  number: number;
  mergedAt: string | null;
}

async function pickPrs(): Promise<PickedPr[]> {
  if (values.prs) {
    const numbers = values.prs
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    return Promise.all(
      numbers.map(async (number) => {
        const { data } = await octokit.pulls.get({ owner, repo, pull_number: number });
        return { number, mergedAt: data.merged_at };
      }),
    );
  }
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: Math.max(1, Math.min(10, Number(values['max-prs']) || 3)),
  });
  return data.map((pr) => ({ number: pr.number, mergedAt: pr.merged_at }));
}

function defaultReleaseFrom(prs: PickedPr[]): string {
  if (values.from) return values.from;
  const merged = prs
    .map((pr) => pr.mergedAt)
    .filter((date): date is string => Boolean(date))
    .sort();
  const oldest = merged[0];
  const start = oldest ? new Date(oldest) : new Date();
  start.setUTCDate(start.getUTCDate() - (oldest ? 1 : 30));
  return start.toISOString().slice(0, 10);
}

const { data: repoInfo } = await octokit.repos.get({ owner, repo });
const prs = await pickPrs();
const releaseFrom = defaultReleaseFrom(prs);

console.log(bold(`DevFlow report for ${fullName}`));
console.log(
  dim(
    `PRs: ${prs.length ? prs.map((pr) => `#${pr.number}`).join(', ') : 'none'} · release notes from ${releaseFrom}`,
  ),
);

// --- Run the suite -------------------------------------------------------------------------------

const prCards: PrCard[] = [];
const notes: Note[] = [];
const signalsSeen = new Set<string>();
let serverVersion: string | undefined;
let viewer = '?';
let resourceUris: string[] = [];
let guidelinesText = '';
let releaseNotes: ReleaseNotes | undefined;
let activity: Activity | undefined;

try {
  await client.connect(transport);
  const server = client.getServerVersion();
  serverVersion = `${server?.name ?? '?'} ${server?.version ?? '?'}`;

  // Discovery
  await check('Discovery', 'tools/list', '', 'success', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
    assert(missing.length === 0, `Missing tools: ${missing.join(', ')}`);
    const noSchema = tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name);
    assert(noSchema.length === 0, `Tools without an outputSchema: ${noSchema.join(', ')}`);
    return `${plural(tools.length, 'tool')}, all with output schemas`;
  });
  await check('Discovery', 'resources/list', '', 'success', async () => {
    const { resources } = await client.listResources();
    resourceUris = resources.map((resource) => resource.uri);
    assert(resourceUris.length > 0, 'No resources listed');
    return resourceUris.join(', ');
  });
  await check('Discovery', 'prompts/list', '', 'success', async () => {
    const { prompts } = await client.listPrompts();
    assert(prompts.length > 0, 'No prompts listed');
    return prompts.map((prompt) => prompt.name).join(', ');
  });

  // Pull requests
  for (const [index, picked] of prs.entries()) {
    // Alternate reference styles so both parsers get exercised.
    const ref =
      index % 2 === 0
        ? `${fullName}#${picked.number}`
        : `https://github.com/${fullName}/pull/${picked.number}`;
    let context: PrContext | undefined;
    let risk: RiskReport | undefined;

    await check('Pull requests', 'get_pr_context', ref, 'success', async () => {
      context = await callTool<PrContext>('get_pr_context', { pr: ref });
      const { pr, files, filesTruncated } = context;
      assert(pr.ref.number === picked.number, `Returned PR #${pr.ref.number}`);
      if (!filesTruncated) {
        assert(
          files.length === pr.changedFiles,
          `${files.length} files listed but PR reports ${pr.changedFiles}`,
        );
        const added = files.reduce((sum, file) => sum + file.additions, 0);
        assert(
          added === pr.additions,
          `File additions sum to ${added}, PR reports ${pr.additions}`,
        );
      }
      const ci = context.checks ? context.checks.state : 'unreadable';
      return `${plural(files.length, 'file')}, +${signed(pr.additions)} / −${signed(pr.deletions)}, ${plural(pr.commits, 'commit')}, ${pr.state}, CI ${ci}`;
    });

    await check('Pull requests', 'analyze_pr_risk', ref, 'success', async () => {
      risk = (await callTool<{ risk: RiskReport }>('analyze_pr_risk', { pr: ref })).risk;
      const sum = Math.min(
        100,
        risk.signals.reduce((total, signal) => total + signal.weight, 0),
      );
      assert(risk.score === sum, `Score ${risk.score} ≠ capped sum of weights ${sum}`);
      const level = risk.score >= 50 ? 'high' : risk.score >= 20 ? 'medium' : 'low';
      assert(risk.level === level, `Level ${risk.level} doesn't match score ${risk.score}`);
      if (context) {
        const paths = new Set(context.files.map((file) => file.path));
        const stray = risk.focusFiles.filter((path) => !paths.has(path));
        assert(stray.length === 0, `focusFiles not in the PR: ${stray.join(', ')}`);
      }
      for (const signal of risk.signals) signalsSeen.add(signal.id);
      const ids = risk.signals.map((signal) => signal.id).join(', ') || 'no signals';
      return `${risk.score}/100 ${risk.level} · ${ids} · ${plural(risk.focusFiles.length, 'focus file')}`;
    });

    if (risk && risk.focusFiles.length > 0) {
      const focus = risk.focusFiles;
      await check('Pull requests', 'get_pr_diff', `${ref} · focusFiles`, 'success', async () => {
        const diff = await callTool<PrDiff>('get_pr_diff', { pr: ref, paths: focus });
        assert(diff.unmatchedPaths.length === 0, `Unmatched: ${diff.unmatchedPaths.join(', ')}`);
        assert(diff.totalChars <= 20_000, `totalChars ${diff.totalChars} exceeds default budget`);
        const patches = `${diff.files.length} patch${diff.files.length === 1 ? '' : 'es'}`;
        return `${patches}, ${signed(diff.totalChars)} chars, ${plural(diff.omitted.length, 'file')} omitted`;
      });
    }

    if (context && risk) {
      const scored = new Set([
        ...risk.focusFiles,
        ...risk.signals.flatMap((signal) => signal.files ?? []),
      ]);
      const configMissed = context.files
        .map((file) => file.path)
        .filter((path) => CONFIG_FILE.test(path) && !scored.has(path));
      prCards.push({
        number: picked.number,
        url: context.pr.url,
        title: context.pr.title,
        state: context.pr.state,
        date: context.pr.mergedAt ?? context.pr.updatedAt,
        files: context.pr.changedFiles,
        additions: context.pr.additions,
        deletions: context.pr.deletions,
        commits: context.pr.commits,
        risk,
        configMissed,
      });
    }
  }

  // Diff budget and path matching, on the first PR with files.
  const first = prs[0];
  if (first) {
    const ref = `${fullName}#${first.number}`;
    await check('Pull requests', 'get_pr_diff', `${ref} · maxChars 1000`, 'success', async () => {
      const diff = await callTool<PrDiff>('get_pr_diff', { pr: ref, maxChars: 1000 });
      assert(diff.totalChars <= 1000, `Returned ${diff.totalChars} chars, budget was 1000`);
      const byBudget = diff.omitted.filter((item) => item.reason === 'budget').length;
      return `${signed(diff.totalChars)} chars returned, ${byBudget} omitted for budget`;
    });
    await check('Pull requests', 'get_pr_diff', `${ref} · unknown path`, 'success', async () => {
      const missing = 'does/not/exist.ts';
      const diff = await callTool<PrDiff>('get_pr_diff', { pr: ref, paths: [missing] });
      assert(diff.unmatchedPaths.includes(missing), 'Unknown path not reported in unmatchedPaths');
      assert(diff.files.length === 0, 'Returned patches for a path that does not exist');
      return 'reported in unmatchedPaths';
    });
  }

  // Repository-level tools
  await check(
    'Repository',
    'generate_release_notes',
    `from ${releaseFrom}`,
    'success',
    async () => {
      releaseNotes = await callTool<ReleaseNotes>('generate_release_notes', {
        repo: fullName,
        from: releaseFrom,
      });
      assert(releaseNotes.markdown.length > 0, 'Empty Markdown');
      const sections = releaseNotes.sections
        .map((section) => `${section.title} (${section.items.length})`)
        .join(', ');
      return `${plural(releaseNotes.totalCount, 'PR')} · ${sections || 'no sections'} · ${plural(releaseNotes.contributors.length, 'contributor')}`;
    },
  );
  await check('Repository', 'list_review_queue', `repo ${fullName}`, 'success', async () => {
    const queue = await callTool<ReviewQueue>('list_review_queue', { repo: fullName });
    viewer = queue.reviewer;
    assert(queue.reviewer.length > 0, 'No reviewer resolved');
    return `reviewer ${queue.reviewer}, ${plural(queue.totalCount, 'PR')} waiting`;
  });
  await check(
    'Repository',
    'get_my_activity',
    `repo ${fullName} · 31 days`,
    'success',
    async () => {
      activity = await callTool<Activity>('get_my_activity', { repo: fullName, days: 31 });
      return `${activity.user}: ${activity.merged.totalCount} merged, ${activity.inProgress.totalCount} in progress, ${activity.reviewed.totalCount} reviewed`;
    },
  );

  // Resources and prompts
  for (const uri of resourceUris) {
    await check('Resources & prompts', 'resources/read', uri, 'success', async () => {
      const text = await readResourceText(uri);
      assert(text.trim().length > 0, 'Empty resource');
      const items = (text.match(/^\s*- \[ \]/gm) ?? []).length;
      return `${signed(text.length)} chars, ${plural(items, 'checklist item')}`;
    });
  }
  const guidelinesUri = `devflow://repos/${fullName}/guidelines`;
  await check('Resources & prompts', 'resources/read', guidelinesUri, 'success', async () => {
    guidelinesText = await readResourceText(guidelinesUri);
    assert(guidelinesText.trim().length > 0, 'Empty resource');
    return guidelinesText.includes('No CONTRIBUTING')
      ? 'No CONTRIBUTING guide or PR template, fallback text returned'
      : `${signed(guidelinesText.length)} chars of repo guidelines`;
  });
  if (first) {
    const ref = `${fullName}#${first.number}`;
    await check('Resources & prompts', 'prompts/get review-pr', ref, 'success', async () => {
      const prompt = await client.getPrompt({ name: 'review-pr', arguments: { pr: ref } });
      assert(prompt.messages.length > 0, 'Prompt has no messages');
      return `${plural(prompt.messages.length, 'message')}: ${prompt.messages.map((m) => m.content.type).join(', ')}`;
    });
  }

  // Error handling: each of these should fail cleanly with a typed error.
  await check('Error handling', 'get_pr_context', `${fullName}#999999`, 'error', () =>
    expectToolError('get_pr_context', { pr: `${fullName}#999999` }, 'NOT_FOUND'),
  );
  await check('Error handling', 'get_pr_context', `https://github.com/${fullName}`, 'error', () =>
    expectToolError('get_pr_context', { pr: `https://github.com/${fullName}` }, 'INVALID_INPUT'),
  );
  await check('Error handling', 'analyze_pr_risk', '"not-a-valid-ref"', 'error', () =>
    expectToolError('analyze_pr_risk', { pr: 'not-a-valid-ref' }, 'INVALID_INPUT'),
  );
  await check('Error handling', 'generate_release_notes', 'from v0.0.0-missing', 'error', () =>
    expectToolError(
      'generate_release_notes',
      { repo: fullName, from: 'v0.0.0-missing' },
      'NOT_FOUND',
    ),
  );
} finally {
  await client.close();
}

// --- Observations --------------------------------------------------------------------------------

for (const card of prCards) {
  if (card.configMissed.length > 0) {
    notes.push({
      severity: 'medium',
      title: `Config changes in #${card.number} were not scored`,
      body: `${card.configMissed.join(', ')} changed, but no risk signal or focusFiles entry covers ${card.configMissed.length === 1 ? 'it' : 'them'}. Build and lint config can break a project as easily as source code.`,
      where: 'analyze_pr_risk',
    });
  }
}
if (prs.length === 0) {
  notes.push({
    severity: 'info',
    title: 'No pull requests to test',
    body: `${fullName} has no pull requests, so the PR tools were not exercised. Pass a repo with PRs, or --prs.`,
    where: 'suite',
  });
}
if (guidelinesText.includes('or the repository is not accessible')) {
  notes.push({
    severity: 'low',
    title: 'Guidelines fallback is ambiguous',
    body: 'The message says no guide was found "or the repository is not accessible". The repository was readable here, so it could say which case applied.',
    where: 'devflow://repos/{owner}/{repo}/guidelines',
  });
}
if (releaseNotes && releaseNotes.totalCount > 0) {
  const other = releaseNotes.sections.find((section) => section.type === 'other');
  if (other && other.items.length === releaseNotes.totalCount) {
    notes.push({
      severity: 'info',
      title: 'Every PR landed in "Other changes"',
      body: 'No PR title uses a conventional-commit prefix (feat:, fix:) and none has a matching label, so release notes cannot group them.',
      where: 'generate_release_notes',
    });
  }
}
if (
  activity &&
  activity.merged.totalCount + activity.inProgress.totalCount + activity.reviewed.totalCount === 0
) {
  notes.push({
    severity: 'info',
    title: 'No activity in the last 31 days',
    body: `${activity.user} has no PR activity in ${fullName} since ${activity.since.slice(0, 10)}. 31 days is the tool's maximum window.`,
    where: 'get_my_activity',
  });
}
const unseen = ALL_SIGNALS.filter((id) => !signalsSeen.has(id));
if (prs.length > 0 && unseen.length > 0) {
  notes.push({
    severity: 'info',
    title: `${ALL_SIGNALS.length - unseen.length} of ${ALL_SIGNALS.length} risk signals exercised`,
    body: `Not triggered by these PRs: ${unseen.join(', ')}. Test against PRs that touch dependencies, auth or CI, or that have failing checks, to cover them.`,
    where: 'analyze_pr_risk',
  });
}

// --- Write the report ----------------------------------------------------------------------------

const now = new Date();
const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const outPath = resolve(values.out ?? `reports/devflow-${owner}-${repo}-${stamp}.html`);
const html = renderReport({
  repo: fullName,
  repoUrl: repoInfo.html_url,
  serverVersion,
  viewer,
  generatedAt: now,
  releaseFrom,
  checks,
  prs: prCards,
  notes,
  releaseMarkdown: releaseNotes?.markdown ?? '',
});
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, html, 'utf8');

const passed = checks.filter((item) => item.ok).length;
const failed = checks.length - passed;
console.log(
  `\n${failed === 0 ? green(bold(`All ${checks.length} checks passed.`)) : red(bold(`${failed} of ${checks.length} checks failed.`))}`,
);
console.log(`Report: ${outPath}`);

if (!values['no-open']) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(opener, [outPath], () => {
    // Opening is a convenience; the path is already printed.
  });
}
process.exitCode = failed === 0 ? 0 : 1;
