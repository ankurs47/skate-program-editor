/* Skate Program Editor — audio analysis.
 *
 * Everything here takes samples or a decoded buffer and returns numbers. No
 * DOM, no program state, nothing that needs a browser: beat detection, phrase
 * detection and loudness measurement, plus the small signal helpers they share.
 *
 * That is the whole reason this is its own file. It is the part of the app that
 * is hardest to get right and easiest to test, and keeping it away from the
 * editing and drawing code is what stops the two being read as one thing.
 *
 * Loaded before app.js, which uses these as plain globals — no modules, no
 * build step. Under Node the test suite requires this file directly.
 */
'use strict';

/* --------------------------------------------------------------- helpers */

/**
 * Hold a value between two ends.
 *
 * Lives here rather than in app.js because this file loads first and everything
 * after it can see the result. Note that an inverted range yields the ceiling,
 * which several callers rely on when a clip is shorter than a minimum.
 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ----------------------------------------------------------------- beats */

/* A join sounds wrong for rhythmic reasons far more often than for any other:
   the beats of the two songs don't coincide through the blend, or the cut lands
   in the middle of a bar. Both are usually fixable by moving the cut a second
   or two, which is what this section is for.

   It is deliberately willing to give up. A lot of skating music is rubato — no
   steady pulse to snap to — and tempo detection will happily return a confident
   wrong answer on it. `analyzeBeats` reports a confidence so the caller can
   leave the cut alone instead of moving it somewhere arbitrary.

   Everything here takes samples and returns numbers, so it is testable without
   a browser. */

const BEAT = {
  frame: 1024, // FFT size for the onset envelope, ~23 ms at 44100
  hop: 512, // ~12 ms between envelope samples
  minBpm: 60,
  maxBpm: 200,
  centerBpm: 120, // tempo prior, so 90 is preferred over 45 or 180
  spreadOctaves: 0.9, // width of that prior
  compression: 100, // γ in log(1 + γ|X|): lets quiet onsets count too
  smoothing: 0.4, // seconds of moving average removed from the envelope
  window: 12, // seconds of audio analyzed around a cut
  minConfidence: 0.3, // below this we decline rather than guess
  minOnsets: 0.05, // flux, as a share of frame magnitude, for "notes start here"
  minCoverage: 0.5, // share of the grid's beats that must actually be played
  maxDrift: 0.125, // acceptable beat slip through a blend, in beats
};

/* Running means over a signal turn up three times in the analysis below — the
   local level the onset envelope is measured against, the two widths a lull is
   judged at, and the smoothing before phrase peaks are picked. All three are
   the same prefix-sum trick, so it lives here once. */

/** Prefix sums, so any window's total is one subtraction. */
function prefixSums(values) {
  const sums = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) sums[i + 1] = sums[i] + values[i];
  return sums;
}

/** Mean of `values[i-half .. i+half]`, clipped to the ends of the signal. */
function windowMean(sums, length, i, half) {
  const a = Math.max(0, i - half);
  const b = Math.min(length, i + half + 1);
  return b > a ? (sums[b] - sums[a]) / (b - a) : 0;
}

/** Every `windowMean` at once. */
function movingAverage(values, half) {
  const sums = prefixSums(values);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = windowMean(sums, values.length, i, half);
  return out;
}

/** In-place radix-2 FFT. `re` and `im` must be the same power-of-two length. */
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + half] * cr - im[i + k + half] * ci;
        const bi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Spectral flux: how much energy appeared since the previous frame. Rising
 * energy is what the ear hears as a note starting, so peaks in this signal are
 * note onsets. Magnitudes are log-compressed first, otherwise a quiet passage
 * contributes nothing and the grid drifts away during it.
 *
 * `level` is the mean magnitude of a frame. Flux measured against it says how
 * much of what is playing is *starting* rather than continuing, which is how a
 * held chord — where nothing ever starts — is told apart from music.
 */
/* Both analyses below walk the same overlapping windowed frames and differ only
   in what they do with each spectrum — one measures energy arriving, the other
   names the notes. The walk itself is written once. */

/** How many whole frames of `n` samples, `hop` apart, fit in `length`. */
function frameCount(length, n, hop) {
  return Math.floor((length - n) / hop) + 1;
}

/**
 * Hand each windowed frame's spectrum to `onFrame(re, im, index)`.
 *
 * `re` and `im` are reused between frames, so a caller that wants to keep
 * anything has to copy it out — every caller here reduces to a handful of
 * numbers instead.
 */
function eachSpectrum(samples, n, hop, onFrame) {
  const frames = frameCount(samples.length, n, hop);
  if (frames < 1) return 0;

  const shape = new Float32Array(n);
  for (let i = 0; i < n; i++) shape[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let f = 0; f < frames; f++) {
    const base = f * hop;
    for (let i = 0; i < n; i++) re[i] = samples[base + i] * shape[i];
    im.fill(0);
    fftInPlace(re, im);
    onFrame(re, im, f);
  }
  return frames;
}

