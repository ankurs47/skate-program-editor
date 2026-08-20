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

check('reorder: moves on a real pair of positions, and only then', () => {
  const clips = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ids = (list) => (list ? list.map((c) => c.id).join('') : null);
  eq(ids(app.reordered(clips, 2, 0)), 'cab', 'last block dragged to the front: ');
  eq(ids(app.reordered(clips, 0, 2)), 'bca');
  eq(app.reordered(clips, 1, 1), null, 'a block dropped back on itself: ');
  eq(ids(clips), 'abc', 'the list handed in is never touched: ');

  /* The drop handler used to read text/plain and hand the result straight over.
     A dragged text selection parses to NaN, every comparison against NaN is
     false, and the check only looked at the destination — so it went through,
     and splice(NaN, 1) coerces to splice(0, 1). Dropping a stray selection on
     the timeline silently moved the *first* song to wherever it landed. */
  for (const bad of [NaN, 1.5, -1, 3, 99, '1', null, undefined, Infinity]) {
    eq(app.reordered(clips, bad, 2), null, `dragged from ${JSON.stringify(bad)}: `);
    eq(app.reordered(clips, 0, bad), null, `dropped at ${JSON.stringify(bad)}: `);
  }
});

check('reorder: a drop counts only when the drag began on a clip block', () => {
  /* A dropped file or text selection carries text/plain too, and for a file it
     reads back as the empty string — which Number() turns into 0, a perfectly
     valid clip index that the guard above cannot catch. So the payload cannot
     be what identifies the drag; a private type is. */
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  ok(!/getData\(\s*'text\/plain'\s*\)/.test(source),
    'a drop handler is reading text/plain again, which every drag supplies');
  ok(/setData\(CLIP_DRAG_TYPE/.test(source) && /getData\(CLIP_DRAG_TYPE/.test(source),
    'the private drag type has to be both published and required');
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
  /* This calls the app's own judgement. It used to reimplement the thresholds
     here and then assert against its own copy of them, which meant it would
     have passed whatever `qualityKind` actually did — the thresholds were never
     under test at all. */
  const verdict = (bitrate, codec) => app.qualityKind({ bitrate, codec });
  eq(verdict(128, 'opus'), 'good', '128k opus is genuinely fine: ');
  eq(verdict(128, 'mp3'), 'caution', 'the same number in mp3 is not: ');
  eq(verdict(107, 'mp3'), 'poor');
  eq(verdict(205, 'mp3'), 'good');
  eq(verdict(64, 'opus'), 'poor');
  eq(verdict(128, 'wma'), 'caution', 'a codec not in the table gets no free credit: ');
});

check('quality: a file we could not measure says so rather than passing', () => {
  eq(app.qualityKind({ bitrate: null, codec: 'm4a' }), 'unknown');
  eq(app.qualityKind({ bitrate: null, lossless: true }), 'good',
    'wav and flac need no bitrate to be trusted: ');
  eq(app.qualityKind({ bitrate: 64, lossless: true }), 'good',
    'a lossless file is not judged on a bitrate at all: ');
});

check('quality: a low sample rate pulls the verdict down on its own', () => {
  // A 320k rip of a 22 kHz source is a bad file the bitrate alone calls good.
  eq(app.qualityKind({ bitrate: 320, sampleRate: 22050, codec: 'mp3' }), 'poor');
  eq(app.qualityKind({ bitrate: 320, sampleRate: 32000, codec: 'mp3' }), 'caution',
    'below CD rate but not hopeless: ');
  eq(app.qualityKind({ bitrate: 320, sampleRate: 44100, codec: 'mp3' }), 'good');
  eq(app.qualityKind({ bitrate: 96, sampleRate: 44100, codec: 'mp3' }), 'poor',
    'a good sample rate cannot rescue a bad bitrate: ');
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

/* ------------------------------------------------------------- 1e. undo */

/** Runs `fn` with a throwaway clip list, then puts the real state back. */
function withClips(clips, fn) {
  const saved = app.state.clips;
  app.undoStack.length = 0;
  app.endUndoRun();
  app.state.clips = clips;
  try { fn(); } finally {
    app.state.clips = saved;
    app.undoStack.length = 0;
    app.endUndoRun();
  }
}

check('undo: a held key is one gesture, not thirty entries', () => {
  /* Key repeat fires about thirty times a second, and each repeat used to push
     its own snapshot. The stack is sixty deep, so two seconds on the arrow key
     emptied it and took every earlier edit with it. These calls are all inside
     the coalescing window by virtue of running synchronously, which is exactly
     the situation a held key produces. */
  withClips([{ id: 'a', srcStart: 0, srcEnd: 10 }], () => {
    app.pushUndo();                                     // an ordinary edit
    for (let i = 0; i < 40; i++) app.pushUndo('nudge-end:a');
    eq(app.undoStack.length, 2, 'the whole run should be a single entry: ');

    app.pushUndo('nudge-end:b');
    eq(app.undoStack.length, 3, 'a different clip is a different gesture: ');
    app.pushUndo('trim-in:b');
    eq(app.undoStack.length, 4, 'so is a different key: ');
  });
});

check('undo: untagged callers never coalesce, and end the run before them', () => {
  withClips([{ id: 'a', srcStart: 0, srcEnd: 10 }], () => {
    app.pushUndo();
    app.pushUndo();
    eq(app.undoStack.length, 2, 'two ordinary edits are two entries: ');
    for (let i = 0; i < 5; i++) app.pushUndo('nudge-end:a');
    eq(app.undoStack.length, 3);
    app.pushUndo();
    for (let i = 0; i < 5; i++) app.pushUndo('nudge-end:a');
    eq(app.undoStack.length, 5, 'the run cannot reach back past an untagged push: ');
  });
});

check('undo: an edit made straight after undoing is still undoable', () => {
  // The run has to end when the snapshot it opened with is popped, or the next
  // repeat of the same key folds into a gesture that no longer exists.
  withClips([{ id: 'a', srcStart: 0, srcEnd: 10 }], () => {
    app.pushUndo('nudge-end:a');
    eq(app.undoStack.length, 1);
    app.undoStack.pop();          // what undo() does to the stack
    app.endUndoRun();             // and what it must do to the run
    app.pushUndo('nudge-end:a');
    eq(app.undoStack.length, 1, 'the edit after an undo left nothing to undo: ');
  });
});

check('undo: the stack stays bounded however many gestures there are', () => {
  withClips([{ id: 'a', srcStart: 0, srcEnd: 10 }], () => {
    for (let i = 0; i < app.UNDO_DEPTH + 25; i++) app.pushUndo();
    eq(app.undoStack.length, app.UNDO_DEPTH, 'oldest entries drop off the bottom: ');
  });
});

/* ---------------------------------------------------------- 1f. library */

check('library: a file is removable only once the program has stopped using it', () => {
  withClips([
    { id: '1', file: 'a.mp3' },
    { id: '2', file: 'b.mp3' },
    { id: '3', file: 'a.mp3' },
  ], () => {
    eq(app.clipsUsing('a.mp3'), 2, 'the same song can be in a program twice: ');
    eq(app.clipsUsing('b.mp3'), 1);
    eq(app.clipsUsing('c.mp3'), 0, 'a file nothing is using can go: ');
  });
  withClips([], () => {
    eq(app.clipsUsing('a.mp3'), 0, 'an empty program holds nothing: ');
  });
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

/* ----------------------------------------------------- 1b. beat detection */

/* Fixtures are synthetic so the expected answer is known exactly. The random
   number generator is seeded, because a test that fails one run in twenty is
   worse than no test. */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Drum-machine audio: a short broadband burst on every beat. */
function clickTrain(bpm, seconds, opts = {}) {
  const sr = opts.sampleRate || 44100;
  const random = rng(opts.seed || 12345);
  const out = new Float32Array(Math.round(seconds * sr));
  const period = 60 / bpm;
  const burst = Math.round(0.03 * sr);
  const decay = 0.006 * sr;
  let k = 0;
  for (let t = opts.offset || 0; t < seconds; t += period, k++) {
    const at = Math.round(t * sr);
    // `accent` marks every Nth click as the downbeat
    const level = opts.accent && k % opts.accent === 0 ? 1 : 0.4;
    for (let i = 0; i < burst && at + i < out.length; i++) {
      out[at + i] += level * Math.exp(-i / decay) * (random() * 2 - 1);
    }
  }
  return out;
}

function noise(seconds, sampleRate = 44100) {
  const random = rng(999);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * 0.3;
  return out;
}

function tone(seconds, hz = 220, sampleRate = 44100) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

function fakeBuffer(samples, sampleRate = 44100) {
  return {
    sampleRate,
    length: samples.length,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
}

/** How far `t` sits from the nearest multiple of `period`, in seconds. */
function offGrid(t, period, phase = 0) {
  const x = (t - phase) / period;
  return Math.abs(x - Math.round(x)) * period;
}

check('FFT: round trips a known signal', () => {
  const n = 16;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 3 * i) / n);
  app.fftInPlace(re, im);
  // a pure cosine at bin 3 puts all its energy in bins 3 and n−3, nowhere else
  for (let k = 0; k < n; k++) {
    const mag = Math.hypot(re[k], im[k]);
    if (k === 3 || k === n - 3) near(mag, n / 2, 1e-3, `bin ${k}: `);
    else near(mag, 0, 1e-3, `bin ${k} should be empty: `);
  }
});

check('tempo: found within 1% for a range of speeds', () => {
  for (const bpm of [90, 120, 150]) {
    const found = app.analyseBeats(clickTrain(bpm, 12), 44100);
    near(found.bpm, bpm, bpm * 0.01, `${bpm} BPM: `);
    ok(found.confidence > 0.5, `${bpm} BPM: confidence only ${found.confidence.toFixed(2)}`);
  }
});

check('tempo: the prior resolves the half-or-double ambiguity', () => {
  // 76 BPM correlates just as well at 38 and 152; the prior should pick 76.
  const found = app.analyseBeats(clickTrain(76, 14), 44100);
  near(found.bpm, 76, 1.5);
});

check('beats: land on the clicks, whatever the phase', () => {
  const offset = 0.23;
  const found = app.analyseBeats(clickTrain(120, 12, { offset }), 44100);
  ok(found.beats.length > 15, `only ${found.beats.length} beats found`);
  for (const beat of found.beats) {
    ok(offGrid(beat.t, 0.5, offset) < 0.02,
      `beat at ${beat.t.toFixed(3)}s is ${(offGrid(beat.t, 0.5, offset) * 1000).toFixed(0)}ms off`);
  }
});

check('beats: an accent every four bars gives a downbeat in 4', () => {
  const found = app.analyseBeats(clickTrain(120, 14, { accent: 4 }), 44100);
  eq(found.meter, 4);
  const downbeats = found.beats.filter((b) => b.downbeat);
  ok(downbeats.length > 3, 'no downbeats marked');
  for (const beat of downbeats) {
    ok(offGrid(beat.t, 2.0) < 0.03, `downbeat at ${beat.t.toFixed(3)}s is not on an accent`);
  }
});

check('beats: material with no pulse reports no confidence', () => {
  // The detector always returns *something*; the point is that it says so.
  for (const [what, samples] of [['noise', noise(12)], ['a held tone', tone(12)]]) {
    const found = app.analyseBeats(samples, 44100);
    ok(found.confidence < app.BEAT.minConfidence,
      `${what} scored ${found.confidence.toFixed(2)}, above the ${app.BEAT.minConfidence} threshold`);
  }
});

check('beats: silence and near-empty input return nothing, not NaN', () => {
  for (const samples of [new Float32Array(0), new Float32Array(100), new Float32Array(44100)]) {
    const found = app.analyseBeats(samples, 44100);
    eq(found.beats, []);
    eq(found.confidence, 0);
    ok(!Number.isNaN(found.bpm), 'bpm went NaN');
  }
});

/* suggestJoin is fed grids directly here: the alignment maths is what is being
   checked, and a hand-built grid makes the right answer unambiguous. */

function grid(bpm, opts = {}) {
  const period = 60 / bpm;
  const meter = opts.meter || 4;
  const beats = [];
  for (let i = 0; i * period < (opts.seconds || 12); i++) {
    beats.push({
      t: (opts.phase || 0) + i * period,
      strength: 1,
      downbeat: (i - (opts.downbeat || 0)) % meter === 0,
    });
  }
  return { bpm, period, confidence: opts.confidence ?? 0.8, meter, beats };
}

check('join: both cuts move onto the beat', () => {
  const a = grid(120);                       // beats every 0.5s from 0
  const b = grid(120, { phase: 0.23 });
  const result = app.suggestJoin(a, 6.31, b, 4.12, { crossfade: 1.5 });
  ok(result.ok, `declined: ${result.reason}`);
  near(offGrid(6.31 + result.endShift, 0.5, 0), 0, 1e-6, 'outgoing cut off the grid: ');
  near(offGrid(4.12 + result.startShift, 0.5, 0.23), 0, 1e-6, 'incoming cut off the grid: ');
  ok(Math.abs(result.endShift) <= 2.5 && Math.abs(result.startShift) <= 2.5, 'moved too far');
});

check('join: the blend is a whole number of beats', () => {
  const a = grid(100);
  const result = app.suggestJoin(a, 6.0, grid(100), 4.0, { crossfade: 1.5 });
  ok(result.ok, `declined: ${result.reason}`);
  const beats = result.crossfade / a.period;
  near(beats, Math.round(beats), 1e-6, 'blend is not a whole number of beats: ');
  ok(beats >= 1, 'blend collapsed to nothing');
});

check('join: a hard cut stays a hard cut', () => {
  const result = app.suggestJoin(grid(120), 6.3, grid(120, { phase: 0.1 }), 4.1,
    { crossfade: 0 });
  ok(result.ok, `declined: ${result.reason}`);
  eq(result.crossfade, 0, 'a deliberate hard cut was turned into a blend: ');
});

check('join: reported length change matches what the shifts actually do', () => {
  const before = 1.5;
  const result = app.suggestJoin(grid(120), 6.31, grid(132, { phase: 0.4 }), 4.12,
    { crossfade: before });
  ok(result.ok, `declined: ${result.reason}`);
  // outgoing clip grows by endShift, incoming shrinks by startShift, and the
  // extra overlap comes off the total
  const expected = result.endShift - result.startShift - (result.crossfade - before);
  near(result.lengthDelta, expected, 1e-9);
});

check('join: a join that is already right is left alone', () => {
  // Both cuts sit on a downbeat and the blend is already four beats. Every
  // other candidate costs movement or length, so the answer must be to do
  // nothing — a tidy-up that fidgets with correct edits is worse than useless.
  const result = app.suggestJoin(grid(120), 6.0, grid(120), 4.0, { crossfade: 2.0 });
  ok(result.ok, `declined: ${result.reason}`);
  near(result.endShift, 0, 1e-9, 'moved the outgoing cut for no reason: ');
  near(result.startShift, 0, 1e-9, 'moved the incoming cut for no reason: ');
  near(result.crossfade, 2.0, 1e-9, 'changed a blend that was already on the beat: ');
  near(result.lengthDelta, 0, 1e-9);
});

check('join: never moves a cut further than the clip allows', () => {
  const result = app.suggestJoin(grid(120), 6.31, grid(120, { phase: 0.23 }), 4.12, {
    crossfade: 1.5,
    outRoom: { min: -0.1, max: 0.6 },
    incRoom: { min: -0.8, max: 0 },
  });
  ok(result.ok, `declined: ${result.reason}`);
  ok(result.endShift >= -0.1 && result.endShift <= 0.6, `endShift ${result.endShift} out of room`);
  ok(result.startShift >= -0.8 && result.startShift <= 0, `startShift ${result.startShift} out of room`);
});

check('join: declines when there is no beat to snap to', () => {
  const vague = grid(120, { confidence: 0.05 });
  const result = app.suggestJoin(vague, 6.0, grid(120), 4.0, { crossfade: 1.5 });
  eq(result.ok, false);
  eq(result.reason, 'no-beat');
  eq(result.endShift, 0, 'a declined join must not move anything: ');
  eq(result.startShift, 0);
  eq(result.crossfade, 1.5, 'a declined join must leave the blend alone: ');
});

check('join: declines when no beat is within reach', () => {
  const result = app.suggestJoin(grid(120), 6.0, grid(120), 4.0, {
    crossfade: 1.5,
    outRoom: { min: 0.05, max: 0.09 },     // narrower than the gap between beats
  });
  eq(result.ok, false);
  eq(result.reason, 'no-room');
});

check('join: mismatched tempos get a short blend, not a long one', () => {
  const wide = app.suggestJoin(grid(120), 6.0, grid(120), 4.0, { crossfade: 4 });
  const clash = app.suggestJoin(grid(120), 6.0, grid(97), 4.0, { crossfade: 4 });
  ok(wide.ok && clash.ok, 'both should still return an answer');
  ok(clash.crossfade < wide.crossfade,
    `${clash.crossfade.toFixed(2)}s blend between clashing tempos is no shorter than ${wide.crossfade.toFixed(2)}s`);
  eq(clash.reason, 'tempo-mismatch', 'the caller has to be able to say why: ');
  ok(clash.drift <= app.BEAT.maxDrift + 1e-9, `slips ${clash.drift.toFixed(3)} beats through the blend`);
});

check('join: half-speed against double-speed still counts as matched', () => {
  const result = app.suggestJoin(grid(80), 6.0, grid(160), 4.0, { crossfade: 2 });
  ok(result.ok, `declined: ${result.reason}`);
  eq(result.reason, 'aligned', 'an octave apart is not a mismatch: ');
  near(result.drift, 0, 1e-9);
});

check('join: end to end from audio, the two grids agree through the blend', () => {
  const a = fakeBuffer(clickTrain(120, 30, { seed: 1 }));               // beats from 0
  const b = fakeBuffer(clickTrain(120, 30, { offset: 0.23, seed: 2 })); // beats from 0.23
  const cutOut = 20.17;
  const cutIn = 5.0;
  const result = app.suggestJoinForBuffers(a, cutOut, b, cutIn, { crossfade: 1.5 });
  ok(result.ok, `declined: ${result.reason}`);

  const endAt = cutOut + result.endShift;
  const startAt = cutIn + result.startShift;
  ok(offGrid(endAt, 0.5, 0) < 0.03, `outgoing cut ${endAt.toFixed(3)}s is not on a click`);
  ok(offGrid(startAt, 0.5, 0.23) < 0.03, `incoming cut ${startAt.toFixed(3)}s is not on a click`);

  // The overlap begins `crossfade` before the outgoing cut. Both songs must be
  // on their own beat there, which is the whole point of the exercise.
  ok(offGrid(endAt - result.crossfade, 0.5, 0) < 0.03, 'the blend starts off the beat');
});

check('joinRoom: a cut can reach the file ends but never eat its clip', () => {
  const clip = { srcStart: 30, srcEnd: 90 };
  const entry = { duration: 200 };
  const end = app.joinRoom(clip, entry, 'end');
  eq(end.max, 110, 'the end can run on to the end of the file: ');
  near(end.min, -59.5, 1e-9, 'but must leave half a second of clip: ');
  const start = app.joinRoom(clip, entry, 'start');
  eq(start.min, -30, 'the start can go back to the beginning of the file: ');
  near(start.max, 59.5, 1e-9);
});

check('joinRoom: a clip already shorter than the minimum still allows no move', () => {
  // min must never come out positive, or zero shift falls outside the range and
  // every candidate is rejected.
  const room = app.joinRoom({ srcStart: 0, srcEnd: 0.2 }, { duration: 0.2 }, 'end');
  ok(room.min <= 0 && room.max >= 0, `zero shift is outside ${JSON.stringify(room)}`);
});

check('describeJoin: says what changed, and what it cost', () => {
  const base = { ok: true, reason: 'aligned', endShift: 0.8, startShift: 0, crossfade: 2 };
  eq(app.describeJoin({ ...base, lengthDelta: 0.8 }, 2),
    'Lined up with the beat. Program is 0.8s longer');
  eq(app.describeJoin({ ...base, lengthDelta: -1.24 }, 2),
    'Lined up with the beat. Program is 1.2s shorter');
  eq(app.describeJoin({ ...base, lengthDelta: 0.01 }, 2),
    'Lined up with the beat. Same length as before');
  eq(app.describeJoin({ ...base, reason: 'tempo-mismatch', lengthDelta: 0 }, 2),
    'Lined up as closely as these two speeds allow. Same length as before');
});

check('describeJoin: does not claim to have done anything it did not', () => {
  const still = { ok: true, reason: 'aligned', endShift: 0, startShift: 0, crossfade: 1.5, lengthDelta: 0 };
  eq(app.describeJoin(still, 1.5), 'This join is already on the beat');
  // a blend change on its own still counts as a change
  ok(app.describeJoin({ ...still, crossfade: 2 }, 1.5).startsWith('Lined up'));
  for (const reason of ['no-beat', 'no-room']) {
    const message = app.describeJoin({ ok: false, reason, lengthDelta: 0 }, 1.5);
    ok(/nothing changed$/.test(message), `"${message}" should end by saying nothing changed`);
  }
});

check('describeJoin: plain language, no audio jargon', () => {
  const banned = /bpm|tempo|crossfade|envelope|onset|phase|grid|downbeat|drift/i;
  const results = [
    { ok: false, reason: 'no-beat' },
    { ok: false, reason: 'no-room' },
    { ok: true, reason: 'aligned', endShift: 1, startShift: 0, crossfade: 2, lengthDelta: 1 },
    { ok: true, reason: 'tempo-mismatch', endShift: 1, startShift: 0, crossfade: 2, lengthDelta: -1 },
    { ok: true, reason: 'aligned', endShift: 0, startShift: 0, crossfade: 2, lengthDelta: 0 },
  ];
  for (const result of results) {
    const message = app.describeJoin(result, 2);
    ok(!banned.test(message), `"${message}" uses a word from the studio`);
    ok(!/\.$/.test(message), `"${message}" ends in a full stop; toasts elsewhere do not`);
  }
});

/* ------------------------------------------------------------ 1d. phrases */

/**
 * A piano-ish note: a few decaying harmonics, struck at `at` seconds.
 *
 * The taper at the end is not cosmetic. Stopping the decay dead at 5% of full
 * level leaves a step in the waveform, which is a broadband click — a false
 * onset in the middle of what the fixture calls silence, and it had the phrase
 * detector correctly reporting a note that only existed because of this.
 */
function note(out, at, hz, seconds = 1.2, level = 0.6, sampleRate = 44100) {
  const start = Math.round(at * sampleRate);
  const len = Math.round(seconds * sampleRate);
  const taper = Math.round(0.05 * sampleRate);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / sampleRate;
    const decay = Math.exp(-t * 2.6) * Math.min(1, (len - i) / taper);
    out[start + i] += level * decay * (
      Math.sin(2 * Math.PI * hz * t)
      + 0.4 * Math.sin(2 * Math.PI * hz * 2 * t)
      + 0.2 * Math.sin(2 * Math.PI * hz * 3 * t));
  }
  return out;
}

const HZ = { C4: 261.63, E4: 329.63, G4: 392.00, A4: 440, D4: 293.66, F4: 349.23, B4: 493.88 };

/**
 * Free-tempo piano: phrases of a few notes, separated by real silences, with
 * every interval drawn from a wide range so nothing repeats.
 *
 * The irregularity is load-bearing. An earlier version spaced notes evenly
 * enough that the beat detector accepted it, and the fallback under test never
 * ran — so the fixture asserts its own premise below, and every test using it
 * checks that `analyseBeats` really is declining before drawing a conclusion.
 *
 * Returns the audio and the spans where nothing is sounding. Spans, not
 * midpoints: anywhere inside a pause is a legitimate cut, and asserting against
 * the middle of one fails a cut that is perfectly good.
 */
function rubato(seconds, sampleRate = 44100) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const random = rng(20260810);
  const scale = [261.63, 277.18, 293.66, 329.63, 349.23, 392.00, 440, 466.16, 493.88];
  const silences = [];
  let t = 0.4;
  while (t < seconds - 1.2) {
    const notes = 3 + Math.floor(random() * 3);
    for (let i = 0; i < notes; i++) {
      note(out, t, scale[Math.floor(random() * scale.length)], 1.1, 0.5, sampleRate);
      if (i < notes - 1) t += 0.24 + random() * 0.62;      // within a line
    }
    const died = t + 1.0;                                   // the last note has decayed
    const pause = 0.7 + random() * 1.9;                     // the breath after it
    if (died + pause < seconds) silences.push([died, died + pause]);
    t = died + pause;
  }
  return { audio: out, silences };
}

/** Distance from `t` into the nearest silence — 0 when it is inside one. */
function outsideSilence(t, silences) {
  return Math.min(...silences.map(([from, to]) => Math.max(0, from - t, t - to)));
}

check('gaps: a silence in the middle of busy music scores high', () => {
  const rate = 86;
  const env = new Float32Array(rate * 10).fill(1);
  for (let i = rate * 4; i < rate * 4.5; i++) env[i] = 0;   // half a second of nothing
  const scores = app.gapScores(env, rate);
  const inTheGap = scores[Math.round(rate * 4.25)];
  const inTheMusic = scores[Math.round(rate * 8)];
  ok(inTheGap > 0.8, `the silence only scored ${inTheGap.toFixed(2)}`);
  ok(inTheMusic < 0.1, `steady music scored ${inTheMusic.toFixed(2)}, should be near zero`);
});

check('gaps: judged against the surroundings, not an absolute level', () => {
  // The same silence in a quiet passage must score the same as in a loud one.
  const rate = 86;
  const make = (level) => {
    const env = new Float32Array(rate * 10).fill(level);
    for (let i = rate * 4; i < rate * 4.5; i++) env[i] = 0;
    return app.gapScores(env, rate)[Math.round(rate * 4.25)];
  };
  near(make(1), make(0.02), 1e-6, 'a lull is a lull at any volume: ');
});

check('gaps: silence throughout scores nothing, rather than everything', () => {
  const scores = app.gapScores(new Float32Array(860), 86);
  for (const s of scores) eq(s, 0, 'with no music there is no break to find: ');
});

check('chroma: names the notes actually being played', () => {
  const sampleRate = 44100;
  const chord = new Float32Array(sampleRate * 2);
  for (const hz of [HZ.C4, HZ.E4, HZ.G4]) note(chord, 0, hz, 2, 0.5, sampleRate);
  const { chroma } = app.chromaFrames(chord, sampleRate);
  ok(chroma.length > 4, 'no chroma frames produced');

  const mid = chroma[Math.floor(chroma.length / 2)];
  const ranked = [...mid.keys()].sort((a, b) => mid[b] - mid[a]).slice(0, 3);
  // C is pitch class 0, E is 4, G is 7
  eq(ranked.slice().sort((a, b) => a - b), [0, 4, 7], 'the three strongest classes: ');
  near(mid.reduce((sum, v) => sum + v * v, 0), 1, 1e-5, 'frames are unit length: ');
});

check('chroma: a single tone lands on its own pitch class', () => {
  const sampleRate = 44100;
  const tone = new Float32Array(sampleRate * 2);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * HZ.A4 * i) / sampleRate);
  const { chroma } = app.chromaFrames(tone, sampleRate);
  const mid = chroma[Math.floor(chroma.length / 2)];
  const loudest = [...mid.keys()].reduce((best, p) => (mid[p] > mid[best] ? p : best), 0);
  eq(loudest, 9, 'A is pitch class 9: ');
});

check('chroma: too short to analyse returns nothing, not a crash', () => {
  const { chroma } = app.chromaFrames(new Float32Array(100), 44100);
  eq(chroma, []);
  eq(app.noveltyScores([], 21).length, 0);
});

check('chromaDistance: identical chords are close, unrelated ones are far', () => {
  const unit = (classes) => {
    const v = new Float32Array(12);
    for (const p of classes) v[p] = 1;
    let e = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    for (let p = 0; p < 12; p++) v[p] /= e;
    return v;
  };
  near(app.chromaDistance(unit([0, 4, 7]), unit([0, 4, 7])), 0, 1e-6, 'the same chord: ');
  near(app.chromaDistance(unit([0, 4, 7]), unit([1, 5, 8])), 1, 1e-6, 'no notes shared: ');
  const related = app.chromaDistance(unit([0, 4, 7]), unit([0, 4, 9]));
  ok(related > 0 && related < 0.5, `chords sharing two notes should be close, got ${related}`);
});

check('novelty: rises where the harmony moves, stays flat inside a chord', () => {
  const sampleRate = 44100;
  const audio = new Float32Array(sampleRate * 8);
  // four seconds of C major, then four of F sharp major — as far away as it gets
  for (let s = 0; s < 4; s += 0.5) for (const hz of [HZ.C4, HZ.E4, HZ.G4]) note(audio, s, hz, 0.6, 0.5, sampleRate);
  for (let s = 4; s < 8; s += 0.5) for (const hz of [369.99, 466.16, 277.18]) note(audio, s, hz, 0.6, 0.5, sampleRate);

  const { chroma, rate, offset } = app.chromaFrames(audio, sampleRate);
  const novelty = app.noveltyScores(chroma, rate);
  const at = (t) => novelty[Math.round((t - offset) * rate)];
  ok(at(4) > 0.5, `the change of key only scored ${at(4).toFixed(2)}`);
  ok(at(2) < at(4) / 2, `the middle of a steady chord scored ${at(2).toFixed(2)}, too high`);
});

check('phrases: found in free-tempo music that has no beat at all', () => {
  const { audio, silences } = rubato(16);
  // the premise: the beat detector should be declining this
  const beats = app.analyseBeats(audio, 44100);
  ok(beats.confidence < app.BEAT.minConfidence,
    `this fixture has a beat after all (${beats.confidence.toFixed(2)}), so it tests nothing`);

  const points = app.phrasePoints(audio, 44100);
  ok(points.length >= silences.length,
    `only found ${points.length} breaks for ${silences.length} pauses`);

  // every real pause is found
  for (const [from, to] of silences) {
    ok(points.some((p) => p.t > from - 0.3 && p.t < to + 0.3),
      `no break found in the pause from ${from.toFixed(2)}s to ${to.toFixed(2)}s`);
  }
  // and nothing is offered that is not one
  for (const p of points) {
    ok(outsideSilence(p.t, silences) < 0.35,
      `a break was offered at ${p.t.toFixed(2)}s, ${outsideSilence(p.t, silences).toFixed(2)}s `
      + 'from any pause — that is in the middle of a phrase');
  }
});

check('phrases: every point says where the music picks up again', () => {
  for (const p of app.phrasePoints(rubato(16).audio, 44100)) {
    ok(p.resumes >= p.t, 'the music cannot resume before the lull starts');
    ok(p.resumes - p.t < 3, `a ${(p.resumes - p.t).toFixed(1)}s lull is not a phrase break`);
    ok(p.score >= app.PHRASE.minScore, 'a point below the threshold was kept');
  }
});

check('phrases: silence has no breaks in it', () => {
  eq(app.phrasePoints(new Float32Array(44100 * 8), 44100), []);
  eq(app.phrasePoints(new Float32Array(64), 44100), []);
});

check('phrase join: both cuts move to a break in the music', () => {
  const points = app.phrasePoints(rubato(16).audio, 44100);
  const result = app.suggestPhraseJoin(points, 7.3, points, 4.1, { crossfade: 1.5 });
  ok(result.ok, `declined: ${result.reason}`);
  eq(result.reason, 'phrase');

  const isPoint = (t, key) => points.some((p) => Math.abs(p[key] - t) < 1e-6);
  ok(isPoint(7.3 + result.endShift, 't'), 'the outgoing cut is not at a break');
  ok(isPoint(4.1 + result.startShift, 'resumes'), 'the incoming cut is not where music resumes');
  ok(Math.abs(result.endShift) <= 2.5 && Math.abs(result.startShift) <= 2.5, 'moved too far');
});

check('phrase join: the cut lands in a pause that is really there', () => {
  /* The check above only says the cut is at one of the points we returned,
     which proves nothing if the points are wrong. This one measures against
     where the fixture actually left silence, and it is what caught the scoring
     cutting in the middle of a line on the strength of a harmony change, and
     then again on the ordinary gap between two notes. */
  const { audio, silences } = rubato(40);
  const buffer = fakeBuffer(audio);

  for (const [cutOut, cutIn] of [[16.4, 9.2], [20, 12], [27, 19]]) {
    const result = app.suggestJoinForBuffers(buffer, cutOut, buffer, cutIn, { crossfade: 1.2 });
    ok(result.ok, `declined at ${cutOut}s: ${result.reason}`);
    const endAt = cutOut + result.endShift;
    const startAt = cutIn + result.startShift;
    ok(outsideSilence(endAt, silences) < 0.25,
      `outgoing cut ${endAt.toFixed(2)}s is ${outsideSilence(endAt, silences).toFixed(2)}s `
      + 'outside any pause — it is cutting through the music');
    ok(outsideSilence(startAt, silences) < 0.25,
      `incoming cut ${startAt.toFixed(2)}s is ${outsideSilence(startAt, silences).toFixed(2)}s `
      + 'outside any pause');
    // the incoming side aims at where the music picks up, so it should sit in
    // the later part of its pause rather than at the front of it
    const pause = silences.find(([from, to]) => startAt > from - 0.25 && startAt < to + 0.25);
    ok(startAt > (pause[0] + pause[1]) / 2,
      `incoming cut ${startAt.toFixed(2)}s opens with silence: the pause runs to ${pause[1].toFixed(2)}s`);
  }
});

check('phrase join: the outgoing clip stops in the lull, the incoming starts after it', () => {
  // The asymmetry is the point: ending in silence sounds finished, but opening
  // with silence just wastes seconds off the clock.
  const points = [
    { t: 5.0, resumes: 5.6, score: 0.9, gap: 0.9, novelty: 0.5 },
    { t: 9.0, resumes: 9.4, score: 0.9, gap: 0.9, novelty: 0.5 },
  ];
  const result = app.suggestPhraseJoin(points, 5.0, points, 5.6, { crossfade: 2 });
  ok(result.ok, `declined: ${result.reason}`);
  near(result.endShift, 0, 1e-9, 'the outgoing cut was already in the lull: ');
  near(result.startShift, 0, 1e-9, 'the incoming cut was already where music resumes: ');
});

check('phrase join: a short blend is lengthened, a hard cut is left alone', () => {
  const points = app.phrasePoints(rubato(16).audio, 44100);
  const blended = app.suggestPhraseJoin(points, 7.3, points, 4.1, { crossfade: 0.6 });
  ok(blended.crossfade >= app.PHRASE.minBlend,
    `a ${blended.crossfade}s blend is exposed with no beat to carry it`);
  const hard = app.suggestPhraseJoin(points, 7.3, points, 4.1, { crossfade: 0 });
  eq(hard.crossfade, 0, 'a deliberate hard cut must survive: ');
  const capped = app.suggestPhraseJoin(points, 7.3, points, 4.1, { crossfade: 0.6, maxCrossfade: 1 });
  ok(capped.crossfade <= 1, 'the blend cannot outlast the clip');
});

check('phrase join: reported length change matches the shifts', () => {
  const points = app.phrasePoints(rubato(16).audio, 44100);
  const before = 1.5;
  const result = app.suggestPhraseJoin(points, 7.3, points, 4.1, { crossfade: before });
  near(result.lengthDelta,
    result.endShift - result.startShift - (result.crossfade - before), 1e-9);
});

check('phrase join: declines rather than inventing a break', () => {
  const empty = app.suggestPhraseJoin([], 5, [], 5, { crossfade: 1.5 });
  eq(empty.ok, false);
  eq(empty.reason, 'no-phrase');
  eq(empty.endShift, 0);
  eq(empty.crossfade, 1.5, 'a declined join leaves the blend alone: ');

  const points = app.phrasePoints(rubato(16).audio, 44100);
  const boxed = app.suggestPhraseJoin(points, 7.3, points, 4.1, {
    crossfade: 1.5,
    outRoom: { min: 0.01, max: 0.02 },
  });
  eq(boxed.ok, false);
  eq(boxed.reason, 'no-room');
});

check('the join button falls back to phrasing whenever the beat path declines', () => {
  // Deterministic: forcing the beat path to decline proves the wiring without
  // depending on how the detector happens to judge a synthetic fixture.
  const buffer = fakeBuffer(rubato(40).audio);
  const forced = app.suggestJoinForBuffers(buffer, 14.5, buffer, 23, {
    crossfade: 1.5, minConfidence: 1,
  });
  ok(forced.ok, `declined: ${forced.reason}`);
  eq(forced.reason, 'phrase');
});

check('the join button falls back to phrasing on free-tempo music', () => {
  const buffer = fakeBuffer(rubato(40).audio);
  for (const [cutOut, cutIn] of [[14.5, 23], [21, 9.5]]) {
    // the premise, per window: the beat path has to be the one declining
    for (const at of [cutOut, cutIn]) {
      const w = app.windowAround(buffer, at);
      ok(app.analyseBeats(w.samples, w.sampleRate).confidence < app.BEAT.minConfidence,
        `the window at ${at}s reads as having a beat, so this tests nothing`);
    }
    const result = app.suggestJoinForBuffers(buffer, cutOut, buffer, cutIn, { crossfade: 1.5 });
    ok(result.ok, `declined: ${result.reason}`);
    eq(result.reason, 'phrase', `free-tempo music at ${cutOut}s should get the phrase strategy: `);
    ok(Math.abs(result.endShift) <= 2.5, 'moved too far');
  }
});

check('beats: a grid mostly nobody plays is not a pulse', () => {
  /* Sparse music lets a metronome fit a few notes by chance, and the contrast
     measure rates that as confidently as a drum track — which had free-tempo
     music being snapped to an invented grid. Coverage is what separates them.

     It is a damper, not a cure: some windows of sparse music still read as
     having a beat. Finishing that needs real recordings to calibrate against,
     and it is written up in AGENTS.md rather than tuned against fixtures. */
  const sparse = app.analyseBeats(rubato(14).audio, 44100);
  const steady = app.analyseBeats(clickTrain(120, 14, { accent: 4 }), 44100);

  ok(sparse.coverage < app.BEAT.minCoverage,
    `sparse piano covers ${sparse.coverage.toFixed(2)} of its grid, which is not sparse`);
  ok(steady.coverage > 0.9, `a drum track covers only ${steady.coverage.toFixed(2)} of its grid`);
  ok(steady.confidence > 0.5,
    `the damper must not touch rhythmic music, which scored ${steady.confidence.toFixed(2)}`);
  ok(sparse.confidence < steady.confidence / 2,
    `sparse piano at ${sparse.confidence.toFixed(2)} is not clearly below `
    + `a drum track at ${steady.confidence.toFixed(2)}`);
});

check('the join button still prefers the beat when there is one', () => {
  const audio = fakeBuffer(clickTrain(120, 30, { accent: 4 }));
  const result = app.suggestJoinForBuffers(audio, 16.4, audio, 9.2, { crossfade: 1.5 });
  ok(result.ok, `declined: ${result.reason}`);
  ok(result.reason !== 'phrase', 'a steady beat must not be given up for phrasing');
});

check('describeJoin: says which of the two things it did', () => {
  const phrase = { ok: true, reason: 'phrase', endShift: 0.8, startShift: 0, crossfade: 2, lengthDelta: 0 };
  eq(app.describeJoin(phrase, 2),
    'No steady beat here, so the cut moved to where the phrase ends. Same length as before');
  eq(app.describeJoin({ ...phrase, endShift: 0, startShift: 0 }, 2),
    'This join is already at a natural break');
  eq(app.describeJoin({ ok: false, reason: 'no-phrase' }, 1.5),
    'Could not find a natural break in the music, so nothing changed');
});

check('monoWindow: averages channels and clamps to the buffer', () => {
  const left = new Float32Array([1, 1, 1, 1]);
  const right = new Float32Array([0, 0, 0, 0]);
  const stereo = {
    sampleRate: 2, length: 4, numberOfChannels: 2,
    getChannelData: (c) => (c === 0 ? left : right),
  };
  const mid = app.monoWindow(stereo, 0.5, 1.5);
  eq(Array.from(mid.samples), [0.5, 0.5], 'channels should be averaged: ');
  eq(mid.start, 0.5);
  const clipped = app.monoWindow(stereo, -10, 99);
  eq(clipped.samples.length, 4, 'a window past the ends should be trimmed: ');
  eq(clipped.start, 0);
});

/* ----------------------------------------------------------- 1c. loudness */

function sine(hz, seconds, amplitude, sampleRate = 44100) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

function join(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** dBFS of a sine's amplitude, as a stereo pair with no weighting applied. */
const stereoSineLevel = (amplitude) => 20 * Math.log10(amplitude / Math.SQRT2) + 10 * Math.log10(2);

check('K-weighting: the derivation reproduces the published 48 kHz table', () => {
  // BS.1770-4 tabulates coefficients at 48 kHz only. Everything here runs at
  // 44100, so they are derived — and this is what says the derivation is right.
  const { shelf, highpass } = app.kWeighting(48000);
  const published = {
    b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
    a1: -1.69065929318241, a2: 0.73248077421585,
  };
  for (const [name, value] of Object.entries(published)) {
    near(shelf[name], value, 1e-12, `shelf ${name}: `);
  }
  eq([highpass.b0, highpass.b1, highpass.b2], [1, -2, 1], 'high pass numerator is fixed: ');
  near(highpass.a1, -1.99004745483398, 1e-12, 'high pass a1: ');
  near(highpass.a2, 0.99007225036621, 1e-12, 'high pass a2: ');
});

check('K-weighting: 44100 gets its own coefficients, not the 48 kHz ones', () => {
  const at44 = app.kWeighting(44100).shelf;
  const at48 = app.kWeighting(48000).shelf;
  ok(Math.abs(at44.b0 - at48.b0) > 1e-6, 'the same numbers came back for a different rate');
  for (const v of Object.values(at44)) ok(isFinite(v), 'coefficient is not finite');
});

check('loudness: a 1 kHz tone reads its own level', () => {
  // What the -0.691 offset is for: at the reference frequency the weighting
  // gain and the offset cancel, so the meter agrees with the arithmetic.
  for (const amplitude of [0.1, 0.5, 0.02]) {
    const tone = sine(997, 5, amplitude);
    near(app.loudnessOf([tone, tone], 44100), stereoSineLevel(amplitude), 0.05,
      `amplitude ${amplitude}: `);
  }
});

check('loudness: a level difference is reported exactly', () => {
  // The property the whole feature rests on. Absolute accuracy can drift a
  // little; the difference between two clips may not.
  const quiet = sine(997, 5, 0.05);
  const loud = sine(997, 5, 0.1);
  const gap = app.loudnessOf([loud, loud], 44100) - app.loudnessOf([quiet, quiet], 44100);
  near(gap, 20 * Math.log10(2), 0.01, 'doubling the amplitude is 6.02 LU: ');
});

check('loudness: weighted, so bass counts for less and treble for more', () => {
  const level = (hz) => app.loudnessOf([sine(hz, 5, 0.1), sine(hz, 5, 0.1)], 44100);
  const reference = level(997);
  ok(level(40) < reference - 4, `40 Hz should read well below 1 kHz, got ${level(40).toFixed(1)}`);
  ok(level(10000) > reference + 2, `10 kHz should read above 1 kHz, got ${level(10000).toFixed(1)}`);
});

check('loudness: mono is measured the way it will be played', () => {
  // Web Audio sends a mono buffer to both speakers. Measured as a single
  // channel it would read 3 dB low, and every mono file would end up too loud.
  const tone = sine(997, 5, 0.1);
  near(app.loudnessOf([tone], 44100), app.loudnessOf([tone, tone], 44100), 1e-9);
});

check('loudness: silence at the end does not drag the reading down', () => {
  const tone = sine(997, 10, 0.1);
  const hush = sine(997, 30, 1e-5);          // audible only to a meter
  const alone = app.loudnessOf([tone, tone], 44100);
  const withTail = app.loudnessOf([join(tone, hush), join(tone, hush)], 44100);
  near(withTail, alone, 0.1, 'the absolute gate should ignore the tail: ');
  // Without the gate the mean would land about 6 dB low — this is the size of
  // the mistake the gate is preventing, not an incidental detail.
  const ungated = 10 * Math.log10((10 * Math.pow(10, alone / 10) + 30 * 1e-10) / 40);
  ok(ungated < alone - 4, 'the tail really would have mattered');
});

check('loudness: a quiet passage does not drag the reading down either', () => {
  // 30 LU below the body of the piece: loud enough to pass the absolute gate,
  // quiet enough that the relative gate has to be the one to exclude it.
  const loud = sine(997, 10, 0.1);
  const soft = sine(997, 10, 0.1 * Math.pow(10, -30 / 20));
  const measured = app.loudnessOf([join(loud, soft), join(loud, soft)], 44100);
  near(measured, app.loudnessOf([loud, loud], 44100), 0.15,
    'the relative gate should keep the reading on the body of the music: ');
});

check('loudness: agrees with an independent meter', () => {
  /* These two numbers came from ffmpeg's ebur128 filter — a separate, long
     established BS.1770 implementation — run on exactly these signals. It
     agreed to the 0.1 dB it prints on every case tried except a pure 50 Hz
     tone (0.06 dB out, on the steepest part of the high pass) and mono, which
     differs by the deliberate 3.01 dB above. Keeping the numbers here means the
     agreement is checked on every run without needing ffmpeg installed. */
  const mixed = (a, b) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < out.length; i++) out[i] = a[i] + b[i];
    return out;
  };
  const left = mixed(sine(220, 8, 0.25), sine(3000, 8, 0.06));
  const right = mixed(sine(220, 8, 0.24), sine(3000, 8, 0.07));
  near(app.loudnessOf([left, right], 44100), -12.4, 0.05, 'two tones, unequal channels: ');

  // Pink noise, which loads the weighting filter far more like music does.
  const pink = (seconds, amplitude, seed) => {
    const random = rng(seed);
    const out = new Float32Array(Math.round(seconds * 44100));
    const b = new Float64Array(7);
    for (let i = 0; i < out.length; i++) {
      const w = random() * 2 - 1;
      b[0] = 0.99886 * b[0] + w * 0.0555179;
      b[1] = 0.99332 * b[1] + w * 0.0750759;
      b[2] = 0.96900 * b[2] + w * 0.1538520;
      b[3] = 0.86650 * b[3] + w * 0.3104856;
      b[4] = 0.55000 * b[4] + w * 0.5329522;
      b[5] = -0.7616 * b[5] - w * 0.0168980;
      out[i] = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11 * amplitude;
      b[6] = w * 0.115926;
    }
    return out;
  };
  near(app.loudnessOf([pink(10, 0.5, 1), pink(10, 0.5, 2)], 44100), -17.7, 0.05, 'pink noise: ');
});

