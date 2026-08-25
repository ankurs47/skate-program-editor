#!/usr/bin/env node
/**
 * Turn on whichever pre-commit machinery this machine can run.
 *
 * Run by `npm install` through the prepare script; harmless to run again.
 *
 * Two paths, because contributors arrive with different toolboxes. With the
 * pre-commit framework present it owns the hook, and you get the file-hygiene,
 * shellcheck and codespell checks as well as lint and tests. With only Node,
 * .githooks/pre-commit still gives you lint and tests, which is what this repo
 * had before and is the part that must never be optional.
 *
 * They cannot both be installed: git ignores .git/hooks entirely once
 * core.hooksPath is set, and pre-commit refuses to install while it is.
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');

const quiet = { stdio: 'ignore' };
const has = (cmd) => spawnSync(cmd, ['--version'], quiet).status === 0;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

try {
  git('rev-parse', '--git-dir');
} catch (_) {
  process.exit(0); // not a clone — nothing to install into
}

if (has('pre-commit')) {
  try {
    git('config', '--unset-all', 'core.hooksPath');
  } catch (_) {
    /* was not set */
  }
  const done = spawnSync('pre-commit', ['install'], { stdio: 'inherit' });
  if (done.status === 0) process.exit(0);
  console.error('hooks: pre-commit failed to install, falling back to .githooks');
}

git('config', 'core.hooksPath', '.githooks');
console.log(
  'hooks: .githooks (lint and tests). For the full set:' +
    ' pip install pre-commit && npm run prepare',
);
