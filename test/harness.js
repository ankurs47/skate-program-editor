/**
 * The bits every test file needs: what a check is, how to assert, and where
 * the app and its shipped files are.
 *
 * No dependencies, and no framework. `check` catches so that one failure does
 * not hide the rest — a run reports everything that is wrong at once, which is
 * what makes the suite worth running after a refactor rather than before.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* The three script files, in the order index.html loads them. app.js requires
   the other two under Node and re-exports them, so requiring it alone still
   gets everything — which is why each test file can ask for just `app`. */
const SCRIPTS = ['analysis.js', 'formats.js', 'app.js'];
const SHIPPED = ['index.html', 'style.css', ...SCRIPTS];

const app = require(path.join(ROOT, 'app.js'));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}expected ${b}, got ${a}`);
}

function near(actual, expected, tol, what = '') {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${what}expected ~${expected} (±${tol}), got ${actual}`);
  }
}

function ok(cond, message) {
  if (!cond) throw new Error(message);
}

/** Totals so far. The runner prints these once every file has been loaded. */
function results() {
  return { passed, failures };
}

module.exports = {
  ROOT, SCRIPTS, SHIPPED, app, html, css,
  check, eq, near, ok, results,
};
