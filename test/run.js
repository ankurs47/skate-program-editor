#!/usr/bin/env node
/**
 * Test suite. No dependencies — plain Node.
 *
 *   node test/run.js          everything except the network check
 *   node test/run.js --net    also verify the pinned CDN hash still matches
 *
 * Three kinds of check live here:
 *   1. unit    — the pure maths: layout, envelopes, parsing, filenames
 *   2. wiring  — every id the JS reaches for exists in the HTML, and vice versa
 *   3. assets  — files parse, braces balance, the pinned CDN hash is current
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
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

/* ------------------------------------------------------------ 1. the maths */

check('layout: clips run back to back when nothing is blended', () => {
  const clips = [
    { srcStart: 0, srcEnd: 60, crossfade: 0 },
    { srcStart: 0, srcEnd: 40, crossfade: 0 },
  ];
  const { parts, total } = app.layout(clips);
  eq(parts.map((p) => p.start), [0, 60]);
  eq(total, 100);
});

check('layout: blending shortens the programme by the overlap', () => {
  const clips = [
    { srcStart: 0, srcEnd: 60, crossfade: 0 },
    { srcStart: 30, srcEnd: 90, crossfade: 2.5 },
    { srcStart: 10, srcEnd: 85, crossfade: 3 },
  ];
  const { parts, total } = app.layout(clips);
  eq(parts.map((p) => p.start), [0, 57.5, 114.5]);
  eq(total, 189.5);              // 60 + 60 + 75 − 2.5 − 3
});

check('layout: a blend cannot exceed either neighbour', () => {
  const clips = [
    { srcStart: 0, srcEnd: 5, crossfade: 0 },
    { srcStart: 0, srcEnd: 40, crossfade: 12 },
  ];
  eq(app.crossfadeOf(clips, 1), 5, 'clamped to the shorter clip: ');
  eq(app.crossfadeOf(clips, 0), 0, 'first clip has nothing to blend into: ');
});

check('layout: empty programme is zero, not NaN', () => {
  const { parts, total } = app.layout([]);
  eq(parts, []);
  eq(total, 0);
});

check('fades: ramp linearly and reach full level', () => {
  const clip = { srcStart: 0, srcEnd: 60, fadeIn: 1.5, fadeOut: 0 };
  const env = app.fadeEnvelope(clip);
  eq(app.valueAt(env, 0), 0, 'silent at the start: ');
  eq(app.valueAt(env, 0.75), 0.5, 'half way up at half the fade: ');
  eq(app.valueAt(env, 1.5), 1, 'full by the end of the fade: ');
  eq(app.valueAt(env, 30), 1, 'stays up afterwards: ');
});

check('fades: fade out lands on silence exactly at the end', () => {
  const clip = { srcStart: 0, srcEnd: 75, fadeIn: 0, fadeOut: 4 };
  const env = app.fadeEnvelope(clip);
  near(app.valueAt(env, 73), 0.5, 1e-9, 'half way down: ');
  eq(app.valueAt(env, 75), 0);
});

check('fades: overlong fades are clamped, never inverted', () => {
  const clip = { srcStart: 0, srcEnd: 10, fadeIn: 30, fadeOut: 30 };
  const env = app.fadeEnvelope(clip);
  const times = env.map((p) => p[0]);
  eq(times, times.slice().sort((a, b) => a - b), 'breakpoints stay in order: ');
  env.forEach(([, v]) => ok(v >= 0 && v <= 1, `gain ${v} out of range`));
});

check('blends: the two sides sum to 1 through the overlap', () => {
  const clips = [
    { srcStart: 0, srcEnd: 60, crossfade: 0 },
    { srcStart: 0, srcEnd: 60, crossfade: 2.5 },
  ];
  const outgoing = app.crossfadeEnvelope(clips, 0);
  const incoming = app.crossfadeEnvelope(clips, 1);
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const t = 2.5 * frac;
    const sum = app.valueAt(outgoing, 60 - 2.5 + t) + app.valueAt(incoming, t);
    near(sum, 1, 1e-9, `no dip or bump at ${Math.round(frac * 100)}% through: `);
  }
});

