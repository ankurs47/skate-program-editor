/**
 * The editor itself — the app.js file.
 *
 * Timeline maths with overlapping blends, the envelopes, the undo stack, the
 * project file format, and the plain-language strings the interface is built
 * from. Nothing here needs a DOM.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { app, check, eq, near, ok, ROOT } = require('./harness.js');

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

check('clips: trims are brought inside the file that actually arrives', () => {
  /* A project records trims but not the audio, so nothing checks those numbers
     against a real duration until the file turns up. Web Audio plays silence
     past the end rather than failing, so an overrun used to show a clip
     duration that was a lie and export a programme of the wrong length. */
  const clips = [
    { file: 'a.mp3', srcStart: 0, srcEnd: 200 },    // the file is only 120s long
    { file: 'a.mp3', srcStart: 10, srcEnd: 60 },    // already fits
    { file: 'b.mp3', srcStart: 0, srcEnd: 900 },    // a different file entirely
  ];
  eq(app.clampClipsToFile(clips, { name: 'a.mp3', duration: 120 }), 1,
    'only the clip that overran should be counted: ');
  eq(clips[0].srcEnd, 120, 'the end is pulled back to the end of the file: ');
  eq([clips[1].srcStart, clips[1].srcEnd], [10, 60], 'a clip that fits is untouched: ');
  eq(clips[2].srcEnd, 900, 'another file is not this file: ');
});

check('clips: even a start past the end of the file leaves a usable clip', () => {
  const clips = [{ file: 'a.mp3', srcStart: 300, srcEnd: 400 }];
  app.clampClipsToFile(clips, { name: 'a.mp3', duration: 10 });
  const { srcStart, srcEnd } = clips[0];
  ok(srcStart >= 0 && srcEnd <= 10, `clip ${srcStart}–${srcEnd} is outside a 10s file`);
  near(srcEnd - srcStart, app.MIN_CLIP, 1e-9, 'it should collapse to the minimum, not invert: ');

  // A zero-length file is degenerate, but must not produce NaN trims.
  const empty = [{ file: 'a.mp3', srcStart: 5, srcEnd: 9 }];
  app.clampClipsToFile(empty, { name: 'a.mp3', duration: 0 });
  for (const v of [empty[0].srcStart, empty[0].srcEnd]) ok(Number.isFinite(v), 'trim went NaN');
});

check('join preview: plays a few seconds either side of the join', () => {
  const clips = [
    { srcStart: 0, srcEnd: 60, crossfade: 0 },
    { srcStart: 0, srcEnd: 60, crossfade: 2 },
  ];
  // the second clip starts at 58, and the blend runs from there to 60
  const range = app.joinPreviewRange(clips, 1, { lead: 4, tail: 4 });
  eq(range.from, 54, 'four seconds before the join: ');
  eq(range.until, 64, 'the tail is measured from the end of the blend, not the cut: ');
});

check('join preview: stays inside the programme, and declines when there is no join', () => {
  const clips = [
    { srcStart: 0, srcEnd: 3, crossfade: 0 },
    { srcStart: 0, srcEnd: 3, crossfade: 0 },
  ];
  const range = app.joinPreviewRange(clips, 1);
  eq(range.from, 0, 'cannot start before the programme does: ');
  eq(range.until, 6, 'cannot run past the end of it: ');
  eq(app.joinPreviewRange(clips, 0), null, 'the first clip has nothing before it: ');
  eq(app.joinPreviewRange(clips, 9), null, 'a clip that is not there: ');
  eq(app.joinPreviewRange([], 1), null, 'an empty programme: ');

  // With room either side the defaults are what decide the window, and they
  // have to be long enough to judge a join by and short enough not to be a wait.
  const roomy = app.joinPreviewRange(
    [{ srcStart: 0, srcEnd: 60, crossfade: 0 }, { srcStart: 0, srcEnd: 60, crossfade: 0 }], 1);
  eq(roomy.from, 60 - app.JOIN_PREVIEW.lead, 'the lead comes from the defaults: ');
  eq(roomy.until, 60 + app.JOIN_PREVIEW.tail, 'and so does the tail: ');
  ok(roomy.until - roomy.from >= 4 && roomy.until - roomy.from <= 20,
    `a ${(roomy.until - roomy.from).toFixed(0)}s preview is not a preview`);
});

