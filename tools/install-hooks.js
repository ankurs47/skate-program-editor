#!/usr/bin/env node
/**
 * Turn on the pre-commit hooks.
 *
 * Run by `npm install` through the prepare script; harmless to run again.
 *
 * This is the only hook path. A plain git hook running lint and the tests would
 * cover anyone without the framework, but two hook systems is two things to
 * understand and that fallback is much the weaker of them: no shellcheck, no
 * spelling, no formatting, none of the file hygiene. Anyone who skips this
 * still has CI, which runs the same hooks.
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

try {
  git('rev-parse', '--git-dir');
} catch (_) {
  process.exit(0); // not a clone — nothing to install into
}

if (spawnSync('pre-commit', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.log(
    'hooks: pre-commit is not installed, so nothing checks your commits.\n' +
      '       pip install pre-commit && npm run prepare',
  );
  process.exit(0); // a missing tool should not fail someone's npm install
}

/* pre-commit refuses to install while core.hooksPath is set, and git ignores
   .git/hooks entirely when it is. Left over from the old fallback on any clone
   that predates this. */
try {
  git('config', '--unset-all', 'core.hooksPath');
} catch (_) {
  /* was not set */
}

const done = spawnSync('pre-commit', ['install'], { stdio: 'inherit' });
process.exit(done.status === 0 ? 0 : 0);
