/**
 * The editor itself — mostly program.js, plus the state app.js owns.
 *
 * Timeline math with overlapping blends, the envelopes, the undo stack, the
 * project file format, and the plain-language strings the interface is built
 * from. Nothing here needs a DOM.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { app, check, eq, near, ok, ROOT, SCRIPTS } = require('./harness.js');
const { validate } = require('./schema.js');

/* ------------------------------------------------------------ 1. the math */

check('layout: clips run back to back when nothing is blended', () => {
  const clips = [
    { srcStart: 0, srcEnd: 60, crossfade: 0 },
    { srcStart: 0, srcEnd: 40, crossfade: 0 },
  ];
  const { parts, total } = app.layout(clips);
  eq(
    parts.map((p) => p.start),
    [0, 60],
  );
  eq(total, 100);
});

check('layout: blending shortens the program by the overlap', () => {
  const clips = [
    { srcStart: 0, srcEnd: 60, crossfade: 0 },
    { srcStart: 30, srcEnd: 90, crossfade: 2.5 },
    { srcStart: 10, srcEnd: 85, crossfade: 3 },
  ];
  const { parts, total } = app.layout(clips);
  eq(
    parts.map((p) => p.start),
    [0, 57.5, 114.5],
  );
  eq(total, 189.5); // 60 + 60 + 75 − 2.5 − 3
});

check('layout: a blend cannot exceed either neighbor', () => {
  const clips = [
    { srcStart: 0, srcEnd: 5, crossfade: 0 },
    { srcStart: 0, srcEnd: 40, crossfade: 12 },
  ];
  eq(app.crossfadeOf(clips, 1), 5, 'clamped to the shorter clip: ');
  eq(app.crossfadeOf(clips, 0), 0, 'first clip has nothing to blend into: ');
});

check('layout: empty program is zero, not NaN', () => {
  const { parts, total } = app.layout([]);
  eq(parts, []);
  eq(total, 0);
});