function onsetEnvelope(samples, sampleRate) {
  const n = BEAT.frame;
  const hop = BEAT.hop;
  const rate = sampleRate / hop;
  const frames = frameCount(samples.length, n, hop);
  if (frames < 2) return { env: new Float32Array(0), rate, offset: 0, level: 0 };

  const bins = n >> 1;
  const prev = new Float32Array(bins);
  const env = new Float32Array(frames - 1);
  let level = 0;

  eachSpectrum(samples, n, hop, (re, im, f) => {
    let flux = 0;
    let magnitude = 0;
    for (let k = 0; k < bins; k++) {
      const mag = Math.log(1 + BEAT.compression * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      magnitude += mag;
      if (f > 0 && mag > prev[k]) flux += mag - prev[k];
      prev[k] = mag;
    }
    level += magnitude;
    if (f > 0) env[f - 1] = flux;
  });

  // env[i] compares frame i+1 against frame i, so it belongs at that frame's center
  return { env, rate, offset: (hop + n / 2) / sampleRate, level: level / frames };
}

/**
 * Blur by a frame, then subtract a local mean and rectify.
 *
 * The local mean is so that loudness stops mattering — otherwise a loud chorus
 * outvotes a quiet verse and the autocorrelation locks onto the wrong thing.
 *
 * The blur is subtler and matters more. A beat at a steady tempo lands at a
 * different position within the analysis frame each time, because the period is
 * never a whole number of frames, and the flux it produces is split between two
 * frames in a proportion that changes from beat to beat. That makes alternate
 * beats measure weaker, which is a period-two pattern the autocorrelation
 * happily reports as half the real tempo. Spreading each frame into its
 * neighbors restores the beats to roughly equal size.
 */
function flattenEnvelope(env, rate) {
  const blurred = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    blurred[i] =
      0.25 * (i > 0 ? env[i - 1] : 0) + 0.5 * env[i] + 0.25 * (i + 1 < env.length ? env[i + 1] : 0);
  }

  const local = movingAverage(blurred, Math.max(1, Math.round((rate * BEAT.smoothing) / 2)));
  const out = new Float32Array(blurred.length);
  for (let i = 0; i < blurred.length; i++) out[i] = Math.max(0, blurred[i] - local[i]);
  return out;
}

function envAt(env, x) {
  if (x <= 0) return env[0] || 0;
  const i = Math.floor(x);
  if (i >= env.length - 1) return env[env.length - 1] || 0;
  const f = x - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}

/** Mean envelope value at every pulse of a metronome with this period/phase. */
function combScore(env, period, phase) {
  if (period < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let x = phase; x < env.length - 1; x += period) {
    sum += envAt(env, x);
    n++;
  }
  return n ? sum / n : 0;
}

function bestPhaseFor(env, period) {
  const steps = Math.max(12, Math.round(period));
  let score = -1;
  let phase = 0;
  for (let s = 0; s < steps; s++) {
    const candidate = (s / steps) * period;
    const value = combScore(env, period, candidate);
    if (value > score) {
      score = value;
      phase = candidate;
    }
  }
  return { phase, score };
}

/**
 * Autocorrelation of the onset envelope, weighted by a log-normal prior around
 * 120 BPM. The prior is what stops a 90 BPM song being reported as 45 or 180 —
 * every multiple of the true period correlates just as well.
 *
 * Only whole-frame lags are tried. Fractional ones need the envelope
 * interpolated, and interpolation flattens exactly the sharp peaks being
 * correlated — by an amount that depends on the fractional part, so the scan
 * quietly prefers round numbers. All this has to do is find the right
 * neighborhood; refinePeriod gets the actual value.
 *
 * Returns the best lag in envelope frames, or 0 if the range is unusable.
 */
function estimateTempoLag(env, rate) {
  const minLag = Math.max(2, Math.round((rate * 60) / BEAT.maxBpm));
  const maxLag = Math.min(env.length - 2, Math.round((rate * 60) / BEAT.minBpm));
  if (maxLag <= minLag) return 0;

  let best = -Infinity;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < env.length; i++) sum += env[i] * env[i + lag];
    const bpm = (60 * rate) / lag;
    const octaves = Math.log2(bpm / BEAT.centerBpm) / BEAT.spreadOctaves;
    const score = (sum / (env.length - lag)) * Math.exp(-0.5 * octaves * octaves);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

/**
 * Polish the autocorrelation's answer by fitting an actual metronome to it.
 * A metronome is the accurate instrument here: a period half a frame out walks
 * off the beat within a few bars and the score collapses, so the peak is sharp
 * and lands where the music actually is.
 */
function refinePeriod(env, lag) {
  let best = { period: lag, phase: 0, score: -1 };
  for (let step = -150; step <= 150; step++) {
    const period = lag + step * 0.01;
    if (period < 2) continue;
    const { phase, score } = bestPhaseFor(env, period);
    if (score > best.score) best = { period, phase, score };
  }
  return best;
}

/**
 * What a metronome scores here when its period means nothing.
 *
 * Needed because the score at the chosen period is the maximum over dozens of
 * phases, and taking a maximum lifts the number even on formless audio — white
 * noise looked 50% confident before this existed. Unrelated periods get the
 * same free lift, so dividing by them cancels it out.
 *
 * Periods related to `period` by a simple ratio are skipped: half, double and
 * three-halves of a real tempo all fit the music properly, and counting them as
 * the unrelated case buries the very evidence being measured.
 */
