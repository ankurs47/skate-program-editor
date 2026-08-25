#!/usr/bin/env node
/**
 * Mutation testing: break the code on purpose, and check a test notices.
 *
 *   npm run test:mutate
 *   npm run test:mutate -- --only "color cache"
 *
 * An ordinary test asks whether the code passes. This asks whether the test can
 * fail — which is not the same question, and three times here the answer was
 * no. A check that watched two gain nodes being created stayed green while the
 * audio bypassed them both; a check on a frame fallback could not fail because
 * headless Chrome paints; a check that "a real change still rebuilds" missed a
 * stale marker left on screen. Each looked like coverage and was not.
 *
 * Each mutation in mutations.json names the invariant it guards and the check
 * that should catch it. Three outcomes:
 *
 *   killed     a test failed, as it should have
 *   SURVIVED   the code was broken and everything still passed
 *   STALE      the code moved and the mutation no longer applies
 *
 * Stale counts as a failure. A mutation that cannot be applied is not evidence
 * of anything, and quietly skipping it would turn this into a suite that passes
 * because it stopped looking.
 *
 * SAFETY: source files are edited in place and restored from a copy held in
 * memory — in a finally, and again if the process is interrupted. It never uses
 * git to undo, because that would destroy uncommitted work rather than restore
 * it. It warns if the tree is dirty so that git is at least available as a
 * backstop if something goes badly wrong.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MUTATIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'mutations.json'), 'utf8'));

const SUITES = {
  unit: ['test/run.js'],
  dom: ['test/dom/run.js'],
};

const only = (() => {
  const at = process.argv.indexOf('--only');
  return at >= 0 ? process.argv[at + 1] : null;
})();

/** Files we have edited, and what they looked like first. */
const held = new Map();

function hold(file) {
  const full = path.join(ROOT, file);
  if (!held.has(full)) held.set(full, fs.readFileSync(full, 'utf8'));
  return full;
}

function restoreAll() {
  for (const [full, original] of held) {
    try {
      fs.writeFileSync(full, original);
    } catch (_) {
      /* nothing better to do */
    }
  }
  held.clear();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  restoreAll();
  console.error(err);
  process.exit(1);
});

/** Run a suite and return everything it said. */
function runSuite(suite) {
  const result = spawnSync(process.execPath, SUITES[suite], { cwd: ROOT, encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function warnIfDirty() {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((line) => MUTATIONS.some((m) => line.endsWith(m.file)));
    if (dirty.length) {
      console.log('  note: uncommitted changes in a file this edits —');
      for (const line of dirty) console.log(`        ${line}`);
      console.log('        they are restored from memory, but git cannot rescue them.\n');
    }
  } catch (_) {
    /* not a git checkout; carry on */
  }
}

function main() {
  const chosen = MUTATIONS.filter((m) => !only || m.name.includes(only) || m.guards.includes(only));
  if (!chosen.length) {
    console.error(`no mutation matches ${JSON.stringify(only)}`);
    process.exit(1);
  }

  warnIfDirty();

  // A suite that is already failing makes every result below meaningless.
  const needed = [...new Set(chosen.map((m) => m.suite))];
  for (const suite of needed) {
    process.stdout.write(`  baseline ${suite} … `);
    const output = runSuite(suite);
    const line = output.trim().split('\n').pop();
    if (!/\b0 failed/.test(output)) {
      console.log('FAILING');
      console.error(`\n  the ${suite} suite does not pass unmutated, so nothing here would mean`);
      console.error(`  anything. Fix it first.\n\n  ${line}\n`);
      process.exit(1);
    }
    console.log(line);
  }
  console.log('');

  const survived = [];
  const stale = [];

  for (const mutation of chosen) {
    process.stdout.write(`  ${mutation.name.padEnd(52)} `);
    const full = hold(mutation.file);
    const original = held.get(full);

    const hits = original.split(mutation.find).length - 1;
    if (hits !== 1) {
      console.log(hits === 0 ? 'STALE (no longer matches)' : `STALE (matches ${hits} places)`);
      stale.push(mutation);
      continue;
    }

    try {
      fs.writeFileSync(full, original.replace(mutation.find, mutation.replace));
      const output = runSuite(mutation.suite);
      if (output.includes(mutation.expect)) {
        console.log('killed');
      } else {
        console.log('SURVIVED');
        survived.push(mutation);
      }
    } finally {
      fs.writeFileSync(full, original);
    }
  }

  restoreAll();

  console.log('');
  if (!survived.length && !stale.length) {
    console.log(`  ${chosen.length} mutations, all caught\n`);
    return 0;
  }

  for (const m of survived) {
    console.log(`  SURVIVED  ${m.name}`);
    console.log(`            guards: ${m.guards}`);
    console.log(`            expected a check saying: ${JSON.stringify(m.expect)}\n`);
  }
  for (const m of stale) {
    console.log(`  STALE     ${m.name}`);
    console.log(`            ${mutationHint(m)}\n`);
  }
  console.log(`  ${chosen.length} mutations, ${survived.length} survived, ${stale.length} stale\n`);
  return 1;
}

function mutationHint(m) {
  return `the code it patches has moved; update its "find" in test/mutations.json (${m.file})`;
}

let code = 1;
try {
  code = main();
} finally {
  restoreAll();
}
process.exit(code);