check('loudness: nothing measurable reports nothing, not a number', () => {
  const cases = [
    ['silence', [new Float32Array(44100 * 5)]],
    ['too short for a block', [sine(997, 0.2, 0.5)]],
    ['no channels', []],
    ['empty channel', [new Float32Array(0)]],
  ];
  for (const [what, channels] of cases) {
    const value = app.loudnessOf(channels, 44100);
    eq(value, -Infinity, `${what}: `);
  }
});

check('loudness: measuring does not alter the audio it measures', () => {
  // These samples are the decoded buffer everything else plays from, and the
  // filter runs in place. A missing copy here would quietly wreck playback.
  const tone = sine(997, 2, 0.4);
  const before = Array.from(tone);
  app.loudnessOf([tone, tone], 44100);
  eq(Array.from(tone), before, 'the input was filtered in place: ');
});

check('peakOf: the largest sample anywhere, across every channel', () => {
  near(app.peakOf([new Float32Array([0.1, -0.7, 0.3])]), 0.7, 1e-7, 'negative peaks count: ');
  near(app.peakOf([new Float32Array([0.1]), new Float32Array([0.9])]), 0.9, 1e-7, 'both channels: ');
  eq(app.peakOf([]), 0);
});

check('measureClip: reads the kept part, not the whole file', () => {
  const buffer = fakeBuffer(join(sine(997, 6, 0.4), sine(997, 6, 0.04)));
  const first = app.measureClip(buffer, 0, 6);
  const second = app.measureClip(buffer, 6, 12);
  near(first.loudness - second.loudness, 20, 0.15, 'the two halves are 20 dB apart: ');
  near(first.peak, 0.4, 0.01);
  near(second.peak, 0.04, 0.01);
});

