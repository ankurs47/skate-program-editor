'use strict';

/* The app is a plain browser script — no bundler, no modules — so its
   functions live in the script's global scope by design. `no-implicit-globals`
   is deliberately not enabled: satisfying it would mean wrapping two thousand
   lines in an IIFE to no benefit. Rules here are the recommended set plus a few
   that catch mistakes which actually bit during development. */
const js = require('@eslint/js');

/* The three script files share one global scope in the browser, but eslint
   reads each on its own and would call every cross-file name undefined. The
   list of what they share is taken from the files themselves rather than
   written out here, so it cannot drift: whatever analysis.js and formats.js
   export under Node is exactly what app.js may refer to. Anything app.js uses
   that they do not export is still a genuine no-undef error. */
const shared = Object.fromEntries(
  [...Object.keys(require('./src/analysis.js')), ...Object.keys(require('./src/formats.js'))]
    .map((name) => [name, 'readonly']));

const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  localStorage: 'readonly', location: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  AudioContext: 'readonly', OfflineAudioContext: 'readonly',
  FileReader: 'readonly', Blob: 'readonly', URL: 'readonly',
  DataView: 'readonly', TextDecoder: 'readonly',
  matchMedia: 'readonly', getComputedStyle: 'readonly',
  // Where the browser has it, file handles are kept here so a project can
  // find its music again without being asked for every song.
  indexedDB: 'readonly',
  // Each file ends with a block that exports its pure logic under Node; app.js
  // additionally bridges the other two onto the global object there.
  module: 'writable', require: 'readonly', global: 'writable',
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
  {
    // These two define the shared names, so they must not also be told the
    // names exist — that would be a redeclaration.
    files: ['src/analysis.js', 'src/formats.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browser },
    rules,
  },
  {
    files: ['src/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browser, ...shared },
    },
    rules,
  },
  {
    files: ['test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly',
                 __dirname: 'readonly', console: 'readonly', global: 'writable',
                 Buffer: 'readonly',
                 // The browser checks drive Chrome over the DevTools Protocol.
                 // Node 22 has WebSocket globally, which is what lets them do
                 // that without a single dependency.
                 WebSocket: 'readonly', setTimeout: 'readonly' },
    },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },
];
