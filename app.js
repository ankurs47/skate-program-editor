/* Skate Program Editor — everything runs in this tab.
 *
 * Audio files are read with the File API and decoded in memory. Nothing is
 * uploaded, and there is no server: opening index.html from disk is enough.
 *
 * The edit is saved as a project file: a small readable JSON document holding
 * the clip list and their trims and fades. That file is the artifact worth
 * committing to git — a few KB that diffs meaningfully, rather than a rendered
 * mixdown that goes stale.
 */
'use strict';

const SR = 44100;
const MIN_CROSSFADE = 0.01;
const MIN_CLIP = 0.1;            // the shortest a clip may be trimmed to, in seconds
const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|m4a|ogg|opus|aac|webm|aiff?)$/i;
const MAX_GAIN = 16;             // a shade over the +24 dB the level slider reaches
const STORE_KEY = 'skate.program.v1';

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

const state = {
  name: 'my program',
  level: 'usfs-juv',        // id from LEVELS, or CUSTOM_LEVEL
  targetSeconds: 135,
  toleranceSeconds: 10,
  clips: [],          // {id, file, title, srcStart, srcEnd, fadeIn, fadeOut, crossfade}
  selected: null,     // clip id
  cursor: 0,          // source-time position inside the selected clip's file
  playPosition: 0,    // program-time position of the playhead, kept across stops
};

const library = new Map();   // file name -> {name, buffer, peaks, duration, state}
const undoStack = [];

let audio = null;            // AudioContext, created on first gesture
let playing = null;          // {nodes, startedAt, fromTime, mode}
let rafId = 0;
let mp3Ready = false;

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);

