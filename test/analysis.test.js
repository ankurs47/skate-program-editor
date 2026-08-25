/**
 * Beat detection, phrase detection and loudness — the analysis.js file.
 *
 * Synthetic fixtures throughout, so the expected answer is known exactly and
 * the random number generator is seeded: a test that fails one run in twenty
 * is worse than no test.
 */
'use strict';

// `html` is here for one check: the level slider's range lives in two places —
// the HTML attribute and LEVEL_SLIDER — and nothing else would notice if they
// stopped agreeing.
const { app, check, eq, near, ok, html } = require('./harness.js');

check('clamp: holds a value between its ends, whichever way round', () => {
  eq(app.clamp(5, 0, 10), 5);
  eq(app.clamp(-3, 0, 10), 0, 'below the floor: ');
  eq(app.clamp(99, 0, 10), 10, 'above the ceiling: ');
  eq(app.clamp(5, 0, 0), 0, 'a collapsed range: ');
  // Deliberate: several callers pass a lo above the hi when a clip is shorter
  // than a minimum, and rely on getting the hi rather than an inverted range.
  eq(app.clamp(5, 10, 0), 0, 'an inverted range yields the ceiling: ');
});

/* ----------------------------------------------------- 1b. beat detection */

/* Fixtures are synthetic so the expected answer is known exactly. The random
   number generator is seeded, because a test that fails one run in twenty is
   worse than no test. */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
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
    const found = app.analyzeBeats(clickTrain(bpm, 12), 44100);
    near(found.bpm, bpm, bpm * 0.01, `${bpm} BPM: `);
    ok(found.confidence > 0.5, `${bpm} BPM: confidence only ${found.confidence.toFixed(2)}`);
  }
});

check('tempo: the prior resolves the half-or-double ambiguity', () => {
  // 76 BPM correlates just as well at 38 and 152; the prior should pick 76.
  const found = app.analyzeBeats(clickTrain(76, 14), 44100);
  near(found.bpm, 76, 1.5);
});

check('beats: land on the clicks, whatever the phase', () => {
  const offset = 0.23;
  const found = app.analyzeBeats(clickTrain(120, 12, { offset }), 44100);
  ok(found.beats.length > 15, `only ${found.beats.length} beats found`);
  for (const beat of found.beats) {
    ok(
      offGrid(beat.t, 0.5, offset) < 0.02,
      `beat at ${beat.t.toFixed(3)}s is ${(offGrid(beat.t, 0.5, offset) * 1000).toFixed(0)}ms off`,
    );
  }
});

check('beats: an accent every four bars gives a downbeat in 4', () => {
  const found = app.analyzeBeats(clickTrain(120, 14, { accent: 4 }), 44100);
  eq(found.meter, 4);
  const downbeats = found.beats.filter((b) => b.downbeat);
  ok(downbeats.length > 3, 'no downbeats marked');
  for (const beat of downbeats) {
    ok(offGrid(beat.t, 2.0) < 0.03, `downbeat at ${beat.t.toFixed(3)}s is not on an accent`);
  }
});

check('beats: material with no pulse reports no confidence', () => {
  // The detector always returns *something*; the point is that it says so.
  for (const [what, samples] of [
    ['noise', noise(12)],
    ['a held tone', tone(12)],
  ]) {
    const found = app.analyzeBeats(samples, 44100);
    ok(
      found.confidence < app.BEAT.minConfidence,
      `${what} scored ${found.confidence.toFixed(2)}, above the ${app.BEAT.minConfidence} threshold`,
    );
  }
});

check('beats: silence and near-empty input return nothing, not NaN', () => {
  for (const samples of [new Float32Array(0), new Float32Array(100), new Float32Array(44100)]) {
    const found = app.analyzeBeats(samples, 44100);
    eq(found.beats, []);
    eq(found.confidence, 0);
    ok(!Number.isNaN(found.bpm), 'bpm went NaN');
  }
});