check('gains: matched clips end up matched, and as loud as the peaks allow', () => {
  // The dynamic clip runs out of headroom first, so it sets the level and its
  // peak lands exactly on the ceiling.
  const measures = [
    { loudness: -24, peak: 0.7 },    // crest 20.9 dB — the constraint
    { loudness: -10, peak: 0.99 },   // crest 9.9 dB
  ];
  const { gains, loudness } = app.solveGains(measures, { ceiling: -1 });
  const after = measures.map((m, i) => m.loudness + 20 * Math.log10(gains[i]));
  near(after[0], after[1], 1e-9, 'clips must end up at the same loudness: ');
  near(after[0], loudness, 1e-9, 'and at the loudness reported: ');
  const worst = Math.max(...measures.map((m, i) => m.peak * gains[i]));
  near(worst, Math.pow(10, -1 / 20), 1e-9, 'the loudest peak should sit on the ceiling: ');
});

check('gains: already matched clips are only trimmed for headroom', () => {
  const measures = [{ loudness: -14, peak: 0.9 }, { loudness: -14, peak: 0.9 }];
  const { gains } = app.solveGains(measures);
  near(gains[0], gains[1], 1e-12, 'equal input, equal output: ');
});

/** Measures a real recording could actually produce: the peak is above the
    loudness, by anything from a squashed 3 dB to a very dynamic 34 dB. */