function combBaseline(env, rate, period) {
  const minLag = Math.max(2, (rate * 60) / BEAT.maxBpm);
  const maxLag = Math.min(env.length - 2, (rate * 60) / BEAT.minBpm);
  if (maxLag <= minLag) return 0;

  const related = (lag) =>
    [1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3].some((m) => Math.abs(lag / (period * m) - 1) < 0.08);

  const probes = 24;
  const scores = [];
  for (let i = 0; i < probes; i++) {
    const lag = minLag + ((maxLag - minLag) * i) / (probes - 1);
    if (!related(lag)) scores.push(bestPhaseFor(env, lag).score);
  }
  if (scores.length < 4) return 0; // nothing unrelated left to compare against
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Which beat starts the bar. Skating music is nearly always in 4, sometimes in
 * 3, so try both and take whichever puts the strongest onsets on the downbeat —
 * with a thumb on the scale for 4, because 3 fits any 4 by accident often
 * enough to matter.
 */
function findBar(beats) {
  let mean = 0;
  for (const beat of beats) mean += beat.strength;
  mean = beats.length ? mean / beats.length : 0;
  if (mean <= 0) return { meter: 4, offset: 0 };

  let best = { meter: 4, offset: 0, score: -1 };
  for (const meter of [4, 3]) {
    for (let offset = 0; offset < meter; offset++) {
      let sum = 0;
      let n = 0;
      for (let i = offset; i < beats.length; i += meter) {
        sum += beats[i].strength;
        n++;
      }
      const score = (n ? sum / n / mean : 0) * (meter === 3 ? 0.9 : 1);
      if (score > best.score) best = { meter, offset, score };
    }
  }
  return best;
}

/**
 * Find the beat grid in a stretch of mono audio. Beat times are seconds from
 * the start of `samples`.
 *
 * `confidence` combines how much better the grid fits than an unrelated one,
 * whether there are any note onsets to fit, and how much of the grid is
 * actually played. Near 0 means there is no steady pulse here and the grid,
 * which will have been found regardless, should not be acted on.
 */
function analyzeBeats(samples, sampleRate) {
  const nothing = { bpm: 0, period: 0, confidence: 0, meter: 4, beats: [] };
  const raw = onsetEnvelope(samples, sampleRate);
  if (raw.env.length < 8) return nothing;

  const env = flattenEnvelope(raw.env, raw.rate);
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= env.length;
  if (!(mean > 0)) return nothing;

  const lag = estimateTempoLag(env, raw.rate);
  if (!lag) return nothing;
  const fit = refinePeriod(env, lag);
  const baseline = combBaseline(env, raw.rate, fit.period);
  if (fit.score <= 0 || baseline <= 0) return nothing;

  const beats = [];
  for (let x = fit.phase; x < env.length - 1; x += fit.period) {
    beats.push({ t: x / raw.rate + raw.offset, strength: envAt(env, x), downbeat: false });
  }
  if (beats.length < 2) return nothing;

  const bar = findBar(beats);
  beats.forEach((beat, i) => {
    beat.downbeat = (i - bar.offset) % bar.meter === 0;
  });

  // A grid can fit anything. Three things have to hold before we believe it.
  //
  // First, there have to be onsets at all — a sustained chord produces a faint,
  // perfectly periodic flicker from the analysis itself, and it fits a grid
  // beautifully.
  let flux = 0;
  for (let i = 0; i < raw.env.length; i++) flux += raw.env[i];
  flux /= raw.env.length;
  const onsets = raw.level > 0 ? flux / raw.level : 0;

  // Second, most of the grid's beats have to have something on them. Sparse
  // music — a dozen piano notes in twelve seconds — lets a metronome fit a
  // handful of them by chance and score very well for it, and the contrast
  // measure alone rates that as confidently as a drum track. Asking how much of
  // the grid is actually occupied is what tells a pulse from a lucky period.
  const occupied = beats.filter((beat) => beat.strength > mean).length;
  const coverage = occupied / beats.length;

  const period = fit.period / raw.rate;
  return {
    bpm: 60 / period,
    period,
    // Third, the grid has to fit better than an unrelated one.
    confidence:
      clamp((fit.score / baseline - 1) / 2, 0, 1) *
      clamp(onsets / BEAT.minOnsets, 0, 1) *
      clamp(coverage / BEAT.minCoverage, 0, 1),
    coverage,
    meter: bar.meter,
    beats,
  };
}

/**
 * Choose beat-aligned cut points for one join.
 *
 * `out` and `inc` are analyzeBeats results for windows taken around the
 * outgoing clip's end and the incoming clip's start; `cutOut` and `cutIn` say
 * where those cuts currently sit inside those windows. `outRoom` and `incRoom`
 * bound how far each cut may move before its clip runs out of song.
 *
 * Returns how far to move each cut, what to set the blend to, and how much
 * longer or shorter the program becomes as a result. `ok: false` means the
 * join should be left exactly as it is.
 */
/* The two strategies answer the same question in different currencies, so the
   parts that are about the *question* rather than the answer — how far a cut may
   travel, what "declined" looks like, which candidates are in reach — are shared
   between them. Callers cannot tell which ran except by `reason`, and that only
   holds if the shape is built in one place. */

/** The options both join strategies take, with their defaults filled in. */
function joinOptions(opts) {
  const maxShift = opts.maxShift ?? 2.5;
  return {
    maxShift,
    crossfade: Math.max(0, opts.crossfade || 0),
    maxCrossfade: opts.maxCrossfade ?? Infinity,
    outRoom: opts.outRoom || { min: -maxShift, max: maxShift },
    incRoom: opts.incRoom || { min: -maxShift, max: maxShift },
  };
}

/** Candidates whose `key` time is within reach of the cut and the clip's room. */
function reachablePoints(points, cut, room, maxShift, key) {
  return points.filter((p) => {
    const shift = p[key] - cut;
    return shift >= Math.max(-maxShift, room.min) && shift <= Math.min(maxShift, room.max);
  });
}

/**
 * The answer both strategies give when they decline.
 *
 * Every number is zero and the blend comes back exactly as it was: a declined
 * join must leave the edit untouched, which callers check by acting on these
 * fields rather than on `ok` alone.
 */
function declineJoin(reason, crossfade, extra = {}) {
  return {
    ok: false,
    reason,
    endShift: 0,
    startShift: 0,
    crossfade,
    lengthDelta: 0,
    drift: 0,
    tempoMismatch: 0,
    confidence: 0,
    bpm: [0, 0],
    ...extra,
  };
}

function suggestJoin(out, cutOut, inc, cutIn, opts = {}) {
  const { maxShift, crossfade, maxCrossfade, outRoom, incRoom } = joinOptions(opts);
  const minConfidence = opts.minConfidence ?? BEAT.minConfidence;
  const confidence = Math.min(out.confidence || 0, inc.confidence || 0);

  const decline = (reason) =>
    declineJoin(reason, crossfade, {
      confidence,
      bpm: [out.bpm || 0, inc.bpm || 0],
    });

  if (!out.beats || !inc.beats || out.beats.length < 2 || inc.beats.length < 2) {
    return decline('no-beat');
  }
  if (confidence < minConfidence) return decline('no-beat');

  // Songs an octave apart in tempo still line up: every beat of the slower one
  // lands on a beat of the faster.
  let ratio = 1;
  let tempoMismatch = Infinity;
  for (const m of [1, 2, 0.5]) {
    const err = Math.abs((inc.period * m) / out.period - 1);
    if (err < tempoMismatch) {
      tempoMismatch = err;
      ratio = m;
    }
  }

  // With unequal tempos the two grids drift apart across the overlap. This is
  // the mean slip, in beats, per second of blend — so a long blend between
  // songs at different speeds costs more than a short one, and the search
  // shortens the blend on its own rather than needing a special case.
  const incPeriod = inc.period * ratio;
  const driftPerSecond = Math.abs(out.period - incPeriod) / (2 * out.period * out.period);

  const outs = reachablePoints(out.beats, cutOut, outRoom, maxShift, 't');
  const incs = reachablePoints(inc.beats, cutIn, incRoom, maxShift, 't');
  if (!outs.length || !incs.length) return decline('no-room');

  // The blend has to be a whole number of the outgoing song's beats, otherwise
  // the overlap starts off the grid however well the cuts themselves are
  // placed. A hard cut stays a hard cut — that is a deliberate edit, not a
  // mistake to fix.
  const maxOverlap =
    driftPerSecond > 0 ? Math.min(maxCrossfade, BEAT.maxDrift / driftPerSecond) : maxCrossfade;
  let blends = [0];
  if (crossfade > 0) {
    blends = [...new Set([1, 2, out.meter, out.meter * 2])]
      .map((k) => k * out.period)
      .filter((x) => x <= maxOverlap);
    // Even one beat may drift too far. Offer it anyway and let the cost say so:
    // a short blend is still better advice than none.
    if (!blends.length) blends = [Math.min(out.period, maxCrossfade)];
  }

  // Weights are judgment, not physics. Landing on a downbeat is worth roughly
  // a second of movement; keeping the program's length is worth slightly less
  // than that, because the timer is visible and easy to correct elsewhere.
  const cost = (endShift, startShift, blend, lengthDelta, a, b) =>
    (0.8 * (Math.abs(endShift) + Math.abs(startShift))) / maxShift +
    0.7 * Math.abs(lengthDelta) +
    1.0 * ((a.downbeat ? 0 : 1) + (b.downbeat ? 0 : 1)) +
    (0.3 * Math.abs(blend - crossfade)) / Math.max(crossfade, 1) +
    (1.5 * blend * driftPerSecond) / BEAT.maxDrift;

  let best = null;
  for (const a of outs) {
    const endShift = a.t - cutOut;
    for (const b of incs) {
      const startShift = b.t - cutIn;
      for (const blend of blends) {
        // Moving the end out lengthens the program, moving the start in
        // shortens it, and a longer blend eats the difference.
        const lengthDelta = endShift - startShift - (blend - crossfade);
        const score = cost(endShift, startShift, blend, lengthDelta, a, b);
        if (!best || score < best.score) best = { score, endShift, startShift, blend, lengthDelta };
      }
    }
  }
  if (!best) return decline('no-room');

  return {
    ok: true,
    reason: tempoMismatch > 0.06 ? 'tempo-mismatch' : 'aligned',
    endShift: best.endShift,
    startShift: best.startShift,
    crossfade: best.blend,
    lengthDelta: best.lengthDelta,
    drift: best.blend * driftPerSecond,
    tempoMismatch,
    confidence,
    bpm: [out.bpm, inc.bpm],
  };
}

/** Mono samples for a stretch of a buffer, plus where that stretch begins. */
function monoWindow(buffer, from, to) {
  const sr = buffer.sampleRate;
  const a = clamp(Math.floor(from * sr), 0, buffer.length);
  const b = clamp(Math.ceil(to * sr), a, buffer.length);
  const samples = new Float32Array(b - a);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < samples.length; i++) samples[i] += data[a + i];
  }
  if (channels > 1) for (let i = 0; i < samples.length; i++) samples[i] /= channels;
  return { samples, start: a / sr };
}