check('clips: trims are brought inside the file that actually arrives', () => {
  /* A project records trims but not the audio, so nothing checks those numbers
     against a real duration until the file turns up. Web Audio plays silence
     past the end rather than failing, so an unclamped overrun shows a clip
     duration that is a lie and exports a program of the wrong length. */
  const clips = [
    { file: 'a.mp3', srcStart: 0, srcEnd: 200 }, // the file is only 120s long
    { file: 'a.mp3', srcStart: 10, srcEnd: 60 }, // already fits
    { file: 'b.mp3', srcStart: 0, srcEnd: 900 }, // a different file entirely
  ];
  eq(
    app.clampClipsToFile(clips, { name: 'a.mp3', duration: 120 }),
    1,
    'only the clip that overran should be counted: ',
  );
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

check('join preview: stays inside the program, and declines when there is no join', () => {
  const clips = [
    { srcStart: 0, srcEnd: 3, crossfade: 0 },
    { srcStart: 0, srcEnd: 3, crossfade: 0 },
  ];
  const range = app.joinPreviewRange(clips, 1);
  eq(range.from, 0, 'cannot start before the program does: ');
  eq(range.until, 6, 'cannot run past the end of it: ');
  eq(app.joinPreviewRange(clips, 0), null, 'the first clip has nothing before it: ');
  eq(app.joinPreviewRange(clips, 9), null, 'a clip that is not there: ');
  eq(app.joinPreviewRange([], 1), null, 'an empty program: ');

  // With room either side the defaults are what decide the window, and they
  // have to be long enough to judge a join by and short enough not to be a wait.
  const roomy = app.joinPreviewRange(
    [
      { srcStart: 0, srcEnd: 60, crossfade: 0 },
      { srcStart: 0, srcEnd: 60, crossfade: 0 },
    ],
    1,
  );
  eq(roomy.from, 60 - app.JOIN_PREVIEW.lead, 'the lead comes from the defaults: ');
  eq(roomy.until, 60 + app.JOIN_PREVIEW.tail, 'and so does the tail: ');
  ok(
    roomy.until - roomy.from >= 4 && roomy.until - roomy.from <= 20,
    `a ${(roomy.until - roomy.from).toFixed(0)}s preview is not a preview`,
  );
});

check('export: too loud is caught before anything is encoded', () => {
  // solveGains guards the automatic path, but the Volume slider reaches +24 dB
  // by hand and the encoders clamp, which is flat-topped distortion.
  ok(app.clipsOnExport(1.2), 'a boosted program clips');
  ok(app.clipsOnExport(1.01), 'a little over is still flat-topped');
  ok(!app.clipsOnExport(1), 'exactly full scale is not clipping');
  ok(
    !app.clipsOnExport(Math.pow(10, app.LOUDNESS.ceiling / 20)),
    'the ceiling solveGains aims at must never trip this: ',
  );
  ok(!app.clipsOnExport(0), 'silence does not clip');
});

check('reorder: moves on a real pair of positions, and only then', () => {
  const clips = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ids = (list) => (list ? list.map((c) => c.id).join('') : null);
  eq(ids(app.reordered(clips, 2, 0)), 'cab', 'last block dragged to the front: ');
  eq(ids(app.reordered(clips, 0, 2)), 'bca');
  eq(app.reordered(clips, 1, 1), null, 'a block dropped back on itself: ');
  eq(ids(clips), 'abc', 'the list handed in is never touched: ');

  /* Where a drag began has to be validated, not just where it lands. A dragged
     text selection carries text/plain, which parses to NaN; every comparison
     against NaN is false, so a check that looks only at the destination lets it
     through, and splice(NaN, 1) coerces to splice(0, 1). A stray selection
     dropped on the timeline would silently move the *first* song to wherever it
     landed. */
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
  /* Every script, not just one. The first assertion is about something being
     absent, so it has to read everywhere the code could be: pointed at a single
     file, it would pass on the strength of not having looked. */
  const source = SCRIPTS.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  ok(
    !/getData\(\s*'text\/plain'\s*\)/.test(source),
    'a drop handler is reading text/plain again, which every drag supplies',
  );
  ok(
    /setData\(CLIP_DRAG_TYPE/.test(source) && /getData\(CLIP_DRAG_TYPE/.test(source),
    'the private drag type has to be both published and required',
  );
});

check("rampEnvelope: one shape behind both of a clip's envelopes", () => {
  // The fades and the blend were written out separately and drifted apart is
  // exactly the risk; this is the shared shape they now both come from.
  const plain = app.rampEnvelope(10, 0, 0);
  eq(
    plain,
    [
      [0, 1],
      [10, 1],
    ],
    'no rise and no fall is a flat line at full: ',
  );

  const both = app.rampEnvelope(10, 2, 3);
  eq(
    both,
    [
      [0, 0],
      [2, 1],
      [7, 1],
      [10, 0],
    ],
    'up, hold, down: ',
  );
  eq(app.valueAt(both, 1), 0.5, 'half way up the rise: ');
  eq(app.valueAt(both, 8.5), 0.5, 'half way down the fall: ');
});

check('rampEnvelope: a rise and fall that would overlap meet instead of crossing', () => {
  // Breakpoints out of order would make valueAt read the wrong segment, and a
  // level above 1 would clip on export.
  const squeezed = app.rampEnvelope(4, 3, 3);
  const times = squeezed.map((p) => p[0]);
  eq(
    times,
    times.slice().sort((a, b) => a - b),
    'breakpoints stay in order: ',
  );
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
  // A window of 5 spreads the spike over its neighbors and divides by 5.
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
  eq(
    times,
    times.slice().sort((a, b) => a - b),
    'breakpoints stay in order: ',
  );
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
  /* Both formatters round before splitting the minutes off. The other way
     round, anything that rounds up to 60 shows as sixty seconds: a 59.98s
     program reads "0:60.0" on the timer, and a 119.6s song lists as "1:60". */
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
  // These land in the program timer and the library, where "NaN:aN" would be
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
  try {
    fn();
  } finally {
    Object.assign(app.state, saved);
  }
}

check('project file: an edit survives being saved and opened again', () => {
  withProgram(
    {
      name: 'my 2026 junior long program',
      level: 'usfs-jr',
      targetSeconds: 210,
      toleranceSeconds: 10,
      clips: [
        {
          id: 'a',
          file: 'one.mp3',
          title: 'opening',
          srcStart: 4.7615,
          srcEnd: 77.0824,
          fadeIn: 1.5,
          fadeOut: 0,
          crossfade: 0,
          gain: 1,
        },
        {
          id: 'b',
          file: 'two.mp3',
          title: 'finale',
          srcStart: 0,
          srcEnd: 60.5,
          fadeIn: 0,
          fadeOut: 2.5,
          crossfade: 1.5,
          gain: 0.5012,
        },
      ],
    },
    () => {
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
        eq(
          read.clips.map((c) => c[key]),
          app.state.clips.map((c) => c[key]),
          `${key}: `,
        );
      }
      // Trims are stored to the millisecond and levels to a thousandth, so the
      // round trip is lossy by exactly that much and no more.
      near(read.clips[0].srcStart, 4.7615, 0.001, 'srcStart: ');
      near(read.clips[0].srcEnd, 77.0824, 0.001, 'srcEnd: ');
      near(read.clips[1].srcEnd, 60.5, 1e-9, 'a round number stays exact: ');
      near(read.clips[1].gain, 0.5012, 0.001, 'gain: ');
    },
  );
});

check('project file: the document holds exactly the fields it is documented to', () => {
  // Adding or dropping a field changes what older versions of the app can read,
  // so it should be a deliberate act rather than a side effect.
  withProgram(
    {
      name: 'x',
      level: 'usfs-juv',
      targetSeconds: 135,
      toleranceSeconds: 10,
      clips: [
        {
          id: 'a',
          file: 'a.mp3',
          title: 'a',
          srcStart: 0,
          srcEnd: 1,
          fadeIn: 0,
          fadeOut: 0,
          crossfade: 0,
          gain: 1,
        },
      ],
    },
    () => {
      const doc = app.project();
      eq(Object.keys(doc).sort(), [
        '$schema',
        'clips',
        'event',
        'format',
        'name',
        'songs',
        'version',
      ]);
      eq(Object.keys(doc.event).sort(), ['label', 'level', 'targetSeconds', 'toleranceSeconds']);
      /* No title: this clip is called what its song is called, so saying so
         again would be noise. A clip with a label of its own writes one. */
      eq(Object.keys(doc.clips[0]).sort(), [
        'blend',
        'end',
        'fadeIn',
        'fadeOut',
        'gainDb',
        'id',
        'song',
        'start',
      ]);
      eq(Object.keys(doc.songs[0]).sort(), ['bytes', 'fingerprint', 'name', 'seconds', 'title']);
      eq(doc.format, app.FORMAT, 'the marker says what kind of document this is: ');
      eq(doc.version, app.FORMAT_VERSION);
      eq(doc.event.label, 'Juvenile', 'the label is denormalized so an old file still reads: ');
    },
  );
});

check('project file: records what each song was, since it cannot record where', () => {
  /* A browser will not tell a page where a file lives, and a handle to one
     cannot be written into a file — so a project cannot save a location. What
     it can save is what the audio was, which is what makes "this is a different
     song with the same name" answerable. */
  const read = app.readProject({
    clips: [{ song: 'one.mp3', start: 0, end: 30 }],
    songs: [{ name: 'one.mp3', bytes: 4096, seconds: 212.5, fingerprint: 'abc123' }],
  });
  eq(read.songs.length, 1);
  eq(read.songs[0].fingerprint, 'abc123');
  eq(read.songs[0].seconds, 212.5);

  // A hand-written project has no such section, and must not be treated as
  // claiming anything about the songs.
  eq(app.readProject({ clips: [] }).songs, [], 'a project without one: ');
  eq(app.readProject({ clips: [], songs: 'nonsense' }).songs, [], 'a damaged one: ');
  eq(
    app.readProject({ clips: [], songs: [{ bytes: 1 }] }).songs,
    [],
    'an entry with no name identifies nothing: ',
  );
});

check('project file: a song that is not the one it was built from is called out', () => {
  const expected = { name: 'song.mp3', bytes: 5000, seconds: 200, fingerprint: 'aaa' };

  eq(
    app.describeWrongFile(expected, { name: 'song.mp3', fingerprint: 'aaa', duration: 200 }),
    null,
    'the same file must pass without comment: ',
  );

  const swapped = app.describeWrongFile(expected, {
    name: 'song.mp3',
    fingerprint: 'bbb',
    duration: 95,
  });
  ok(swapped && swapped.includes('song.mp3'), `"${swapped}" should name the file`);
  ok(
    swapped.includes('1:35') && swapped.includes('3:20'),
    `"${swapped}" should contrast the two lengths, so the mistake is obvious`,
  );

  // A different file of the same length is still the wrong file.
  const sameLength = app.describeWrongFile(expected, {
    name: 'song.mp3',
    fingerprint: 'bbb',
    duration: 200,
  });
  ok(
    sameLength && !sameLength.includes('3:20'),
    'with nothing to contrast, do not pad the sentence with numbers',
  );

  // Nothing recorded, nothing claimed.
  eq(app.describeWrongFile(null, { name: 'x', fingerprint: 'a', duration: 1 }), null);
  eq(
    app.describeWrongFile({ name: 'x' }, { name: 'x', fingerprint: 'a', duration: 1 }),
    null,
    'a project with no fingerprint recorded cannot judge: ',
  );
  eq(
    app.describeWrongFile(expected, { name: 'song.mp3', duration: 200 }),
    null,
    'and nor can one where the file could not be fingerprinted: ',
  );
});

check('reconnect: each way of failing says what to do about it', () => {
  /* "Could not open the files" tells nobody which situation they are in, and
     the three need different next steps. */
  const gone = app.describeReconnect({ files: [], gone: ['a.mp3'], refused: [] });
  ok(/moved, renamed or deleted/.test(gone), `"${gone}" should say what may have happened`);
  ok(/Add files/.test(gone), `"${gone}" should say what to do instead`);
  ok(gone.includes('a.mp3'), 'and name the file');

  const many = app.describeReconnect({ files: [], gone: ['a.mp3', 'b.mp3'], refused: [] });
  ok(/2 songs/.test(many), `"${many}" should count them rather than listing forever`);

  const refused = app.describeReconnect({ files: [], gone: [], refused: ['a.mp3'] });
  ok(
    /[Pp]ermission/.test(refused) && /Allow/.test(refused),
    `"${refused}" should point at the prompt that was declined`,
  );
  ok(!/moved|deleted/.test(refused), 'a refusal is not a missing file');

  const partly = app.describeReconnect({ files: [{}, {}], gone: ['c.mp3'], refused: [] });
  ok(/Opened 2 songs/.test(partly), `"${partly}" should report what did work`);
  ok(partly.includes('c.mp3'), 'and name what did not');

  const both = app.describeReconnect({ files: [{}], gone: ['a'], refused: ['b'] });
  ok(
    /Opened one song/.test(both) && /could not be found/.test(both) && /not allowed/.test(both),
    `"${both}" should cover all three outcomes`,
  );
});

check('reconnect: the messages stay in plain language', () => {
  const banned = /handle|IndexedDB|permission state|API|filesystem|serial/i;
  const cases = [
    { files: [], gone: ['a.mp3'], refused: [] },
    { files: [], gone: [], refused: ['a.mp3'] },
    { files: [], gone: [], refused: [] },
    { files: [{}], gone: ['a.mp3'], refused: [] },
    { files: [{}], gone: [], refused: ['a.mp3'] },
    { files: [{}], gone: ['a'], refused: ['b'] },
  ];
  for (const outcome of cases) {
    const message = app.describeReconnect(outcome);
    ok(!banned.test(message), `"${message}" uses a word from the machine room`);
    ok(message.length < 160, `"${message}" is too long for a toast`);
  }
});

check('project file: a level whose length has changed reopens as custom', () => {
  /* The rulebook numbers move between seasons. A project stores the seconds it
     was actually built to, so reopening it must keep that time and give up the
     level — never quietly retarget the program to the new number. */
  const level = app.allLevels()[0];
  const read = app.readProject({
    name: 'last season',
    event: { level: level.id, targetSeconds: level.seconds + 25, toleranceSeconds: 10 },
    clips: [],
  });
  eq(read.targetSeconds, level.seconds + 25, 'the stored time wins: ');
  eq(read.level, app.CUSTOM_LEVEL, 'and the level falls back to custom: ');
  ok(
    read.retargeted && read.retargeted.id === level.id,
    'the caller has to be able to say which level it no longer matches',
  );
});

check('project file: an older or damaged file opens with usable defaults', () => {
  const empty = app.readProject({});
  eq(empty.name, 'my program');
  eq(empty.clips, []);
  ok(empty.targetSeconds > 0 && empty.toleranceSeconds > 0, 'defaults have to be usable');

  // A hand-written file says only what it has to.
  const bare = app.readProject({ clips: [{ song: 'chosen song.mp3', start: 1, end: 50 }] });
  eq(bare.clips[0].gain, 1, 'a missing level means "as recorded", not silent: ');
  eq(bare.clips[0].title, 'chosen song', 'a title is taken from the song name: ');
  eq([bare.clips[0].fadeIn, bare.clips[0].fadeOut, bare.clips[0].crossfade], [0, 0, 0]);
});

check('project file: hand-edited nonsense cannot blow the speakers', () => {
  const read = app.readProject({
    clips: [
      { song: 'a.mp3', gainDb: 9999 },
      { song: 'b.mp3', gainDb: -9999 },
      { song: 'c.mp3', gainDb: 'loud' },
      { song: 'd.mp3' },
    ],
  });
  const slider = app.LEVEL_SLIDER;
  eq(
    read.clips.map((c) => Number(c.gain.toFixed(4))),
    [
      Number(app.dbToGain(slider.max).toFixed(4)),
      Number(app.dbToGain(slider.min).toFixed(4)),
      1,
      1,
    ],
    'clamped both ways, then defaulted twice to "as recorded": ',
  );
  for (const clip of read.clips) {
    ok(clip.gain <= app.MAX_GAIN, `a level past what the app allows got through: ${clip.gain}`);
  }
  for (const clip of read.clips) {
    ok(Number.isFinite(clip.srcStart) && Number.isFinite(clip.srcEnd), 'trims went non-numeric');
  }
});

check('project file: every clip gets its own id, however the file was written', () => {
  /* Selection and removal are by id, so two clips sharing one would take each
     other out. A file may supply ids — that is what lets anything else refer to
     a clip — but it is not trusted to have made them unique. */
  const read = app.readProject({
    clips: [{ song: 'a.mp3' }, { song: 'a.mp3' }, { song: 'a.mp3' }],
  });
  const ids = read.clips.map((c) => c.id);
  eq(new Set(ids).size, ids.length, 'duplicate clip ids: ');
  for (const id of ids) ok(id && typeof id === 'string', `unusable id ${JSON.stringify(id)}`);

  // Ids that the file supplies are kept, so a reference to a clip survives.
  const given = app.readProject({
    clips: [
      { song: 'a.mp3', id: 'opening' },
      { song: 'b.mp3', id: 'finale' },
    ],
  });
  eq(
    given.clips.map((c) => c.id),
    ['opening', 'finale'],
    'the ids the file gave were thrown away: ',
  );

  // Repeats and unusable ones are replaced rather than trusted.
  const messy = app.readProject({
    clips: [
      { song: 'a.mp3', id: 'same' },
      { song: 'b.mp3', id: 'same' },
      { song: 'c.mp3', id: '' },
      { song: 'd.mp3', id: 42 },
    ],
  });
  const messyIds = messy.clips.map((c) => c.id);
  eq(messyIds[0], 'same', 'the first to claim an id keeps it: ');
  eq(new Set(messyIds).size, 4, 'a repeated or unusable id was trusted: ');
  for (const id of messyIds) ok(id && typeof id === 'string', `unusable id ${JSON.stringify(id)}`);
});

check('project file: a clip id survives being saved and opened again', () => {
  /* The point of ids in the file: anything that refers to a clip — a note, a
     marker, another tool — still refers to the same clip after a save. */
  const read = app.readProject({
    clips: [
      { song: 'a.mp3', id: 'opening', start: 0, end: 30 },
      { song: 'b.mp3', id: 'finale', start: 0, end: 20 },
    ],
  });
  withProgram(
    {
      name: 'x',
      level: 'usfs-juv',
      targetSeconds: 135,
      toleranceSeconds: 10,
      clips: read.clips,
    },
    () => {
      const again = app.readProject(app.project());
      eq(
        again.clips.map((c) => c.id),
        ['opening', 'finale'],
        'ids did not survive the round trip: ',
      );
    },
  );
});

check('project file: a note and a media folder are carried, not acted on', () => {
  /* Neither is read by anything in the browser: there is no folder here, and
     nothing writes a note yet. They are named fields rather than unknown ones
     so they are documented and validated — but the test that matters is the
     same either way, that a project carrying them keeps carrying them. */
  const read = app.readProject({
    format: app.FORMAT,
    version: app.FORMAT_VERSION,
    name: 'x',
    event: { level: 'usfs-juv', targetSeconds: 135, toleranceSeconds: 10 },
    notes: 'coach wants more of the slow part',
    mediaDir: 'media',
    clips: [{ song: 'a.mp3', start: 0, end: 30 }],
  });
  eq(read.notes, 'coach wants more of the slow part');
  eq(read.mediaDir, 'media');

  withProgram(
    {
      name: read.name,
      level: read.level,
      targetSeconds: read.targetSeconds,
      toleranceSeconds: read.toleranceSeconds,
      clips: read.clips,
    },
    () => {
      const saved = { notes: app.state.notes, mediaDir: app.state.mediaDir };
      app.state.notes = read.notes;
      app.state.mediaDir = read.mediaDir;
      try {
        const doc = app.project();
        eq(doc.notes, 'coach wants more of the slow part', 'the note was dropped: ');
        eq(doc.mediaDir, 'media', 'the media folder was dropped: ');
      } finally {
        app.state.notes = saved.notes;
        app.state.mediaDir = saved.mediaDir;
      }
    },
  );

  // A project that says nothing does not gain empty fields it never had.
  const bare = app.readProject({ clips: [] });
  eq([bare.notes, bare.mediaDir], ['', ''], 'absent should read as empty: ');
  withProgram({ name: 'x', level: 'usfs-juv', targetSeconds: 135, clips: [] }, () => {
    const doc = app.project();
    ok(!('notes' in doc) && !('mediaDir' in doc), 'empty fields were written out anyway');
  });
});

check('project file: the $schema it writes is the schema that is published', () => {
  /* The app writes a URL into every project file so an editor can validate it.
     A URL that has drifted from where the file actually sits does not fail —
     it 404s quietly and the validation simply stops happening. */
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'docs/program.skate.schema.json'), 'utf8'),
  );
  /* Read out of a document the app actually produced, not out of the constant.
     Asserting the constant leaves the writing of it untested — the mutation
     that pointed a saved file somewhere else survived exactly that way. */
  withProgram({ name: 'x', level: 'usfs-juv', targetSeconds: 135, clips: [] }, () => {
    const written = app.project().$schema;
    eq(written, schema.$id, 'the written $schema and the schema $id disagree: ');
    const site = 'https://ankurs47.github.io/skate-program-editor/';
    ok(written.startsWith(site), `the schema URL is not on this site: ${written}`);
    eq(
      written.slice(site.length),
      'docs/program.skate.schema.json',
      'the URL does not point at where the file is published: ',
    );
  });
});

check('project file: a field this app has never heard of survives a save', () => {
  /* A desktop shell writes into the same file — where a song came from, what
     wrote it last — and more of that is coming. Rebuilding the document from
     only the keys this app knows would erase every one of them on the next
     save, silently, and only for people using both. */
  const written = {
    format: app.FORMAT,
    version: app.FORMAT_VERSION,
    name: 'from a shell',
    event: { level: 'usfs-juv', targetSeconds: 135, toleranceSeconds: 10 },
    songs: [
      {
        name: 'one.mp3',
        bytes: 4096,
        seconds: 30,
        fingerprint: 'abc123',
        source: { kind: 'youtube', url: 'https://example.invalid/watch?v=x' },
        somethingNewerStillWrote: { deep: [1, 2] },
      },
    ],
    clips: [{ song: 'one.mp3', start: 0, end: 30 }],
    writtenBy: { app: 'skate-desktop', version: '0.1.0' },
    aFieldFromTheFuture: 'keep me',
  };

  const read = app.readProject(written);
  withProgram(
    {
      name: read.name,
      level: read.level,
      targetSeconds: read.targetSeconds,
      toleranceSeconds: read.toleranceSeconds,
      clips: read.clips,
    },
    () => {
      const saved = app.state.expectedFiles;
      const carried = app.state.carried;
      app.state.expectedFiles = new Map(read.songs.map((s) => [s.name, s]));
      app.state.carried = read.carried;
      try {
        const out = app.project();
        eq(out.aFieldFromTheFuture, 'keep me', 'a top-level field was dropped: ');
        eq(out.writtenBy, written.writtenBy, 'the shell stamp was dropped: ');
        eq(out.songs[0].source, written.songs[0].source, 'the source was dropped: ');
        eq(
          out.songs[0].somethingNewerStillWrote,
          written.songs[0].somethingNewerStillWrote,
          'an unknown per-song field was dropped: ',
        );
        eq(out.songs[0].fingerprint, 'abc123', 'and the fields it does know still round trip: ');
        eq(out.format, app.FORMAT, 'a carried key must not overwrite one this app owns: ');
      } finally {
        app.state.expectedFiles = saved;
        app.state.carried = carried;
      }
    },
  );
});

check('project file: a version from the future is refused, not guessed at', () => {
  /* Everything else here falls back rather than failing, because a hand-edited
     file should not be rejected over a number that can be clamped. A version
     this app does not know is the opposite case: its fields may mean something
     other than what they say, so reading it would produce a program that looks
     right and is not. */
  const ahead = app.readProject({
    format: app.FORMAT,
    version: app.FORMAT_VERSION + 1,
    name: 'from a newer editor',
    clips: [{ song: 'a.mp3', start: 0, end: 30 }],
  });
  ok(ahead.unsupported, 'a newer version was read anyway');
  eq(ahead.unsupported.version, app.FORMAT_VERSION + 1);
  eq(ahead.unsupported.understands, app.FORMAT_VERSION, 'the caller has to say what it can read: ');
  eq(ahead.clips, undefined, 'nothing may be handed back from a file it cannot read: ');

  // The version this app writes, and an absent one, both open normally.
  ok(!app.readProject({ version: app.FORMAT_VERSION, clips: [] }).unsupported);
  ok(!app.readProject({ clips: [] }).unsupported, 'a file with no version at all: ');
});

check('project file: the worked example still opens the way it reads', () => {
  /* A saved file of the real format, asserted field by field. From the moment
     anything else writes one of these, changing the format by accident has to
     fail here rather than in someone's project folder. */
  const doc = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'test/fixtures/program.skate.json'), 'utf8'),
  );
  const read = app.readProject(doc);
  ok(!read.unsupported, 'the fixture does not open');
  eq(read.name, 'my 2027 junior long');
  eq(read.level, 'usfs-jr');
  eq(read.targetSeconds, 210);
  eq(read.toleranceSeconds, 10);
  eq(read.songs.length, 3);
  eq(read.clips.length, 3);
  eq(read.songs[0].source.kind, 'youtube', 'a recorded source has to survive being read: ');
  eq(
    read.clips[0].title,
    'Opening Theme — Live at the Proms',
    'a clip with no label of its own takes the song\u2019s title: ',
  );
  eq(read.clips[1].title, 'the slow part', 'a clip labeled for the program keeps its label: ');
  eq(read.clips[1].crossfade, 1.8, 'blend in the file is the crossfade in memory: ');
  eq(read.clips[0].srcStart, 6, 'start in the file is the source trim in memory: ');
  eq(
    read.clips.map((c) => c.id),
    ['opening', 'slow', 'finish'],
    'the ids the file names have to survive being read: ',
  );
  eq(read.mediaDir, 'media');
  ok(read.notes.length > 0, 'the note in the fixture was dropped');
  near(
    read.clips[1].gain,
    app.dbToGain(-1.7),
    1e-9,
    'decibels in the file, a multiplier in memory',
  );

  // And the program it describes lands where the file says it should.
  near(app.layout(read.clips).total, 208.8, 0.05, 'the example program has changed length');
});