function plausibleMeasures(random, count) {
  const measures = [];
  for (let i = 0; i < count; i++) {
    const peak = 0.02 + random() * 0.98;
    measures.push({ loudness: 20 * Math.log10(peak) - (3 + random() * 31), peak });
  }
  return measures;
}

check('gains: nothing clips, whatever it is handed', () => {
  const random = rng(4242);
  const limit = Math.pow(10, app.LOUDNESS.ceiling / 20);
  for (let trial = 0; trial < 300; trial++) {
    const measures = plausibleMeasures(random, 1 + Math.floor(random() * 5));
    const { gains } = app.solveGains(measures);
    measures.forEach((m, i) => {
      ok(m.peak * gains[i] <= limit + 1e-9,
        `clip ${i} of ${JSON.stringify(measures)} peaks at ${(m.peak * gains[i]).toFixed(4)}`);
    });
  }
});

check('gains: one freak clip cannot pull the rest down without limit', () => {
  // A cut that is mostly quiet with a single crash in it sits 38 dB below its
  // own peak. It cannot be matched without clipping whatever we do — the point
  // of the cap is that it cannot take the other songs down with it either.
  const ordinary = [{ loudness: -12, peak: 0.9 }, { loudness: -14, peak: 0.85 }];
  const freak = { loudness: -40, peak: Math.pow(10, -2 / 20) };
  const { loudness, short } = app.solveGains([...ordinary, freak]);

  const uncapped = app.LOUDNESS.ceiling - 38;
  ok(loudness > uncapped + 10, `the outlier still set the level (${loudness.toFixed(1)})`);
  near(loudness, app.LOUDNESS.ceiling - app.LOUDNESS.maxCrest, 1e-9,
    'the cap should be what decides the level: ');
  eq(short, [2], 'and the outlier is the one left short: ');
});