/** Beat grid around one cut, with the cut expressed in the same time base. */
function beatsAround(buffer, at, opts = {}) {
  const half = (opts.window ?? BEAT.window) / 2;
  const { samples, start } = monoWindow(buffer, at - half, at + half);
  return { beats: analyzeBeats(samples, buffer.sampleRate), cut: at - start };
}

/* --------------------------------------------------------------- phrases */

/* Much skating music has no beat to find. Solo piano especially: the tempo
   pushes and pulls, and there is no grid, so `analyzeBeats` correctly refuses
   to name one. That left the join button with nothing to offer on exactly the
   repertoire skaters use most.

   Rhythm is not the only structure music has, though. A pianist finishes a
   phrase, the sound decays, the next begins — and cutting at one of those
   breaths is what makes a join sound intended rather than accidental. That is
   findable without any tempo at all, from two things: moments where nothing is
   sounding, and moments where the harmony changes.

   This is the second strategy behind the same button, used when the first one
   declines. Pure, like the rest of the analysis. */

const PHRASE = {
  frame: 4096, // ~10.8 Hz bins at 44100 — fine enough to tell semitones apart
  hop: 2048, // ~46 ms
  quiet: 0.12, // seconds; how wide a "nothing is happening" moment is
  context: 1.6, // seconds of surrounding music a lull is judged against
  novelty: 1.5, // seconds either side compared for a change of harmony
  minLull: 0.4, // seconds; shorter than this is a gap between notes, not a breath
  maxLull: 2, // seconds; longer than this is a section break, not a breath
  smooth: 0.15, // seconds of moving average before looking for peaks
  separation: 0.6, // seconds; two breaths closer together than this are one
  minScore: 0.35, // below this a candidate is not really a break at all
  minBlend: 2, // seconds; a short blend is exposed with no beat to carry it
  chromaLow: 200, // Hz; below this the bins are too coarse to name a note
  chromaHigh: 3000, // Hz; above this it is mostly harmonics and noise
  gapWeight: 0.8, // the rest is novelty
};

/**
 * How much of a lull there is at each moment, from 0 to 1.
 *
 * Judged against the surrounding minute or so rather than an absolute level,
 * because a lull in a quiet passage is still a lull. 1 means nothing at all is
 * starting here while the music around it is busy.
 */