check('project file: the published schema describes what the app actually writes', () => {
  /* The schema is maintained by hand and shipped for other tools to validate
     against, so the way it fails is by quietly describing a format that has
     moved on. Comparing it with a real document from `project()` is what stops
     that: a renamed field breaks here rather than in whatever reads it. */
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'docs/program.skate.schema.json'), 'utf8'),
  );
  withProgram(
    {
      name: 'x',
      level: 'usfs-juv',
      targetSeconds: 135,
      toleranceSeconds: 10,
      clips: [
        {
          id: 'a',
          file: 'a.mp3',
          title: 'a',
          srcStart: 0,
          srcEnd: 1,
          fadeIn: 0,
          fadeOut: 0,
          crossfade: 0,
          gain: 1,
        },
      ],
    },
    () => {
      const saved = app.state.expectedFiles;
      app.state.expectedFiles = new Map([['a.mp3', { name: 'a.mp3', fingerprint: 'f' }]]);
      try {
        const doc = app.project();
        const undeclared = (obj, sub, where) =>
          Object.keys(obj)
            .filter((key) => !sub.properties[key])
            .map((key) => `${where}.${key}`);

        eq(undeclared(doc, schema, ''), [], 'written but not in the schema: ');
        eq(
          undeclared(doc.event, schema.properties.event, 'event'),
          [],
          'written but not in the schema: ',
        );
        eq(
          undeclared(doc.clips[0], schema.properties.clips.items, 'clips[]'),
          [],
          'written but not in the schema: ',
        );
        eq(
          undeclared(doc.songs[0], schema.properties.songs.items, 'songs[]'),
          [],
          'written but not in the schema: ',
        );

        const missing = schema.required.filter((key) => !(key in doc));
        eq(missing, [], 'the schema requires fields the app does not write: ');

        /* The one rule the schema states that is also a boundary elsewhere: a
           host resolves a song name inside a project folder, so a separator in
           one would be a way out of it. */
        const namePattern = new RegExp(schema.properties.songs.items.properties.name.pattern);
        for (const song of doc.songs) {
          ok(namePattern.test(song.name), `a song name the schema rejects: ${song.name}`);
        }
        ok(
          schema.additionalProperties === true,
          'the schema must not forbid the unknown fields the format promises to keep',
        );
      } finally {
        app.state.expectedFiles = saved;
      }
    },
  );
});