check('gains: an absurd target is still not allowed to clip', () => {
  const measures = [{ loudness: -20, peak: 0.8 }];
  const { gains, short } = app.solveGains(measures, { target: 0 });
  near(measures[0].peak * gains[0], Math.pow(10, -1 / 20), 1e-9, 'held at the ceiling: ');
  eq(short, [0], 'and reported as not having got there: ');
});

check('gains: near-silence is boosted only so far, and says so', () => {
  const measures = [{ loudness: -20, peak: 0.8 }, { loudness: -60, peak: 0.001 }];
  const { gains, short } = app.solveGains(measures);
  eq(short, [1], 'the clip that fell short should be named: ');
  near(20 * Math.log10(gains[1]), app.LOUDNESS.maxBoost, 1e-9, 'held at the boost limit: ');
});

check('gains: an unmeasurable clip is left alone and does not spoil the rest', () => {
  const measures = [
    { loudness: -20, peak: 0.8 },
    { loudness: -Infinity, peak: 0 },          // a silent clip
    { loudness: -26, peak: 0.5 },
  ];
  const { gains } = app.solveGains(measures);
  eq(gains[1], 1, 'an unmeasurable clip must come back untouched, exactly: ');
  for (const g of gains) ok(isFinite(g) && g > 0, `gain ${g} is not usable`);
  const after = [0, 2].map((i) => measures[i].loudness + 20 * Math.log10(gains[i]));
  near(after[0], after[1], 1e-9, 'the measurable clips still match each other: ');
});