check('onsetEnvelope: measures energy arriving, and how much is playing', () => {
  const clicks = app.onsetEnvelope(clickTrain(120, 6), 44100);
  eq(clicks.rate, 44100 / app.BEAT.hop, 'one envelope sample per hop: ');
  near(
    clicks.offset,
    (app.BEAT.hop + app.BEAT.frame / 2) / 44100,
    1e-12,
    'env[i] compares frame i+1 with i, so it belongs at that frame center: ',
  );
  ok(clicks.env.length > 400, `only ${clicks.env.length} envelope samples`);
  ok(clicks.level > 0, 'a click track has energy in it');

  // The peaks have to be where the clicks are: 120 BPM is one every 0.5s.
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < clicks.env.length; i++) {
    if (clicks.env[i] > peak) {
      peak = clicks.env[i];
      peakAt = i;
    }
  }
  const t = peakAt / clicks.rate + clicks.offset;
  ok(offGrid(t, 0.5) < 0.03, `the strongest onset at ${t.toFixed(3)}s is not on a click`);

  // Silence has nothing starting and nothing playing — the pair `analyzeBeats`
  // uses to tell a held chord from music.
  const quiet = app.onsetEnvelope(new Float32Array(44100 * 4), 44100);
  eq(quiet.level, 0, 'silence has no level: ');
  for (const v of quiet.env) eq(v, 0, 'silence has no onsets: ');
  eq(app.onsetEnvelope(new Float32Array(100), 44100).env.length, 0, 'too short for two frames: ');
});

check('flattenEnvelope: removes the local level and never goes negative', () => {
  // Loudness must stop mattering, or a loud chorus outvotes a quiet verse and
  // the autocorrelation locks onto the wrong thing.
  const rate = 86;
  const flat = app.flattenEnvelope(new Float32Array(rate * 4).fill(3), rate);
  // Away from the ends, a constant envelope has to flatten to nothing.
  const margin = Math.round(rate * app.BEAT.smoothing) + 2;
  for (let i = margin; i < flat.length - margin; i++) {
    near(flat[i], 0, 1e-6, `a constant envelope carries no onsets (at ${i}): `);
  }
  // The blur reads past the ends as zero, so the first and last samples sit
  // low and lift their neighborhood slightly. Small, and bounded — but real,
  // so it is pinned here rather than discovered as a surprise later.
  ok(flat[0] < 3 * 0.02, `the edge lift is ${flat[0].toFixed(3)} on a level of 3`);

  const spikes = new Float32Array(rate * 6);
  for (let i = 0; i < spikes.length; i += rate) spikes[i] = 1; // one a second
  const out = app.flattenEnvelope(spikes, rate);
  for (const v of out) ok(v >= 0, `rectified output went to ${v}`);
  ok(out[rate * 2] > 0, 'a real onset should survive the flattening');
  ok(out[rate * 2 + Math.round(rate / 3)] === 0, 'the gap between onsets should not');

  // The one-frame blur is what stops alternate beats measuring weaker; it puts
  // a quarter of each spike into each neighbor.
  ok(out[rate * 2 - 1] > 0 && out[rate * 2 + 1] > 0, 'the blur should reach both neighbors');
});

check('estimateTempoLag: lands in the right neighborhood for a known tempo', () => {
  // It only has to find the neighborhood — refinePeriod finds the value.
  for (const bpm of [90, 120, 150]) {
    const raw = app.onsetEnvelope(clickTrain(bpm, 12), 44100);
    const env = app.flattenEnvelope(raw.env, raw.rate);
    const lag = app.estimateTempoLag(env, raw.rate);
    const expected = (raw.rate * 60) / bpm;
    near(lag, expected, 1.5, `${bpm} BPM should give a lag near ${expected.toFixed(1)}: `);
  }
  eq(app.estimateTempoLag(new Float32Array(4), 86), 0, 'too short to hold a period: ');
});

check('energyEnvelope: reads the RMS of what is sounding', () => {
  const rate = 86;
  const amplitude = 0.5;
  const rms = app.energyEnvelope(sine(440, 4, amplitude), 44100, rate);
  ok(rms.length > 300, `only ${rms.length} samples`);
  // RMS of a sine is its amplitude over root two.
  for (const v of rms.slice(2, -2)) near(v, amplitude / Math.SQRT2, 0.01, 'sine RMS: ');
  for (const v of app.energyEnvelope(new Float32Array(44100), 44100, rate)) {
    eq(v, 0, 'silence has no energy: ');
  }
});