/** The shipped schema, and a program shaped like a real one to check against it. */
const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/program.skate.schema.json'), 'utf8'),
);

check('project file: what the app writes validates against the published schema', () => {
  /* The schema is shipped for other tools to trust. Checking the fixture alone
     would only prove the fixture was written carefully; this checks a document
     the app itself produced, which is the one anybody will actually be handed. */
  withProgram(
    {
      name: 'my 2027 junior long',
      level: 'usfs-jr',
      targetSeconds: 210,
      toleranceSeconds: 10,
      clips: [
        {
          id: 'opening',
          file: 'one.mp3',
          title: 'opening',
          srcStart: 4.7615,
          srcEnd: 77.0824,
          fadeIn: 1.5,
          fadeOut: 0,
          crossfade: 0,
          gain: 1,
        },
        {
          id: 'finale',
          file: 'two.mp3',
          title: 'finale',
          srcStart: 0,
          srcEnd: 60.5,
          fadeIn: 0,
          fadeOut: 2.5,
          crossfade: 1.8,
          gain: app.dbToGain(-8),
        },
      ],
    },
    () => {
      const saved = app.state.expectedFiles;
      const notes = app.state.notes;
      app.state.expectedFiles = new Map([
        ['one.mp3', { name: 'one.mp3', bytes: 4096, seconds: 212.5, fingerprint: 'abc' }],
        [
          'two.mp3',
          {
            name: 'two.mp3',
            bytes: 8192,
            seconds: 180,
            fingerprint: 'def',
            source: { kind: 'youtube', url: 'https://example.invalid/watch?v=x' },
          },
        ],
      ]);
      app.state.notes = 'coach wants the slow part longer';
      try {
        eq(
          validate(app.project(), SCHEMA),
          [],
          'the app wrote a document its own schema rejects: ',
        );
      } finally {
        app.state.expectedFiles = saved;
        app.state.notes = notes;
      }
    },
  );
});

check('project file: the worked example validates against the published schema', () => {
  const doc = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'test/fixtures/program.skate.json'), 'utf8'),
  );
  eq(validate(doc, SCHEMA), [], 'the fixture no longer fits the schema: ');
});

check('project file: every key the app writes is one the reader knows', () => {
  /* A key `project` writes that `readProject` does not list is read back as a
     carried key, and from the next save on the carried copy overwrites whatever
     the app computed — the field freezes at the first value it ever had, and
     nothing looks wrong. Adding a field to one list and forgetting the other is
     the whole of the mistake, so the two are compared. */
  withProgram(
    {
      name: 'x',
      level: 'usfs-juv',
      targetSeconds: 135,
      toleranceSeconds: 10,
      clips: [{ id: 'a', file: 'a.mp3', title: 'a', srcStart: 0, srcEnd: 1, gain: 1 }],
    },
    () => {
      const saved = { notes: app.state.notes, mediaDir: app.state.mediaDir };
      const exports_ = app.state.exportSettings;
      // Everything optional turned on at once, so no key can hide by being absent.
      app.state.notes = 'a note';
      app.state.mediaDir = 'media';
      app.state.exportSettings = { format: 'mp3', bitrate: 320 };
      try {
        const written = Object.keys(app.project());
        eq(
          written.filter((key) => !app.KNOWN_KEYS.includes(key)),
          [],
          'written by project() but not listed in KNOWN_KEYS, so it will freeze: ',
        );
      } finally {
        app.state.notes = saved.notes;
        app.state.mediaDir = saved.mediaDir;
        app.state.exportSettings = exports_;
      }
    },
  );
});

check('project file: a title belongs to the song, and a clip may differ', () => {
  /* What the music is called is a fact about the song. What a slice of it is
     called in the program is a different thing, and usually not needed: three
     clips cut from one song repeating its name says nothing, and renaming the
     song would mean editing all three. So a clip writes a title only when it
     has one of its own. */
  const read = app.readProject({
    songs: [{ name: 'one.m4a', title: 'Adagio in G minor' }, { name: 'two.m4a' }],
    clips: [
      { song: 'one.m4a', start: 0, end: 30 },
      { song: 'one.m4a', start: 40, end: 60, title: 'the quiet bit' },
      { song: 'two.m4a', start: 0, end: 10 },
    ],
  });
  eq(read.clips[0].title, 'Adagio in G minor', "a clip takes its song's title: ");
  eq(read.clips[1].title, 'the quiet bit', 'a labeled clip keeps its label: ');
  eq(read.clips[2].title, 'two', 'with no title anywhere, the file name without its extension: ');

  withProgram(
    {
      name: 'x',
      level: 'usfs-juv',
      targetSeconds: 135,
      toleranceSeconds: 10,
      clips: read.clips,
    },
    () => {
      const saved = app.state.expectedFiles;
      app.state.expectedFiles = new Map(read.songs.map((s) => [s.name, s]));
      try {
        const doc = app.project();
        eq(doc.songs[0].title, 'Adagio in G minor', 'the song lost its title: ');
        eq(doc.songs[1].title, 'two', 'a song with no title of its own gets the file name: ');
        ok(!('title' in doc.clips[0]), 'a clip repeated the title of its own song');
        eq(doc.clips[1].title, 'the quiet bit', 'a labeled clip lost its label: ');
        ok(!('title' in doc.clips[2]), 'a clip repeated the title of its own song');
      } finally {
        app.state.expectedFiles = saved;
      }
    },
  );
});