function gapScores(env, rate) {
  const n = env.length;
  // One pass of prefix sums serves both widths, which is why this reaches for
  // windowMean rather than movingAverage.
  const sums = prefixSums(env);
  const near = Math.max(1, Math.round((rate * PHRASE.quiet) / 2));
  const far = Math.max(near + 1, Math.round((rate * PHRASE.context) / 2));

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const context = windowMean(sums, n, i, far);
    out[i] = context > 0 ? clamp(1 - windowMean(sums, n, i, near) / context, 0, 1) : 0;
  }
  return out;
}

/** Short-term loudness, sampled at the onset envelope's frame rate. */
function energyEnvelope(samples, sampleRate, rate) {
  const step = Math.max(1, Math.round(sampleRate / rate));
  const count = Math.floor(samples.length / step);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const end = (i + 1) * step;
    let sum = 0;
    for (let j = i * step; j < end; j++) sum += samples[j] * samples[j];
    out[i] = Math.sqrt(sum / step);
  }
  return out;
}

/**
 * Twelve pitch classes per frame, each frame normalized to unit length so two
 * can be compared by angle alone.
 *
 * A longer frame than the beat detector uses: naming a note needs resolution in
 * frequency, where finding an onset needs it in time. Only the middle of the
 * range is counted — below `chromaLow` the bins are wider than a semitone, and
 * above `chromaHigh` there is little but harmonics.
 */
function chromaFrames(samples, sampleRate) {
  const n = PHRASE.frame;
  const hop = PHRASE.hop;
  const rate = sampleRate / hop;
  if (frameCount(samples.length, n, hop) < 1) return { chroma: [], rate, offset: 0 };

  const low = Math.max(1, Math.ceil((PHRASE.chromaLow * n) / sampleRate));
  const high = Math.min(n >> 1, Math.floor((PHRASE.chromaHigh * n) / sampleRate));
  const pitchClass = new Int8Array(high + 1);
  for (let k = low; k <= high; k++) {
    const hz = (k * sampleRate) / n;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    pitchClass[k] = ((midi % 12) + 12) % 12;
  }

  const chroma = [];
  eachSpectrum(samples, n, hop, (re, im) => {
    const bins = new Float32Array(12);
    for (let k = low; k <= high; k++) {
      bins[pitchClass[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    let energy = 0;
    for (let p = 0; p < 12; p++) energy += bins[p] * bins[p];
    energy = Math.sqrt(energy);
    if (energy > 0) for (let p = 0; p < 12; p++) bins[p] /= energy;
    chroma.push(bins);
  });
  return { chroma, rate, offset: n / 2 / sampleRate };
}

/** Angle between two chroma vectors, 0 for identical and 1 for unrelated. */
function chromaDistance(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let p = 0; p < 12; p++) {
    dot += a[p] * b[p];
    na += a[p] * a[p];
    nb += b[p] * b[p];
  }
  // Nothing sounding on one side is not a change of harmony, it is silence —
  // and the gap score is the right instrument for that. Reporting a change here
  // made every moment of a silent passage look like a phrase boundary.
  if (na <= 0 || nb <= 0) return 0;
  return clamp(1 - dot / Math.sqrt(na * nb), 0, 1);
}

/**
 * How much the harmony changes at each moment, from 0 to 1: the distance
 * between the chord before and the chord after. This catches the phrase
 * boundaries that are not quiet — where the music simply moves somewhere else.
 */
function noveltyScores(chroma, rate) {
  const n = chroma.length;
  const out = new Float32Array(n);
  if (!n) return out;
  const span = Math.max(1, Math.round(rate * PHRASE.novelty));

  // running sums per pitch class, so each window mean is a subtraction
  const sums = [];
  for (let p = 0; p < 12; p++) sums.push(new Float64Array(n + 1));
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < 12; p++) sums[p][i + 1] = sums[p][i] + chroma[i][p];
  }
  const window = (from, to) => {
    const a = clamp(from, 0, n);
    const b = clamp(to, a, n);
    const mean = new Float32Array(12);
    if (b === a) return mean;
    let energy = 0;
    for (let p = 0; p < 12; p++) {
      mean[p] = (sums[p][b] - sums[p][a]) / (b - a);
      energy += mean[p] * mean[p];
    }
    energy = Math.sqrt(energy);
    if (energy > 0) for (let p = 0; p < 12; p++) mean[p] /= energy;
    return mean;
  };

  for (let i = 0; i < n; i++) {
    out[i] = chromaDistance(window(i - span, i), window(i, i + span));
  }
  return out;
}

/**
 * Places in a stretch of audio where the music takes a breath.
 *
 * Each point carries `t`, the middle of the lull — where an outgoing clip
 * should stop — and `resumes`, where the music picks up again, which is where
 * an incoming clip should start so it does not open with silence.
 */