check('gains: nothing measurable at all leaves every clip untouched', () => {
  const { gains, loudness, short } = app.solveGains([{ loudness: -Infinity, peak: 0 }]);
  eq(gains, [1]);
  eq(loudness, -Infinity);
  eq(short, []);
});

check('clipGain: a hand-edited project file cannot blow the speakers', () => {
  eq(app.clipGain({ gain: 1 }), 1);
  eq(app.clipGain({}), 1, 'missing means "as recorded", not silent: ');
  eq(app.clipGain({ gain: undefined }), 1);
  eq(app.clipGain({ gain: 0 }), 0, 'a deliberate zero is allowed: ');
  eq(app.clipGain({ gain: 9999 }), app.MAX_GAIN, 'absurd values are clamped: ');
  for (const bad of [-1, NaN, Infinity, 'loud', null]) {
    eq(app.clipGain({ gain: bad }), 1, `${JSON.stringify(bad)} should fall back to 1: `);
  }
});

check('level slider: decibels and percentages agree, and round trip', () => {
  near(app.gainToDb(1), 0, 1e-9);
  near(app.gainToDb(2), 6.0206, 1e-4, 'twice as loud is about 6 dB: ');
  near(app.dbToGain(0), 1, 1e-9);
  for (const db of [-24, -12, -6, -0.5, 0, 3, 12]) {
    near(app.gainToDb(app.dbToGain(db)), db, 1e-9, `${db} dB: `);
  }
  eq(app.levelPercent(1), 100, 'unchanged reads as 100%: ');
  eq(app.levelPercent(app.dbToGain(-6)), 50);
  eq(app.levelPercent(app.dbToGain(6)), 200);
  eq(app.gainToDb(0), app.LEVEL_SLIDER.min, 'silence pins to the bottom, not -Infinity: ');
});

