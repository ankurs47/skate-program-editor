'use strict';

/* The app is a plain browser script — no bundler, no modules — so its
   functions live in the script's global scope by design. `no-implicit-globals`
   is deliberately not enabled: satisfying it would mean wrapping two thousand
   lines in an IIFE to no benefit. Rules here are the recommended set plus a few
   that catch mistakes which actually bit during development. */
const js = require('@eslint/js');

module.exports = [
  { ignores: ['node_modules/**'] },
  {
    files: ['app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', location: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        AudioContext: 'readonly', OfflineAudioContext: 'readonly',
        FileReader: 'readonly', Blob: 'readonly', URL: 'readonly',
        DataView: 'readonly', TextDecoder: 'readonly',
        matchMedia: 'readonly', getComputedStyle: 'readonly',
        module: 'writable',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      // A ternary written as a statement reads as a value being computed and
      // then dropped. Both of the ones here were really if/else.
      'no-unused-expressions': 'error',
    },
  },
  {
    files: ['test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly',
                 __dirname: 'readonly', console: 'readonly', global: 'writable',
                 Buffer: 'readonly' },
    },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },
];