check('parseClock: accepts the sensible forms, rejects nonsense', () => {
  eq(app.parseClock('3:10'), 190);
  eq(app.parseClock('0:45'), 45);
  eq(app.parseClock('45'), 45);
  eq(app.parseClock('1:05.5'), 65.5);
  for (const bad of ['', 'abc', '-2', '99:00', 'x:y', null, undefined]) {
    eq(app.parseClock(bad), null, `${JSON.stringify(bad)} should be rejected: `);
  }
});

check('exportFileName: readable, and safe on every filesystem', () => {
  const original = app.state.name;
  const cases = [
    ['my 2026 junior long program', 190, 'my 2026 junior long program (3-10).mp3'],
    ['long-program v2', 210, 'long-program v2 (3-30).mp3'],
    ['short program 2026/27', 160, 'short program 2026 27 (2-40).mp3'],
    ['a:b*c?d"e<f>g|h', 135, 'a b c d e f g h (2-15).mp3'],
    ['   ...trailing...   ', 240, 'trailing (4-00).mp3'],
    ['', 90, 'my program (1-30).mp3'],
  ];
  for (const [name, target, expected] of cases) {
    app.state.name = name;
    app.state.targetSeconds = target;
    eq(app.exportFileName('mp3'), expected, `${JSON.stringify(name)}: `);
  }
  app.state.name = 'x'.repeat(400);
  ok(app.exportFileName('mp3').length < 130, 'absurd names are truncated');
  app.state.name = original;
});

check('quality: judged per codec, not on the raw number', () => {
  const verdict = (bitrate, codec) => {
    const eff = bitrate * (app.CODEC_EFFICIENCY[codec] || 1);
    return eff < app.QUALITY.minBitrate ? 'poor'
      : eff < app.QUALITY.goodBitrate ? 'caution' : 'good';
  };
  eq(verdict(128, 'opus'), 'good', '128k opus is genuinely fine: ');
  eq(verdict(128, 'mp3'), 'caution', 'the same number in mp3 is not: ');
  eq(verdict(107, 'mp3'), 'poor');
  eq(verdict(205, 'mp3'), 'good');
  eq(verdict(64, 'opus'), 'poor');
});

check('quality: badges are short words, never bitrates', () => {
  for (const kind of ['good', 'caution', 'poor', 'unknown']) {
    const label = app.qualityLabel({ kind });
    ok(label.length <= 8, `"${label}" is too long for the badge`);
    ok(!/\d/.test(label), `"${label}" leaks a number into the badge`);
  }
});

check('codecOf: WebM from YouTube is Opus', () => {
  eq(app.codecOf('song.webm'), 'opus');
  eq(app.codecOf('song.opus'), 'opus');
  eq(app.codecOf('song.MP3'), 'mp3', 'extension match is case insensitive: ');
});

check('MPEG parser: rejects data that merely looks like a frame', () => {
  // Random bytes contain 0xFF sync patterns constantly; without requiring
  // consecutive frames this returned a confident, wrong bitrate.
  const noise = Buffer.alloc(200000);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff;
  eq(app.readMpegFrame(noise.buffer.slice(0), 0), null);
});

check('id3Size: reads the syncsafe length, tolerates untagged files', () => {
  const tagged = Buffer.alloc(20);
  tagged.write('ID3');
  [tagged[6], tagged[7], tagged[8], tagged[9]] = [0, 0, 2, 1];
  eq(app.id3Size(tagged.buffer.slice(0)), (2 << 7 | 1) + 10);
  eq(app.id3Size(Buffer.alloc(20).buffer.slice(0)), 0, 'no tag: ');
  eq(app.id3Size(Buffer.alloc(4).buffer.slice(0)), 0, 'too short to have one: ');
});