check('biquad: filters in place, and the high pass really blocks DC', () => {
  const pass = new Float32Array([1, -0.5, 0.25, 2]);
  const before = Array.from(pass);
  app.biquad(pass, { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
  eq(Array.from(pass), before, 'a unity filter must change nothing: ');

  const halved = new Float32Array([1, 1, 1, 1]);
  app.biquad(halved, { b0: 0.5, b1: 0, b2: 0, a1: 0, a2: 0 });
  eq(Array.from(halved), [0.5, 0.5, 0.5, 0.5], 'and it works in place: ');

  // The K-weighting high pass has numerator 1, -2, 1, which sums to zero — so a
  // constant input has to settle to nothing. This is the stage that stops a DC
  // offset or subsonic rumble being counted as loudness.
  const dc = new Float32Array(44100).fill(0.5);
  app.biquad(dc, app.kWeighting(44100).highpass);
  near(dc[dc.length - 1], 0, 1e-3, 'DC should have decayed away: ');
});

check('beatsAround: reports the cut in the window it measured, not the song', () => {
  /* Beat times are relative to the window, never to the file — getting this
     wrong would place every cut by the offset of the window it came from. */
  const buffer = fakeBuffer(clickTrain(120, 40));
  const at = 20.17;
  const found = app.beatsAround(buffer, at, { window: 12 });
  near(found.cut, 6, 0.001, 'the cut sits in the middle of a 12s window: ');
  ok(found.beats.beats.length > 15, 'no grid found in a click track');
  ok(found.beats.confidence > 0.5, `confidence only ${found.beats.confidence.toFixed(2)}`);
  for (const beat of found.beats.beats) {
    ok(beat.t >= 0 && beat.t <= 12.001, `beat at ${beat.t} is outside its own window`);
  }

  // Up against the start of the file the window is clipped, and the cut moves
  // with it rather than staying at the halfway mark.
  const early = app.beatsAround(buffer, 2, { window: 12 });
  near(early.cut, 2, 0.001, 'a window clipped at the start still locates the cut: ');
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
  const a = grid(120); // beats every 0.5s from 0
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
  const result = app.suggestJoin(grid(120), 6.3, grid(120, { phase: 0.1 }), 4.1, { crossfade: 0 });
  ok(result.ok, `declined: ${result.reason}`);
  eq(result.crossfade, 0, 'a deliberate hard cut was turned into a blend: ');
});

check('join: reported length change matches what the shifts actually do', () => {
  const before = 1.5;
  const result = app.suggestJoin(grid(120), 6.31, grid(132, { phase: 0.4 }), 4.12, {
    crossfade: before,
  });
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
  ok(
    result.startShift >= -0.8 && result.startShift <= 0,
    `startShift ${result.startShift} out of room`,
  );
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
    outRoom: { min: 0.05, max: 0.09 }, // narrower than the gap between beats
  });
  eq(result.ok, false);
  eq(result.reason, 'no-room');
});

check('join: mismatched tempos get a short blend, not a long one', () => {
  const wide = app.suggestJoin(grid(120), 6.0, grid(120), 4.0, { crossfade: 4 });
  const clash = app.suggestJoin(grid(120), 6.0, grid(97), 4.0, { crossfade: 4 });
  ok(wide.ok && clash.ok, 'both should still return an answer');
  ok(
    clash.crossfade < wide.crossfade,
    `${clash.crossfade.toFixed(2)}s blend between clashing tempos is no shorter than ${wide.crossfade.toFixed(2)}s`,
  );
  eq(clash.reason, 'tempo-mismatch', 'the caller has to be able to say why: ');
  ok(
    clash.drift <= app.BEAT.maxDrift + 1e-9,
    `slips ${clash.drift.toFixed(3)} beats through the blend`,
  );
});

check('join: half-speed against double-speed still counts as matched', () => {
  const result = app.suggestJoin(grid(80), 6.0, grid(160), 4.0, { crossfade: 2 });
  ok(result.ok, `declined: ${result.reason}`);
  eq(result.reason, 'aligned', 'an octave apart is not a mismatch: ');
  near(result.drift, 0, 1e-9);
});

check('join: end to end from audio, the two grids agree through the blend', () => {
  const a = fakeBuffer(clickTrain(120, 30, { seed: 1 })); // beats from 0
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
  eq(
    app.describeJoin({ ...base, lengthDelta: 0.8 }, 2),
    'Lined up with the beat. Program is 0.8s longer',
  );
  eq(
    app.describeJoin({ ...base, lengthDelta: -1.24 }, 2),
    'Lined up with the beat. Program is 1.2s shorter',
  );
  eq(
    app.describeJoin({ ...base, lengthDelta: 0.01 }, 2),
    'Lined up with the beat. Same length as before',
  );
  eq(
    app.describeJoin({ ...base, reason: 'tempo-mismatch', lengthDelta: 0 }, 2),
    'Lined up as closely as these two speeds allow. Same length as before',
  );
});