/* Both of these round to the precision they display *before* splitting the
   minutes off, not after. Rounding afterwards means a value that comes to 60
   once rounded is shown as sixty seconds rather than carried: 59.98 read as
   "0:60.0" on the programme timer, and a 119.6 second song listed as "1:60". */

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

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function toast(message, ms = 2600) {
  const el = $('toast');
  // Shown before the text is set, not after: this is a live region, and a
  // change made while it is still display:none may never be announced at all.
  // Every outcome the app reports goes through here.
  el.classList.remove('hidden');
  el.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function ctx() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

/* ------------------------------------------------------------------ layout */

function clipDuration(clip) {
  return Math.max(0, clip.srcEnd - clip.srcStart);
}

/**
 * A clip's level as a plain multiplier. Anything missing, negative or absurd
 * becomes 1 — a hand-edited project file must not be able to silence the
 * programme or blow the speakers.
 */
function clipGain(clip) {
  const gain = clip ? clip.gain : undefined;
  // Checked as a number before anything else: `Number(null)` is 0, so coercing
  // first would read a null in a project file as "silent" rather than "absent".
  return typeof gain === 'number' && isFinite(gain) && gain >= 0
    ? clamp(gain, 0, MAX_GAIN)
    : 1;
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
    i + 1 < clips.length ? crossfadeOf(clips, i + 1) : 0);
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

/**
 * Apply breakpoints to a gain param. `clipT0` is the context time at which the
 * clip's timeline position begins; `skip` is how far into the clip we start,
 * so resuming mid-program keeps the envelope correct.
 */
function applyEnvelope(param, points, clipT0, skip, now) {
  const startAt = Math.max(clipT0 + skip, now);
  param.cancelScheduledValues(startAt);
  param.setValueAtTime(valueAt(points, skip), startAt);
  for (const [t, v] of points) {
    if (t > skip) param.linearRampToValueAtTime(v, Math.max(clipT0 + t, startAt));
  }
}

/* ------------------------------------------------------------- scheduling */

/**
 * Schedule the whole program into `context`, starting playback of the timeline
 * at `fromTime` seconds. Used for both live preview and the offline render, so
 * what you hear is what gets exported.
 */
function scheduleProgram(context, destination, when, fromTime) {
  const clips = state.clips;
  const { parts } = layout(clips);
  const nodes = [];

  clips.forEach((clip, i) => {
    const entry = library.get(clip.file);
    if (!entry || !entry.buffer) return;

    const { start, dur } = parts[i];
    if (start + dur <= fromTime) return;          // entirely in the past

    const skip = Math.max(0, fromTime - start);
    const clipT0 = when + (start - fromTime);     // may be before `when`
    const playAt = Math.max(clipT0 + skip, when);

    const src = context.createBufferSource();
    src.buffer = entry.buffer;
    const level = context.createGain();
    const fade = context.createGain();
    const blend = context.createGain();
    // Level is a constant, so it sits before the two envelopes rather than
    // being folded into either — the fade still runs 0 to 1, and the two sides
    // of a crossfade still sum to 1, whatever the clips are set to.
    level.gain.value = clipGain(clip);
    src.connect(level).connect(fade).connect(blend).connect(destination);

    const now = context.currentTime;
    applyEnvelope(fade.gain, fadeEnvelope(clip), clipT0, skip, now);
    applyEnvelope(blend.gain, crossfadeEnvelope(clips, i), clipT0, skip, now);

    const offset = clip.srcStart + skip;
    const length = Math.max(0, dur - skip);
    src.start(playAt, offset, length);
    nodes.push(src);
  });

  return nodes;
}

function stopPlayback() {
  if (playing) {
    for (const node of playing.nodes) {
      try { node.stop(); } catch (_) { /* already ended */ }
    }
    playing = null;
  }
  cancelAnimationFrame(rafId);
  $('btnPlayLabel').textContent = 'Play';
  drawScrubber();   // the playhead stays where it is, so Space resumes there
}

/** `until` stops playback at a point in programme time, for auditioning a join. */
function playProgram(fromTime = 0, until = Infinity) {
  const { total } = layout(state.clips);
  if (total <= 0) return;
  stopPlayback();
  const context = ctx();
  const when = context.currentTime + 0.08;   // small lead so nothing is late
  const nodes = scheduleProgram(context, context.destination, when, fromTime);
  if (!nodes.length) { toast('Add some music files first'); return; }
  playing = { nodes, startedAt: when, fromTime, mode: 'program', total, until };
  $('btnPlayLabel').textContent = 'Pause';
  tickPlayhead();
}

/**
 * Play one clip on its own, from a point inside it.
 *
 * Its level and its own fades are applied, because hearing what this song will
 * sound like is the entire point — auditioning at full volume a song you have
 * just set to 40% tells you nothing, and it used to do exactly that. The blend
 * is not applied: that belongs to the join rather than to the song, and there
 * is no previous song here to blend with.
 */
function playClipAudition(clip, fromSource) {
  const entry = library.get(clip.file);
  if (!entry || !entry.buffer) { toast('That file is not loaded'); return; }
  stopPlayback();
  const context = ctx();
  const src = context.createBufferSource();
  src.buffer = entry.buffer;
  const level = context.createGain();
  const fade = context.createGain();
  level.gain.value = clipGain(clip);
  src.connect(level).connect(fade).connect(context.destination);

  const from = clamp(fromSource, clip.srcStart, clip.srcEnd);
  const when = context.currentTime + 0.05;
  // Clip time zero sits `skip` seconds before we actually start, so the
  // envelope is anchored back there and applyEnvelope joins it part-way.
  const skip = from - clip.srcStart;
  applyEnvelope(fade.gain, fadeEnvelope(clip), when - skip, skip, context.currentTime);

  src.start(when, from, clip.srcEnd - from);
  playing = { nodes: [src], startedAt: when, fromTime: from, mode: 'clip', clip };
  $('btnPlayLabel').textContent = 'Pause';
  tickPlayhead();
}

function tickPlayhead() {
  cancelAnimationFrame(rafId);
  const step = () => {
    if (!playing) return;
    const elapsed = ctx().currentTime - playing.startedAt;
    if (elapsed < 0) { rafId = requestAnimationFrame(step); return; }

    if (playing.mode === 'program') {
      const at = Math.min(playing.fromTime + elapsed, playing.total);
      state.playPosition = at;
      $('playhead').textContent = fmt(at);
      drawScrubber();
      const stopAt = Math.min(playing.total, playing.until ?? Infinity);
      if (at >= stopAt) { stopPlayback(); return; }
    } else {
      const at = playing.fromTime + elapsed;
      state.cursor = at;
      drawClipEditor();
      if (at >= playing.clip.srcEnd) { stopPlayback(); return; }
    }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

/* --------------------------------------------------------- source quality */

/* Competitions ask for clean audio, and a bad YouTube rip is the usual culprit.
 * Announcements vary and rarely quote a number, so treat these as sensible
 * defaults rather than a rule — check the specific competition's announcement.
 * Lossless sources (wav/flac) skip the bitrate test entirely. */
const QUALITY = {
  goodBitrate: 192,      // kbps: comfortable for a rink PA
  minBitrate: 128,       // kbps: below this, flag it loudly
  goodSampleRate: 44100, // Hz: CD rate
  minSampleRate: 32000,
};

/* Thresholds above are in MP3 terms. Newer codecs sound better at the same
 * bitrate, so compare an equivalent figure rather than the raw number —
 * otherwise a perfectly good 128 kbps Opus download gets flagged. Displayed
 * bitrates are always the real ones. */
const CODEC_EFFICIENCY = { mp3: 1, aac: 1.3, m4a: 1.3, opus: 1.5, ogg: 1.2, vorbis: 1.2 };

function codecOf(name) {
  const match = String(name).match(/\.([a-z0-9]+)$/i);
  const ext = match ? match[1].toLowerCase() : '';
  if (ext === 'webm') return 'opus';   // YouTube's WebM audio is Opus
  return ext;
}

const MPEG_BITRATES = {
  // [versionKey][bitrateIndex] in kbps, Layer III only
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Length of an ID3v2 tag at the start of the file, or 0. Takes an ArrayBuffer. */
function id3Size(bytes) {
  if (bytes.byteLength < 10) return 0;
  const view = new DataView(bytes, 0, 10);
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return 0;
  // syncsafe integer: 7 bits per byte
  const size = (view.getUint8(6) << 21) | (view.getUint8(7) << 14)
             | (view.getUint8(8) << 7) | view.getUint8(9);
  return size + 10;
}

/** Decode one MPEG Layer III frame header, or null if these bytes aren't one. */
function parseFrameHeader(view, i) {
  if (i + 4 > view.byteLength) return null;
  if (view.getUint8(i) !== 0xff) return null;
  const b1 = view.getUint8(i + 1);
  if ((b1 & 0xe0) !== 0xe0) return null;              // 11-bit frame sync

  const versionBits = (b1 >> 3) & 0x03;               // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (b1 >> 1) & 0x03;                 // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;

  const b2 = view.getUint8(i + 2);
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const bitrate = MPEG_BITRATES[versionBits === 3 ? 1 : 2][bitrateIndex];
  const sampleRate = MPEG_RATES[versionBits][rateIndex];
  const padding = (b2 >> 1) & 0x01;
  const channels = ((view.getUint8(i + 3) >> 6) & 0x03) === 3 ? 1 : 2;
  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8) * bitrate * 1000 / sampleRate) + padding;
  if (frameLength < 8) return null;

  return { versionBits, bitrate, sampleRate, channels, samplesPerFrame, frameLength };
}

/**
 * Find the first real MPEG audio frame. Returns null for non-MPEG data.
 *
 * A bare sync-word search is not enough: compressed audio of any kind is full
 * of 0xFF bytes followed by high bits, so scanning Opus or AAC data will find a
 * false "frame" almost immediately and report a nonsense bitrate. Requiring
 * several consecutive frames to sit exactly frameLength apart, agreeing on
 * version and sample rate, is what makes the match trustworthy.
 *
 * Also picks up a Xing/Info header, which is how VBR files declare their real
 * average — the frame header alone reports only the first frame's rate.
 */
function readMpegFrame(bytes, start) {
  const view = new DataView(bytes);
  const limit = Math.min(view.byteLength - 4, start + 65536);

  for (let i = start; i < limit; i++) {
    if (view.getUint8(i) !== 0xff) continue;
    const first = parseFrameHeader(view, i);
    if (!first) continue;

    // Walk forward and confirm this is a real frame chain, not a coincidence.
    let pos = i;
    let confirmed = 0;
    for (let n = 0; n < 4; n++) {
      const frame = parseFrameHeader(view, pos);
      if (!frame
          || frame.versionBits !== first.versionBits
          || frame.sampleRate !== first.sampleRate) break;
      confirmed++;
      pos += frame.frameLength;
      if (pos + 4 > view.byteLength) break;   // ran out of file, not a failure
    }
    if (confirmed < 3) continue;

    const { bitrate, sampleRate, channels, samplesPerFrame, versionBits } = first;

    // Xing/Info sits after the side information block
    const sideInfo = versionBits === 3 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
    let vbr = false;
    let average = bitrate;
    const tagAt = i + 4 + sideInfo;
    if (tagAt + 16 < view.byteLength) {
      const tag = String.fromCharCode(
        view.getUint8(tagAt), view.getUint8(tagAt + 1),
        view.getUint8(tagAt + 2), view.getUint8(tagAt + 3));
      if (tag === 'Xing' || tag === 'Info') {
        vbr = tag === 'Xing';
        const flags = view.getUint32(tagAt + 4);
        let p = tagAt + 8;
        const frames = (flags & 1) ? view.getUint32(p) : 0;
        if (flags & 1) p += 4;
        const streamBytes = (flags & 2) ? view.getUint32(p) : 0;
        if (frames > 0 && streamBytes > 0) {
          const seconds = (frames * samplesPerFrame) / sampleRate;
          average = Math.round((streamBytes * 8) / seconds / 1000);
        }
      }
    }
    return { bitrate: average, sampleRate, channels, vbr, codec: 'mp3' };
  }
  return null;
}

/**
 * Byte offset where audio data begins in an Ogg stream, or 0 if not Ogg.
 *
 * Ogg Opus puts the cover art in the OpusTags comment header, which for a
 * yt-dlp download runs to several hundred KB. Measuring from file size without
 * skipping it overstates the bitrate by ~40%. The first two packets are
 * OpusHead and OpusTags; everything after them is audio.
 */
function oggAudioStart(bytes) {
  const view = new DataView(bytes);
  if (view.byteLength < 27) return 0;
  const magic = (at) => view.getUint8(at) === 0x4f && view.getUint8(at + 1) === 0x67
    && view.getUint8(at + 2) === 0x67 && view.getUint8(at + 3) === 0x53;   // "OggS"
  if (!magic(0)) return 0;

  let pos = 0;
  let packets = 0;
  while (pos + 27 < view.byteLength && magic(pos) && packets < 2) {
    const segments = view.getUint8(pos + 26);
    let payload = 0;
    for (let i = 0; i < segments; i++) {
      const len = view.getUint8(pos + 27 + i);
      payload += len;
      if (len < 255) packets++;    // a segment under 255 ends a packet
    }
    pos += 27 + segments + payload;
  }
  return packets >= 2 ? pos : 0;
}

/**
 * The verdict for one source: good, caution, poor, or unknown.
 *
 * Separate from `analyseSource`, which needs a decoded buffer and a File to say
 * anything at all. The judgement itself is the part that is easy to get wrong
 * and easy to check, so it stands on its own and takes plain numbers — the test
 * for it used to reimplement these thresholds and assert against its own copy,
 * which would have passed whatever this actually did.
 *
 * `bitrate` is the real figure; the comparison is against its MP3-equivalent,
 * because 128k Opus and 128k MP3 are not the same thing. A null measurement
 * means unknown, never zero.
 */
function qualityKind({ bitrate = null, sampleRate = null, codec = '', lossless = false }) {
  // Nothing measurable and not a known lossless format — say so rather than
  // implying it's fine.
  let kind = (!lossless && bitrate === null) ? 'unknown' : 'good';
  if (!lossless && bitrate !== null) {
    // Judge on the MP3-equivalent figure; display the real one.
    const effective = bitrate * (CODEC_EFFICIENCY[codec] || 1);
    if (effective < QUALITY.minBitrate) kind = 'poor';
    else if (effective < QUALITY.goodBitrate) kind = 'caution';
  }
  if (sampleRate !== null && kind !== 'unknown') {
    if (sampleRate < QUALITY.minSampleRate) kind = 'poor';
    else if (sampleRate < QUALITY.goodSampleRate && kind === 'good') kind = 'caution';
  }
  return kind;
}

/**
 * Work out what we can about a source file. `head` is a copy of the bytes at
 * the first audio frame, taken before decoding because decodeAudioData detaches
 * the buffer. `tagEnd` is where the ID3v2 tag ended — with embedded artwork
 * that is routinely several hundred KB, so it cannot be assumed small.
 */
function analyseSource(head, tagEnd, file, buffer) {
  const lossless = /\.(wav|flac|aiff?)$/i.test(file.name);
  // Only attempt MPEG parsing on files that could plausibly be MPEG. The frame
  // validator would reject Opus anyway, but not paying for the scan is better.
  const maybeMpeg = /\.(mp3|mp2|mpga)$/i.test(file.name);
  let info = null;

  if (!lossless && maybeMpeg) {
    try { info = readMpegFrame(head, 0); } catch (_) { info = null; }
  }

  // buffer.sampleRate is the AudioContext's rate, not the file's — everything
  // is resampled to 44100 on decode. Only an actual header tells us the source
  // rate, so leave it unknown rather than reporting a number we made up.
  const sampleRate = info ? info.sampleRate : null;
  const channels = info ? info.channels : buffer.numberOfChannels;
  let bitrate = info ? info.bitrate : null;
  let estimated = false;

  if (!lossless && bitrate === null && buffer.duration > 0) {
    // Fallback for m4a/ogg/opus. `tagEnd` already skips embedded artwork, which
    // yt-dlp adds by default and which runs to hundreds of KB.
    const payload = Math.max(0, file.size - tagEnd);
    bitrate = Math.round((payload * 8) / buffer.duration / 1000);
    estimated = true;
  }

  const codec = info ? 'mp3' : codecOf(file.name);
  const kind = qualityKind({ bitrate, sampleRate, codec, lossless });

  // Short flags, used where there is room to show them. The badge never uses
  // these — it has to stay narrow enough to sit beside the Add button.
  const notes = [];
  if (channels === 1) notes.push('mono');
  if (sampleRate !== null && sampleRate < QUALITY.goodSampleRate) {
    notes.push(`${(sampleRate / 1000).toFixed(1)} kHz`);
  }

  return {
    bitrate, sampleRate, channels, lossless, kind, codec, notes,
    estimated, vbr: Boolean(info && info.vbr),
  };
}

/* A verdict rather than a number. 128k Opus and 128k MP3 sound nothing alike,
 * so showing bitrates invites exactly the wrong comparison — the codec factors
 * above already do that reasoning. The figures stay in the tooltip. */
const QUALITY_LABEL = { good: 'Good', caution: 'Fair', poor: 'Low', unknown: 'Unknown' };

/** Compact badge text — must stay narrow enough to sit beside the Add button. */
function qualityLabel(q) {
  return q ? (QUALITY_LABEL[q.kind] || 'Unknown') : '';
}

/** Everything worth saying, for the tooltip and the export warning. */
function qualityDetail(q) {
  const head = q.lossless ? 'Lossless source'
    : q.kind === 'unknown' ? 'Could not measure this file'
    : q.kind === 'good' ? 'Good quality'
    : q.kind === 'poor' ? 'Low quality — may sound rough on a rink system'
    : 'Below CD quality, but probably fine';
  const parts = [];
  if (q.bitrate && !q.lossless) parts.push(`${q.bitrate} kbps${q.estimated ? ' (estimated)' : ''}`);
  if (q.codec) parts.push(q.codec);
  if (q.sampleRate !== null) parts.push(`${(q.sampleRate / 1000).toFixed(1)} kHz`);
  parts.push(q.channels === 1 ? 'mono' : 'stereo');
  if (q.vbr) parts.push('VBR');
  return `${head} — ${parts.join(', ')}`;
}

/** Sources used by the program that fall short, for the export warning. */
function weakSources() {
  const seen = new Map();
  for (const clip of state.clips) {
    const entry = library.get(clip.file);
    // 'unknown' is not a complaint — only flag what we measured and found short.
    const weak = entry && entry.quality
      && (entry.quality.kind === 'caution' || entry.quality.kind === 'poor');
    if (weak && !seen.has(clip.file)) {
      seen.set(clip.file, entry);
    }
  }
  return [...seen.values()];
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
    let mn = 1, mx = -1;
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

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

function drawWave(canvas, peaks, duration, t0, t1, color, gain = 1) {
  const { g, w, h } = fitCanvas(canvas);
  g.clearRect(0, 0, w, h);
  if (!peaks || duration <= 0) return;

  const count = peaks.length / 2;
  const mid = h / 2;
  g.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const ta = t0 + ((t1 - t0) * x) / w;
    const tb = t0 + ((t1 - t0) * (x + 1)) / w;
    let ia = Math.floor((ta / duration) * count);
    let ib = Math.ceil((tb / duration) * count);
    ia = clamp(ia, 0, count - 1);
    ib = clamp(ib, ia + 1, count);
    let mn = 1, mx = -1;
    for (let i = ia; i < ib; i++) {
      if (peaks[i * 2] < mn) mn = peaks[i * 2];
      if (peaks[i * 2 + 1] > mx) mx = peaks[i * 2 + 1];
    }
    if (mx < mn) { mn = 0; mx = 0; }
    const y0 = mid - clamp(mx * gain, -1, 1) * mid * 0.94;
    const y1 = mid - clamp(mn * gain, -1, 1) * mid * 0.94;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ----------------------------------------------------------------- beats */

/* A join sounds wrong for rhythmic reasons far more often than for any other:
   the beats of the two songs don't coincide through the blend, or the cut lands
   in the middle of a bar. Both are usually fixable by moving the cut a second
   or two, which is what this section is for.

   It is deliberately willing to give up. A lot of skating music is rubato — no
   steady pulse to snap to — and tempo detection will happily return a confident
   wrong answer on it. `analyseBeats` reports a confidence so the caller can
   leave the cut alone instead of moving it somewhere arbitrary.

   Everything here takes samples and returns numbers, so it is testable without
   a browser. */

const BEAT = {
  frame: 1024,          // FFT size for the onset envelope, ~23 ms at 44100
  hop: 512,             // ~12 ms between envelope samples
  minBpm: 60,
  maxBpm: 200,
  centreBpm: 120,       // tempo prior, so 90 is preferred over 45 or 180
  spreadOctaves: 0.9,   // width of that prior
  compression: 100,     // γ in log(1 + γ|X|): lets quiet onsets count too
  smoothing: 0.4,       // seconds of moving average removed from the envelope
  window: 12,           // seconds of audio analysed around a cut
  minConfidence: 0.3,   // below this we decline rather than guess
  minOnsets: 0.05,      // flux, as a share of frame magnitude, for "notes start here"
  minCoverage: 0.5,     // share of the grid's beats that must actually be played
  maxDrift: 0.125,      // acceptable beat slip through a blend, in beats
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
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
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

  // env[i] compares frame i+1 against frame i, so it belongs at that frame's centre
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
 * neighbours restores the beats to roughly equal size.
 */
function flattenEnvelope(env, rate) {
  const blurred = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    blurred[i] = 0.25 * (i > 0 ? env[i - 1] : 0)
      + 0.5 * env[i]
      + 0.25 * (i + 1 < env.length ? env[i + 1] : 0);
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
    if (value > score) { score = value; phase = candidate; }
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
 * neighbourhood; refinePeriod gets the actual value.
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
    const octaves = Math.log2(bpm / BEAT.centreBpm) / BEAT.spreadOctaves;
    const score = (sum / (env.length - lag)) * Math.exp(-0.5 * octaves * octaves);
    if (score > best) { best = score; bestLag = lag; }
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

  const related = (lag) => [1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3]
    .some((m) => Math.abs(lag / (period * m) - 1) < 0.08);

  const probes = 24;
  const scores = [];
  for (let i = 0; i < probes; i++) {
    const lag = minLag + ((maxLag - minLag) * i) / (probes - 1);
    if (!related(lag)) scores.push(bestPhaseFor(env, lag).score);
  }
  if (scores.length < 4) return 0;   // nothing unrelated left to compare against
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
      for (let i = offset; i < beats.length; i += meter) { sum += beats[i].strength; n++; }
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
function analyseBeats(samples, sampleRate) {
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
  beats.forEach((beat, i) => { beat.downbeat = (i - bar.offset) % bar.meter === 0; });

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
    confidence: clamp((fit.score / baseline - 1) / 2, 0, 1)
      * clamp(onsets / BEAT.minOnsets, 0, 1)
      * clamp(coverage / BEAT.minCoverage, 0, 1),
    coverage,
    meter: bar.meter,
    beats,
  };
}

/**
 * Choose beat-aligned cut points for one join.
 *
 * `out` and `inc` are analyseBeats results for windows taken around the
 * outgoing clip's end and the incoming clip's start; `cutOut` and `cutIn` say
 * where those cuts currently sit inside those windows. `outRoom` and `incRoom`
 * bound how far each cut may move before its clip runs out of song.
 *
 * Returns how far to move each cut, what to set the blend to, and how much
 * longer or shorter the programme becomes as a result. `ok: false` means the
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
    ok: false, reason, endShift: 0, startShift: 0, crossfade,
    lengthDelta: 0, drift: 0, tempoMismatch: 0, confidence: 0, bpm: [0, 0],
    ...extra,
  };
}

function suggestJoin(out, cutOut, inc, cutIn, opts = {}) {
  const { maxShift, crossfade, maxCrossfade, outRoom, incRoom } = joinOptions(opts);
  const minConfidence = opts.minConfidence ?? BEAT.minConfidence;
  const confidence = Math.min(out.confidence || 0, inc.confidence || 0);

  const decline = (reason) => declineJoin(reason, crossfade, {
    confidence, bpm: [out.bpm || 0, inc.bpm || 0],
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
    if (err < tempoMismatch) { tempoMismatch = err; ratio = m; }
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
  const maxOverlap = driftPerSecond > 0
    ? Math.min(maxCrossfade, BEAT.maxDrift / driftPerSecond)
    : maxCrossfade;
  let blends = [0];
  if (crossfade > 0) {
    blends = [...new Set([1, 2, out.meter, out.meter * 2])]
      .map((k) => k * out.period)
      .filter((x) => x <= maxOverlap);
    // Even one beat may drift too far. Offer it anyway and let the cost say so:
    // a short blend is still better advice than none.
    if (!blends.length) blends = [Math.min(out.period, maxCrossfade)];
  }

  // Weights are judgement, not physics. Landing on a downbeat is worth roughly
  // a second of movement; keeping the programme's length is worth slightly less
  // than that, because the timer is visible and easy to correct elsewhere.
  const cost = (endShift, startShift, blend, lengthDelta, a, b) =>
    (0.8 * (Math.abs(endShift) + Math.abs(startShift))) / maxShift
    + 0.7 * Math.abs(lengthDelta)
    + 1.0 * ((a.downbeat ? 0 : 1) + (b.downbeat ? 0 : 1))
    + (0.3 * Math.abs(blend - crossfade)) / Math.max(crossfade, 1)
    + (1.5 * blend * driftPerSecond) / BEAT.maxDrift;

  let best = null;
  for (const a of outs) {
    const endShift = a.t - cutOut;
    for (const b of incs) {
      const startShift = b.t - cutIn;
      for (const blend of blends) {
        // Moving the end out lengthens the programme, moving the start in
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
  return { beats: analyseBeats(samples, buffer.sampleRate), cut: at - start };
}

/* --------------------------------------------------------------- phrases */

/* Much skating music has no beat to find. Solo piano especially: the tempo
   pushes and pulls, and there is no grid, so `analyseBeats` correctly refuses
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
  frame: 4096,          // ~10.8 Hz bins at 44100 — fine enough to tell semitones apart
  hop: 2048,            // ~46 ms
  quiet: 0.12,          // seconds; how wide a "nothing is happening" moment is
  context: 1.6,         // seconds of surrounding music a lull is judged against
  novelty: 1.5,         // seconds either side compared for a change of harmony
  minLull: 0.4,         // seconds; shorter than this is a gap between notes, not a breath
  maxLull: 2,           // seconds; longer than this is a section break, not a breath
  smooth: 0.15,         // seconds of moving average before looking for peaks
  separation: 0.6,      // seconds; two breaths closer together than this are one
  minScore: 0.35,       // below this a candidate is not really a break at all
  minBlend: 2,          // seconds; a short blend is exposed with no beat to carry it
  chromaLow: 200,       // Hz; below this the bins are too coarse to name a note
  chromaHigh: 3000,     // Hz; above this it is mostly harmonics and noise
  gapWeight: 0.8,       // the rest is novelty
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
 * Twelve pitch classes per frame, each frame normalised to unit length so two
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
  const blend = crossfade > 0
    ? Math.min(Math.max(crossfade, PHRASE.minBlend), maxCrossfade)
    : 0;

  let best = null;
  for (const a of outs) {
    const endShift = a.t - cutOut;
    for (const b of incs) {
      const startShift = b.resumes - cutIn;
      const lengthDelta = endShift - startShift - (blend - crossfade);
      const cost = 1.2 * ((1 - a.score) + (1 - b.score))
        + (0.8 * (Math.abs(endShift) + Math.abs(startShift))) / maxShift
        + 0.7 * Math.abs(lengthDelta);
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
    analyseBeats(a.samples, a.sampleRate), a.cut,
    analyseBeats(b.samples, b.sampleRate), b.cut, opts);
  if (beat.ok || beat.reason !== 'no-beat') return beat;

  return suggestPhraseJoin(
    phrasePoints(a.samples, a.sampleRate), a.cut,
    phrasePoints(b.samples, b.sampleRate), b.cut, opts);
}

/**
 * What to say afterwards, in one sentence.
 *
 * The change itself is visible — the waveform, the blocks and the timer all
 * move — so this says the part that isn't: whether it worked, and what it cost
 * in programme length, because that is the number being worked to.
 */
function describeJoin(result, wasCrossfade) {
  if (!result.ok) {
    return {
      'no-room': 'Not enough song either side to move the cut, so nothing changed',
      'no-beat': 'No steady beat to line up with here, so nothing changed',
    }[result.reason] || 'Could not find a natural break in the music, so nothing changed';
  }

  const changed = Math.abs(result.endShift) >= 0.05
    || Math.abs(result.startShift) >= 0.05
    || Math.abs(result.crossfade - wasCrossfade) >= 0.05;
  if (!changed) {
    return result.reason === 'phrase'
      ? 'This join is already at a natural break'
      : 'This join is already on the beat';
  }

  const delta = result.lengthDelta;
  const length = Math.abs(delta) < 0.05
    ? 'Same length as before'
    : `Program is ${Math.abs(delta).toFixed(1)}s ${delta > 0 ? 'longer' : 'shorter'}`;
  const lead = {
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
  block: 0.4,            // seconds per measurement block
  step: 0.1,             // block spacing, so blocks overlap by 75%
  absoluteGate: -70,     // LUFS; below this a block is silence, not quiet music
  relativeGate: -10,     // LU below the ungated mean
  offset: -0.691,        // BS.1770 calibration, so 1 kHz reads its own level
  ceiling: -1,           // dBFS left free, because sample peaks understate the real ones
  // Quiet classical masters really do sit 25 dB below a pop single, so this has
  // to be generous or the very case the feature exists for gets refused. Its
  // job is only to decline near-silence, which needs far more than this.
  maxBoost: 24,          // dB
  maxCrest: 22,          // dB of peak above loudness; beyond this a clip is an outlier
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
 * the level for everyone else. That is the loudest the programme can be while
 * staying both matched and clean, and it means a programme of quiet orchestral
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
    if (!measured(m)) return 1;                 // nothing to measure — leave it alone
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
    notes.push(short === 1
      ? 'one could not come all the way up, so it stays quieter than the rest'
      : `${short} could not come all the way up, so they stay quieter than the rest`);
  }
  if (unmeasured) {
    notes.push(unmeasured === 1
      ? 'one could not be measured and was left as it was'
      : `${unmeasured} could not be measured and were left as they were`);
  }
  const head = `Evened out ${matched} song${matched === 1 ? '' : 's'}`;
  return notes.length ? `${head} — ${notes.join(', and ')}` : head;
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
 * shows a duration that is a lie and the finished programme comes out the wrong
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

async function addFiles(fileList) {
  // The type and the name are asked separately. Testing a regex against the
  // two concatenated let "audio" match anywhere in either, so a file called
  // audiobook.txt was accepted and then failed to decode. Browsers also report
  // no type at all for .opus and .webm, which is why the extension is a second
  // chance rather than a formality.
  const files = Array.from(fileList).filter(
    (f) => /^audio\//i.test(f.type) || AUDIO_EXTENSIONS.test(f.name));
  if (!files.length) { toast('No audio files in that drop'); return; }
  let shortened = 0;

  for (const file of files) {
    if (library.has(file.name)) continue;
    library.set(file.name, { name: file.name, buffer: null, peaks: null, duration: 0, state: 'loading' });
  }
  renderLibrary();

  for (const file of files) {
    const entry = library.get(file.name);
    if (entry.buffer) continue;
    try {
      const bytes = await readFileBytes(file);
      // Copy a window at the first audio frame before decoding — decodeAudioData
      // detaches the buffer, and the source bitrate exists only in those bytes,
      // not in the decoded PCM. The window has to start past the ID3v2 tag,
      // which is ~430 KB on anything with embedded artwork.
      // Ogg keeps its cover art in the comment header rather than an ID3 tag,
      // so ask whichever container this is where its audio really starts.
      const tagEnd = id3Size(bytes) || oggAudioStart(bytes);
      const head = bytes.slice(tagEnd, Math.min(bytes.byteLength, tagEnd + 32768));
      const buffer = await ctx().decodeAudioData(bytes);
      entry.buffer = buffer;
      entry.duration = buffer.duration;
      entry.peaks = computePeaks(buffer);
      entry.quality = analyseSource(head, tagEnd, file, buffer);
      entry.state = 'ready';
      // Now that there is a real duration, the trims can finally be checked
      // against it. Silently playing silence off the end is the alternative.
      shortened += clampClipsToFile(state.clips, entry);
    } catch (err) {
      entry.state = 'error';
      toast(`Could not read ${file.name}`);
    }
    renderLibrary();
    updateMissingNotice();
    updateExportAvailability();
    renderTimeline();
    drawScrubber();
    drawClipEditor();
  }
  updateBudget();
  if (shortened) {
    save();
    toast(shortened === 1
      ? 'One song asked for more music than its file holds, so it was shortened to fit'
      : `${shortened} songs asked for more music than their files hold, so they were shortened to fit`,
    6000);
  }
}

/** How many clips in the program are playing from this file. */
function clipsUsing(file) {
  return state.clips.filter((c) => c.file === file).length;
}

/**
 * Take a file back out of the list.
 *
 * Only when nothing in the program is using it. Removing a file the program
 * depends on would quietly gut the edit, so the button is shut rather than
 * guarded by a confirmation — the same choice as the export button, and for the
 * same reason. Dropping the entry is what actually releases the decoded audio,
 * which is around 90 MB for every four minutes of stereo, and until now there
 * was no way to release it at all.
 */
function removeFromLibrary(name) {
  if (clipsUsing(name)) {
    toast('That song is in your program — take it out of the program first');
    return;
  }
  library.delete(name);
  renderLibrary();
}

function renderLibrary() {
  const list = $('libraryList');
  list.innerHTML = '';
  for (const entry of library.values()) {
    const li = document.createElement('li');
    if (entry.state === 'loading') li.classList.add('loading');

    const title = document.createElement('div');
    title.className = 'lib-title';
    title.textContent = entry.name;
    li.appendChild(title);

    if (entry.peaks) {
      const canvas = document.createElement('canvas');
      canvas.height = 28;
      li.appendChild(canvas);
      requestAnimationFrame(() => drawWave(canvas, entry.peaks, entry.duration, 0, entry.duration, css('--wave')));
    }

    const row = document.createElement('div');
    row.className = 'lib-row';
    const dur = document.createElement('span');
    dur.className = 'lib-dur';
    dur.textContent = entry.state === 'loading' ? 'reading…'
      : entry.state === 'error' ? 'unreadable' : fmtShort(entry.duration);
    row.appendChild(dur);

    if (entry.quality) {
      const badge = document.createElement('span');
      badge.className = `badge ${entry.quality.kind}`;
      badge.textContent = qualityLabel(entry.quality);
      badge.title = qualityDetail(entry.quality);
      row.insertBefore(badge, row.firstChild);
    }

    if (entry.state === 'ready') {
      const add = document.createElement('button');
      add.className = 'small';
      add.textContent = 'Add to program';
      add.onclick = () => addClip(entry);
      row.appendChild(add);
    }

    const drop = document.createElement('button');
    drop.className = 'small danger';
    drop.textContent = 'Remove';
    const used = clipsUsing(entry.name);
    drop.disabled = used > 0;
    drop.title = used
      ? `This song is in your program ${used === 1 ? 'once' : `${used} times`} — `
        + 'take it out of the program first'
      : 'Take this file out of the list and give back the memory it is holding. '
        + 'Your program is untouched, and nothing is deleted from your computer.';
    drop.onclick = () => removeFromLibrary(entry.name);
    row.appendChild(drop);

    li.appendChild(row);
    list.appendChild(li);
  }
}

/* ----------------------------------------------------------------- clips */

/* A held key repeats about thirty times a second, and every repeat used to push
   its own snapshot. The stack is sixty deep, so two seconds on the arrow key
   emptied it and took every earlier edit down with it — which is the one thing
   an undo stack exists to prevent.

   A run of repeats of the same key on the same clip is one gesture and gets one
   snapshot. `tag` is what says two calls belong to that run; untagged callers
   never coalesce, and end any run in progress. The sliders solve the same
   problem with an `editing` flag, because a drag has an end event to hang it
   on and a key repeat does not. */
const UNDO_DEPTH = 60;
const UNDO_COALESCE_MS = 700;
let undoRun = { tag: null, at: 0 };

function pushUndo(tag = null) {
  const now = Date.now();
  if (tag !== null && tag === undoRun.tag && now - undoRun.at < UNDO_COALESCE_MS) {
    undoRun.at = now;      // the gesture continues; its opening snapshot stands
    return;
  }
  undoRun = { tag, at: now };
  undoStack.push(JSON.stringify(state.clips));
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

/** End any run of coalesced edits, so the next one starts a fresh entry. */
function endUndoRun() {
  undoRun = { tag: null, at: 0 };
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) { toast('Nothing to undo'); return; }
  // Without this, nudging again straight after an undo would be folded into the
  // run whose snapshot has just been popped, and that second edit could not be
  // undone at all.
  endUndoRun();
  state.clips = JSON.parse(prev);
  if (!state.clips.some((c) => c.id === state.selected)) {
    state.selected = state.clips.length ? state.clips[state.clips.length - 1].id : null;
  }
  refresh();
}

function addClip(entry) {
  pushUndo();
  const clip = {
    id: uid(),
    file: entry.name,
    title: entry.name.replace(/\.[^.]+$/, ''),
    srcStart: 0,
    srcEnd: entry.duration,
    fadeIn: state.clips.length === 0 ? 1.0 : 0,
    fadeOut: 0,
    crossfade: state.clips.length === 0 ? 0 : 1.5,
    gain: 1,
  };
  state.clips.push(clip);
  state.selected = clip.id;
  state.cursor = 0;
  refresh();
}

function selectedClip() {
  return state.clips.find((c) => c.id === state.selected) || null;
}

function removeClip(id) {
  pushUndo();
  const i = state.clips.findIndex((c) => c.id === id);
  state.clips = state.clips.filter((c) => c.id !== id);
  if (state.clips.length) {
    state.selected = state.clips[Math.min(i, state.clips.length - 1)].id;
  } else {
    state.selected = null;
  }
  if (state.clips.length) state.clips[0].crossfade = 0;   // nothing to blend into
  refresh();
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

function moveClip(fromIndex, toIndex) {
  const next = reordered(state.clips, fromIndex, toIndex);
  if (!next) return;
  pushUndo();
  state.clips = next;
  if (state.clips.length) state.clips[0].crossfade = 0;   // nothing to blend into
  refresh();
}

/* -------------------------------------------------------------- timeline */

/* Private to this page, so only a drag that began on a clip block carries it. */
const CLIP_DRAG_TYPE = 'application/x-skate-clip';

function renderTimeline() {
  const wrap = $('timeline');
  const { parts, total } = layout(state.clips);
  wrap.innerHTML = '';

  $('timelineEmpty').classList.toggle('hidden', state.clips.length > 0);

  state.clips.forEach((clip, i) => {
    if (parts[i].xf >= MIN_CROSSFADE) {
      const tag = document.createElement('div');
      tag.className = 'tl-xf';
      tag.textContent = `↔ ${parts[i].xf.toFixed(1)}s`;
      tag.title = `blends ${parts[i].xf.toFixed(1)}s into the previous clip`;
      wrap.appendChild(tag);
    }

    const el = document.createElement('div');
    el.className = 'tl-clip' + (clip.id === state.selected ? ' selected' : '');
    el.draggable = true;
    el.dataset.index = String(i);

    const entry = library.get(clip.file);
    if (!entry || !entry.buffer) el.classList.add('missing');

    // Grow proportionally to duration from a zero basis, so the strip fills the
    // panel exactly however many clips there are. Sizing in pixels against the
    // program length overflowed, because crossfades make the clip durations sum
    // to more than the timeline they occupy.
    const share = total > 0 ? parts[i].dur / total : 1 / state.clips.length;
    el.style.flex = `${share.toFixed(4)} 1 0`;

    const name = document.createElement('div');
    name.className = 'tl-name';
    name.textContent = clip.title;
    el.appendChild(name);

    const canvas = document.createElement('canvas');
    canvas.height = 44;
    el.appendChild(canvas);

    const dur = document.createElement('div');
    dur.className = 'tl-dur';
    dur.textContent = entry && entry.buffer ? fmt(parts[i].dur) : 'file missing';
    el.appendChild(dur);

    el.onclick = () => {
      state.selected = clip.id;
      state.cursor = clip.srcStart;
      state.playPosition = parts[i].start;   // jump the playhead to this clip
      $('playhead').textContent = fmt(state.playPosition);
      refresh();
    };

    // The reorder rides on a private type, so a drop counts only when the drag
    // started on one of these blocks. Reading text/plain instead meant any drag
    // was treated as a reorder: a text selection parsed to NaN, and a dropped
    // file gave the empty string, which Number() turns into 0 — a real index.
    // Either way a stray drop silently moved the first song. text/plain is
    // still published, because some browsers want it to start a drag at all.
    el.ondragstart = (e) => {
      el.classList.add('dragging');
      e.dataTransfer.setData(CLIP_DRAG_TYPE, String(i));
      e.dataTransfer.setData('text/plain', String(i));
    };
    el.ondragend = () => el.classList.remove('dragging');
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData(CLIP_DRAG_TYPE);
      if (from === '') return;              // not one of our blocks
      moveClip(Number(from), i);
    };

    wrap.appendChild(el);
    if (entry && entry.peaks) {
      requestAnimationFrame(() => drawWave(
        canvas, entry.peaks, entry.duration, clip.srcStart, clip.srcEnd,
        clip.id === state.selected ? css('--wave-sel') : css('--wave')));
    }
  });
}

/* ---------------------------------------------------------- program ruler */

/**
 * The scrubber is the authoritative view of program time: clip blocks sit at
 * their true timeline positions, so crossfade overlaps show as the places where
 * two blocks share space. The clip strip above is a list, not a ruler — its
 * widths sum to more than the program length whenever clips overlap.
 */
function scrubberSpan() {
  const { total } = layout(state.clips);
  // Always keep the allowed window on screen, even when the program is short.
  return Math.max(total, state.targetSeconds + state.toleranceSeconds, 1);
}

function tickStep(span) {
  if (span <= 60) return 5;
  if (span <= 150) return 10;
  if (span <= 400) return 30;
  return 60;
}

function drawScrubber() {
  const canvas = $('scrubber');
  const { g, w, h } = fitCanvas(canvas);
  const { parts, total } = layout(state.clips);
  g.clearRect(0, 0, w, h);

  const span = scrubberSpan();
  const x = (t) => (t / span) * w;
  const rulerY = h - 15;

  // allowed window for the chosen level
  const lo = Math.max(0, state.targetSeconds - state.toleranceSeconds);
  const hi = state.targetSeconds + state.toleranceSeconds;
  g.fillStyle = css('--accent-soft');
  g.fillRect(x(lo), 0, x(hi) - x(lo), rulerY);
  g.strokeStyle = css('--accent');
  g.setLineDash([3, 3]);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x(state.targetSeconds), 0);
  g.lineTo(x(state.targetSeconds), rulerY);
  g.stroke();
  g.setLineDash([]);

  // clip blocks at their real positions; overlaps stack visibly
  state.clips.forEach((clip, i) => {
    const { start, dur } = parts[i];
    const x0 = x(start);
    const x1 = x(start + dur);
    g.fillStyle = clip.id === state.selected ? css('--wave-sel') : css('--wave');
    g.globalAlpha = 0.55;
    g.fillRect(x0, 6, Math.max(1, x1 - x0), rulerY - 14);
    g.globalAlpha = 1;

    if (x1 - x0 > 46) {
      g.fillStyle = css('--panel');
      g.font = '10px system-ui, sans-serif';
      g.save();
      g.beginPath();
      g.rect(x0 + 3, 6, x1 - x0 - 6, rulerY - 14);
      g.clip();
      g.fillText(clip.title, x0 + 5, 18);
      g.restore();
    }
  });

  // ruler
  g.strokeStyle = css('--line');
  g.beginPath();
  g.moveTo(0, rulerY + 0.5);
  g.lineTo(w, rulerY + 0.5);
  g.stroke();

  const step = tickStep(span);
  g.fillStyle = css('--muted');
  g.font = '10px var(--mono), monospace';
  for (let t = 0; t <= span; t += step) {
    const px = x(t);
    g.fillRect(px, rulerY, 1, 4);
    if (t % (step * 2) === 0 && px < w - 22) g.fillText(fmtShort(t), px + 3, h - 3);
  }

  // playhead
  if (total > 0) {
    const px = x(clamp(state.playPosition, 0, total));
    g.fillStyle = css('--ink');
    g.fillRect(px - 1, 0, 2, rulerY);
    g.beginPath();
    g.moveTo(px - 5, 0);
    g.lineTo(px + 5, 0);
    g.lineTo(px, 7);
    g.closePath();
    g.fill();
  }
}

/** Move the playhead, restarting playback there if we were already playing. */
function seekTo(seconds) {
  const { total } = layout(state.clips);
  state.playPosition = clamp(seconds, 0, total);
  $('playhead').textContent = fmt(state.playPosition);
  drawScrubber();
}

function bindScrubber() {
  const canvas = $('scrubber');
  let scrubbing = false;
  let wasPlaying = false;

  const timeAt = (e) => {
    const rect = canvas.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * scrubberSpan();
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { total } = layout(state.clips);
    if (total <= 0) return;
    scrubbing = true;
    wasPlaying = Boolean(playing) && playing.mode === 'program';
    if (playing) stopPlayback();
    canvas.setPointerCapture(e.pointerId);
    seekTo(timeAt(e));
  });

  canvas.addEventListener('pointermove', (e) => {
    if (scrubbing) seekTo(timeAt(e));
  });

  const release = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    if (wasPlaying) playProgram(state.playPosition);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

/* ---------------------------------------------------------- clip editor */

function drawClipEditor() {
  const clip = selectedClip();
  const editor = $('editor');
  editor.classList.toggle('hidden', !clip);
  if (!clip) return;

  $('editorTitle').textContent = clip.title;
  $('editorTitle').title = clip.title;   // the heading ellipsises when it is long
  const entry = library.get(clip.file);
  const canvas = $('clipCanvas');
  const duration = entry && entry.buffer ? entry.duration : Math.max(clip.srcEnd, 1);

  drawWave(canvas, entry ? entry.peaks : null, duration, 0, duration, css('--wave'), clipGain(clip));

  const { g, w, h } = fitCanvas(canvas);
  const x = (t) => (t / duration) * w;

  // dim everything outside the kept region
  g.fillStyle = 'rgba(0,0,0,.35)';
  g.fillRect(0, 0, x(clip.srcStart), h);
  g.fillRect(x(clip.srcEnd), 0, w - x(clip.srcEnd), h);

  // the fade shape actually being applied, drawn over the kept region
  const points = fadeEnvelope(clip);
  g.strokeStyle = css('--accent');
  g.lineWidth = 2;
  g.beginPath();
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const t = (clipDuration(clip) * i) / steps;
    const px = x(clip.srcStart + t);
    const py = h - valueAt(points, t) * h * 0.5 - h * 0.02;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.stroke();

  // trim handles
  for (const t of [clip.srcStart, clip.srcEnd]) {
    g.fillStyle = css('--accent');
    g.fillRect(x(t) - 1.5, 0, 3, h);
    g.fillRect(x(t) - 5, h / 2 - 14, 10, 28);
  }

  // playback cursor
  if (state.cursor > clip.srcStart && state.cursor < clip.srcEnd) {
    g.fillStyle = css('--ink');
    g.fillRect(x(state.cursor), 0, 1, h);
  }

  $('lblStart').textContent = fmt(clip.srcStart);
  $('lblEnd').textContent = fmt(clip.srcEnd);

  const gain = clipGain(clip);
  $('level').value = String(clamp(gainToDb(gain), LEVEL_SLIDER.min, LEVEL_SLIDER.max));
  $('valLevel').textContent = `${levelPercent(gain)}%`;

  const maxFade = Math.max(0.1, clipDuration(clip));
  for (const [key, slider, label] of [
    ['fadeIn', $('fadeIn'), $('valFadeIn')],
    ['fadeOut', $('fadeOut'), $('valFadeOut')],
    ['crossfade', $('crossfade'), $('valCrossfade')],
  ]) {
    slider.max = Math.min(10, maxFade).toFixed(1);
    slider.value = String(clip[key] || 0);
    label.textContent = `${(clip[key] || 0).toFixed(1)}s`;
  }
  // the first clip has nothing before it to blend into
  $('crossfadeWrap').classList.toggle('hidden', state.clips.indexOf(clip) === 0);
  updateAlignAvailability();
  updateOrderAvailability();
}

/**
 * The two order buttons, greyed at the ends of the program.
 *
 * Dragging a block is the quick way to reorder and stays the headline one, but
 * it is the *only* way, and HTML drag-and-drop does not fire on a touchscreen
 * at all — so on the tablet the small-screen advisory says this works on, the
 * order simply could not be changed. These also give it a keyboard path, which
 * dragging never had either.
 */
function updateOrderAvailability() {
  const i = state.clips.indexOf(selectedClip());
  const first = i <= 0;
  const last = i < 0 || i >= state.clips.length - 1;
  $('btnMoveLeft').disabled = first;
  $('btnMoveRight').disabled = last;
  $('btnMoveLeft').title = first
    ? 'This song is already first'
    : 'Play this song one place earlier — the same as dragging its block left';
  $('btnMoveRight').title = last
    ? 'This song is already last'
    : 'Play this song one place later — the same as dragging its block right';
}

/** Move the selected song one place earlier or later in the program. */
function moveSelected(by) {
  const i = state.clips.indexOf(selectedClip());
  if (i < 0) return;
  moveClip(i, i + by);
}

/* Enough music either side to hear the join in context. Four seconds is about
   two bars at a walking tempo — long enough to have settled into the first song
   before it hands over, short enough not to be a wait. */
const JOIN_PREVIEW = { lead: 4, tail: 4 };

/**
 * The stretch of programme time to play when auditioning one join.
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

/** Play across the selected clip's join with the one before it. */
function previewJoin() {
  const range = joinPreviewRange(state.clips, state.clips.indexOf(selectedClip()));
  if (!range) return;
  seekTo(range.from);
  playProgram(range.from, range.until);
}

/** How far a join's two cuts may move without eating a clip whole. */
function joinRoom(clip, entry, side) {
  const keep = 0.5;
  return side === 'end'
    ? { min: Math.min(0, keep - clipDuration(clip)), max: Math.max(0, entry.duration - clip.srcEnd) }
    : { min: Math.min(0, -clip.srcStart), max: Math.max(0, clipDuration(clip) - keep) };
}

function updateAlignAvailability() {
  const button = $('btnAlignJoin');
  const clip = selectedClip();
  const i = clip ? state.clips.indexOf(clip) : -1;
  const prev = i > 0 ? state.clips[i - 1] : null;
  const ready = prev && library.get(prev.file)?.buffer && library.get(clip.file)?.buffer;

  button.disabled = !ready;
  button.title = ready
    ? 'Moves this cut and the end of the song before it by up to 2.5 seconds each, '
      + 'so they land on a beat — or, if the music has no steady beat, where a '
      + 'phrase ends'
    : 'Add both songs first';

  const play = $('btnPlayJoin');
  play.disabled = !ready;
  play.title = ready
    ? 'Plays the few seconds either side of this join, so you can hear how the '
      + 'two songs meet without hunting for it on the bar above'
    : 'Add both songs first';
}

/**
 * Nudge the selected clip's join with the one before it onto the beat.
 *
 * Nothing is touched unless there is a beat worth trusting on both sides —
 * declining is a normal outcome here, not a failure, so it reports and stops.
 */
function alignSelectedJoin() {
  const clip = selectedClip();
  const i = clip ? state.clips.indexOf(clip) : -1;
  if (i <= 0) return;
  const prev = state.clips[i - 1];
  const prevEntry = library.get(prev.file);
  const entry = library.get(clip.file);
  if (!prevEntry?.buffer || !entry?.buffer) { toast('Add both songs first'); return; }

  const was = clip.crossfade || 0;
  const result = suggestJoinForBuffers(prevEntry.buffer, prev.srcEnd, entry.buffer, clip.srcStart, {
    crossfade: was,
    // The blend slider tops out at 10s and cannot outlast either clip.
    maxCrossfade: Math.min(10, clipDuration(prev), clipDuration(clip)),
    outRoom: joinRoom(prev, prevEntry, 'end'),
    incRoom: joinRoom(clip, entry, 'start'),
  });

  const moves = result.ok && (Math.abs(result.endShift) >= 0.005
    || Math.abs(result.startShift) >= 0.005
    || Math.abs(result.crossfade - was) >= 0.005);
  if (moves) {
    pushUndo();
    prev.srcEnd = clamp(prev.srcEnd + result.endShift, prev.srcStart + 0.1, prevEntry.duration);
    clip.srcStart = clamp(clip.srcStart + result.startShift, 0, clip.srcEnd - 0.1);
    clip.crossfade = Math.max(0, result.crossfade);
    refresh();
  }
  toast(describeJoin(result, was), 4200);
}

/**
 * Run a piece of analysis that takes long enough to look like a hang.
 *
 * Measuring a four-minute programme is around half a second, and lining up a
 * join runs FFTs over two twelve-second windows. Neither is worth moving off
 * the main thread — but both are long enough that a button which does not
 * change reads as broken and gets clicked a second time. The double frame yield
 * is what lets the disabled state actually paint before the work blocks.
 *
 * The availability rules are re-run afterwards rather than the old `disabled`
 * being restored, because the work itself may have changed whether the button
 * should be live at all.
 */
async function withBusy(button, work) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  // Two frames, so the disabled state is actually on screen before the work
  // blocks — but never *only* frames: a hidden or backgrounded tab stops
  // painting entirely, and waiting on a frame that will never come would leave
  // the button stuck on "Working…" with the work never run at all.
  await new Promise((done) => {
    let settled = false;
    const go = () => { if (!settled) { settled = true; done(); } };
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 50);
  });
  try {
    work();
  } finally {
    button.textContent = label;
    updateEvenOutAvailability();
    updateAlignAvailability();
  }
}

function updateEvenOutAvailability() {
  const button = $('btnEvenOut');
  const ready = state.clips.filter((c) => library.get(c.file)?.buffer).length;
  const reason = state.clips.length < 2 ? 'Add at least two songs first'
    : ready < 2 ? 'Some songs still need to be added'
      : '';
  button.disabled = Boolean(reason);
  button.title = reason
    || 'Sets each song so they all sound about equally loud, without letting any of them distort';
}

/**
 * Put every clip at the same loudness.
 *
 * The measuring is done on what is actually kept of each song, so this has to
 * be redone whenever anything is re-trimmed — which is why it is a button and
 * not something that happens quietly in the background.
 */
function evenOutLevels() {
  const measures = state.clips.map((clip) => {
    const entry = library.get(clip.file);
    return entry?.buffer
      ? measureClip(entry.buffer, clip.srcStart, clip.srcEnd)
      : { loudness: -Infinity, peak: 0 };
  });

  const { gains, short } = solveGains(measures);
  const usable = measures.map((m) => isFinite(m.loudness) && m.peak > 0);
  const matched = usable.filter(Boolean).length;

  if (matched) {
    pushUndo();
    state.clips.forEach((clip, i) => { if (usable[i]) clip.gain = clamp(gains[i], 0, MAX_GAIN); });
    refresh();
  }
  toast(describeLevels({
    matched,
    short: short.length,
    unmeasured: usable.filter((u) => !u).length,
  }), 4200);
}

function bindClipCanvas() {
  const canvas = $('clipCanvas');
  let dragging = null;

  const timeAt = (e) => {
    const clip = selectedClip();
    const entry = library.get(clip.file);
    const duration = entry && entry.buffer ? entry.duration : Math.max(clip.srcEnd, 1);
    const rect = canvas.getBoundingClientRect();
    return clamp(((e.clientX - rect.left) / rect.width) * duration, 0, duration);
  };

  canvas.addEventListener('pointerdown', (e) => {
    const clip = selectedClip();
    if (!clip) return;
    const t = timeAt(e);
    const entry = library.get(clip.file);
    const duration = entry && entry.buffer ? entry.duration : Math.max(clip.srcEnd, 1);
    const grab = (duration / canvas.getBoundingClientRect().width) * 8;   // 8px in seconds

    if (Math.abs(t - clip.srcStart) < grab) dragging = 'start';
    else if (Math.abs(t - clip.srcEnd) < grab) dragging = 'end';
    else { state.cursor = t; drawClipEditor(); return; }

    pushUndo();
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const clip = selectedClip();
    const t = timeAt(e);
    if (dragging === 'start') clip.srcStart = Math.min(t, clip.srcEnd - 0.1);
    else clip.srcEnd = Math.max(t, clip.srcStart + 0.1);
    drawClipEditor();
    renderTimeline();
    updateBudget();
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* never captured */ }
    save();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('dblclick', (e) => {
    const clip = selectedClip();
    if (clip) playClipAudition(clip, timeAt(e));
  });
}

/* ---------------------------------------------------------- time budget */

function updateBudget() {
  const { total } = layout(state.clips);
  const target = state.targetSeconds;
  const tol = state.toleranceSeconds;

  $('totalTime').textContent = fmt(total);

  const delta = total - target;
  const ok = Math.abs(delta) <= tol;
  const label = $('budgetDelta');
  const fill = $('budgetFill');

  if (total === 0) {
    label.textContent = 'add some music';
    label.className = 'delta';
  } else if (ok) {
    label.textContent = `within ${tol}s — good to go`;
    label.className = 'delta ok';
  } else if (delta > 0) {
    label.textContent = `${fmt(delta - tol)} too long`;
    label.className = 'delta bad';
  } else {
    label.textContent = `${fmt(-delta - tol)} too short`;
    label.className = 'delta bad';
  }

  const scale = target + tol * 3;
  fill.style.width = `${clamp((total / scale) * 100, 0, 100)}%`;
  fill.className = 'budget-fill' + (total === 0 ? '' : ok ? ' ok' : ' bad');
  const okBar = $('budgetOk');
  okBar.style.left = `${((target - tol) / scale) * 100}%`;
  okBar.style.width = `${((tol * 2) / scale) * 100}%`;
}

/* ------------------------------------------------------------ persistence */

function project() {
  const level = findLevel(state.level);
  return {
    name: state.name,
    level: state.level,
    // Denormalised on purpose: if the rulebook table changes, an old project
    // still knows the length it was actually built to.
    levelLabel: level ? level.label : 'Custom',
    targetSeconds: state.targetSeconds,
    toleranceSeconds: state.toleranceSeconds,
    clips: state.clips.map((c) => ({
      file: c.file,
      title: c.title,
      srcStart: Number(c.srcStart.toFixed(3)),
      srcEnd: Number(c.srcEnd.toFixed(3)),
      fadeIn: Number((c.fadeIn || 0).toFixed(2)),
      fadeOut: Number((c.fadeOut || 0).toFixed(2)),
      crossfade: Number((c.crossfade || 0).toFixed(2)),
      gain: Number(clipGain(c).toFixed(3)),
    })),
  };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(project()));
  } catch (_) { /* private mode, or quota — Save project still works */ }
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

function loadProject(data) {
  const read = readProject(data);
  state.name = read.name;
  state.level = read.level;
  state.targetSeconds = read.targetSeconds;
  state.toleranceSeconds = read.toleranceSeconds;
  state.clips = read.clips;
  state.selected = state.clips.length ? state.clips[0].id : null;
  if (read.retargeted) {
    toast(`This program targets ${fmtShort(state.targetSeconds)}, `
      + `which no longer matches ${read.retargeted.label}`, 6000);
  }
  $('programName').value = state.name;
  syncLevelPicker();
  refresh();

  // The persistent notice above the timeline does the telling now.
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * A filename you would be happy to see in a folder or email to a coach:
 *   my 2026 junior long program (3-10).mp3
 *
 * Only the characters filesystems actually reject are removed — spaces and
 * ordinary punctuation are kept, so the name reads as it was typed. The target
 * length is appended because competitions usually want it visible, and a colon
 * is not legal in a filename, so 3:10 is written 3-10.
 */
function exportFileName(extension) {
  const name = (state.name || 'my program')
    .replace(/[\\/:*?"<>|]+/g, ' ')      // rejected by Windows or POSIX
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f]+/g, ' ')   // control characters
    .replace(/\s+/g, ' ')
    .slice(0, 90)
    .replace(/^[.\s]+|[.\s]+$/g, '')     // Windows rejects these at either end
    || 'my program';
  const t = Math.max(0, Math.round(state.targetSeconds));
  const length = `${Math.floor(t / 60)}-${String(t % 60).padStart(2, '0')}`;
  return `${name} (${length}).${extension}`;
}

/* Set once the warning has been shown and the choice made, so the second click
   on "Save it anyway" goes through instead of warning again. Reset every time
   the dialog opens. */
let clippingAccepted = false;

/**
 * Say that the programme is too loud to store cleanly, and what fixes it.
 *
 * Deliberately the same shape as the length warning: the route through is still
 * open, because a draft is a legitimate thing to want, but it stops looking like
 * the routine path.
 */
function showClippingWarning() {
  $('clipWarning').classList.remove('hidden');
  const go = $('btnExportGo');
  go.textContent = 'Save it anyway';
  go.classList.remove('primary');
  go.classList.add('danger-solid');
  go.focus();
}

/**
 * Length is the one thing that can get a program marked down no matter how good
 * the edit is, so say plainly how far off it is and what would fix it — a red
 * timer alone is easy to talk yourself past.
 */
function showLengthWarning(total) {
  const tol = state.toleranceSeconds;
  const lo = Math.max(0, state.targetSeconds - tol);
  const hi = state.targetSeconds + tol;
  const box = $('lengthWarning');
  const inRange = total >= lo && total <= hi;

  box.classList.toggle('hidden', inRange);
  // Proceeding is allowed — drafts are legitimate — but it should not look like
  // the routine path when the length is wrong.
  const go = $('btnExportGo');
  go.textContent = inRange ? 'Make the file' : 'Make it anyway';
  go.classList.toggle('primary', inRange);
  go.classList.toggle('danger-solid', !inRange);
  if (inRange) return false;

  const tooLong = total > hi;
  const off = tooLong ? total - hi : lo - total;
  const level = findLevel(state.level);

  $('lengthWarnHead').textContent =
    `${tooLong ? 'Too long' : 'Too short'} by ${off.toFixed(1)} seconds`;
  $('lengthWarnDetail').textContent =
    `Your program is ${fmt(total)}. ${level ? `For ${level.label} the` : 'The'} `
    + `music needs to be between ${fmt(lo)} and ${fmt(hi)}.`;
  $('lengthWarnFix').textContent = tooLong
    ? 'Trim the start or end of a song, or blend two songs together more to '
      + 'overlap them.'
    : 'Add more music, or reduce a blend so the songs overlap less.';
  return true;
}

/* A hair above 1, so a programme that merely touches full scale is not nagged
 * about. Anything genuinely past it is flat-topped by the encoders below. */
const PEAK_TOLERANCE = 1e-4;

/**
 * Does the finished programme go past what a sound file can hold?
 *
 * `solveGains` guards the automatic path carefully, but the Volume slider
 * reaches +24 dB by hand and nothing downstream stops it. `encodeWav` clamps,
 * so the result is flat-topped distortion rather than wrap-around noise —
 * audible, and worth catching here rather than at the rink.
 */
function clipsOnExport(peak) {
  return peak > 1 + PEAK_TOLERANCE;
}

/** Every channel of a rendered buffer, for measuring. */
function channelsOf(buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return channels;
}

/* ---------------------------------------------------------------- export */

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                       // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * channels * 2, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = clamp(data[c][i], -1, 1);
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function encodeMp3(buffer, onProgress) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const encoder = new window.lamejs.Mp3Encoder(channels, buffer.sampleRate, 320);
  const left = buffer.getChannelData(0);
  const right = channels > 1 ? buffer.getChannelData(1) : null;
  const block = 1152;
  const chunks = [];

  const toInt16 = (src, start, len) => {
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const v = clamp(src[start + i] || 0, -1, 1);
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };

  for (let i = 0; i < buffer.length; i += block) {
    const len = Math.min(block, buffer.length - i);
    const l = toInt16(left, i, len);
    const r = right ? toInt16(right, i, len) : null;
    const encoded = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (encoded.length) chunks.push(encoded);
    if (i % (block * 200) === 0) {
      onProgress(i / buffer.length);
      await new Promise((r2) => setTimeout(r2, 0));   // keep the UI responsive
    }
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  onProgress(1);
  return new Blob(chunks, { type: 'audio/mpeg' });
}

async function renderProgram() {
  const { total } = layout(state.clips);
  if (total <= 0) throw new Error('there is no music in the program yet');
  const missing = state.clips.filter((c) => !library.get(c.file)?.buffer);
  if (missing.length) {
    throw new Error(`${missing.length} song${missing.length === 1 ? ' is' : 's are'} still missing`);
  }

  const offline = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
  scheduleProgram(offline, offline.destination, 0, 0);
  return offline.startRendering();
}

async function doExport() {
  const format = $('exportFormat').value;
  const bar = $('exportBar');
  const progress = $('exportProgress');
  const go = $('btnExportGo');

  progress.classList.remove('hidden');
  bar.style.width = '5%';
  go.disabled = true;

  try {
    const rendered = await renderProgram();
    bar.style.width = '40%';

    // Rendering is the cheap half; the encode is what takes the time. Checking
    // the peak here means a distorted programme is caught before any of that,
    // and before a file anyone might take to a competition exists.
    if (clipsOnExport(peakOf(channelsOf(rendered))) && !clippingAccepted) {
      clippingAccepted = true;          // saying "anyway" once is enough
      showClippingWarning();
      return;
    }

    let blob, ext;
    if (format === 'mp3') {
      blob = await encodeMp3(rendered, (p) => { bar.style.width = `${40 + p * 58}%`; });
      ext = 'mp3';
    } else {
      blob = encodeWav(rendered);
      ext = 'wav';
    }
    bar.style.width = '100%';
    const filename = exportFileName(ext);
    download(blob, filename);
    toast(`Saved “${filename}” — ${fmt(rendered.duration)}`, 4500);
    closeExportDialog();
  } catch (err) {
    toast(`Could not make the file: ${err.message}`);
  } finally {
    go.disabled = false;
    progress.classList.add('hidden');
    bar.style.width = '0';
  }
}

/* --------------------------------------------------------------- dialogs */

/* Every modal is a plain div over a backdrop rather than a <dialog>, so the
   three things the platform would have given us — a role, focus that starts
   inside and cannot leave, and focus that goes back afterwards — have to be
   done here. Without the trap, Tab walks straight out of the card and onto the
   controls behind it, which are unreachable by mouse and still operable by
   keyboard. */

const DIALOGS = ['helpModal', 'startDialog', 'exportDialog'];

/** Whichever dialog is on top, or null when none is open. */
function openDialog() {
  return DIALOGS.map($).find((el) => !el.classList.contains('hidden')) || null;
}

let returnFocusTo = null;

function rememberFocus() {
  returnFocusTo = document.activeElement;
}

/** Send focus back where it came from, so keyboard users don't lose their place. */
function restoreFocus() {
  if (returnFocusTo && returnFocusTo.focus) returnFocusTo.focus();
  returnFocusTo = null;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside the open dialog rather than letting it wander behind. */
function trapFocus(e, dialog) {
  if (e.key !== 'Tab') return;
  const items = [...dialog.querySelectorAll(FOCUSABLE)]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function closeExportDialog() {
  $('exportDialog').classList.add('hidden');
  restoreFocus();
}

/** Close whichever dialog is on top. Returns false when none was open. */
function closeTopDialog() {
  const el = openDialog();
  if (!el) return false;
  if (el.id === 'helpModal') closeHelp();
  else if (el.id === 'startDialog') closeStartDialog();
  else closeExportDialog();
  return true;
}

/* ----------------------------------------------------------- help popups */

function openHelp(topic) {
  const source = document.querySelector(`#helpSources [data-help="${topic}"]`);
  if (!source) return;
  $('helpTitle').textContent = source.dataset.title;
  $('helpBody').innerHTML = source.innerHTML;
  rememberFocus();
  $('helpModal').classList.remove('hidden');
  $('helpClose').focus();
}

function closeHelp() {
  $('helpModal').classList.add('hidden');
  restoreFocus();
}

function bindHelp() {
  for (const button of document.querySelectorAll('.help-btn')) {
    button.onclick = () => openHelp(button.dataset.help);
  }
  $('helpClose').onclick = closeHelp;
  // Clicking the backdrop closes; clicking inside the card does not.
  $('helpModal').onclick = (e) => { if (e.target === $('helpModal')) closeHelp(); };
}

/* ------------------------------------------------------------------ wiring */

/** Play from the playhead, wrapping to the start if it sits at the very end. */
function playFromPlayhead() {
  const { total } = layout(state.clips);
  playProgram(state.playPosition >= total - 0.05 ? 0 : state.playPosition);
}

/* ----------------------------------------------------------- start dialog */

/* Unskippable at startup — a program should begin with a name and a target
   length rather than defaults nobody chose. Cancellable when you open it
   yourself from New, so a misclick is not a trap. */
let startDismissable = false;

function openStartDialog(dismissable) {
  startDismissable = dismissable;
  const clips = state.clips.length;

  $('startWarn').classList.toggle('hidden', !dismissable || clips === 0);
  if (dismissable && clips) {
    const { total } = layout(state.clips);
    $('startWarnInfo').textContent =
      `“${state.name}” — ${clips} song${clips === 1 ? '' : 's'}, ${fmt(total)}`;
  }
  $('startCancelRow').classList.toggle('hidden', !dismissable);

  $('startName').value = '';
  fillLevelOptions($('startLevel'));
  $('startLevel').value = findLevel(state.level) ? state.level : 'usfs-juv';
  $('startCustomWrap').classList.add('hidden');

  $('startDialog').classList.remove('hidden');
  $('startName').focus();
}

function closeStartDialog() {
  if (!startDismissable) return;   // startup: choose a route, don't slip past it
  $('startDialog').classList.add('hidden');
}

/** Empty the program but keep the loaded music — a new program usually reuses it. */
function resetProgram() {
  stopPlayback();
  undoStack.length = 0;
  state.clips = [];
  state.selected = null;
  state.cursor = 0;
  state.playPosition = 0;
  $('playhead').textContent = '0:00.0';
  try { localStorage.removeItem(STORE_KEY); } catch (_) { /* private mode */ }
}

function startNewProgram() {
  const levelId = $('startLevel').value;
  let custom = null;

  if (levelId === CUSTOM_LEVEL) {
    custom = parseClock($('startCustom').value);
    if (custom === null) {
      toast('Enter a length like 3:10');
      $('startCustom').focus();
      return;
    }
  }

  resetProgram();
  state.name = $('startName').value.trim() || 'my program';
  if (custom === null) {
    applyLevel(levelId);
  } else {
    state.level = CUSTOM_LEVEL;
    state.targetSeconds = custom;
    state.toleranceSeconds = 10;
  }

  $('programName').value = state.name;
  syncLevelPicker();
  startDismissable = true;              // the choice has been made
  $('startDialog').classList.add('hidden');
  refresh();
  toast(library.size ? 'Ready — add songs from the list on the left'
                     : 'Ready — add your music on the left to begin');
}

function bindStartDialog() {
  $('startLevel').onchange = () => {
    $('startCustomWrap').classList.toggle('hidden', $('startLevel').value !== CUSTOM_LEVEL);
    if ($('startLevel').value === CUSTOM_LEVEL) $('startCustom').focus();
  };
  $('btnStartNew').onclick = startNewProgram;
  $('btnStartCancel').onclick = closeStartDialog;
  $('btnStartLoad').onclick = () => {
    startDismissable = true;            // loading a file is a valid way out
    $('startDialog').classList.add('hidden');
    $('projectInput').click();
  };
  $('startDialog').onclick = (e) => { if (e.target === $('startDialog')) closeStartDialog(); };
  for (const id of ['startName', 'startCustom']) {
    $(id).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); startNewProgram(); } };
  }
}

/**
 * Grey out "Make music file" whenever it could only fail. Better to show the
 * door is shut than to let someone through it and explain afterwards.
 */
function updateExportAvailability() {
  const { total } = layout(state.clips);
  const missing = state.clips.filter((c) => !library.get(c.file)?.buffer).length;
  const button = $('btnExport');

  let reason = '';
  if (total <= 0) {
    reason = 'Add some music to your program first';
  } else if (missing) {
    reason = `${missing} song${missing === 1 ? ' is' : 's are'} still missing — `
      + `add the file${missing === 1 ? '' : 's'} first`;
  }

  button.disabled = Boolean(reason);
  button.title = reason || 'Make the finished music file to take to the competition';
}

/**
 * A saved project holds the edit, not the audio, so after loading one the songs
 * have to be re-added. A toast would be gone before it was read — this stays up
 * until the files are actually there.
 */
function updateMissingNotice() {
  const missing = [...new Set(
    state.clips.filter((c) => !library.get(c.file)?.buffer).map((c) => c.file))];
  $('missingNotice').classList.toggle('hidden', missing.length === 0);
  if (missing.length) {
    $('missingList').textContent = missing.join(' · ');
  }
}

function refresh() {
  updateMissingNotice();
  updateExportAvailability();
  updateEvenOutAvailability();
  // The library is redrawn too: whether a file can be removed depends on
  // whether the program is still using it, so it changes as clips come and go.
  renderLibrary();
  renderTimeline();
  drawScrubber();
  drawClipEditor();
  updateBudget();
  save();
}

/* ------------------------------------------------------------ level picker */

function parseClock(text) {
  const m = String(text).trim().match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const seconds = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return seconds > 0 && seconds < 3600 ? seconds : null;
}

/** Fill any <select> with the level list. Shared by the header and the start dialog. */
function fillLevelOptions(select) {
  select.innerHTML = '';
  for (const group of LEVELS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.group;
    for (const level of group.items) {
      const option = document.createElement('option');
      option.value = level.id;
      // The time is always visible, so a stale rulebook number is obvious.
      option.textContent = `${level.label} — ${fmtShort(level.seconds)} ±${level.tol}s`;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_LEVEL;
  custom.textContent = 'Custom length…';
  select.appendChild(custom);
}

function buildLevelPicker() {
  const select = $('targetLength');
  fillLevelOptions(select);

  select.onchange = () => applyLevel(select.value);
  $('customLength').onchange = () => {
    const seconds = parseClock($('customLength').value);
    if (seconds === null) {
      toast('Enter a time like 3:10');
      $('customLength').value = fmtShort(state.targetSeconds);
      return;
    }
    state.targetSeconds = seconds;
    updateBudget();
    save();
  };

  syncLevelPicker();
}

function applyLevel(id) {
  state.level = id;
  const level = findLevel(id);
  if (level) {
    state.targetSeconds = level.seconds;
    state.toleranceSeconds = level.tol;
  }
  syncLevelPicker();
  updateBudget();
  save();
}

function syncLevelPicker() {
  const select = $('targetLength');
  const custom = $('customLength');
  const isCustom = state.level === CUSTOM_LEVEL || !findLevel(state.level);
  select.value = isCustom ? CUSTOM_LEVEL : state.level;
  custom.classList.toggle('hidden', !isCustom);
  if (isCustom) custom.value = fmtShort(state.targetSeconds);
}

function bind() {
  buildLevelPicker();

  $('programName').value = state.name;
  $('programName').oninput = (e) => { state.name = e.target.value; save(); };

  $('btnAddFiles').onclick = () => $('fileInput').click();
  $('btnAddMissing').onclick = () => $('fileInput').click();

  $('btnNew').onclick = () => openStartDialog(true);
  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  const zone = $('dropzone');
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  zone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  $('btnPlay').onclick = () => (playing ? stopPlayback() : playFromPlayhead());
  $('btnStop').onclick = () => { stopPlayback(); seekTo(0); };
  $('btnPreviewClip').onclick = () => {
    const clip = selectedClip();
    if (clip) playClipAudition(clip, state.cursor > clip.srcStart ? state.cursor : clip.srcStart);
  };
  $('btnRemoveClip').onclick = () => { if (state.selected) removeClip(state.selected); };
  $('btnMoveLeft').onclick = () => moveSelected(-1);
  $('btnMoveRight').onclick = () => moveSelected(1);
  $('btnPlayJoin').onclick = previewJoin;
  $('btnAlignJoin').onclick = () => withBusy($('btnAlignJoin'), alignSelectedJoin);
  $('btnEvenOut').onclick = () => withBusy($('btnEvenOut'), evenOutLevels);

  {
    const slider = $('level');
    let editing = false;
    const begin = () => { if (!editing) { pushUndo(); editing = true; } };
    slider.addEventListener('pointerdown', begin);
    slider.addEventListener('keydown', begin);
    slider.oninput = () => {
      const clip = selectedClip();
      if (!clip) return;
      begin();
      clip.gain = clamp(dbToGain(Number(slider.value)), 0, MAX_GAIN);
      drawClipEditor();
    };
    slider.onchange = () => { editing = false; save(); };
  }

  for (const key of ['fadeIn', 'fadeOut', 'crossfade']) {
    const slider = $(key);
    let editing = false;
    // Snapshot before the gesture starts, not after — pushing undo on `change`
    // would capture the already-modified value and make undo a no-op.
    const begin = () => { if (!editing) { pushUndo(); editing = true; } };
    slider.addEventListener('pointerdown', begin);
    slider.addEventListener('keydown', begin);
    slider.oninput = () => {
      const clip = selectedClip();
      if (!clip) return;
      begin();
      clip[key] = Number(slider.value);
      drawClipEditor();
      renderTimeline();
      updateBudget();
    };
    slider.onchange = () => { editing = false; save(); };
  }

  $('btnExport').onclick = () => {
    const { total } = layout(state.clips);
    if (total <= 0) { toast('Add some music to your program first'); return; }
    $('exportSummary').textContent =
      `${fmt(total)} — target ${fmtShort(state.targetSeconds)} ±${state.toleranceSeconds}s`;
    // A fresh look at the programme: whatever was too loud last time may have
    // been turned down since.
    clippingAccepted = false;
    $('clipWarning').classList.add('hidden');
    const tooLong = showLengthWarning(total);

    // Exporting at 320k cannot recover detail a bad source never had, so say so
    // here rather than after the file has been taken to the rink.
    const weak = weakSources();
    const box = $('exportWarnings');
    box.classList.toggle('hidden', weak.length === 0);
    box.innerHTML = '';
    if (weak.length) {
      const head = document.createElement('p');
      const worst = weak.some((e) => e.quality.kind === 'poor');
      head.className = 'warn-head';
      head.textContent = worst
        ? 'Some music is low quality — it may sound rough on a rink sound system.'
        : 'Some music is below CD quality.';
      box.appendChild(head);
      for (const entry of weak) {
        const row = document.createElement('div');
        row.className = 'warn-row';
        const badge = document.createElement('span');
        badge.className = `badge ${entry.quality.kind}`;
        badge.textContent = qualityLabel(entry.quality);
        badge.title = qualityDetail(entry.quality);
        row.appendChild(badge);
        const name = document.createElement('span');
        name.textContent = entry.name
          + (entry.quality.notes.length ? ` (${entry.quality.notes.join(', ')})` : '');
        row.appendChild(name);
        box.appendChild(row);
      }
      const tail = document.createElement('p');
      tail.className = 'hint';
      tail.textContent = 'Saving at higher quality will not fix this — you need '
        + 'a better copy of the song itself. You can carry on anyway.';
      box.appendChild(tail);
    }
    rememberFocus();
    $('exportDialog').classList.remove('hidden');
    // The safe option takes focus when the length is wrong, so the keyboard
    // route through a warning is never the one that ignores it.
    (tooLong ? $('btnExportCancel') : $('btnExportGo')).focus();
  };
  $('btnExportCancel').onclick = closeExportDialog;
  $('btnExportGo').onclick = doExport;

  $('btnSaveProject').onclick = () => {
    download(new Blob([JSON.stringify(project(), null, 2) + '\n'], { type: 'application/json' }),
      exportFileName('json'));
    toast('Project saved to your downloads');
  };
  $('btnLoadProject').onclick = () => $('projectInput').click();
  $('projectInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.clips)) throw new Error('no clips');
      loadProject(data);
    } catch (_) {
      toast('That does not look like a saved project');
    }
    e.target.value = '';
  };

  bindClipCanvas();
  bindScrubber();
  bindHelp();
  window.addEventListener('resize', () => { renderTimeline(); drawScrubber(); drawClipEditor(); });
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  // Escape closes whichever dialog is open, wherever focus happens to be.
  if (e.key === 'Escape' && closeTopDialog()) return;

  // A dialog is open — it owns the keyboard, and Tab stays inside it. The
  // export dialog used to be left out of this, so Space, Delete and the trim
  // keys all still reached the programme behind it.
  const dialog = openDialog();
  if (dialog) { trapFocus(e, dialog.querySelector('.modal-card') || dialog); return; }

  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const clip = selectedClip();
  const nudge = e.shiftKey ? 1 : 0.1;

  if (e.code === 'Space') {
    e.preventDefault();
    if (playing) stopPlayback(); else playFromPlayhead();
    return;
  }
  if (e.key === 'Home') { e.preventDefault(); stopPlayback(); seekTo(0); return; }
  if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); return; }
  if (!clip) return;

  // Tagged, so holding one of these down is a single undo step rather than
  // thirty that bury everything before them.
  if (e.key === 'i' || e.key === 'I') {
    pushUndo(`trim-in:${clip.id}`);
    clip.srcStart = clamp(state.cursor, 0, clip.srcEnd - 0.1);
    refresh();
  } else if (e.key === 'o' || e.key === 'O') {
    const entry = library.get(clip.file);
    pushUndo(`trim-out:${clip.id}`);
    clip.srcEnd = clamp(state.cursor, clip.srcStart + 0.1, entry ? entry.duration : clip.srcEnd);
    refresh();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); removeClip(clip.id);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    pushUndo(`nudge-end:${clip.id}`);
    clip.srcEnd = Math.max(clip.srcStart + 0.1, clip.srcEnd + dir * nudge);
    refresh();
  } else if (e.key === '[' || e.key === ']') {
    const i = state.clips.indexOf(clip);
    const next = state.clips[i + (e.key === ']' ? 1 : -1)];
    if (next) { state.selected = next.id; state.cursor = next.srcStart; refresh(); }
  }
}

/*
 * MP3 encoder. Browsers can decode MP3 but none can encode it, so the encoder
 * has to come from somewhere — lamejs is a 156 KB JS port of LAME.
 *
 * Loaded from a CDN so the app is a single HTML file you can drop on any host
 * with nothing to install. It is fetched asynchronously and the app does not
 * wait for it: if it is slow the editor still starts, and if it never arrives
 * WAV export carries on working. The integrity hash pins the exact bytes, so a
 * compromised or altered CDN copy is refused rather than executed.
 */
const LAME_URL = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
const LAME_SRI = 'sha384-xuasJXVcyv3hZq0eYpelEkBC8l4yufatZXDsKuyCU2rqfhDCb+ftuE/mSfZAteiK';

function tryLoadLame() {
  const script = document.createElement('script');
  script.src = LAME_URL;
  script.integrity = LAME_SRI;
  script.crossOrigin = 'anonymous';
  script.async = true;
  script.onload = () => {
    mp3Ready = typeof window.lamejs !== 'undefined';
    updateExportOptions();
  };
  script.onerror = updateExportOptions;
  document.head.appendChild(script);
}

function updateExportOptions() {
  const select = $('exportFormat');
  const mp3Option = select.querySelector('option[value=mp3]');
  mp3Option.disabled = !mp3Ready;
  if (mp3Ready) {
    mp3Option.textContent = "MP3 — smaller, usually what's asked for";
    select.value = 'mp3';
    $('exportNote').textContent = 'MP3 is what most competitions ask for.';
  } else {
    mp3Option.textContent = 'MP3 — could not be loaded';
    select.value = 'wav';
    $('exportNote').textContent =
      'The MP3 encoder could not be reached, so only WAV is available right now. '
      + 'WAV plays anywhere, it is just a much larger file.';
  }
}

/* ------------------------------------------------------- browser support */

/**
 * What this actually needs, and why. Everything here is a hard requirement —
 * without it the editor cannot do its job, so say so plainly rather than
 * letting someone hit a broken button ten minutes in.
 */
function unsupportedReasons() {
  const missing = [];
  if (!(window.AudioContext || window.webkitAudioContext)) {
    missing.push('playing and mixing audio');
  }
  if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) {
    missing.push('building the finished file');
  }
  if (!(window.File && window.FileList && (window.FileReader || Blob.prototype.arrayBuffer))) {
    missing.push('reading music files from your computer');
  }
  if (!window.URL || !URL.createObjectURL) {
    missing.push('saving files back out');
  }
  return missing;
}

/** Older Safari has no Blob.arrayBuffer; FileReader covers it. */
function readFileBytes(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

const SMALL_SCREEN_KEY = 'skate.smallScreenSeen';

/* Not a blocker — it does work on a tablet. But decoded audio is uncompressed,
 * so a few long songs will exhaust the memory a mobile browser allows, and the
 * failure looks like a crash rather than an explanation. */
function maybeWarnSmallScreen() {
  const small = window.matchMedia('(max-width: 860px), (pointer: coarse)').matches;
  let seen = false;
  try { seen = localStorage.getItem(SMALL_SCREEN_KEY) === '1'; } catch (_) { /* private mode */ }
  if (!small || seen) return;

  $('smallScreen').classList.remove('hidden');
  $('btnDismissSmall').onclick = () => {
    $('smallScreen').classList.add('hidden');
    try { localStorage.setItem(SMALL_SCREEN_KEY, '1'); } catch (_) { /* private mode */ }
  };
}

function init() {
  const missing = unsupportedReasons();
  if (missing.length) {
    $('unsupportedWhy').textContent =
      `This browser is missing what the editor needs for ${missing.join(', ')}.`;
    $('unsupported').classList.remove('hidden');
    return;   // nothing below would work anyway
  }
  maybeWarnSmallScreen();

  bind();
  bindStartDialog();
  tryLoadLame();

  let saved = null;
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) {
      saved = JSON.parse(stored);
      loadProject(saved);
    }
  } catch (_) { /* start empty */ }

  refresh();
  // Only interrupt when there is no work to come back to.
  if (!saved || !(saved.clips || []).length) openStartDialog(false);
}

