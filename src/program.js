/* What a program is, with no reference to the page it is shown on.
 *
 * Clip geometry, the event length tables, fade and crossfade envelopes, the
 * arithmetic behind a join, and reading a project file back. Everything here
 * is a function of its arguments, which is why almost all of the unit tests
 * point at this file.
 *
 * Like analysis.js and formats.js it touches no DOM, and a test holds it to
 * that: the rules of a program do not change because a button moved.
 */
'use strict';

const SR = 44100;
const MIN_CROSSFADE = 0.01;
const MIN_CLIP = 0.1; // the shortest a clip may be trimmed to, in seconds
/* One list, two shapes: the file picker wants extensions with dots, and the
   drop handler wants something to test a name against. */
const AUDIO_EXTENSION_LIST = [
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.ogg',
  '.opus',
  '.aac',
  '.webm',
  '.aif',
  '.aiff',
];
const AUDIO_EXTENSIONS = new RegExp(
  `(${AUDIO_EXTENSION_LIST.map((e) => `\\${e}`).join('|')})$`,
  'i',
);
const MAX_GAIN = 16; // a shade over the +24 dB the level slider reaches

/* ---------------------------------------------------------------------------
 * PROGRAM LENGTHS — CHECK THESE AGAINST THE CURRENT RULEBOOK
 *
 * Competition lengths are set by the ISU and U.S. Figure Skating and they do
 * change between seasons. This table is a convenience, not an authority. The
 * dropdown always shows the time beside the level name so a wrong number is
 * visible rather than hidden behind a label.
 *
 * To correct one, edit `seconds` here — nothing else refers to these values.
 * Times are m:ss; `tol` is the allowed variance in seconds either way.
 * ------------------------------------------------------------------------- */
const LEVELS = [
  {
    group: 'ISU — Singles',
    items: [
      { id: 'isu-sr-sp', label: 'Senior Short Program', seconds: 160, tol: 10 },
      { id: 'isu-sr-fs', label: 'Senior Free Skate', seconds: 240, tol: 10 },
      { id: 'isu-jr-sp', label: 'Junior Short Program', seconds: 160, tol: 10 },
      { id: 'isu-jr-fs', label: 'Junior Free Skate', seconds: 210, tol: 10 },
      { id: 'isu-adv-nov-sp', label: 'Advanced Novice Short Program', seconds: 140, tol: 10 },
      { id: 'isu-adv-nov-fs', label: 'Advanced Novice Free Skate', seconds: 180, tol: 10 },
      { id: 'isu-int-nov-fs', label: 'Intermediate Novice Free Skate', seconds: 180, tol: 10 },
      { id: 'isu-bas-nov-fs', label: 'Basic Novice Free Skate', seconds: 150, tol: 10 },
    ],
  },
  {
    group: 'ISU — Pairs',
    items: [
      { id: 'isu-pr-sr-sp', label: 'Senior Pairs Short Program', seconds: 160, tol: 10 },
      { id: 'isu-pr-sr-fs', label: 'Senior Pairs Free Skate', seconds: 240, tol: 10 },
      { id: 'isu-pr-jr-sp', label: 'Junior Pairs Short Program', seconds: 160, tol: 10 },
      { id: 'isu-pr-jr-fs', label: 'Junior Pairs Free Skate', seconds: 210, tol: 10 },
    ],
  },
  {
    group: 'ISU — Ice Dance',
    items: [
      { id: 'isu-id-sr-rd', label: 'Senior Rhythm Dance', seconds: 170, tol: 10 },
      { id: 'isu-id-sr-fd', label: 'Senior Free Dance', seconds: 240, tol: 10 },
      { id: 'isu-id-jr-rd', label: 'Junior Rhythm Dance', seconds: 170, tol: 10 },
      { id: 'isu-id-jr-fd', label: 'Junior Free Dance', seconds: 210, tol: 10 },
    ],
  },
  {
    group: 'U.S. Figure Skating — Free Skate',
    items: [
      { id: 'usfs-prelim', label: 'Preliminary', seconds: 90, tol: 10 },
      { id: 'usfs-pre-juv', label: 'Pre-Juvenile', seconds: 105, tol: 10 },
      { id: 'usfs-juv', label: 'Juvenile', seconds: 135, tol: 10 },
      { id: 'usfs-int', label: 'Intermediate', seconds: 160, tol: 10 },
      { id: 'usfs-nov', label: 'Novice', seconds: 180, tol: 10 },
      { id: 'usfs-jr', label: 'Junior', seconds: 210, tol: 10 },
      { id: 'usfs-sr', label: 'Senior', seconds: 240, tol: 10 },
    ],
  },
  {
    group: 'U.S. Figure Skating — Short Program',
    items: [
      { id: 'usfs-nov-sp', label: 'Novice Short Program', seconds: 160, tol: 10 },
      { id: 'usfs-jr-sp', label: 'Junior Short Program', seconds: 160, tol: 10 },
      { id: 'usfs-sr-sp', label: 'Senior Short Program', seconds: 160, tol: 10 },
    ],
  },
];