check('level slider: its range covers every gain the solver can produce', () => {
  // A clip pushed past the ends of the slider would show a position that lies.
  const random = rng(90210);
  for (let trial = 0; trial < 200; trial++) {
    const measures = plausibleMeasures(random, 2 + Math.floor(random() * 4));
    for (const gain of app.solveGains(measures).gains) {
      const db = app.gainToDb(gain);
      ok(db >= app.LEVEL_SLIDER.min - 1e-9 && db <= app.LEVEL_SLIDER.max + 1e-9,
        `${db.toFixed(1)} dB is outside the slider for ${JSON.stringify(measures)}`);
    }
  }
});

check('level slider: the HTML range matches the constant the code works from', () => {
  // Two places have to agree, and nothing else would notice if they stopped.
  const tag = html.match(/<input id="level"[^>]*>/);
  ok(tag, 'the level slider is missing from the HTML');
  for (const [attribute, expected] of Object.entries(app.LEVEL_SLIDER)) {
    const found = tag[0].match(new RegExp(`${attribute}="(-?[\\d.]+)"`));
    ok(found, `the slider has no ${attribute}`);
    eq(Number(found[1]), expected, `slider ${attribute}: `);
  }
  ok(app.MAX_GAIN >= app.dbToGain(app.LEVEL_SLIDER.max),
    'the clamp is tighter than the slider, so the top of the slider would not stick');
});