check('describeJoin: does not claim to have done anything it did not', () => {
  const still = {
    ok: true,
    reason: 'aligned',
    endShift: 0,
    startShift: 0,
    crossfade: 1.5,
    lengthDelta: 0,
  };
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
    {
      ok: true,
      reason: 'tempo-mismatch',
      endShift: 1,
      startShift: 0,
      crossfade: 2,
      lengthDelta: -1,
    },
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
    out[start + i] +=
      level *
      decay *
      (Math.sin(2 * Math.PI * hz * t) +
        0.4 * Math.sin(2 * Math.PI * hz * 2 * t) +
        0.2 * Math.sin(2 * Math.PI * hz * 3 * t));
  }
  return out;
}

const HZ = { C4: 261.63, E4: 329.63, G4: 392.0, A4: 440, D4: 293.66, F4: 349.23, B4: 493.88 };

/**
 * Free-tempo piano: phrases of a few notes, separated by real silences, with
 * every interval drawn from a wide range so nothing repeats.
 *
 * The irregularity is load-bearing. An earlier version spaced notes evenly
 * enough that the beat detector accepted it, and the fallback under test never
 * ran — so the fixture asserts its own premise below, and every test using it
 * checks that `analyzeBeats` really is declining before drawing a conclusion.
 *
 * Returns the audio and the spans where nothing is sounding. Spans, not
 * midpoints: anywhere inside a pause is a legitimate cut, and asserting against
 * the middle of one fails a cut that is perfectly good.
 */
function rubato(seconds, sampleRate = 44100) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const random = rng(20260810);
  const scale = [261.63, 277.18, 293.66, 329.63, 349.23, 392.0, 440, 466.16, 493.88];
  const silences = [];
  let t = 0.4;
  while (t < seconds - 1.2) {
    const notes = 3 + Math.floor(random() * 3);
    for (let i = 0; i < notes; i++) {
      note(out, t, scale[Math.floor(random() * scale.length)], 1.1, 0.5, sampleRate);
      if (i < notes - 1) t += 0.24 + random() * 0.62; // within a line
    }
    const died = t + 1.0; // the last note has decayed
    const pause = 0.7 + random() * 1.9; // the breath after it
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
  for (let i = rate * 4; i < rate * 4.5; i++) env[i] = 0; // half a second of nothing
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
  eq(
    ranked.slice().sort((a, b) => a - b),
    [0, 4, 7],
    'the three strongest classes: ',
  );
  near(
    mid.reduce((sum, v) => sum + v * v, 0),
    1,
    1e-5,
    'frames are unit length: ',
  );
});

check('chroma: a single tone lands on its own pitch class', () => {
  const sampleRate = 44100;
  const tone = new Float32Array(sampleRate * 2);
  for (let i = 0; i < tone.length; i++)
    tone[i] = 0.5 * Math.sin((2 * Math.PI * HZ.A4 * i) / sampleRate);
  const { chroma } = app.chromaFrames(tone, sampleRate);
  const mid = chroma[Math.floor(chroma.length / 2)];
  const loudest = [...mid.keys()].reduce((best, p) => (mid[p] > mid[best] ? p : best), 0);
  eq(loudest, 9, 'A is pitch class 9: ');
});

check('chroma: too short to analyze returns nothing, not a crash', () => {
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
  for (let s = 0; s < 4; s += 0.5)
    for (const hz of [HZ.C4, HZ.E4, HZ.G4]) note(audio, s, hz, 0.6, 0.5, sampleRate);
  for (let s = 4; s < 8; s += 0.5)
    for (const hz of [369.99, 466.16, 277.18]) note(audio, s, hz, 0.6, 0.5, sampleRate);

  const { chroma, rate, offset } = app.chromaFrames(audio, sampleRate);
  const novelty = app.noveltyScores(chroma, rate);
  const at = (t) => novelty[Math.round((t - offset) * rate)];
  ok(at(4) > 0.5, `the change of key only scored ${at(4).toFixed(2)}`);
  ok(at(2) < at(4) / 2, `the middle of a steady chord scored ${at(2).toFixed(2)}, too high`);
});

