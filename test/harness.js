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

/* The script files, in the order index.html loads them — as the page spells
   them, since that is what the wiring checks compare against. app.js requires
   all the others under Node and re-exports them, so requiring it alone still
   gets everything, which is why each test file asks for just `app`. */
const SCRIPTS = [
  'src/analysis.js',
  'src/formats.js',
  'src/program.js',
  'src/canvas.js',
  'src/audio.js',
  'src/library.js',
  'src/timeline.js',
  'src/editor.js',
  'src/dialogs.js',
  'src/app.js',
];
/* The documentation pages. They are served alongside the app rather than only
   read on GitHub, so whatever must never ship applies to them too. */
const DOCS = ['docs/help.html', 'docs/docs.css', 'docs/program.skate.schema.json'];
const ASSETS = ['src/logo.svg'];
const SHIPPED = ['index.html', 'src/style.css', ...SCRIPTS, ...DOCS, ...ASSETS];

const app = require(path.join(ROOT, 'src/app.js'));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/style.css'), 'utf8');

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

/** Walks tags and returns the names left open, so both pages can be checked. */
function unclosedTags(source) {
  const voids = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'track']);
  const stack = [];
  for (const m of source.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, , selfClose] = m;
    const name = tag.toLowerCase();
    if (voids.has(name) || selfClose || name === '!doctype') continue;
    if (closing) {
      ok(stack.length, `stray </${name}>`);
      const open = stack.pop();
      eq(open, name, `</${name}> closes <${open}>: `);
    } else {
      stack.push(name);
    }
  }
  return stack;
}

/** Totals so far. The runner prints these once every file has been loaded. */
function results() {
  return { passed, failures };
}

/**
 * Write a run's outcome somewhere a later step can read it.
 *
 * CI turns these into the summary it posts on the pull request, so the numbers
 * there are the ones the run actually produced rather than any written down by
 * hand — the whole point of posting them.
 */
function writeReport(file, report) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

/** `--report path` on a runner's command line, or null. */
function reportPath(argv) {
  const at = argv.indexOf('--report');
  return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
}

module.exports = {
  ROOT,
  SCRIPTS,
  SHIPPED,
  DOCS,
  ASSETS,
  app,
  html,
  css,
  check,
  eq,
  near,
  ok,
  unclosedTags,
  results,
  writeReport,
  reportPath,
};