function phrasePoints(samples, sampleRate) {
  const raw = onsetEnvelope(samples, sampleRate);
  if (raw.env.length < 8) return [];
  const env = flattenEnvelope(raw.env, raw.rate);

  /* A lull needs two things, and the onset envelope only knows one of them.
     Between two notes of a phrase nothing is starting either — what separates
     that from the end of a phrase is that here the sound has died away, and
     there it is still ringing. Taking the smaller of the two scores means a
     break has to be both: nothing beginning, and nothing still sounding. */
  const rms = energyEnvelope(samples, sampleRate, raw.rate);
  const quietOnsets = gapScores(env, raw.rate);
  const quietSound = gapScores(rms, raw.rate);
  const shift = Math.round(raw.offset * raw.rate);
  const gaps = new Float32Array(quietOnsets.length);
  for (let i = 0; i < gaps.length; i++) {
    const j = clamp(i + shift, 0, quietSound.length - 1);
    gaps[i] = quietSound.length ? Math.min(quietOnsets[i], quietSound[j]) : quietOnsets[i];
  }

  // "The music resumes" means the next note actually starts, not the point
  // where the lull's score happens to tail off.
  let busy = 0;
  for (let i = 0; i < env.length; i++) busy += env[i];
  busy = (busy / Math.max(1, env.length)) * 0.6;

  const { chroma, rate: chromaRate, offset: chromaOffset } = chromaFrames(samples, sampleRate);
  const novelty = noveltyScores(chroma, chromaRate);

  const at = (i) => {
    const t = i / raw.rate + raw.offset;
    if (!novelty.length) return 0;
    const j = clamp(Math.round((t - chromaOffset) * chromaRate), 0, novelty.length - 1);
    return novelty[j];
  };

  // Novelty can promote a shallow lull that happens to be a real turning point,
  // but it must never carry a candidate on its own: with `minScore` above the
  // novelty weight, a change of harmony in the middle of a continuous line
  // scores too low to qualify. Cutting there chops the line in half, which is
  // precisely the thing this is meant to avoid.
  const score = new Float32Array(gaps.length);
  for (let i = 0; i < gaps.length; i++) {
    score[i] = PHRASE.gapWeight * gaps[i] + (1 - PHRASE.gapWeight) * at(i);
  }

  // Peak-pick on a smoothed curve. Frame-to-frame wobble in the envelope
  // otherwise yields hundreds of "boundaries" a few milliseconds apart, which
  // is the same as having none.
  const smooth = movingAverage(score, Math.max(1, Math.round((raw.rate * PHRASE.smooth) / 2)));

  const points = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] < PHRASE.minScore) continue;
    if (smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1]) continue;
    // Measure how long the lull lasts, in both directions. This is what tells a
    // breath between phrases from the ordinary gap between two notes — a
    // pianist's phrase ending leaves half a second or more, where notes within
    // a line are a couple of hundred milliseconds apart. Without it, cuts
    // landed in the middle of a phrase on the strength of one such gap.
    const floor = Math.max(gaps[i] * 0.5, 0.05);
    const reach = Math.round(raw.rate * PHRASE.maxLull);
    let begin = i;
    while (begin - 1 >= Math.max(0, i - reach) && gaps[begin - 1] >= floor) begin--;
    let end = i;
    const limit = Math.min(env.length - 1, i + reach);
    while (end + 1 <= limit && env[end + 1] <= busy) end++;
    if ((end - begin) / raw.rate < PHRASE.minLull) continue;

    points.push({
      t: i / raw.rate + raw.offset,
      resumes: end / raw.rate + raw.offset,
      score: smooth[i],
      gap: gaps[i],
      lull: (end - begin) / raw.rate,
      novelty: at(i),
    });
  }

  // One breath, one point: keep the best of any cluster. A phrase boundary is
  // an event, not a region, and the join search should not be choosing between
  // forty descriptions of the same pause.
  const kept = [];
  for (const point of [...points].sort((a, b) => b.score - a.score)) {
    if (kept.every((other) => Math.abs(other.t - point.t) >= PHRASE.separation)) {
      kept.push(point);
    }
  }
  return kept.sort((a, b) => a.t - b.t);
}

/**
 * Choose cut points at phrase boundaries, for music with no beat to snap to.
 *
 * Same shape of answer as `suggestJoin`, so the caller does not care which
 * strategy produced it. The outgoing clip stops where its phrase died away;
 * the incoming one starts where its next phrase picks up.
 */
function suggestPhraseJoin(out, cutOut, inc, cutIn, opts = {}) {
  const { maxShift, crossfade, maxCrossfade, outRoom, incRoom } = joinOptions(opts);
  const decline = (reason) => declineJoin(reason, crossfade);
  if (!out.length || !inc.length) return decline('no-phrase');

  // The outgoing clip stops where its phrase died away; the incoming one starts
  // where the next picks up, which is a different instant in the same lull.
  const outs = reachablePoints(out, cutOut, outRoom, maxShift, 't');
  const incs = reachablePoints(inc, cutIn, incRoom, maxShift, 'resumes');
  if (!outs.length || !incs.length) return decline('no-room');

  // With no beat, a blend has nothing to drift out of — and a short one over
  // free tempo is the most exposed a join can be. A hard cut stays a hard cut.
  const blend = crossfade > 0 ? Math.min(Math.max(crossfade, PHRASE.minBlend), maxCrossfade) : 0;

  let best = null;
  for (const a of outs) {
    const endShift = a.t - cutOut;
    for (const b of incs) {
      const startShift = b.resumes - cutIn;
      const lengthDelta = endShift - startShift - (blend - crossfade);
      const cost =
        1.2 * (1 - a.score + (1 - b.score)) +
        (0.8 * (Math.abs(endShift) + Math.abs(startShift))) / maxShift +
        0.7 * Math.abs(lengthDelta);
      if (!best || cost < best.cost) best = { cost, endShift, startShift, lengthDelta, a, b };
    }
  }

  return {
    ok: true,
    reason: 'phrase',
    endShift: best.endShift,
    startShift: best.startShift,
    crossfade: blend,
    lengthDelta: best.lengthDelta,
    drift: 0,
    tempoMismatch: 0,
    confidence: Math.min(best.a.score, best.b.score),
    bpm: [0, 0],
  };
}

/** Mono samples around one cut, with the cut expressed in the same time base. */
function windowAround(buffer, at, opts = {}) {
  const half = (opts.window ?? BEAT.window) / 2;
  const { samples, start } = monoWindow(buffer, at - half, at + half);
  return { samples, sampleRate: buffer.sampleRate, cut: at - start };
}

/**
 * The join button's whole decision, from the two buffers either side.
 *
 * Beats first, because a shared pulse is the strongest thing two pieces of
 * music can have in common. When there isn't one — rubato piano, a free-time
 * introduction, most of the orchestral repertoire — fall back to phrasing
 * rather than giving up, which is what this used to do.
 */
function suggestJoinForBuffers(outBuffer, cutOut, incBuffer, cutIn, opts = {}) {
  const a = windowAround(outBuffer, cutOut, opts);
  const b = windowAround(incBuffer, cutIn, opts);

  const beat = suggestJoin(
    analyzeBeats(a.samples, a.sampleRate),
    a.cut,
    analyzeBeats(b.samples, b.sampleRate),
    b.cut,
    opts,
  );
  if (beat.ok || beat.reason !== 'no-beat') return beat;

  return suggestPhraseJoin(
    phrasePoints(a.samples, a.sampleRate),
    a.cut,
    phrasePoints(b.samples, b.sampleRate),
    b.cut,
    opts,
  );
}