const CUSTOM_LEVEL = 'custom';

function allLevels() {
  return LEVELS.flatMap((g) => g.items);
}

function findLevel(id) {
  return allLevels().find((l) => l.id === id) || null;
}

/* Both of these round to the precision they display *before* splitting the
   minutes off, not after. Rounding afterwards means a value that comes to 60
   once rounded is shown as sixty seconds rather than carried: 59.98 read as
   "0:60.0" on the program timer, and a 119.6 second song listed as "1:60". */

function fmt(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const tenths = Math.round(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function fmtShort(seconds) {
  const whole = isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const m = Math.floor(whole / 60);
  return `${m}:${String(whole - m * 60).padStart(2, '0')}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/* ------------------------------------------------------------------ layout */

function clipDuration(clip) {
  return Math.max(0, clip.srcEnd - clip.srcStart);
}

/**
 * A clip's level as a plain multiplier. Anything missing, negative or absurd
 * becomes 1 — a hand-edited project file must not be able to silence the
 * program or blow the speakers.
 */
function clipGain(clip) {
  const gain = clip ? clip.gain : undefined;
  // Checked as a number before anything else: `Number(null)` is 0, so coercing
  // first would read a null in a project file as "silent" rather than "absent".
  return typeof gain === 'number' && isFinite(gain) && gain >= 0 ? clamp(gain, 0, MAX_GAIN) : 1;
}

/** Overlap between clip i and the one before it, clamped to fit both. */
function crossfadeOf(clips, i) {
  if (i === 0) return 0;
  const x = Math.max(0, clips[i].crossfade || 0);
  return Math.min(x, clipDuration(clips[i]), clipDuration(clips[i - 1]));
}

/** Timeline start of every clip, plus the total program length. */
function layout(clips) {
  const parts = [];
  let t = 0;
  clips.forEach((clip, i) => {
    if (i) t += clipDuration(clips[i - 1]) - crossfadeOf(clips, i);
    parts.push({ start: t, dur: clipDuration(clip), xf: crossfadeOf(clips, i) });
  });
  const total = parts.length ? parts[parts.length - 1].start + parts[parts.length - 1].dur : 0;
  return { parts, total };
}

/* ------------------------------------------------------------- envelopes */

/**
 * Piecewise-linear breakpoints for something that rises, holds, and falls.
 *
 * Both envelopes a clip has are this shape, and they were written out twice.
 * Keeping one copy is what makes the property the whole crossfade rests on —
 * that the two sides sum to 1 through the overlap — a single thing to reason
 * about rather than two that have to be kept in step.
 *
 * A rise and a fall that would overlap meet in the middle instead, so the
 * breakpoints stay in order and the level never exceeds 1.
 */
function rampEnvelope(dur, rise, fall) {
  const up = clamp(rise, 0, dur);
  const down = clamp(fall, 0, dur);
  const points = [[0, up > 0 ? 0 : 1]];
  if (up > 0) points.push([up, 1]);
  if (down > 0) {
    points.push([Math.max(up, dur - down), 1], [dur, 0]);
  } else {
    points.push([dur, 1]);
  }
  return points;
}

/** Breakpoints for a clip's intrinsic fades. */
function fadeEnvelope(clip) {
  return rampEnvelope(clipDuration(clip), clip.fadeIn || 0, clip.fadeOut || 0);
}

/** Breakpoints for the crossfade with the previous and next clips. */
function crossfadeEnvelope(clips, i) {
  return rampEnvelope(
    clipDuration(clips[i]),
    crossfadeOf(clips, i),
    i + 1 < clips.length ? crossfadeOf(clips, i + 1) : 0,
  );
}

function valueAt(points, t) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return t1 === t0 ? v1 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
    }
  }
  return points[points.length - 1][1];
}

/* ----------------------------------------------------------------- peaks */

function computePeaks(buffer, buckets = 5000) {
  const n = buffer.length;
  const step = Math.max(1, Math.floor(n / buckets));
  const count = Math.ceil(n / step);
  const peaks = new Float32Array(count * 2);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < count; i++) {
    const s = i * step;
    const e = Math.min(n, s + step);
    let mn = 1,
      mx = -1;
    for (const data of channels) {
      for (let j = s; j < e; j++) {
        const v = data[j];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    peaks[i * 2] = mn;
    peaks[i * 2 + 1] = mx;
  }
  return peaks;
}

/* --------------------------------------------------------------- library */

/**
 * Bring clips back inside a file that has just been decoded.
 *
 * A project records trims but not the audio, so until the file actually arrives
 * nothing has checked those numbers against a real duration. If the file turns
 * out shorter than the project expects — a different copy of the song, a fresh
 * download, a hand-edited project — the clip is claiming time that does not
 * exist. Web Audio plays silence past the end rather than failing, so the strip
 * shows a duration that is a lie and the finished program comes out the wrong
 * length with nothing said about it.
 *
 * Mutates the clips it has to, and returns how many that was.
 */
function clampClipsToFile(clips, entry) {
  const duration = entry.duration;
  let changed = 0;
  for (const clip of clips) {
    if (clip.file !== entry.name) continue;
    const start = clamp(clip.srcStart, 0, Math.max(0, duration - MIN_CLIP));
    const end = clamp(clip.srcEnd, start + MIN_CLIP, duration);
    if (start === clip.srcStart && end === clip.srcEnd) continue;
    clip.srcStart = start;
    clip.srcEnd = end;
    changed++;
  }
  return changed;
}

/**
 * The clip list with one clip moved, or null if that is not a real move.
 *
 * Both indices are checked, not just the destination. `fromIndex` arrives from
 * a drag's data transfer, so it is whatever the browser was carrying, and every
 * comparison against NaN is false — a destination-only check let it straight
 * through, and `splice(NaN, 1)` coerces to `splice(0, 1)`.
 *
 * Pure: the list handed in, and the clips in it, come back untouched.
 */
function reordered(clips, fromIndex, toIndex) {
  const valid = (i) => Number.isInteger(i) && i >= 0 && i < clips.length;
  if (!valid(fromIndex) || !valid(toIndex) || fromIndex === toIndex) return null;
  const next = clips.slice();
  const [clip] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, clip);
  return next;
}

/* Enough music either side to hear the join in context. Four seconds is about
   two bars at a walking tempo — long enough to have settled into the first song
   before it hands over, short enough not to be a wait. */
const JOIN_PREVIEW = { lead: 4, tail: 4 };

/**
 * The stretch of program time to play when auditioning one join.
 *
 * The join is where clip `i` begins; the blend, if there is one, runs on from
 * there, so the tail is measured from the end of the overlap rather than from
 * the cut. Returns null when there is no join — the first clip has nothing
 * before it.
 */
function joinPreviewRange(clips, i, opts = {}) {
  if (!(i > 0) || i >= clips.length) return null;
  const lead = opts.lead ?? JOIN_PREVIEW.lead;
  const tail = opts.tail ?? JOIN_PREVIEW.tail;
  const { parts, total } = layout(clips);
  const at = parts[i].start;
  return {
    from: Math.max(0, at - lead),
    until: Math.min(total, at + parts[i].xf + tail),
  };
}

/** How far a join's two cuts may move without eating a clip whole. */
function joinRoom(clip, entry, side) {
  const keep = 0.5;
  return side === 'end'
    ? {
        min: Math.min(0, keep - clipDuration(clip)),
        max: Math.max(0, entry.duration - clip.srcEnd),
      }
    : { min: Math.min(0, -clip.srcStart), max: Math.max(0, clipDuration(clip) - keep) };
}

/**
 * Read a saved project document into the state it describes.
 *
 * Pure — no DOM, nothing global touched — because this is the contract with
 * every project anyone has already saved, and `loadProject` could not be
 * checked at all while the parsing and the wiring were the same function.
 * Anything absent or nonsense falls back to something usable rather than
 * throwing: a project file is a plain text document people do edit by hand.
 *
 * `retargeted` names the level whose length no longer matches the stored time,
 * for the caller to mention. It is not an error — the stored time is the one
 * that wins.
 */
function readProject(data) {
  // The stored time wins over the level's current table value, so reopening an
  // old program never silently retargets it because a rulebook number changed.
  const targetSeconds = data.targetSeconds || 135;
  let levelId = data.level || CUSTOM_LEVEL;
  const level = findLevel(levelId);
  const retargeted = level && level.seconds !== targetSeconds ? level : null;
  if (retargeted) levelId = CUSTOM_LEVEL;

  return {
    name: data.name || 'my program',
    level: levelId,
    targetSeconds,
    toleranceSeconds: data.toleranceSeconds || 10,
    retargeted,
    // Absent in projects written before this existed, which is fine: without a
    // record of what the songs were, nothing is claimed about them.
    files: Array.isArray(data.files) ? data.files.filter((f) => f && f.name) : [],
    clips: (data.clips || []).map((c) => ({
      id: uid(),
      file: c.file,
      title: c.title || String(c.file).replace(/\.[^.]+$/, ''),
      srcStart: c.srcStart || 0,
      srcEnd: c.srcEnd || 0,
      fadeIn: c.fadeIn || 0,
      fadeOut: c.fadeOut || 0,
      crossfade: c.crossfade || 0,
      // Older project files predate levels and have no gain at all; missing
      // means "as recorded", not silent.
      gain: clipGain(c),
    })),
  };
}

/* A hair above 1, so a program that merely touches full scale is not nagged
 * about. Anything genuinely past it is flat-topped by the encoders below. */
const PEAK_TOLERANCE = 1e-4;

/**
 * Does the finished program go past what a sound file can hold?
 *
 * `solveGains` guards the automatic path carefully, but the Volume slider
 * reaches +24 dB by hand and nothing downstream stops it. `encodeWav` clamps,
 * so the result is flat-topped distortion rather than wrap-around noise —
 * audible, and worth catching here rather than at the rink.
 */
function clipsOnExport(peak) {
  return peak > 1 + PEAK_TOLERANCE;
}

/** The picker's filter, built from the same list the drop handler tests against. */
function audioPickerTypes() {
  return [{ description: 'Music', accept: { 'audio/*': [...AUDIO_EXTENSION_LIST] } }];
}

/**
 * Is this the song the project was built from? One sentence if not, else null.
 *
 * Matching is by file name because that is all a browser gives us, and two
 * different songs can easily share one — "track01.mp3" from two albums, or a
 * re-download at a different quality. Rebuilding a program around the wrong
 * one silently is the failure worth catching: the trims would still apply, the
 * timer would still read correctly, and it would all be wrong.
 *
 * Pure, and forgiving: a project written before this existed records nothing to
 * compare against, and says nothing rather than crying wolf.
 */
function describeWrongFile(expected, entry) {
  if (!expected || !expected.fingerprint || !entry.fingerprint) return null;
  if (expected.fingerprint === entry.fingerprint) return null;

  const was = Number(expected.seconds);
  const now = entry.duration;
  const length =
    isFinite(was) && was > 0 && Math.abs(was - now) > 1
      ? ` — this one is ${fmtShort(now)}, the program was built from ${fmtShort(was)}`
      : '';
  return `“${entry.name}” is not the song this program was built from${length}`;
}

/**
 * What happened when the music was asked for again, in one sentence.
 *
 * Each outcome needs a different next step, and "could not open the files" tells
 * nobody which one they are in: a file that has been moved needs finding, a
 * refused prompt needs saying yes to, and a file that is simply elsewhere needs
 * Add files. Pure, so the wording is under test.
 */
function describeReconnect({ files, gone, refused }) {
  const names = (list) => list.map((n) => `“${n}”`).join(', ');
  if (!files.length && gone.length && !refused.length) {
    return gone.length === 1
      ? `${names(gone)} is not where it was — it may have been moved, renamed or deleted. ` +
          'Use Add files to find it'
      : `${gone.length} songs are not where they were — they may have been moved, ` +
          'renamed or deleted. Use Add files to find them';
  }
  if (!files.length && refused.length && !gone.length) {
    return (
      'Permission to read the music was not given, so nothing was opened. ' +
      'Try again and choose Allow, or use Add files'
    );
  }
  if (!files.length) {
    return 'Could not open the music again — use Add files to find it';
  }
  const opened = files.length === 1 ? 'Opened one song' : `Opened ${files.length} songs`;
  if (gone.length && refused.length) {
    return `${opened}. ${gone.length} could not be found and ${refused.length} were not allowed`;
  }
  if (gone.length) {
    return (
      `${opened}, but ${names(gone)} could not be found — use Add files for ` +
      (gone.length === 1 ? 'it' : 'those')
    );
  }
  return `${opened}, but permission was not given for ${refused.length} of them`;
}

/* ------------------------------------------------------------ level picker */

function parseClock(text) {
  const m = String(text)
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const seconds = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return seconds > 0 && seconds < 3600 ? seconds : null;
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SR,
    MIN_CROSSFADE,
    MIN_CLIP,
    AUDIO_EXTENSION_LIST,
    AUDIO_EXTENSIONS,
    MAX_GAIN,
    LEVELS,
    CUSTOM_LEVEL,
    allLevels,
    findLevel,
    fmt,
    fmtShort,
    uid,
    clipDuration,
    clipGain,
    crossfadeOf,
    layout,
    rampEnvelope,
    fadeEnvelope,
    crossfadeEnvelope,
    valueAt,
    computePeaks,
    clampClipsToFile,
    reordered,
    JOIN_PREVIEW,
    joinPreviewRange,
    joinRoom,
    readProject,
    PEAK_TOLERANCE,
    clipsOnExport,
    audioPickerTypes,
    describeWrongFile,
    describeReconnect,
    parseClock,
  };
}