check('project file: saving twice in a row changes nothing', () => {
  /* The property that makes a format safe to keep in git: opening a project and
     saving it without touching anything has to leave the file alone. Anything
     that rounds, reorders or re-derives differently on the way back out shows
     up here as a diff nobody made. */
  const first = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'test/fixtures/program.skate.json'), 'utf8'),
  );

  const saveOnce = (doc) => {
    const read = app.readProject(doc);
    const kept = {
      name: app.state.name,
      level: app.state.level,
      targetSeconds: app.state.targetSeconds,
      toleranceSeconds: app.state.toleranceSeconds,
      clips: app.state.clips,
      notes: app.state.notes,
      mediaDir: app.state.mediaDir,
      carried: app.state.carried,
      exportSettings: app.state.exportSettings,
      expectedFiles: app.state.expectedFiles,
    };
    Object.assign(app.state, {
      name: read.name,
      level: read.level,
      targetSeconds: read.targetSeconds,
      toleranceSeconds: read.toleranceSeconds,
      clips: read.clips,
      notes: read.notes,
      mediaDir: read.mediaDir,
      carried: read.carried,
      exportSettings: read.exportSettings,
      expectedFiles: new Map(read.songs.map((s) => [s.name, s])),
    });
    try {
      return app.project();
    } finally {
      Object.assign(app.state, kept);
    }
  };

  const once = saveOnce(first);
  const twice = saveOnce(once);
  const a = JSON.stringify(once, null, 2).split('\n');
  const b = JSON.stringify(twice, null, 2).split('\n');
  const differs = a.findIndex((line, i) => line !== b[i]);
  ok(
    differs === -1 && a.length === b.length,
    `a save changed the file at line ${differs + 1}:\n` +
      `      first save:  ${a[differs]}\n` +
      `      second save: ${b[differs]}`,
  );
  eq(validate(once, SCHEMA), [], 'a saved document does not fit the schema: ');
});