check('describeLevels: counts what happened, and owns up to what did not', () => {
  eq(app.describeLevels({ matched: 3, short: 0, unmeasured: 0 }), 'Evened out 3 songs');
  eq(app.describeLevels({ matched: 1, short: 0, unmeasured: 0 }), 'Evened out 1 song');
  eq(app.describeLevels({ matched: 2, short: 1, unmeasured: 0 }),
    'Evened out 2 songs — one could not come all the way up, so it stays quieter than the rest');
  eq(app.describeLevels({ matched: 2, short: 0, unmeasured: 1 }),
    'Evened out 2 songs — one could not be measured and was left as it was');
  eq(app.describeLevels({ matched: 2, short: 2, unmeasured: 3 }),
    'Evened out 2 songs — 2 could not come all the way up, so they stay quieter '
    + 'than the rest, and 3 could not be measured and were left as they were');
  eq(app.describeLevels({ matched: 0, short: 0, unmeasured: 2 }),
    'Could not measure these songs, so nothing changed');
});

check('describeLevels: plain language, no audio jargon', () => {
  const banned = /lufs|decibel| db\b|gain|normali[sz]|peak|headroom|loudness|amplitude/i;
  for (const short of [0, 1, 2]) {
    for (const unmeasured of [0, 1, 2]) {
      for (const matched of [0, 1, 3]) {
        const message = app.describeLevels({ matched, short, unmeasured });
        ok(!banned.test(message), `"${message}" uses a word from the studio`);
        ok(!/\.$/.test(message), `"${message}" ends in a full stop; toasts elsewhere do not`);
      }
    }
  }
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

/* The two music-get wrappers are the same tool written twice, once for a shell
   and once for cmd. Nothing forces them to agree, and a fix applied to one and
   forgotten on the other is the obvious way for that to rot, so the flags that
   define the behaviour are asserted in both. */
check('the music-get wrappers agree on what they do', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'tools/music-get.sh'), 'utf8');
  const cmd = fs.readFileSync(path.join(ROOT, 'tools/music-get.cmd'), 'utf8');
  const flags = [
    '--format bestaudio',   // the native stream, never re-encoded
    '--no-overwrites',
    '--no-playlist',
    '--yes-playlist',
    '--playlist-items 1',   // one song means one song, even off a stray feed
    '--print-to-file',      // how "did anything actually arrive" is answered
  ];
  for (const flag of flags) {
    ok(sh.includes(flag), `music-get.sh no longer passes ${flag}`);
    ok(cmd.includes(flag), `music-get.cmd no longer passes ${flag}`);
  }
  // Comments only, stripped out: both scripts say the word ffmpeg while
  // explaining that they don't need it, which is the opposite of the problem.
  const code = (sh + cmd)
    .split('\n')
    .filter((line) => !/^\s*(#|rem\b)/i.test(line))
    .join('\n');
  ok(!/--extract-audio|--audio-format|\bffmpeg\b/i.test(code),
    'a wrapper converts the audio; it is meant to take the stream as it is');
  ok(!/\/home\/|file:\/\/\//.test(code), 'a wrapper references a local path');
  if (process.platform !== 'win32') {
    ok(fs.statSync(path.join(ROOT, 'tools/music-get.sh')).mode & 0o111,
      'music-get.sh is not executable');
  }
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