/**
 * What to say afterwards, in one sentence.
 *
 * The change itself is visible — the waveform, the blocks and the timer all
 * move — so this says the part that isn't: whether it worked, and what it cost
 * in program length, because that is the number being worked to.
 */
function describeJoin(result, wasCrossfade) {
  if (!result.ok) {
    return (
      {
        'no-room': 'Not enough song either side to move the cut, so nothing changed',
        'no-beat': 'No steady beat to line up with here, so nothing changed',
      }[result.reason] || 'Could not find a natural break in the music, so nothing changed'
    );
  }

  const changed =
    Math.abs(result.endShift) >= 0.05 ||
    Math.abs(result.startShift) >= 0.05 ||
    Math.abs(result.crossfade - wasCrossfade) >= 0.05;
  if (!changed) {
    return result.reason === 'phrase'
      ? 'This join is already at a natural break'
      : 'This join is already on the beat';
  }

  const delta = result.lengthDelta;
  const length =
    Math.abs(delta) < 0.05
      ? 'Same length as before'
      : `Program is ${Math.abs(delta).toFixed(1)}s ${delta > 0 ? 'longer' : 'shorter'}`;
  const lead =
    {
      'tempo-mismatch': 'Lined up as closely as these two speeds allow',
      // Saying which of the two things happened matters: it says the music
      // has no steady beat, which is why the advice for it is different.
      phrase: 'No steady beat here, so the cut moved to where the phrase ends',
    }[result.reason] || 'Lined up with the beat';
  return `${lead}. ${length}`;
}

/* -------------------------------------------------------------- loudness */

/* Songs cut from different records arrive at wildly different levels. A
   remastered single can sit 15 dB above an orchestral recording that peaks
   just as high, and at a rink — where the desk is set once and left alone —
   that is the difference between a program you can hear and one you cannot.

   Loudness here means ITU-R BS.1770 integrated loudness. Not peak, which says
   nothing about how loud something sounds, and not plain RMS, which over-reads
   anything with weight in the bass. The extra work over RMS is one filter and
   one gating rule; both earn their place, and both are in the traps list.

   Pure: takes channels of samples, returns numbers. */

const LOUDNESS = {
  block: 0.4, // seconds per measurement block
  step: 0.1, // block spacing, so blocks overlap by 75%
  absoluteGate: -70, // LUFS; below this a block is silence, not quiet music
  relativeGate: -10, // LU below the ungated mean
  offset: -0.691, // BS.1770 calibration, so 1 kHz reads its own level
  ceiling: -1, // dBFS left free, because sample peaks understate the real ones
  // Quiet classical masters really do sit 25 dB below a pop single, so this has
  // to be generous or the very case the feature exists for gets refused. Its
  // job is only to decline near-silence, which needs far more than this.
  maxBoost: 24, // dB
  maxCrest: 22, // dB of peak above loudness; beyond this a clip is an outlier
};

/**
 * The two K-weighting biquads: a shelf that lifts everything above ~1.7 kHz,
 * and a high pass at ~38 Hz.
 *
 * BS.1770 tabulates its coefficients at 48 kHz only, and everything here is
 * decoded to 44100, so they have to be derived rather than copied. These are
 * the prototype values the published table comes from — a test checks that
 * passing 48000 reproduces that table.
 */
function kWeighting(sampleRate) {
  const shelfHz = 1681.974450955533;
  const shelfGain = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * shelfHz) / sampleRate);
  const vh = Math.pow(10, shelfGain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const d1 = 1 + k1 / shelfQ + k1 * k1;

  const highHz = 38.13547087602444;
  const highQ = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * highHz) / sampleRate);
  const d2 = 1 + k2 / highQ + k2 * k2;

  return {
    shelf: {
      b0: (vh + (vb * k1) / shelfQ + k1 * k1) / d1,
      b1: (2 * (k1 * k1 - vh)) / d1,
      b2: (vh - (vb * k1) / shelfQ + k1 * k1) / d1,
      a1: (2 * (k1 * k1 - 1)) / d1,
      a2: (1 - k1 / shelfQ + k1 * k1) / d1,
    },
    // The standard leaves this stage's numerator at exactly 1, −2, 1.
    highpass: {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (k2 * k2 - 1)) / d2,
      a2: (1 - k2 / highQ + k2 * k2) / d2,
    },
  };
}

/** One biquad, transposed direct form II, applied in place. */
function biquad(samples, c) {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = c.b0 * x + s1;
    s1 = c.b1 * x - c.a1 * y + s2;
    s2 = c.b2 * x - c.a2 * y;
    samples[i] = y;
  }
}

/**
 * Integrated loudness in LUFS, or -Infinity for silence and for anything too
 * short to hold a single 400 ms block.
 *
 * `channels` is an array of Float32Array. A mono source counts double, because
 * Web Audio sends it to both speakers on playback — measured as one channel it
 * would come out 3 dB quiet and every mono file would end up too loud.
 */