check('project file: nothing a file can contain makes opening it throw', () => {
  /* Every project anybody has goes through readProject, including hand-edited
     ones and — once anything else writes these — ones this app did not make. It
     must always come back with something usable. A file that is wrong should
     look wrong on screen, never take the page down. */
  const hostile = [
    ['nothing at all', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['clips that are not an array', { clips: { a: 1 } }],
    ['a null clip', { clips: [null] }],
    ['a clip that is a string', { clips: ['x'] }],
    ['a clip that is an array', { clips: [[]] }],
    ['event that is not an object', { event: 'x', clips: [] }],
    ['songs holding a null', { clips: [], songs: [null, { name: 'a.mp3' }] }],
    ['songs that are strings', { clips: [], songs: ['a.mp3'] }],
    ['a song with no name', { clips: [], songs: [{ bytes: 1 }] }],
    /* Parsed rather than written: 1e999 as a literal is a lint error, and a
       file is where one of these actually comes from. It arrives as Infinity. */
    ['numbers past what a double holds', JSON.parse('{"clips":[{"song":"a.mp3","start":1e999}]}')],
    ['negative trims', { clips: [{ song: 'a.mp3', start: -5, end: -1 }] }],
    ['a fade that is a string', { clips: [{ song: 'a.mp3', fadeIn: 'lots' }] }],
    ['a prototype key', JSON.parse('{"clips":[],"__proto__":{"polluted":1}}')],
    ['deep nonsense', { clips: [], songs: [{ name: 'a.mp3', source: { kind: { deep: [1] } } }] }],
  ];

  for (const [label, doc] of hostile) {
    let read = null;
    try {
      read = app.readProject(doc);
    } catch (e) {
      ok(false, `opening ${label} threw: ${e.message}`);
      continue;
    }
    ok(read && typeof read === 'object', `opening ${label} gave back nothing usable`);
    if (read.unsupported) continue;
    ok(Array.isArray(read.clips), `${label}: clips came back as ${typeof read.clips}`);
    ok(Array.isArray(read.songs), `${label}: songs came back as ${typeof read.songs}`);
    ok(read.targetSeconds > 0, `${label}: the target length came back unusable`);
    for (const clip of read.clips) {
      const numbers = [clip.srcStart, clip.srcEnd, clip.fadeIn, clip.fadeOut, clip.crossfade];
      ok(
        numbers.every((n) => typeof n === 'number' && isFinite(n) && n >= 0),
        `${label}: a clip came back with ${JSON.stringify(numbers)}`,
      );
      ok(clip.file && typeof clip.file === 'string', `${label}: a clip names no song`);
    }
    ok(isFinite(app.layout(read.clips).total), `${label}: the program has no length`);
  }
  ok({}.polluted === undefined, 'a project file reached Object.prototype');
});

check('project file: a song name can never be a path', () => {
  /* A project holds names, and a desktop app resolves each one inside the
     folder holding the project. A name carrying `../` would be a way out of
     that folder, so it is reduced here as well — the app doing the resolving
     should not be the only thing in the way. Reduced on both sides, so the clip
     still points at the song it came in with. */
  for (const [written, expected] of [
    ['../../etc/passwd', 'passwd'],
    ['/etc/passwd', 'passwd'],
    ['C:\\music\\a.mp3', 'a.mp3'],
    ['media/opening.mp3', 'opening.mp3'],
    ['plain.mp3', 'plain.mp3'],
  ]) {
    const read = app.readProject({
      clips: [{ song: written, start: 0, end: 30 }],
      songs: [{ name: written, fingerprint: 'f' }],
    });
    eq(read.clips[0].file, expected, `a clip kept a path: ${written} -> `);
    eq(read.songs[0].name, expected, `a song kept a path: ${written} -> `);
    eq(read.clips[0].file, read.songs[0].name, 'the clip and its song stopped agreeing: ');
  }

  // A name that is nothing but dots points at no file at all.
  for (const nothing of ['..', '.', '', 'media/', '../']) {
    const read = app.readProject({ clips: [{ song: nothing }], songs: [{ name: nothing }] });
    eq(read.clips.length, 0, `${JSON.stringify(nothing)} was read as a song: `);
    eq(read.songs.length, 0, `${JSON.stringify(nothing)} was recorded as a song: `);
  }
});

/* ------------------------------------------------------- 1f. a desktop host */

/** Runs `fn` with `window.skateHost` set to `given`, then puts the world back. */
function withHost(given, fn) {
  const had = 'window' in global;
  const saved = had ? global.window : undefined;
  global.window = { ...(saved || {}), skateHost: given };
  try {
    fn();
  } finally {
    if (had) global.window = saved;
    else delete global.window;
  }
}

/**
 * The same, for a `fn` that has to be awaited.
 *
 * Kept apart from `withHost` rather than making that one async: the synchronous
 * version would then have to be awaited everywhere it is used, and a check that
 * forgot would put the world back before the thing it was testing had run.
 */
async function withHostAsync(given, fn) {
  const had = 'window' in global;
  const saved = had ? global.window : undefined;
  global.window = { ...(saved || {}), skateHost: given };
  try {
    await fn();
  } finally {
    if (had) global.window = saved;
    else delete global.window;
  }
}

/** A host with everything this app requires, plus whatever `extra` adds. */
const workingHost = (extra = {}) => ({
  version: app.HOST_VERSION,
  project: {
    name: () => 'a folder',
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(),
    media: () => Promise.resolve([]),
    open: () => Promise.resolve(new ArrayBuffer(0)),
  },
  ...extra,
});

check('host: with nothing offering one, there is no host', () => {
  /* The whole guarantee: the page is a web page first. Everything a shell makes
     possible is asked for through here, so if this says no, none of it runs. */
  ok(!app.hostPresent(), 'a host was found where there is no window at all');
  eq(app.hostProject(), null);
  eq(app.hostAdded(), null);
  withHost(undefined, () => ok(!app.hostPresent(), 'undefined counted as a host'));
});

check('host: a shell that does not fit is ignored, not half-used', () => {
  /* A bridge whose methods mean something other than what they say is worse
     than no bridge, because the page works perfectly well without one. Same
     reasoning as refusing a project file from a newer version. */
  const broken = [
    ['not an object', 'yes please'],
    ['null', null],
    ['no version at all', { project: workingHost().project }],
    ['a version from the future', { ...workingHost(), version: app.HOST_VERSION + 1 }],
    ['a version as a string', { ...workingHost(), version: String(app.HOST_VERSION) }],
    ['no project', { version: app.HOST_VERSION }],
    ['a project that is not an object', { version: app.HOST_VERSION, project: 'folder' }],
  ];
  for (const [label, given] of broken) {
    withHost(given, () => {
      ok(!app.hostPresent(), `${label} was accepted as a host`);
      eq(app.hostProject(), null, `${label}: `);
    });
  }

  // One missing method is enough: a shell offering a project with no way to
  // read one is not offering a project.
  for (const method of app.HOST_PROJECT_METHODS) {
    const given = workingHost();
    delete given.project[method];
    withHost(given, () => ok(!app.hostPresent(), `a host with no ${method}() was accepted`));
  }

  // And the one that fits is accepted, so none of the above passes by refusing
  // everything.
  withHost(workingHost(), () => {
    ok(app.hostPresent(), 'a host that fits was refused');
    ok(app.hostProject(), 'a host that fits gave back no project');
  });
});

check('host: a shell is never asked to name a program it already named', () => {
  /* The first run interrupts with a dialog asking for a name and an event.
     Inside a shell both were answered before this page loaded and the folder is
     already a project, so asking again is asking somebody to repeat themselves
     and then disagreeing with the file. */
  const nothing = null;
  const empty = { clips: [] };
  const work = { clips: [{ id: 'a' }] };

  // In a browser this page is the whole application and has to ask.
  eq(app.shouldOfferStart(nothing), true, 'nothing stored: ');
  eq(app.shouldOfferStart(empty), true, 'stored but empty: ');
  eq(app.shouldOfferStart(work), false, 'there is work to come back to: ');

  // With a shell it never asks, whatever it found.
  withHost(workingHost(), () => {
    for (const saved of [nothing, empty, work]) {
      eq(app.shouldOfferStart(saved), false, `hosted, ${JSON.stringify(saved)}: `);
    }
  });
});

check('host: the shell says when the folder changed, and offers no button', () => {
  /* There used to be a `hostImport()` here and a button in the page that a
     shell named and the page rendered. Bringing music in is the shell's own
     affair now, done in its own interface; the page's part is to notice that
     the folder changed and read it again. */
  ok(!('hostImport' in app), 'the page still knows how to render a shell-supplied button');

  const told = () => {};
  withHost(workingHost({ project: { ...workingHost().project, onAdded: told } }), () => {
    eq(app.hostAdded(), told, 'a shell offering to say so was not heard');
  });

  // A shell that says nothing is a shell the page simply does not hear from.
  withHost(workingHost(), () => eq(app.hostAdded(), null, 'invented a way to be told: '));
  withHost(workingHost({ project: { ...workingHost().project, onAdded: 'soon' } }), () => {
    eq(app.hostAdded(), null, 'onAdded that is not a function: ');
  });
  eq(app.hostAdded(), null, 'with no host at all: ');
});

check('host: what a shell knows about a song is not in the song', async () => {
  /* A file says what its tags say. Where it came from — a video, a purchase, a
     CD — is something only whatever fetched it knows, and it is worth keeping:
     the day the media folder and the project file get separated, this is what
     says how to get the music back. */
  const added = {
    name: 'Now We Are Free.m4a',
    title: 'Now We Are Free',
    source: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=x', addedAt: '2026-08-25' },
  };

  const saved = new Map(app.state.expectedFiles);
  try {
    app.state.expectedFiles.clear();
    await withHostAsync(workingHost(), () => app.openHostMedia(added));
    const kept = app.state.expectedFiles.get(added.name);
    ok(kept, 'the shell said where a song came from and nothing recorded it');
    eq(kept.source, added.source);
    eq(kept.title, added.title);

    /* And it reaches the file. `usedSongs` only writes songs a clip uses, which
       is the right rule — a song nobody cut from is not part of the program —
       so this is what the project says once one does. */
    withClips([{ id: 'c1', file: added.name, srcStart: 0, srcEnd: 10, gain: 1 }], () => {
      const song = app.project().songs.find((s) => s.name === added.name);
      ok(song, 'the song a clip is cut from was not written down');
      eq(song.source, added.source, 'the source did not survive into the file: ');
      eq(song.title, added.title, 'the title did not survive into the file: ');
    });
  } finally {
    app.state.expectedFiles = saved;
  }
});

check('host: a song already open is not fetched out of the folder again', async () => {
  /* Every song that arrives means reading the folder, and the folder holds
     every song. Without this the fifth download reads all five files across the
     bridge and decodes none of them, since `addFiles` skips what it already
     has — the work is wasted on the way rather than at the end.

     `addFiles` is stubbed because what is being checked is which files were
     gathered, not what decoding does with them: the real one draws.  */
  const asked = [];
  const host = workingHost();
  host.project.media = () =>
    Promise.resolve([{ name: 'open.m4a' }, { name: 'failed.m4a' }, { name: 'new.m4a' }]);
  host.project.open = (name) => {
    asked.push(name);
    return Promise.resolve(new ArrayBuffer(8));
  };

  const decoding = [];
  const realAddFiles = global.addFiles;
  global.addFiles = (files) => {
    decoding.push(...Array.from(files).map((f) => f.name));
    return Promise.resolve();
  };
  app.library.set('open.m4a', { name: 'open.m4a', buffer: {}, state: 'ready' });
  /* One that was read last time and would not decode. The same test `addFiles`
     uses, so it gets another go rather than being written off for the session. */
  app.library.set('failed.m4a', { name: 'failed.m4a', buffer: null, state: 'error' });

  try {
    await withHostAsync(host, () => app.openHostMedia());
    eq(asked.sort(), ['failed.m4a', 'new.m4a'], 'the wrong files were read out of the folder: ');
    eq(decoding.sort(), ['failed.m4a', 'new.m4a']);
  } finally {
    global.addFiles = realAddFiles;
    app.library.delete('open.m4a');
    app.library.delete('failed.m4a');
  }
});

check('host: a song arriving does not reopen the program underneath it', async () => {
  /* The bug this shape exists to avoid. A song arrives while somebody is
     editing, and re-reading the *project* to learn about it would replace the
     program on screen with whatever was last written to disk — throwing away
     the seconds of editing that happened while the download ran.

     Only the folder's music is re-read. The project file is not touched, and
     this holds it to that by making reading it an error. */
  let readProject = 0;
  const host = workingHost();
  host.project.read = () => {
    readProject++;
    return Promise.resolve(null);
  };

  const saved = new Map(app.state.expectedFiles);
  try {
    await withHostAsync(host, () => app.openHostMedia({ name: 'a song.m4a' }));
    eq(readProject, 0, 'the project file was read when only a song had arrived: ');
  } finally {
    app.state.expectedFiles = saved;
  }
});

check('history: a saved history describes the program it was saved from', () => {
  /* The guard the whole feature rests on. A history whose `current` does not
     match the program that was just loaded is a history of some other version
     of this file — edited by hand between sessions, or written by a second copy
     of the app. Applying it would let somebody undo into a program that never
     existed, which is not an undo, it is a substitution. */
  withProgram(
    { name: 'a program', clips: [{ id: 'c1', file: 'a.wav', srcStart: 0, srcEnd: 5, gain: 1 }] },
    () => {
      const mine = app.historyNow();
      eq(mine.current, app.undoSnapshot(), 'what was saved is not what is on screen: ');

      app.undoStack.length = 0;
      ok(app.restoreHistory(mine), 'its own history was refused');

      // A history from a different program is not this program's history.
      ok(
        !app.restoreHistory({ current: '{"clips":[]}', undo: ['x'], redo: [] }),
        'a history for another program was accepted',
      );
      eq(app.undoStack.length, 0, 'a refused history left something behind: ');

      // And neither is nonsense.
      for (const junk of [null, undefined, 'a string', 42, []]) {
        ok(!app.restoreHistory(junk), `${JSON.stringify(junk)} was accepted as a history`);
      }
    },
  );
});

check('history: what comes back is what went in, and no deeper', () => {
  withProgram({ name: 'p', clips: [] }, () => {
    const current = app.undoSnapshot();
    const deep = Array.from({ length: app.UNDO_DEPTH + 40 }, (_, i) => `snapshot ${i}`);

    ok(app.restoreHistory({ current, undo: deep, redo: ['r1', 'r2'] }));
    /* Trimmed to the depth this app keeps, from the recent end: a file written
       by a version that kept more should not make this one keep more. */
    eq(app.undoStack.length, app.UNDO_DEPTH, 'the stack came back deeper than the app allows: ');
    eq(app.undoStack[app.undoStack.length - 1], deep[deep.length - 1], 'the newest was dropped: ');
    eq(app.redoStack, ['r1', 'r2'], 'the redo stack did not survive: ');

    /* Entries that are not snapshots are dropped rather than carried into
       something that will try to apply them. */
    app.restoreHistory({ current, undo: ['ok', 7, null, { a: 1 }], redo: [] });
    eq(app.undoStack, ['ok'], 'junk in the file reached the stack: ');
  });
});

check('history: restoring always clears what was there', () => {
  /* Whether it accepts or refuses. A refusal that left the previous project's
     stack in place would let somebody undo one program into another, which is
     the exact failure the `current` check exists to stop. */
  withProgram({ name: 'p', clips: [] }, () => {
    /* Every way it can refuse, not just the interesting one. A history that is
       not an object at all is the easiest case to return early from and the
       easiest to return early from too soon. */
    for (const refused of [
      { current: 'no match', undo: [], redo: [] },
      null,
      undefined,
      'a string',
      42,
      [],
    ]) {
      app.undoStack.push('from another project');
      app.redoStack.push('and its redo');
      ok(!app.restoreHistory(refused), `${JSON.stringify(refused)} was accepted: `);
      eq(app.undoStack.length, 0, `undo survived ${JSON.stringify(refused)}: `);
      eq(app.redoStack.length, 0, `redo survived ${JSON.stringify(refused)}: `);
    }
  });
});

/* ------------------------------------------------------------- 1e. undo */

/** Runs `fn` with a throwaway clip list, then puts the real state back. */
function withClips(clips, fn) {
  const saved = app.state.clips;
  app.undoStack.length = 0;
  app.redoStack.length = 0;
  app.endUndoRun();
  app.state.clips = clips;
  try {
    fn();
  } finally {
    app.state.clips = saved;
    app.undoStack.length = 0;
    app.redoStack.length = 0;
    app.endUndoRun();
  }
}

check('undo: a snapshot holds the length being worked to, not only the clips', () => {
  /* The event has to be inside the stack. Outside it, picking the wrong one
     loses the target length with no way back — the one number the whole edit
     is aimed at. */
  withProgram(
    {
      name: 'my long program',
      level: 'usfs-jr',
      targetSeconds: 210,
      toleranceSeconds: 10,
      clips: [{ id: 'a', file: 'a.mp3', srcStart: 0, srcEnd: 30 }],
    },
    () => {
      const held = JSON.parse(app.undoSnapshot());
      eq(Object.keys(held).sort(), [
        'clips',
        'level',
        'name',
        'notes',
        'targetSeconds',
        'toleranceSeconds',
      ]);
      eq(held.name, 'my long program');
      eq(held.level, 'usfs-jr');
      eq(held.targetSeconds, 210);
      eq(held.clips.length, 1);
    },
  );
});

check('undo: a step back can be stepped forward again', () => {
  withProgram(
    {
      name: 'before',
      level: 'usfs-juv',
      targetSeconds: 135,
      toleranceSeconds: 10,
      clips: [],
    },
    () => {
      app.undoStack.length = 0;
      app.redoStack.length = 0;
      app.endUndoRun();

      app.pushUndo(); // snapshot "before"
      app.state.name = 'after';

      const back = app.takeUndo();
      eq(JSON.parse(back).name, 'before', 'undo hands back the earlier state: ');
      eq(app.redoStack.length, 1, 'and puts the current one where redo can reach it: ');

      const forward = app.takeRedo();
      eq(JSON.parse(forward).name, 'after', 'redo hands back what was undone: ');
      eq(app.undoStack.length, 1, 'and the step back is available again: ');
    },
  );
});

check('undo: nothing to go back or forward to is not an error', () => {
  withProgram(
    { name: 'x', level: 'usfs-juv', targetSeconds: 135, toleranceSeconds: 10, clips: [] },
    () => {
      app.undoStack.length = 0;
      app.redoStack.length = 0;
      eq(app.takeUndo(), null, 'an empty undo stack: ');
      eq(app.takeRedo(), null, 'an empty redo stack: ');
      eq(app.redoStack.length, 0, 'and neither should have grown: ');
      eq(app.undoStack.length, 0);
    },
  );
});

check('undo: a fresh edit closes off the branch that was undone', () => {
  /* Redo has to mean "put back what I just took away", not "put back something
     that never followed from here". Editing after an undo abandons that future. */
  withProgram(
    { name: 'one', level: 'usfs-juv', targetSeconds: 135, toleranceSeconds: 10, clips: [] },
    () => {
      app.undoStack.length = 0;
      app.redoStack.length = 0;
      app.endUndoRun();

      app.pushUndo();
      app.state.name = 'two';
      app.takeUndo();
      eq(app.redoStack.length, 1, 'there is a future to go back to: ');

      app.pushUndo();
      app.state.name = 'three';
      eq(app.redoStack.length, 0, 'a new edit must discard it: ');
    },
  );
});

check('undo: a held key is one gesture, not thirty entries', () => {
  /* Key repeat fires about thirty times a second. One snapshot per repeat fills
     the sixty-deep stack in two seconds and takes every earlier edit with it.
     These calls are all inside the coalescing window by virtue of running
     synchronously, which is exactly the situation a held key produces. */
  withClips([{ id: 'a', srcStart: 0, srcEnd: 10 }], () => {
    app.pushUndo(); // an ordinary edit
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
  ok(
    app.UNDO_COALESCE_MS >= 200,
    `${app.UNDO_COALESCE_MS}ms is shorter than the gap between key repeats`,
  );
  ok(
    app.UNDO_COALESCE_MS <= 1500,
    `${app.UNDO_COALESCE_MS}ms would swallow edits a second apart into one step`,
  );
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
    app.undoStack.pop(); // what undo() does to the stack
    app.endUndoRun(); // and what it must do to the run
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
  withClips(
    [
      { id: '1', file: 'a.mp3' },
      { id: '2', file: 'b.mp3' },
      { id: '3', file: 'a.mp3' },
    ],
    () => {
      eq(app.clipsUsing('a.mp3'), 2, 'the same song can be in a program twice: ');
      eq(app.clipsUsing('b.mp3'), 1);
      eq(app.clipsUsing('c.mp3'), 0, 'a file nothing is using can go: ');
    },
  );
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
  const saved = {
    AudioContext: global.AudioContext,
    OfflineAudioContext: global.OfflineAudioContext,
  };
  global.window = {
    AudioContext: function () {},
    OfflineAudioContext: function () {},
    File: function () {},
    FileList: function () {},
    FileReader: function () {},
    URL: { createObjectURL() {} },
  };
  global.Blob = { prototype: { arrayBuffer() {} } };
  eq(app.unsupportedReasons(), [], 'modern browser should pass: ');
  global.window = {
    File: function () {},
    FileList: function () {},
    FileReader: function () {},
    URL: { createObjectURL() {} },
  };
  ok(app.unsupportedReasons().length >= 2, 'a browser with no Web Audio should be blocked');
  Object.assign(global, saved);
});

/* ------------------------------------ swapping a song out from under an edit */

/* The verdicts and the wording, fed the numbers rather than the audio. What
   `sameRecording` and `compareQuality` produce is tested where they live; this
   is about what gets said, which is the part a person acts on. */

const swap = (over = {}) => ({
  current: { name: 'rough.mp3', duration: 200 },
  candidate: { name: 'good.flac', duration: 200 },
  match: { correlation: 0.99, shift: 0, same: true },
  quality: { direction: 'better', says: 'lossless, up from 128 kbps mp3' },
  clips: [{ file: 'rough.mp3', srcStart: 10, srcEnd: 60 }],
  ...over,
});

const find = (report, id) => report.checks.find((c) => c.id === id);

check('checkReplacement: a clean upgrade has nothing to warn about', () => {
  const report = app.checkReplacement(swap());
  eq(report.worst, 'good');
  eq(report.shift, 0);
  eq(report.shortened, 0);
  eq(find(report, 'song').level, 'good');
  eq(find(report, 'quality').level, 'good');
  eq(find(report, 'timing').level, 'good');
  eq(find(report, 'length'), undefined, 'the same length is not worth a line: ');
  eq(find(report, 'fit'), undefined);
});

check('checkReplacement: a song that does not match is the warning', () => {
  const report = app.checkReplacement(
    swap({ match: { correlation: 0.4, shift: 1.2, same: false } }),
  );
  eq(report.worst, 'warn');
  eq(find(report, 'song').level, 'warn');
  ok(/every trim/i.test(find(report, 'song').says), 'says what goes wrong');
});

check('checkReplacement: an offset found against a song that did not match is not used', () => {
  /* Where two different songs happen to line up best is not a fact about
     either. Moving every trim in a program by it would turn one mistake into
     two. */
  const report = app.checkReplacement(
    swap({ match: { correlation: 0.4, shift: 1.2, same: false } }),
  );
  eq(report.shift, 0);
  eq(find(report, 'timing'), undefined, 'and it is not offered as a thing that will happen: ');
});

check('checkReplacement: a real offset moves the trims, and says so', () => {
  const later = app.checkReplacement(
    swap({ match: { correlation: 0.98, shift: 0.4, same: true } }),
  );
  eq(later.shift, 0.4);
  eq(find(later, 'timing').level, 'note');
  ok(/later/.test(find(later, 'timing').head), `${find(later, 'timing').head}`);

  const earlier = app.checkReplacement(
    swap({ match: { correlation: 0.98, shift: -0.4, same: true } }),
  );
  eq(earlier.shift, -0.4);
  ok(/earlier/.test(find(earlier, 'timing').head), `${find(earlier, 'timing').head}`);
});

check('checkReplacement: an offset too small to matter is left alone', () => {
  const report = app.checkReplacement(
    swap({ match: { correlation: 0.99, shift: 0.01, same: true } }),
  );
  eq(report.shift, 0, 'nothing moves: ');
  eq(find(report, 'timing').level, 'good');
});

check('checkReplacement: a clip that would run past the end is a warning', () => {
  const report = app.checkReplacement(
    swap({
      candidate: { name: 'good.flac', duration: 40 },
      clips: [{ file: 'rough.mp3', srcStart: 10, srcEnd: 60 }],
    }),
  );
  eq(report.shortened, 1);
  eq(find(report, 'fit').level, 'warn');
  eq(report.worst, 'warn');
});

check('checkReplacement: the shift is counted when working out what fits', () => {
  /* A clip ending at 199 in a file that is 200 long fits — until every trim is
     moved two seconds later, at which point it does not. Checking the fit
     against the untouched trims would miss exactly the clips the swap itself
     pushes over the edge. */
  const clips = [{ file: 'rough.mp3', srcStart: 100, srcEnd: 199 }];
  eq(app.checkReplacement(swap({ clips })).shortened, 0);
  eq(
    app.checkReplacement(swap({ clips, match: { correlation: 0.98, shift: 2, same: true } }))
      .shortened,
    1,
  );
});

check('checkReplacement: only clips playing from this song are counted', () => {
  const report = app.checkReplacement(
    swap({
      candidate: { name: 'good.flac', duration: 40 },
      clips: [
        { file: 'rough.mp3', srcStart: 0, srcEnd: 30 },
        { file: 'other.mp3', srcStart: 0, srcEnd: 300 },
      ],
    }),
  );
  eq(report.shortened, 0);
});

check('checkReplacement: a real difference in length is mentioned', () => {
  const longer = app.checkReplacement(swap({ candidate: { name: 'good.flac', duration: 230 } }));
  eq(find(longer, 'length').level, 'note');
  ok(/3:50/.test(find(longer, 'length').head), `${find(longer, 'length').head}`);
  ok(/3:20/.test(find(longer, 'length').head), 'and what it was: ' + find(longer, 'length').head);

  const barely = app.checkReplacement(swap({ candidate: { name: 'good.flac', duration: 200.5 } }));
  eq(find(barely, 'length'), undefined, 'half a second is not a difference: ');
});

check('checkReplacement: lower quality warns but does not stop', () => {
  const report = app.checkReplacement(
    swap({ quality: { direction: 'worse', says: '96 kbps mp3, down from 320 kbps mp3' } }),
  );
  eq(find(report, 'quality').level, 'warn');
  eq(report.worst, 'warn');
  eq(report.shift, 0, 'and the swap itself is still described in full: ');
});

check('checkReplacement: too short to compare is unknown, not a mismatch', () => {
  const report = app.checkReplacement(swap({ match: null }));
  eq(find(report, 'song').level, 'note');
  eq(report.worst, 'note', 'unknown is not a reason to shout: ');
  eq(find(report, 'timing'), undefined, 'and nothing is claimed about the timing: ');
});

check('checkReplacement: every check says something, so the dialog is never blank', () => {
  for (const direction of ['better', 'same', 'worse', 'unknown']) {
    const report = app.checkReplacement(swap({ quality: { direction, says: 'something' } }));
    for (const c of report.checks) {
      ok(c.head && c.says, `${direction}/${c.id} is missing its wording`);
      ok(['good', 'note', 'warn'].includes(c.level), `${c.id} has level ${c.level}`);
    }
  }
});

check('clipsPastEnd: counts what would not fit, and does not change it', () => {
  const clips = [
    { file: 'a.mp3', srcStart: 0, srcEnd: 100 },
    { file: 'a.mp3', srcStart: 0, srcEnd: 20 },
    { file: 'b.mp3', srcStart: 0, srcEnd: 500 },
  ];
  eq(app.clipsPastEnd(clips, 'a.mp3', 50), 1);
  eq(app.clipsPastEnd(clips, 'a.mp3', 50, 40), 2, 'with a shift applied: ');
  eq(app.clipsPastEnd(clips, 'a.mp3', 200), 0);
  eq(clips[0].srcEnd, 100, 'and nothing was touched: ');
});

check('clipsPastEnd: a clip ending exactly at the end fits', () => {
  eq(app.clipsPastEnd([{ file: 'a.mp3', srcStart: 0, srcEnd: 50 }], 'a.mp3', 50), 0);
});

/* --------------------------------------- what the music is costing to hold */

/* The arithmetic, the budget and the wording. Nothing here can measure a real
   AudioBuffer, so the byte figure is checked against a buffer whose size is
   known exactly — and against the one number this was calibrated on, which is
   the 85 MB four minutes of stereo really costs. */

const song = (seconds, channels = 2, rate = 44100) => ({
  buffer: { length: Math.round(seconds * rate), numberOfChannels: channels },
});

check('decodedBytes: four bytes a sample a channel, which is what it really is', () => {
  eq(app.decodedBytes(song(240)), 84672000);
  /* Measured, not derived: a four-minute stereo song in Chrome reports exactly
     10584000 frames and costs 84.7 MB. If this ever stops matching, the model
     behind every figure the app shows has changed. */
  near(app.decodedBytes(song(240)) / 1e6, 84.7, 0.1, 'four minutes of stereo, in MB: ');
  eq(app.decodedBytes(song(240, 1)), 42336000, 'mono is half: ');
  eq(app.decodedBytes(song(240, 2, 48000)), 92160000, 'a higher rate is more: ');
});

check('decodedBytes: a song not yet decoded costs nothing', () => {
  eq(app.decodedBytes({ buffer: null }), 0);
  eq(app.decodedBytes({}), 0);
  eq(app.decodedBytes(null), 0);
  eq(app.decodedBytes({ buffer: { length: 0, numberOfChannels: 2 } }), 0);
});

check('memoryBudget: a share of what the machine says it has', () => {
  eq(app.memoryBudget(4), 4 * 1e9 * app.MEMORY.share);
  ok(app.memoryBudget(8) > app.memoryBudget(4), 'more memory, more room');
});

check('memoryBudget: pinned at both ends, because the figure cannot be trusted', () => {
  /* The specification says this is capped at 8 and rounded to a power of two.
     Chrome returns 32 on a 32 GB machine, so it is not capped in practice —
     and a browser reporting 0.25 should not produce a budget of 62 MB, which
     every single song would exceed. */
  eq(app.memoryBudget(32), app.memoryBudget(app.MEMORY.mostGb), 'a huge claim is capped: ');
  eq(app.memoryBudget(0.25), app.memoryBudget(app.MEMORY.leastGb), 'a tiny one has a floor: ');
});

check('memoryBudget: a browser that will not say gets an assumption, not a zero', () => {
  const assumed = app.memoryBudget(app.MEMORY.assumedGb);
  eq(app.memoryBudget(undefined), assumed, 'Firefox and Safari offer nothing: ');
  eq(app.memoryBudget(null), assumed);
  eq(app.memoryBudget(0), assumed);
  eq(app.memoryBudget('lots'), assumed);
  eq(app.memoryBudget(-4), assumed);
});

check('describeBytes: megabytes until it is worth saying gigabytes', () => {
  eq(app.describeBytes(84672000), '85 MB');
  eq(app.describeBytes(1.4e9), '1.4 GB');
  eq(app.describeBytes(999000000), '999 MB');
  eq(app.describeBytes(0), '0 MB');
});

check('describeMemoryUse: says nothing at all until it matters', () => {
  eq(
    app.describeMemoryUse({ used: 5e8, budget: 1e9, unused: 3, unusedBytes: 4e8 }),
    null,
    'well under: ',
  );
  eq(
    app.describeMemoryUse({ used: 1e9, budget: 1e9, unused: 3, unusedBytes: 4e8 }),
    null,
    'exactly at the budget is not over it: ',
  );
});

check('describeMemoryUse: offers the songs nothing is playing', () => {
  const say = app.describeMemoryUse({ used: 1.4e9, budget: 1e9, unused: 3, unusedBytes: 6e8 });
  ok(/1\.4 GB/.test(say.head), `says how much: ${say.head}`);
  ok(/3 songs are not in your program/.test(say.says), say.says);
  ok(/600 MB/.test(say.says), `and how much they hold: ${say.says}`);
  eq(say.offer, 'Remove 3 unused songs');
});

check('describeMemoryUse: one song is one song, not "1 songs"', () => {
  const say = app.describeMemoryUse({ used: 1.4e9, budget: 1e9, unused: 1, unusedBytes: 9e7 });
  ok(/One song is not in your program and is holding/.test(say.says), say.says);
  eq(say.offer, 'Remove the unused song');
});

check('describeMemoryUse: with nothing to give back it explains rather than offers', () => {
  const say = app.describeMemoryUse({ used: 1.4e9, budget: 1e9, unused: 0, unusedBytes: 0 });
  eq(say.offer, null, 'there is no button when there is nothing to press it about: ');
  ok(/nothing to give back/.test(say.says), say.says);
});

check('describeMemoryUse: the program is never what is at risk, and it says so', () => {
  /* The failure is a tab that closes, and what that costs is the music, not the
     work — which is written out as it is edited. Telling a skater they are
     about to lose their program would be false and frightening. */
  for (const unused of [0, 1, 4]) {
    const say = app.describeMemoryUse({ used: 1.4e9, budget: 1e9, unused, unusedBytes: 1e8 });
    ok(/Your program is saved either way/.test(say.says), `unused=${unused}: ${say.says}`);
    ok(/open all the music again/.test(say.says), `unused=${unused}: says what is lost`);
  }
});
