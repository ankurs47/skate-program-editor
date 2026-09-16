#!/usr/bin/env node
/**
 * Turn the runners' reports into the summary CI posts on a pull request.
 *
 *   node test/summary.js report/unit.json report/browser.json \
 *     [--baseline <dir>] [--encoder <outcome>] [--hooks <outcome>] > comment.md
 *
 * Every number here comes from the run that just happened. Nothing is written
 * down by hand, because a summary that can drift from what actually ran is
 * worse than no summary — it is a claim nobody checks.
 *
 * What it is for: saying what is different about *this* change. The version
 * before this one printed the same counts and the same five percentages on
 * every pull request, because the percentages were against a baseline frozen in
 * the test file — so they could not move, and the one number with a tolerance
 * rather than a hard zero could get four times worse and still render as a 93%
 * improvement next to the healthy 98%. Anything invariant is the check mark's
 * job, not a comment's.
 *
 * So the comparison is against main: `--baseline` points at the reports from
 * main's last successful run, downloaded by CI as an artifact. A counter that
 * is inside its limit but worse than main is flagged — that is a change this
 * pull request makes, and it is exactly what a frozen baseline could not see.
 *
 * Missing reports are reported as missing rather than skipped: a suite that
 * failed to produce one is exactly what a reader needs to know about. A missing
 * baseline says so too, rather than quietly printing a one-sided table.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** The marker CI matches on, so one comment is edited rather than many posted. */
const MARKER = '<!-- skate-program-editor: verification summary -->';

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'did not run' : err.message };
  }
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] || null;
}

/** ✅ / ❌ for a step whose whole result is whether it passed — no count to
    give, so the middle column stays empty rather than inventing one. */
function outcomeRow(label, outcome) {
  if (!outcome) return null;
  return `| ${label} | — | ${outcome === 'success' ? '✅ passed' : `❌ ${outcome}`} |`;
}

/** "263 → 265 (+2)", or just the count when there is nothing to compare to. */
function countCell(now, before) {
  if (typeof before !== 'number' || before === now) return String(now);
  const delta = now - before;
  return `${before} → **${now}** (${delta > 0 ? '+' : ''}${delta})`;
}

function suiteRow(label, report, base, extra = '') {
  if (report.error) return `| ${label} | — | ⚠️ ${report.error} |`;
  const mark = report.failed ? `❌ ${report.failed} failed` : '✅ all passed';
  return `| ${label} | ${countCell(report.passed, base && base.passed)} | ${mark}${extra} |`;
}

/* The counters each budget reports, in the order they are worth reading. Their
   limits come from the report rather than from here — the browser suite writes
   down the same numbers it asserts on, so what the comment calls a budget and
   what CI enforces as one cannot drift apart. */
const COUNTERS = [
  ['elementsCreated', 'elements created'],
  ['forcedStyleReads', 'forced style reads'],
  ['timelineWaveDraws', 'timeline waveform draws'],
];

function budgetRows(metrics, baseline) {
  const rows = [];
  const notes = [];
  for (const [key, budget] of Object.entries(metrics)) {
    const was = baseline && baseline[key];
    rows.push(`| **${budget.label}** — ${budget.detail} | | | | |`);
    for (const [field, label] of COUNTERS) {
      if (typeof budget[field] !== 'number') continue;
      const now = budget[field];
      const before = was && typeof was[field] === 'number' ? was[field] : null;
      const limit = budget.limits && budget.limits[field];

      /* Three things can be true of a counter, and they are not the same news.
         Over its limit is a failure the suite already reported. Worse than main
         but inside the limit is the case this comment exists for. Equal to main
         is not worth a reader's attention at all. */
      /* Anything above main is worth naming in the summary line, including the
         ones that also break their limit — the verdict below picks the more
         serious label for the row, but a reader skimming the one-liner should
         not be told less than the table says. */
      if (before !== null && now > before) {
        notes.push(`${budget.label.toLowerCase()}: ${label} ${before} → ${now}`);
      }

      let verdict = '';
      if (typeof limit === 'number' && now > limit) {
        verdict = `❌ over ${limit}`;
      } else if (before !== null && now > before) {
        verdict = before === 0 ? '⚠️ was none on main' : `⚠️ ${(now / before).toFixed(1)}× main`;
      } else if (before !== null && now < before) {
        verdict = '✅ better than main';
      }
      rows.push(
        `| ${label} | ${before === null ? '—' : before} | **${now}** |` +
          ` ${typeof limit === 'number' ? limit : '—'} | ${verdict} |`,
      );
    }
  }
  return { rows, notes };
}

