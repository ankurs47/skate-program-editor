#!/usr/bin/env node
/**
 * Test suite. No dependencies — plain Node.
 *
 *   node test/run.js          everything except the network check
 *   node test/run.js --net    also ask npm about the encoder's pinned versions
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
 * Loading a test file queues its checks; this file runs them and collects the
 * totals. `check` records a failure rather than throwing, so one never hides
 * the rest — and queueing is what lets an async check be an ordinary one.
 */
'use strict';

const { check, runAll, results, writeReport, reportPath } = require('./harness.js');
const build = require('../tools/build-mp3-encoder.js');

require('./analysis.test.js');
require('./formats.test.js');
require('./app.test.js');
require('./assets.test.js');
require('./site.test.js');
require('./repo.test.js');

/* Off by default: it reaches the network, and a test suite that fails when the
   wifi does is a test suite people stop trusting. CI runs it. */
if (process.argv.includes('--net')) {
  /* The encoder is committed, so nothing has to be downloaded for it to work.
     What this asks is narrower: are the versions it was built from still the
     bytes npm published? A republished version is the one way the file in
     src/vendor could stop being traceable to anything. */
  for (const name of Object.keys(build.PINS)) {
    check(`${name}@${build.PINS[name].version} is still what npm published`, () =>
      build.verifyPublished(name),
    );
  }
}

/* ---------------------------------------------------------------- report */

runAll().then(() => {
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
});
