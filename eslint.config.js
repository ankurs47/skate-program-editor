'use strict';

/* The app is a plain browser script — no bundler, no modules — so its
   functions live in the script's global scope by design. `no-implicit-globals`
   is deliberately not enabled: satisfying it would mean wrapping two thousand
   lines in an IIFE to no benefit. Rules here are the recommended set plus a few
   that catch mistakes which actually bit during development. */
const path = require('path');

const js = require('@eslint/js');

/* The script files share one global scope in the browser, but eslint reads each
   on its own and would call every cross-file name undefined. What they share is
   taken from the files themselves rather than written out here, so it cannot
   drift: every one ends by exporting its own top-level names under Node, and
   each is then told about every name except the ones it declares itself.
   Referring to a name no file exports is still a genuine no-undef error, and
   the exclusion is what keeps a file's own declarations from reading as
   redeclarations of a global.

   The set of files is read from the directory, so adding one needs no edit
   here — only a script tag in index.html and an entry in the test harness. */
const fs = require('fs');
const PARTS = fs
  .readdirSync(path.join(__dirname, 'src'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => name.slice(0, -'.js'.length));

const own = Object.fromEntries(
  PARTS.map((part) => [part, new Set(Object.keys(require(`./src/${part}.js`)))]),
);
/* app.js re-exports every other file so that requiring it alone gets the whole
   shared scope; subtracting them leaves the names it declares itself. */
for (const part of PARTS) {
  if (part !== 'app') for (const name of own[part]) own.app.delete(name);
}

const sharedWith = (part) =>
  Object.fromEntries(
    PARTS.filter((p) => p !== part)
      .flatMap((p) => [...own[p]])
      .map((name) => [name, 'readonly']),
  );

const browser = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  AudioContext: 'readonly',
  OfflineAudioContext: 'readonly',
  FileReader: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  DataView: 'readonly',
  TextDecoder: 'readonly',
  matchMedia: 'readonly',
  getComputedStyle: 'readonly',
  // Used to tell an Element apart from the document, which also receives
  // events but has no closest().
  Element: 'readonly',
  // Where the browser has it, file handles are kept here so a project can
  // find its music again without being asked for every song.
  indexedDB: 'readonly',
  // Each file ends with a block that exports its top-level names under Node;
  // app.js additionally bridges all of them onto the global object there.
  module: 'writable',
  require: 'readonly',
  global: 'writable',
};

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-undef': 'error',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
  // A ternary written as a statement reads as a value being computed and then
  // dropped. Both of the ones here were really if/else.
  'no-unused-expressions': 'error',
};

module.exports = [
  { ignores: ['node_modules/**'] },
  ...PARTS.map((part) => ({
    files: [`src/${part}.js`],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browser, ...sharedWith(part) },
    },
    rules,
  })),
  {
    files: ['test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        global: 'writable',
        Buffer: 'readonly',
        // The browser checks drive Chrome over the DevTools Protocol.
        // Node 22 has WebSocket globally, which is what lets them do
        // that without a single dependency.
        WebSocket: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
];