function timings(metrics) {
  const rows = Object.values(metrics)
    .filter((b) => typeof b.blockingMs === 'number')
    .map((b) => `| ${b.label} — ${b.detail} | ${b.blockingMs} ms |`);
  if (!rows.length) return [];
  return [
    '',
    '<details><summary>Timings from this run</summary>',
    '',
    '| | best of five |',
    '|---|---:|',
    ...rows,
    '',
    'Deliberately not compared against anything. These come from a shared CI',
    'machine, so the difference between two runs is mostly which machine ran',
    'them — the counts above are the ones that mean something.',
    '',
    '</details>',
  ];
}

function budgets(metrics, baseline, baselineNote) {
  if (!metrics || !Object.keys(metrics).length) return null;
  const { rows, notes } = budgetRows(metrics, baseline);
  return [
    '',
    '### Render budgets',
    '',
    'Elements built, forced style reads and waveforms drawn — what costs the',
    'time, and the same on every machine. The limit is what the browser suite',
    'asserts; a counter inside its limit but above main is a change this pull',
    'request makes.',
    '',
    `| | main | this PR | limit | |`,
    '|---|---:|---:|---:|---|',
    ...rows,
    '',
    notes.length
      ? `**Moved since main:** ${notes.join('; ')}.`
      : baseline
        ? 'Nothing moved since main.'
        : baselineNote,
    ...timings(metrics),
  ].join('\n');
}

function failureList(...reports) {
  const named = reports.flatMap((r) => (r.failures || []).map((f) => `- ${f}`));
  return named.length ? ['', '### What failed', '', ...named].join('\n') : null;
}

const [unitFile, browserFile] = process.argv.slice(2);
const unit = read(unitFile);
const browser = read(browserFile);

/* main's reports, downloaded by CI from its last successful run. Absent on the
   first run after this lands, on a fork, and whenever the artifact has expired
   — all of which are said out loud rather than papered over. */
const baselineDir = arg('baseline');

/* Either layout: `gh run download` unpacks an artifact's files at the root of
   the directory it was given, but an artifact uploaded with its containing
   folder keeps that folder. Looking in both costs a stat and removes the only
   thing about this that could not be checked before it ran. */
function baseline(name) {
  if (!baselineDir) return { error: 'none' };
  const direct = read(path.join(baselineDir, name));
  return direct.error ? read(path.join(baselineDir, 'report', name)) : direct;
}

const baseUnit = baseline('unit.json');
const baseBrowser = baseline('browser.json');
const haveBase = !baseUnit.error || !baseBrowser.error;
const baselineNote = baselineDir
  ? `No usable reports from main to compare against (${baseUnit.error || baseBrowser.error}).`
  : "Nothing from main to compare against — this is the first run, or main's reports have expired.";

const out = [
  MARKER,
  '## Verification summary',
  '',
  '| check | this run | result |',
  '|---|---:|---|',
  suiteRow(
    'Unit — `npm test`',
    unit,
    haveBase ? baseUnit : null,
    unit.net ? ' (incl. encoder pins)' : '',
  ),
  suiteRow('Browser — `npm run test:dom`', browser, haveBase ? baseBrowser : null),
  /* Both of these run in CI and neither was ever mentioned here. The encoder
     one is what catches a hand-edited file in src/vendor; the hooks are the
     only place stylelint and shellcheck run at all, so "all passed" without
     them left a reader with no idea the CSS had been checked. */
  outcomeRow('Vendored encoder built from its pins — `npm run check:encoder`', arg('encoder')),
  outcomeRow(
    'Pre-commit — eslint, prettier, stylelint, shellcheck, codespell, and file hygiene',
    arg('hooks'),
  ),
  failureList(unit, browser),
  budgets(browser.metrics, haveBase ? baseBrowser.metrics : null, baselineNote),
  '',
  '### Not covered here',
  '',
  'Mutation testing runs on push to `main` and weekly, the dependency check',
  'weekly, the rule sources monthly. A green tick here says nothing about those.',
  '',
  '<sub>Posted by CI from the reports this run produced.</sub>',
]
  /* null is "this section does not apply"; '' is a blank line somebody meant.
     Filtering both, as this did, silently welded the last three sections
     together. */
  .filter((part) => part !== null)
  .join('\n');

process.stdout.write(`${out}\n`);
