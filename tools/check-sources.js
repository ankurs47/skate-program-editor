#!/usr/bin/env node
/**
 * Notice when the ISU or U.S. Figure Skating publish something, so the program
 * lengths this app ships can be checked against it by a person.
 *
 *   node tools/check-sources.js            # report; exit 1 if anything moved
 *   node tools/check-sources.js --update   # accept what is there now as the baseline
 *
 * What this is NOT: a check that our times are correct. Neither body publishes
 * the durations anywhere machine-readable — they live in season-specific PDFs
 * whose addresses change — so anything claiming to verify them would be
 * guessing, and a green tick saying "program lengths verified" would quietly
 * contradict the disclaimer the app and the README both carry. This only
 * answers a much smaller question honestly: has the source of truth changed
 * since a human last looked?
 *
 * The pages carry per-request tokens, so hashing them whole fires every run.
 * What is compared instead is the one part of each that is stable between
 * fetches and meaningful when it moves.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'tools/sources.json');
const UA = 'skate-program-editor source check (+https://github.com/ankurs47/skate-program-editor)';

/* One extractor per source, in code rather than as a regex in the JSON: these
   need a comment explaining what they are looking at, and JSON has nowhere to
   put one. Each must return something that does not change between two fetches
   a second apart — verified by --update printing the same thing twice. */
const EXTRACTORS = {
  /* Every ISU rule change arrives as a numbered Communication. A new number is
     the signal; whether it touches program durations is the human's call. */
  'isu-communications': (html) =>
    [...new Set([...html.matchAll(/communication[^<>"]{0,8}(\d{4})/gi)].map((m) => m[1]))].sort(),

  /* The rules hub does not link the PDFs directly, but it does carry the season
     it is describing. A new season is when the rulebook gets reissued. */
  'usfs-rules': (html) =>
    [...new Set([...html.matchAll(/\b(20\d{2}-\d{2})\b/g)].map((m) => m[1]))].sort(),
};

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** What we ship, rendered from the code so the report cannot drift from it. */
function shippedLengths() {
  const { LEVELS } = require(path.join(ROOT, 'src/app.js'));
  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return LEVELS.map((group) =>
    [
      `**${group.group}**`,
      ...group.items.map((i) => `  - ${i.label} — ${clock(i.seconds)} ±${i.tol}s`),
    ].join('\n'),
  ).join('\n\n');
}

async function main() {
  const update = process.argv.includes('--update');
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const changes = [];
  const failures = [];

  for (const source of baseline.sources) {
    const extract = EXTRACTORS[source.id];
    if (!extract) {
      failures.push(`${source.id}: no extractor`);
      continue;
    }

    let seen;
    try {
      seen = extract(await fetchText(source.url));
    } catch (err) {
      /* Unreachable is itself worth knowing — a moved page is a change. It is
         reported rather than thrown so one dead link cannot hide the others. */
      failures.push(`${source.id}: ${source.url} — ${err.message}`);
      continue;
    }
    if (!seen.length) {
      failures.push(`${source.id}: nothing matched; the page layout changed`);
      continue;
    }

    const before = source.seen || [];
    const added = seen.filter((v) => !before.includes(v));
    const gone = before.filter((v) => !seen.includes(v));
    if (added.length || gone.length) {
      changes.push({ source, added, gone });
      if (update) source.seen = seen;
    }
    console.log(
      `  ${source.id.padEnd(20)} ${seen.length} found` +
        `${added.length ? `, ${added.length} new: ${added.join(', ')}` : ''}` +
        `${gone.length ? `, ${gone.length} gone: ${gone.join(', ')}` : ''}`,
    );
  }

  if (update) {
    baseline.checked = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\n  baseline updated (${baseline.checked})\n`);
    return failures.length ? 1 : 0;
  }

  if (!changes.length && !failures.length) {
    console.log(`\n  nothing has moved since ${baseline.checked}\n`);
    return 0;
  }

  const report = ['## Something moved at the source\n'];
  for (const { source, added, gone } of changes) {
    report.push(`**${source.what}** — <${source.url}>`);
    if (added.length) report.push(`- new: ${added.join(', ')}`);
    if (gone.length) report.push(`- no longer listed: ${gone.join(', ')}`);
    report.push('');
  }
  for (const failure of failures) report.push(`**Could not check** — ${failure}\n`);
  report.push(
    'This does not mean our times are wrong. It means the body that decides them',
    'has published something since a person last looked, so the times below are',
    'worth checking against it.\n',
    '### What this app currently ships\n',
    shippedLengths(),
    '',
    '### When you have checked\n',
    'Edit `LEVELS` in `src/app.js` if anything changed, then run',
    '`npm run check:sources -- --update` and commit `tools/sources.json`. Until',
    'that baseline moves this will keep asking, which is the point.',
  );
  fs.writeFileSync(path.join(ROOT, 'sources-report.md'), `${report.join('\n')}\n`);
  console.log(`\n${report.join('\n')}\n`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n  the source check could not run: ${err.message}\n`);
    process.exit(1);
  });