check('export: too loud is caught before anything is encoded', () => {
  // solveGains guards the automatic path, but the Volume slider reaches +24 dB
  // by hand and the encoders clamp, which is flat-topped distortion.
  ok(app.clipsOnExport(1.2), 'a boosted programme clips');
  ok(app.clipsOnExport(1.01), 'a little over is still flat-topped');
  ok(!app.clipsOnExport(1), 'exactly full scale is not clipping');
  ok(!app.clipsOnExport(Math.pow(10, app.LOUDNESS.ceiling / 20)),
    'the ceiling solveGains aims at must never trip this: ');
  ok(!app.clipsOnExport(0), 'silence does not clip');
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

check('rampEnvelope: one shape behind both of a clip\'s envelopes', () => {
  // The fades and the blend were written out separately and drifted apart is
  // exactly the risk; this is the shared shape they now both come from.
  const plain = app.rampEnvelope(10, 0, 0);
  eq(plain, [[0, 1], [10, 1]], 'no rise and no fall is a flat line at full: ');

  const both = app.rampEnvelope(10, 2, 3);
  eq(both, [[0, 0], [2, 1], [7, 1], [10, 0]], 'up, hold, down: ');
  eq(app.valueAt(both, 1), 0.5, 'half way up the rise: ');
  eq(app.valueAt(both, 8.5), 0.5, 'half way down the fall: ');
});

check('rampEnvelope: a rise and fall that would overlap meet instead of crossing', () => {
  // Breakpoints out of order would make valueAt read the wrong segment, and a
  // level above 1 would clip on export.
  const squeezed = app.rampEnvelope(4, 3, 3);
  const times = squeezed.map((p) => p[0]);
  eq(times, times.slice().sort((a, b) => a - b), 'breakpoints stay in order: ');
  for (const [, v] of squeezed) ok(v >= 0 && v <= 1, `level ${v} is out of range`);

  // Longer than the clip is clamped to the clip, not left to run past its end.
  const overlong = app.rampEnvelope(5, 99, 99);
  eq(overlong[overlong.length - 1][0], 5, 'the envelope ends with the clip: ');
});

check('movingAverage: smooths, and treats the ends as shorter windows', () => {
  const flat = app.movingAverage(new Float32Array(20).fill(4), 3);
  for (const v of flat) near(v, 4, 1e-6, 'a constant signal averages to itself: ');

  const spike = new Float32Array(21);
  spike[10] = 7;
  const smoothed = app.movingAverage(spike, 2);
  // A window of 5 spreads the spike over its neighbours and divides by 5.
  near(smoothed[10], 7 / 5, 1e-6, 'the peak is flattened: ');
  near(smoothed[8], 7 / 5, 1e-6, 'and reaches exactly as far as the half width: ');
  eq(smoothed[7], 0, 'but no further: ');

  // At the ends the window is clipped, so the divisor shrinks with it.
  const edge = app.movingAverage(new Float32Array([6, 0, 0, 0, 0]), 1);
  near(edge[0], 3, 1e-6, 'the first sample averages over two, not three: ');
  eq(app.movingAverage(new Float32Array(0), 2).length, 0, 'an empty signal: ');
});

check('frameCount: counts whole frames only, and never goes negative', () => {
  eq(app.frameCount(1024, 1024, 512), 1, 'exactly one frame fits: ');
  eq(app.frameCount(1536, 1024, 512), 2);
  eq(app.frameCount(1535, 1024, 512), 1, 'a part frame does not count: ');
  ok(app.frameCount(100, 1024, 512) < 1, 'shorter than one frame yields nothing usable');
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

check('fmt: carries the minute rather than showing sixty seconds', () => {
  /* Both formatters used to round the seconds after splitting the minutes off,
     so anything that rounded up to 60 was displayed as sixty seconds: a 59.98s
     programme read "0:60.0" on the timer, and a 119.6s song listed as "1:60". */
  eq(app.fmt(59.98), '1:00.0', 'rounding up to a whole minute has to carry: ');
  eq(app.fmt(119.97), '2:00.0');
  eq(app.fmtShort(59.7), '1:00');
  eq(app.fmtShort(119.6), '2:00');

  eq(app.fmt(0), '0:00.0');
  eq(app.fmt(65.25), '1:05.3', 'tenths are shown, and padded: ');
  eq(app.fmt(3599.9), '59:59.9', 'no hours field, by design: ');
  eq(app.fmtShort(0), '0:00');
  eq(app.fmtShort(65.25), '1:05');
  eq(app.fmtShort(135), '2:15', 'the level times in the dropdown: ');
});

check('fmt: nothing measurable shows as zero, never NaN', () => {
  // These land in the programme timer and the library, where "NaN:aN" would be
  // alarming and meaningless.
  for (const bad of [NaN, -5, -0.4, Infinity, -Infinity]) {
    eq(app.fmt(bad), '0:00.0', `fmt(${bad}): `);
    eq(app.fmtShort(bad), '0:00', `fmtShort(${bad}): `);
  }
});

check('clipDuration: never negative, however the trims are set', () => {
  eq(app.clipDuration({ srcStart: 10, srcEnd: 70 }), 60);
  eq(app.clipDuration({ srcStart: 10, srcEnd: 10 }), 0);
  eq(app.clipDuration({ srcStart: 70, srcEnd: 10 }), 0, 'inverted trims are not negative time: ');
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

/* ------------------------------------------------- 1g. the project file */

/* The saved project is the contract with every edit anyone has already put on
   disk, and with the format written down in the README. Nothing checked it
   until `readProject` was split out of the DOM half of `loadProject`. */

/** Runs `fn` with a throwaway program, then puts the real state back. */
function withProgram(fields, fn) {
  const keys = ['name', 'level', 'targetSeconds', 'toleranceSeconds', 'clips'];
  const saved = {};
  for (const k of keys) saved[k] = app.state[k];
  Object.assign(app.state, fields);
  try { fn(); } finally { Object.assign(app.state, saved); }
}

check('project file: an edit survives being saved and opened again', () => {
  withProgram({
    name: 'my 2026 junior long program',
    level: 'usfs-jr',
    targetSeconds: 210,
    toleranceSeconds: 10,
    clips: [
      { id: 'a', file: 'one.mp3', title: 'opening', srcStart: 4.7615, srcEnd: 77.0824,
        fadeIn: 1.5, fadeOut: 0, crossfade: 0, gain: 1 },
      { id: 'b', file: 'two.mp3', title: 'finale', srcStart: 0, srcEnd: 60.5,
        fadeIn: 0, fadeOut: 2.5, crossfade: 1.5, gain: 0.5012 },
    ],
  }, () => {
    // Through JSON, because that is what actually happens to it on the way out
    // and back — a value that does not survive stringify is not really saved.
    const read = app.readProject(JSON.parse(JSON.stringify(app.project())));

    eq(read.name, 'my 2026 junior long program');
    eq(read.level, 'usfs-jr', 'a level whose time still matches is kept: ');
    eq(read.targetSeconds, 210);
    eq(read.toleranceSeconds, 10);
    eq(read.retargeted, null, 'nothing to report about the level: ');
    eq(read.clips.length, 2);

    for (const key of ['file', 'title', 'fadeIn', 'fadeOut', 'crossfade']) {
      eq(read.clips.map((c) => c[key]), app.state.clips.map((c) => c[key]), `${key}: `);
    }
    // Trims are stored to the millisecond and levels to a thousandth, so the
    // round trip is lossy by exactly that much and no more.
    near(read.clips[0].srcStart, 4.7615, 0.001, 'srcStart: ');
    near(read.clips[0].srcEnd, 77.0824, 0.001, 'srcEnd: ');
    near(read.clips[1].srcEnd, 60.5, 1e-9, 'a round number stays exact: ');
    near(read.clips[1].gain, 0.5012, 0.001, 'gain: ');
  });
});

check('project file: the document holds exactly the fields it is documented to', () => {
  // Adding or dropping a field changes what older versions of the app can read,
  // so it should be a deliberate act rather than a side effect.
  withProgram({
    name: 'x', level: 'usfs-juv', targetSeconds: 135, toleranceSeconds: 10,
    clips: [{ id: 'a', file: 'a.mp3', title: 'a', srcStart: 0, srcEnd: 1,
      fadeIn: 0, fadeOut: 0, crossfade: 0, gain: 1 }],
  }, () => {
    const doc = app.project();
    eq(Object.keys(doc).sort(),
      ['clips', 'level', 'levelLabel', 'name', 'targetSeconds', 'toleranceSeconds']);
    eq(Object.keys(doc.clips[0]).sort(),
      ['crossfade', 'fadeIn', 'fadeOut', 'file', 'gain', 'srcEnd', 'srcStart', 'title']);
    eq(doc.levelLabel, 'Juvenile', 'the label is denormalised so an old file still reads: ');
  });
});

check('project file: a level whose length has changed reopens as custom', () => {
  /* The rulebook numbers move between seasons. A project stores the seconds it
     was actually built to, so reopening it must keep that time and give up the
     level — never quietly retarget the programme to the new number. */
  const level = app.allLevels()[0];
  const read = app.readProject({
    name: 'last season', level: level.id,
    targetSeconds: level.seconds + 25, toleranceSeconds: 10, clips: [],
  });
  eq(read.targetSeconds, level.seconds + 25, 'the stored time wins: ');
  eq(read.level, app.CUSTOM_LEVEL, 'and the level falls back to custom: ');
  ok(read.retargeted && read.retargeted.id === level.id,
    'the caller has to be able to say which level it no longer matches');
});

check('project file: an older or damaged file opens with usable defaults', () => {
  const empty = app.readProject({});
  eq(empty.name, 'my program');
  eq(empty.clips, []);
  ok(empty.targetSeconds > 0 && empty.toleranceSeconds > 0, 'defaults have to be usable');

  // Files written before levels existed carry no gain at all.
  const old = app.readProject({ clips: [{ file: 'chosen song.mp3', srcStart: 1, srcEnd: 50 }] });
  eq(old.clips[0].gain, 1, 'a missing gain means "as recorded", not silent: ');
  eq(old.clips[0].title, 'chosen song', 'a title is taken from the file name: ');
  eq([old.clips[0].fadeIn, old.clips[0].fadeOut, old.clips[0].crossfade], [0, 0, 0]);
});

check('project file: hand-edited nonsense cannot blow the speakers', () => {
  const read = app.readProject({
    clips: [
      { file: 'a.mp3', gain: 9999 },
      { file: 'b.mp3', gain: -3 },
      { file: 'c.mp3', gain: 'loud' },
      { file: 'd.mp3', gain: 0 },
    ],
  });
  eq(read.clips.map((c) => c.gain), [app.MAX_GAIN, 1, 1, 0],
    'clamped, defaulted, defaulted, and a deliberate zero kept: ');
  for (const clip of read.clips) {
    ok(Number.isFinite(clip.srcStart) && Number.isFinite(clip.srcEnd), 'trims went non-numeric');
  }
});

check('project file: every clip gets its own id, however the file was written', () => {
  // Selection and removal are by id, so two clips sharing one would take each
  // other out. The file does not carry ids at all — they are made on load.
  const read = app.readProject({ clips: [{ file: 'a.mp3' }, { file: 'a.mp3' }, { file: 'a.mp3' }] });
  const ids = read.clips.map((c) => c.id);
  eq(new Set(ids).size, ids.length, 'duplicate clip ids: ');
  for (const id of ids) ok(id && typeof id === 'string', `unusable id ${JSON.stringify(id)}`);
});

/* ------------------------------------------------------------- 1e. undo */

/** Runs `fn` with a throwaway clip list, then puts the real state back. */
function withClips(clips, fn) {
  const saved = app.state.clips;
  app.undoStack.length = 0;
  app.redoStack.length = 0;
  app.endUndoRun();
  app.state.clips = clips;
  try { fn(); } finally {
    app.state.clips = saved;
    app.undoStack.length = 0;
    app.redoStack.length = 0;
    app.endUndoRun();
  }
}

check('undo: a snapshot holds the length being worked to, not only the clips', () => {
  /* Changing the event used to be outside the stack entirely, so picking the
     wrong one lost the target length with no way back — the one number the
     whole edit is aimed at. */
  withProgram({
    name: 'my long program', level: 'usfs-jr', targetSeconds: 210,
    toleranceSeconds: 10, clips: [{ id: 'a', file: 'a.mp3', srcStart: 0, srcEnd: 30 }],
  }, () => {
    const held = JSON.parse(app.undoSnapshot());
    eq(Object.keys(held).sort(),
      ['clips', 'level', 'name', 'targetSeconds', 'toleranceSeconds']);
    eq(held.name, 'my long program');
    eq(held.level, 'usfs-jr');
    eq(held.targetSeconds, 210);
    eq(held.clips.length, 1);
  });
});

check('undo: a step back can be stepped forward again', () => {
  withProgram({
    name: 'before', level: 'usfs-juv', targetSeconds: 135,
    toleranceSeconds: 10, clips: [],
  }, () => {
    app.undoStack.length = 0;
    app.redoStack.length = 0;
    app.endUndoRun();

    app.pushUndo();                       // snapshot "before"
    app.state.name = 'after';

    const back = app.takeUndo();
    eq(JSON.parse(back).name, 'before', 'undo hands back the earlier state: ');
    eq(app.redoStack.length, 1, 'and puts the current one where redo can reach it: ');

    const forward = app.takeRedo();
    eq(JSON.parse(forward).name, 'after', 'redo hands back what was undone: ');
    eq(app.undoStack.length, 1, 'and the step back is available again: ');
  });
});

check('undo: nothing to go back or forward to is not an error', () => {
  withProgram({ name: 'x', level: 'usfs-juv', targetSeconds: 135,
    toleranceSeconds: 10, clips: [] }, () => {
    app.undoStack.length = 0;
    app.redoStack.length = 0;
    eq(app.takeUndo(), null, 'an empty undo stack: ');
    eq(app.takeRedo(), null, 'an empty redo stack: ');
    eq(app.redoStack.length, 0, 'and neither should have grown: ');
    eq(app.undoStack.length, 0);
  });
});

check('undo: a fresh edit closes off the branch that was undone', () => {
  /* Redo has to mean "put back what I just took away", not "put back something
     that never followed from here". Editing after an undo abandons that future. */
  withProgram({ name: 'one', level: 'usfs-juv', targetSeconds: 135,
    toleranceSeconds: 10, clips: [] }, () => {
    app.undoStack.length = 0;
    app.redoStack.length = 0;
    app.endUndoRun();

    app.pushUndo(); app.state.name = 'two';
    app.takeUndo();
    eq(app.redoStack.length, 1, 'there is a future to go back to: ');

    app.pushUndo(); app.state.name = 'three';
    eq(app.redoStack.length, 0, 'a new edit must discard it: ');
  });
});

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

check('undo: the coalescing window covers a key repeat without merging real edits', () => {
  /* Too short and a held key still floods the stack; too long and two separate
     deliberate nudges become one undo step. Key repeat runs at roughly 30 a
     second, so anything from a repeat interval up to about a second works. */
  ok(app.UNDO_COALESCE_MS >= 200,
    `${app.UNDO_COALESCE_MS}ms is shorter than the gap between key repeats`);
  ok(app.UNDO_COALESCE_MS <= 1500,
    `${app.UNDO_COALESCE_MS}ms would swallow edits a second apart into one step`);
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