function loudnessOf(channels, sampleRate) {
  const used = channels.slice(0, 2);
  if (!used.length) return -Infinity;
  const weight = used.length === 1 ? 2 : 1;

  const sub = Math.round(LOUDNESS.step * sampleRate);
  const per = Math.round(LOUDNESS.block / LOUDNESS.step);
  const length = Math.min(...used.map((c) => c.length));
  const count = Math.floor(length / sub);
  if (sub < 1 || count < per) return -Infinity;

  const coefficients = kWeighting(sampleRate);
  const sums = new Float64Array(count);
  for (const channel of used) {
    // Copy before filtering: biquad works in place, and these samples belong to
    // the decoded audio everything else is playing from.
    const y = Float32Array.from(channel.subarray(0, count * sub));
    biquad(y, coefficients.shelf);
    biquad(y, coefficients.highpass);
    for (let s = 0; s < count; s++) {
      const end = (s + 1) * sub;
      let acc = 0;
      for (let i = s * sub; i < end; i++) acc += y[i] * y[i];
      sums[s] += weight * acc;
    }
  }

  // At 75% overlap every 400 ms block is four consecutive 100 ms sums, so the
  // overlapping blocks cost nothing beyond the additions.
  const size = per * sub;
  const blocks = [];
  for (let j = 0; j + per <= count; j++) {
    let power = 0;
    for (let k = 0; k < per; k++) power += sums[j + k];
    blocks.push(power / size);
  }

  const level = (power) => LOUDNESS.offset + 10 * Math.log10(power);
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;

  // Silence is not quiet music: without this gate a cut that ends in a long
  // fade measures far below what anyone hears, and gets boosted for it.
  const heard = blocks.filter((p) => p > 0 && level(p) > LOUDNESS.absoluteGate);
  if (!heard.length) return -Infinity;

  // Nor is a genuinely quiet passage of the same piece — the second gate keeps
  // the reading on the body of the music rather than its softest moments.
  const threshold = level(mean(heard)) + LOUDNESS.relativeGate;
  const kept = heard.filter((p) => level(p) > threshold);
  if (!kept.length) return -Infinity;
  return level(mean(kept));
}

/** Largest absolute sample across all channels, 0 to 1. */
function peakOf(channels) {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Loudness and peak of the kept part of a clip — not of the whole file. */
function measureClip(buffer, from, to) {
  const sr = buffer.sampleRate;
  const a = clamp(Math.floor(from * sr), 0, buffer.length);
  const b = clamp(Math.ceil(to * sr), a, buffer.length);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).subarray(a, b));
  }
  return { loudness: loudnessOf(channels, sr), peak: peakOf(channels) };
}

/**
 * Gains that put every clip at the same loudness, as loud as the material
 * allows without clipping.
 *
 * There is no fixed target. The clip with the widest gap between its peak and
 * its loudness — the most dynamic one — runs out of headroom first, so it sets
 * the level for everyone else. That is the loudest the program can be while
 * staying both matched and clean, and it means a program of quiet orchestral
 * cuts is not dragged down to the level of its quietest moment.
 *
 * `maxCrest` stops one freak clip doing exactly that. A cut that is mostly
 * quiet with a single bang in it can sit 38 dB below its own peak, and letting
 * it set the level would drag three ordinary songs down with it. Past that
 * point the clip is the outlier, so it is the one that stays quiet.
 *
 * No clip can be pushed past the ceiling: each one's gain is capped by its own
 * headroom, so a clip that cannot reach the target simply does not, and the
 * others are unaffected. Returns a gain per input clip, in the order given,
 * and the indices of any that fell short.
 */
function solveGains(measures, opts = {}) {
  const ceiling = opts.ceiling ?? LOUDNESS.ceiling;
  const maxBoost = opts.maxBoost ?? LOUDNESS.maxBoost;
  const maxCrest = opts.maxCrest ?? LOUDNESS.maxCrest;
  const measured = (m) => isFinite(m.loudness) && m.peak > 0;

  const usable = measures.filter(measured);
  if (!usable.length) return { gains: measures.map(() => 1), loudness: -Infinity, short: [] };

  const crest = (m) => 20 * Math.log10(m.peak) - m.loudness;
  const loudness = opts.target ?? ceiling - Math.min(maxCrest, Math.max(...usable.map(crest)));

  const short = [];
  const gains = measures.map((m, i) => {
    if (!measured(m)) return 1; // nothing to measure — leave it alone
    const wanted = loudness - m.loudness;
    // Two things stop a clip reaching the target: its own peaks would go over
    // the ceiling, or it is so quiet that we would be raising hiss rather than
    // music. Either way it stays put instead of pulling the others down.
    const headroom = ceiling - 20 * Math.log10(m.peak);
    const allowed = Math.min(wanted, headroom, maxBoost);
    if (allowed < wanted - 1e-9) short.push(i);
    return Math.pow(10, allowed / 20);
  });

  return { gains, loudness, short };
}

/* The slider works in decibels because that is what tracks how loud a change
   sounds — half the travel is half the change, which is not true of a plain
   multiplier. The number beside it is a percentage, because that is what a
   skater reads without being taught anything. */

const LEVEL_SLIDER = { min: -24, max: 24, step: 0.5 };

function gainToDb(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : LEVEL_SLIDER.min;
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/** A clip's level as a percentage of the recording's own volume. */
function levelPercent(gain) {
  return Math.round(gain * 100);
}

/** One plain sentence for what evening out the volume did. */
function describeLevels({ matched, short, unmeasured }) {
  if (!matched) return 'Could not measure these songs, so nothing changed';
  const notes = [];
  if (short) {
    notes.push(
      short === 1
        ? 'one could not come all the way up, so it stays quieter than the rest'
        : `${short} could not come all the way up, so they stay quieter than the rest`,
    );
  }
  if (unmeasured) {
    notes.push(
      unmeasured === 1
        ? 'one could not be measured and was left as it was'
        : `${unmeasured} could not be measured and were left as they were`,
    );
  }
  const head = `Evened out ${matched} song${matched === 1 ? '' : 's'}`;
  return notes.length ? `${head} — ${notes.join(', and ')}` : head;
}

/* Under Node — the test suite — hand the pure logic over. In a browser these
   are already global and this block does nothing. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clamp,
    movingAverage,
    frameCount,
    BEAT,
    fftInPlace,
    onsetEnvelope,
    flattenEnvelope,
    estimateTempoLag,
    analyzeBeats,
    suggestJoin,
    monoWindow,
    beatsAround,
    suggestJoinForBuffers,
    describeJoin,
    PHRASE,
    gapScores,
    energyEnvelope,
    chromaFrames,
    chromaDistance,
    noveltyScores,
    phrasePoints,
    suggestPhraseJoin,
    windowAround,
    LOUDNESS,
    kWeighting,
    biquad,
    loudnessOf,
    peakOf,
    measureClip,
    solveGains,
    gainToDb,
    dbToGain,
    levelPercent,
    describeLevels,
    LEVEL_SLIDER,
  };
}