check('levels: ids unique, times sane, every group populated', () => {
  const all = app.allLevels();
  ok(all.length > 0, 'no levels defined');
  const ids = all.map((l) => l.id);
  eq(new Set(ids).size, ids.length, 'duplicate level ids: ');
  for (const level of all) {
    ok(level.seconds > 30 && level.seconds < 600, `${level.id}: implausible length`);
    ok(level.tol > 0 && level.tol <= 30, `${level.id}: implausible tolerance`);
    ok(level.label && level.label.trim(), `${level.id}: missing label`);
  }
  for (const group of app.LEVELS) ok(group.items.length > 0, `${group.group} is empty`);
});

check('levels: findLevel returns null rather than throwing', () => {
  eq(app.findLevel('nope'), null);
  ok(app.findLevel(app.allLevels()[0].id) !== null);
});

check('support check: passes a modern browser, blocks a hopeless one', () => {
  const saved = { AudioContext: global.AudioContext, OfflineAudioContext: global.OfflineAudioContext };
  global.window = {
    AudioContext: function () {}, OfflineAudioContext: function () {},
    File: function () {}, FileList: function () {}, FileReader: function () {},
    URL: { createObjectURL() {} },
  };
  global.Blob = { prototype: { arrayBuffer() {} } };
  eq(app.unsupportedReasons(), [], 'modern browser should pass: ');
  global.window = { File: function () {}, FileList: function () {}, FileReader: function () {}, URL: { createObjectURL() {} } };
  ok(app.unsupportedReasons().length >= 2, 'a browser with no Web Audio should be blocked');
  Object.assign(global, saved);
});

/* --------------------------------------------------------------- 2. wiring */

check('every element the code reaches for exists in the HTML', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const wanted = new Set([...source.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  const present = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !present.has(id));
  eq(missing, [], 'ids used in app.js but absent from index.html: ');
});

check('every help button has a matching topic', () => {
  const buttons = [...html.matchAll(/class="help-btn" data-help="(\w+)"/g)].map((m) => m[1]);
  const topics = [...html.matchAll(/data-help="(\w+)" data-title="([^"]+)"/g)];
  const names = new Set(topics.map((m) => m[1]));
  ok(buttons.length > 0, 'no help buttons found');
  eq(buttons.filter((b) => !names.has(b)), [], 'buttons with no content: ');
  eq([...names].filter((n) => !buttons.includes(n)), [], 'content with no button: ');
  for (const [, , title] of topics) ok(title.trim(), 'a topic has an empty title');
});

check('no personal information in anything shipped', () => {
  const banned = /abrysha|srivastava(?!,)|category10women/i;
  for (const file of ['index.html', 'app.js', 'style.css']) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    ok(!banned.test(body), `${file} contains personal information`);
  }
});

check('no absolute local paths leaked into the app', () => {
  for (const file of ['index.html', 'app.js', 'style.css']) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    ok(!/\/home\/|file:\/\/\//.test(body), `${file} references a local path`);
  }
});

/* --------------------------------------------------------------- 3. assets */

check('app.js parses', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'app.js')]);
});

check('HTML tags are balanced', () => {
  const voids = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'track']);
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g)) {
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
  eq(stack, [], 'unclosed tags: ');
});

check('CSS braces balance', () => {
  const opens = (css.match(/{/g) || []).length;
  const closes = (css.match(/}/g) || []).length;
  eq(opens, closes, 'unbalanced braces: ');
});

check('every CSS custom property used is defined', () => {
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  eq([...used].filter((v) => !defined.has(v)), [], 'used but never defined: ');
});

check('both colour themes define the same variables', () => {
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  const light = css.slice(0, css.indexOf('prefers-color-scheme: dark'));
  const names = (block) => new Set([...block.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  const l = names(light);
  const d = names(dark);
  const onlyDark = [...d].filter((v) => !l.has(v));
  eq(onlyDark, [], 'defined only in dark mode: ');
});

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

for (const failure of failures) console.error(`  FAIL  ${failure}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