/* In a browser, start. Under Node — the test suite — export the pure logic
   instead, so the maths can be checked without a DOM. */
if (typeof document !== 'undefined') {
  init();
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    state, LEVELS, QUALITY, CODEC_EFFICIENCY, CUSTOM_LEVEL,
    allLevels, findLevel,
    clipDuration, crossfadeOf, layout, reordered, clampClipsToFile, MIN_CLIP,
    rampEnvelope, movingAverage, frameCount,
    joinPreviewRange, JOIN_PREVIEW, clipsOnExport,
    fadeEnvelope, crossfadeEnvelope, valueAt,
    BEAT, fftInPlace, onsetEnvelope, flattenEnvelope, estimateTempoLag,
    analyseBeats, suggestJoin, monoWindow, beatsAround, suggestJoinForBuffers,
    describeJoin, joinRoom,
    PHRASE, gapScores, energyEnvelope, chromaFrames, chromaDistance, noveltyScores,
    phrasePoints, suggestPhraseJoin, windowAround,
    LOUDNESS, kWeighting, biquad, loudnessOf, peakOf, measureClip, solveGains,
    clipGain, gainToDb, dbToGain, levelPercent, describeLevels, LEVEL_SLIDER, MAX_GAIN,
    parseClock, exportFileName, fmt, fmtShort, clamp,
    project, readProject,
    undoStack, pushUndo, endUndoRun, UNDO_COALESCE_MS, UNDO_DEPTH,
    clipsUsing,
    codecOf, qualityLabel, qualityDetail, qualityKind,
    id3Size, oggAudioStart, readMpegFrame, parseFrameHeader,
    unsupportedReasons, LAME_URL, LAME_SRI,
  };
}
