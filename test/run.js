#!/usr/bin/env node
/**
 * Test suite. No dependencies — plain Node.
 *
 *   node test/run.js          everything except the network check
 *   node test/run.js --net    also verify the pinned CDN hash still matches
 *
 * One file per script file, so a change to the analysis has an obvious place
 * to be tested and the editor's own tests are not buried under a thousand
 * lines of signal processing:
 *
 *   harness.js          what a check is, and where the app lives
 *   analysis.test.js    beats, phrases, loudness
 *   formats.test.js     ID3/MPEG/Ogg parsing, the quality verdict
 *   app.test.js         layout, envelopes, undo, the project file
 *   assets.test.js      wiring, and the app's own files
 *   site.test.js        the guide, the logo, and how a link to this looks
 *   repo.test.js        what must never ship, and how everything is spelled
 *
 * Loading a test file runs its checks — `check` records rather than throws, so
 * one failure never hides the rest. This file only collects the totals.
 */
'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { app, check, eq, results, writeReport, reportPath } = require('./harness.js');

require('./analysis.test.js');
require('./formats.test.js');
require('./app.test.js');
require('./assets.test.js');
require('./site.test.js');
require('./repo.test.js');

/* Off by default: it reaches the network, and a test suite that fails when the
   wifi does is a test suite people stop trusting. CI runs it. */
if (process.argv.includes('--net')) {
  check('the pinned MP3 encoder hash still matches the CDN', () => {
    const body = execFileSync('curl', ['-sSL', '--max-time', '30', app.LAME_URL],
      { maxBuffer: 1 << 24 });
    const got = `sha384-${crypto.createHash('sha384').update(body).digest('base64')}`;
    eq(got, app.LAME_SRI,
      'the CDN now serves different bytes; update LAME_SRI after checking why: ');
  });
}

/* ---------------------------------------------------------------- report */

const { passed, failures } = results();
for (const failure of failures) console.error(`  FAIL  ${failure}`);
console.log(`\n${passed} passed, ${failures.length} failed`);

writeReport(reportPath(process.argv), {
  suite: 'unit',
  passed,
  failed: failures.length,
  net: process.argv.includes('--net'),
  failures: failures.map((f) => f.split('\n')[0]),
});

process.exit(failures.length ? 1 : 0);