check('phrases: found in free-tempo music that has no beat at all', () => {
  const { audio, silences } = rubato(16);
  // the premise: the beat detector should be declining this
  const beats = app.analyzeBeats(audio, 44100);
  ok(
    beats.confidence < app.BEAT.minConfidence,
    `this fixture has a beat after all (${beats.confidence.toFixed(2)}), so it tests nothing`,
  );

  const points = app.phrasePoints(audio, 44100);
  ok(
    points.length >= silences.length,
    `only found ${points.length} breaks for ${silences.length} pauses`,
  );

  // every real pause is found
  for (const [from, to] of silences) {
    ok(
      points.some((p) => p.t > from - 0.3 && p.t < to + 0.3),
      `no break found in the pause from ${from.toFixed(2)}s to ${to.toFixed(2)}s`,
    );
  }
  // and nothing is offered that is not one
  for (const p of points) {
    ok(
      outsideSilence(p.t, silences) < 0.35,
      `a break was offered at ${p.t.toFixed(2)}s, ${outsideSilence(p.t, silences).toFixed(2)}s ` +
        'from any pause — that is in the middle of a phrase',
    );
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

  for (const [cutOut, cutIn] of [
    [16.4, 9.2],
    [20, 12],
    [27, 19],
  ]) {
    const result = app.suggestJoinForBuffers(buffer, cutOut, buffer, cutIn, { crossfade: 1.2 });
    ok(result.ok, `declined at ${cutOut}s: ${result.reason}`);
    const endAt = cutOut + result.endShift;
    const startAt = cutIn + result.startShift;
    ok(
      outsideSilence(endAt, silences) < 0.25,
      `outgoing cut ${endAt.toFixed(2)}s is ${outsideSilence(endAt, silences).toFixed(2)}s ` +
        'outside any pause — it is cutting through the music',
    );
    ok(
      outsideSilence(startAt, silences) < 0.25,
      `incoming cut ${startAt.toFixed(2)}s is ${outsideSilence(startAt, silences).toFixed(2)}s ` +
        'outside any pause',
    );
    // the incoming side aims at where the music picks up, so it should sit in
    // the later part of its pause rather than at the front of it
    const pause = silences.find(([from, to]) => startAt > from - 0.25 && startAt < to + 0.25);
    ok(
      startAt > (pause[0] + pause[1]) / 2,
      `incoming cut ${startAt.toFixed(2)}s opens with silence: the pause runs to ${pause[1].toFixed(2)}s`,
    );
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
  ok(
    blended.crossfade >= app.PHRASE.minBlend,
    `a ${blended.crossfade}s blend is exposed with no beat to carry it`,
  );
  const hard = app.suggestPhraseJoin(points, 7.3, points, 4.1, { crossfade: 0 });
  eq(hard.crossfade, 0, 'a deliberate hard cut must survive: ');
  const capped = app.suggestPhraseJoin(points, 7.3, points, 4.1, {
    crossfade: 0.6,
    maxCrossfade: 1,
  });
  ok(capped.crossfade <= 1, 'the blend cannot outlast the clip');
});

check('phrase join: reported length change matches the shifts', () => {
  const points = app.phrasePoints(rubato(16).audio, 44100);
  const before = 1.5;
  const result = app.suggestPhraseJoin(points, 7.3, points, 4.1, { crossfade: before });
  near(result.lengthDelta, result.endShift - result.startShift - (result.crossfade - before), 1e-9);
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
    crossfade: 1.5,
    minConfidence: 1,
  });
  ok(forced.ok, `declined: ${forced.reason}`);
  eq(forced.reason, 'phrase');
});

