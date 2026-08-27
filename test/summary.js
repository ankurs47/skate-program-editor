#!/usr/bin/env node
/**
 * Turn the runners' reports into the summary CI posts on a pull request.
 *
 *   node test/summary.js report/unit.json report/browser.json > comment.md
 *
 * Every number here comes from the run that just happened. Nothing is written
 * down by hand, because a summary that can drift from what actually ran is
 * worse than no summary — it is a claim nobody checks.
 *
 * Missing reports are reported as missing rather than skipped: a suite that
 * failed to produce one is exactly what a reader needs to know about.
 */
'use strict';

const fs = require('fs');

/** The marker CI matches on, so one comment is edited rather than many posted. */
const MARKER = '<!-- skate-program-editor: verification summary -->';

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'did not run' : err.message };
  }
}

const pct = (was, now) => (was > 0 ? `−${Math.round((1 - now / was) * 100)}%` : '');

function suiteRow(label, report, extra = '') {
  if (report.error) return `| ${label} | — | ⚠️ ${report.error} |`;
  const mark = report.failed ? `❌ ${report.failed} failed` : '✅ all passed';
  return `| ${label} | ${report.passed} | ${mark}${extra} |`;
}

function budgets(metrics) {
  if (!metrics || (!metrics.drag && !metrics.refresh)) return '';
  const rows = [];
  const timings = [];
  const d = metrics.drag;
  if (d) {
    rows.push(
      `| **Dragging a slider** — ${d.events} input events, ${d.clips} clips | | | |`,
      `| elements created | ${d.wasElements} | **${d.elementsCreated}** | ${pct(d.wasElements, d.elementsCreated)} |`,
      `| forced style reads | ${d.wasStyleReads} | **${d.forcedStyleReads}** | ${pct(d.wasStyleReads, d.forcedStyleReads)} |`,
      `| timeline waveform draws | ${d.wasWaveDraws} | **${d.timelineWaveDraws}** | ${pct(d.wasWaveDraws, d.timelineWaveDraws)} |`,
    );
    timings.push(`| dragging, ${d.events} input events | ${d.blockingMs} ms |`);
  }
  const r = metrics.refresh;
  if (r) {
    rows.push(
      `| **${r.calls} idle refreshes** | | | |`,
      `| elements created | ${r.wasElements} | **${r.elementsCreated}** | ${pct(r.wasElements, r.elementsCreated)} |`,
      `| forced style reads | ${r.wasStyleReads} | **${r.forcedStyleReads}** | ${pct(r.wasStyleReads, r.forcedStyleReads)} |`,
    );
    timings.push(`| ${r.calls} idle refreshes | ${r.blockingMs} ms |`);
  }
  return [
    '',
    '### Render budgets',
    '',
    'Elements built, forced style reads and waveform draws. These are what cost',
    'the time, they are identical on every machine, and they are what the checks',
    'assert on. The baseline is the measurement each one improved on.',
    '',
    '| | baseline | this run | |',
    '|---|---:|---:|---|',
    ...rows,
    '',
    '<details><summary>Timings from this run</summary>',
    '',
    '| | best of five |',
    '|---|---:|',
    ...timings,
    '',
    'Deliberately shown without a baseline to compare against. These come from a',
    'shared CI machine and the numbers the work was developed against came from a',
    'developer laptop, so the difference between them is mostly which machine ran',
    'it — a run twice as slow as the last one usually means the runner was busy,',
    'not that anything regressed. The counts above are the ones that mean',
    'something. Best of five after a warm-up, so a single interruption does not',
    'become the headline.',
    '',
    '</details>',
  ].join('\n');
}

function failureList(...reports) {
  const named = reports.flatMap((r) => (r.failures || []).map((f) => `- ${f}`));
  return named.length ? ['', '### What failed', '', ...named].join('\n') : '';
}

const [unitFile, browserFile] = process.argv.slice(2);
const unit = read(unitFile);
const browser = read(browserFile);

const out = [
  MARKER,
  '## Verification summary',
  '',
  '| suite | checks | result |',
  '|---|---:|---|',
  suiteRow('Unit — `npm test`', unit, unit.net ? ' (incl. encoder pins)' : ''),
  suiteRow('Browser — `npm run test:dom`', browser),
  budgets(browser.metrics),
  failureList(unit, browser),
  '',
  '<sub>Posted by CI from the reports this run produced.</sub>',
]
  .filter((part) => part !== '')
  .join('\n');

process.stdout.write(`${out}\n`);