check('the join button falls back to phrasing on free-tempo music', () => {
  const buffer = fakeBuffer(rubato(40).audio);
  for (const [cutOut, cutIn] of [
    [14.5, 23],
    [21, 9.5],
  ]) {
    // the premise, per window: the beat path has to be the one declining
    for (const at of [cutOut, cutIn]) {
      const w = app.windowAround(buffer, at);
      ok(
        app.analyzeBeats(w.samples, w.sampleRate).confidence < app.BEAT.minConfidence,
        `the window at ${at}s reads as having a beat, so this tests nothing`,
      );
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
  const sparse = app.analyzeBeats(rubato(14).audio, 44100);
  const steady = app.analyzeBeats(clickTrain(120, 14, { accent: 4 }), 44100);

  ok(
    sparse.coverage < app.BEAT.minCoverage,
    `sparse piano covers ${sparse.coverage.toFixed(2)} of its grid, which is not sparse`,
  );
  ok(steady.coverage > 0.9, `a drum track covers only ${steady.coverage.toFixed(2)} of its grid`);
  ok(
    steady.confidence > 0.5,
    `the damper must not touch rhythmic music, which scored ${steady.confidence.toFixed(2)}`,
  );
  ok(
    sparse.confidence < steady.confidence / 2,
    `sparse piano at ${sparse.confidence.toFixed(2)} is not clearly below ` +
      `a drum track at ${steady.confidence.toFixed(2)}`,
  );
});

check('the join button still prefers the beat when there is one', () => {
  const audio = fakeBuffer(clickTrain(120, 30, { accent: 4 }));
  const result = app.suggestJoinForBuffers(audio, 16.4, audio, 9.2, { crossfade: 1.5 });
  ok(result.ok, `declined: ${result.reason}`);
  ok(result.reason !== 'phrase', 'a steady beat must not be given up for phrasing');
});

check('describeJoin: says which of the two things it did', () => {
  const phrase = {
    ok: true,
    reason: 'phrase',
    endShift: 0.8,
    startShift: 0,
    crossfade: 2,
    lengthDelta: 0,
  };
  eq(
    app.describeJoin(phrase, 2),
    'No steady beat here, so the cut moved to where the phrase ends. Same length as before',
  );
  eq(
    app.describeJoin({ ...phrase, endShift: 0, startShift: 0 }, 2),
    'This join is already at a natural break',
  );
  eq(
    app.describeJoin({ ok: false, reason: 'no-phrase' }, 1.5),
    'Could not find a natural break in the music, so nothing changed',
  );
});

check('monoWindow: averages channels and clamps to the buffer', () => {
  const left = new Float32Array([1, 1, 1, 1]);
  const right = new Float32Array([0, 0, 0, 0]);
  const stereo = {
    sampleRate: 2,
    length: 4,
    numberOfChannels: 2,
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
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** dBFS of a sine's amplitude, as a stereo pair with no weighting applied. */
const stereoSineLevel = (amplitude) => 20 * Math.log10(amplitude / Math.SQRT2) + 10 * Math.log10(2);

check('K-weighting: the derivation reproduces the published 48 kHz table', () => {
  // BS.1770-4 tabulates coefficients at 48 kHz only. Everything here runs at
  // 44100, so they are derived — and this is what says the derivation is right.
  const { shelf, highpass } = app.kWeighting(48000);
  const published = {
    b0: 1.53512485958697,
    b1: -2.69169618940638,
    b2: 1.19839281085285,
    a1: -1.69065929318241,
    a2: 0.73248077421585,
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
    near(
      app.loudnessOf([tone, tone], 44100),
      stereoSineLevel(amplitude),
      0.05,
      `amplitude ${amplitude}: `,
    );
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
  ok(
    level(10000) > reference + 2,
    `10 kHz should read above 1 kHz, got ${level(10000).toFixed(1)}`,
  );
});

check('loudness: mono is measured the way it will be played', () => {
  // Web Audio sends a mono buffer to both speakers. Measured as a single
  // channel it would read 3 dB low, and every mono file would end up too loud.
  const tone = sine(997, 5, 0.1);
  near(app.loudnessOf([tone], 44100), app.loudnessOf([tone, tone], 44100), 1e-9);
});

check('loudness: silence at the end does not drag the reading down', () => {
  const tone = sine(997, 10, 0.1);
  const hush = sine(997, 30, 1e-5); // audible only to a meter
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
  near(
    measured,
    app.loudnessOf([loud, loud], 44100),
    0.15,
    'the relative gate should keep the reading on the body of the music: ',
  );
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
      b[2] = 0.969 * b[2] + w * 0.153852;
      b[3] = 0.8665 * b[3] + w * 0.3104856;
      b[4] = 0.55 * b[4] + w * 0.5329522;
      b[5] = -0.7616 * b[5] - w * 0.016898;
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
  near(
    app.peakOf([new Float32Array([0.1]), new Float32Array([0.9])]),
    0.9,
    1e-7,
    'both channels: ',
  );
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
    { loudness: -24, peak: 0.7 }, // crest 20.9 dB — the constraint
    { loudness: -10, peak: 0.99 }, // crest 9.9 dB
  ];
  const { gains, loudness } = app.solveGains(measures, { ceiling: -1 });
  const after = measures.map((m, i) => m.loudness + 20 * Math.log10(gains[i]));
  near(after[0], after[1], 1e-9, 'clips must end up at the same loudness: ');
  near(after[0], loudness, 1e-9, 'and at the loudness reported: ');
  const worst = Math.max(...measures.map((m, i) => m.peak * gains[i]));
  near(worst, Math.pow(10, -1 / 20), 1e-9, 'the loudest peak should sit on the ceiling: ');
});

check('gains: already matched clips are only trimmed for headroom', () => {
  const measures = [
    { loudness: -14, peak: 0.9 },
    { loudness: -14, peak: 0.9 },
  ];
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
      ok(
        m.peak * gains[i] <= limit + 1e-9,
        `clip ${i} of ${JSON.stringify(measures)} peaks at ${(m.peak * gains[i]).toFixed(4)}`,
      );
    });
  }
});

check('gains: one freak clip cannot pull the rest down without limit', () => {
  // A cut that is mostly quiet with a single crash in it sits 38 dB below its
  // own peak. It cannot be matched without clipping whatever we do — the point
  // of the cap is that it cannot take the other songs down with it either.
  const ordinary = [
    { loudness: -12, peak: 0.9 },
    { loudness: -14, peak: 0.85 },
  ];
  const freak = { loudness: -40, peak: Math.pow(10, -2 / 20) };
  const { loudness, short } = app.solveGains([...ordinary, freak]);

  const uncapped = app.LOUDNESS.ceiling - 38;
  ok(loudness > uncapped + 10, `the outlier still set the level (${loudness.toFixed(1)})`);
  near(
    loudness,
    app.LOUDNESS.ceiling - app.LOUDNESS.maxCrest,
    1e-9,
    'the cap should be what decides the level: ',
  );
  eq(short, [2], 'and the outlier is the one left short: ');
});

check('gains: an absurd target is still not allowed to clip', () => {
  const measures = [{ loudness: -20, peak: 0.8 }];
  const { gains, short } = app.solveGains(measures, { target: 0 });
  near(measures[0].peak * gains[0], Math.pow(10, -1 / 20), 1e-9, 'held at the ceiling: ');
  eq(short, [0], 'and reported as not having got there: ');
});

check('gains: near-silence is boosted only so far, and says so', () => {
  const measures = [
    { loudness: -20, peak: 0.8 },
    { loudness: -60, peak: 0.001 },
  ];
  const { gains, short } = app.solveGains(measures);
  eq(short, [1], 'the clip that fell short should be named: ');
  near(20 * Math.log10(gains[1]), app.LOUDNESS.maxBoost, 1e-9, 'held at the boost limit: ');
});

check('gains: an unmeasurable clip is left alone and does not spoil the rest', () => {
  const measures = [
    { loudness: -20, peak: 0.8 },
    { loudness: -Infinity, peak: 0 }, // a silent clip
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
      ok(
        db >= app.LEVEL_SLIDER.min - 1e-9 && db <= app.LEVEL_SLIDER.max + 1e-9,
        `${db.toFixed(1)} dB is outside the slider for ${JSON.stringify(measures)}`,
      );
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
  ok(
    app.MAX_GAIN >= app.dbToGain(app.LEVEL_SLIDER.max),
    'the clamp is tighter than the slider, so the top of the slider would not stick',
  );
});

check('describeLevels: counts what happened, and owns up to what did not', () => {
  eq(app.describeLevels({ matched: 3, short: 0, unmeasured: 0 }), 'Evened out 3 songs');
  eq(app.describeLevels({ matched: 1, short: 0, unmeasured: 0 }), 'Evened out 1 song');
  eq(
    app.describeLevels({ matched: 2, short: 1, unmeasured: 0 }),
    'Evened out 2 songs — one could not come all the way up, so it stays quieter than the rest',
  );
  eq(
    app.describeLevels({ matched: 2, short: 0, unmeasured: 1 }),
    'Evened out 2 songs — one could not be measured and was left as it was',
  );
  eq(
    app.describeLevels({ matched: 2, short: 2, unmeasured: 3 }),
    'Evened out 2 songs — 2 could not come all the way up, so they stay quieter ' +
      'than the rest, and 3 could not be measured and were left as they were',
  );
  eq(
    app.describeLevels({ matched: 0, short: 0, unmeasured: 2 }),
    'Could not measure these songs, so nothing changed',
  );
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
