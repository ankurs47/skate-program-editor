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

function fmt(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function fmtShort(seconds) {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.round(seconds - m * 60)).padStart(2, '0')}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
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

/** Piecewise-linear breakpoints for a clip's intrinsic fades. */
function fadeEnvelope(clip) {
  const dur = clipDuration(clip);
  const fi = clamp(clip.fadeIn || 0, 0, dur);
  const fo = clamp(clip.fadeOut || 0, 0, dur);
  const points = [[0, fi > 0 ? 0 : 1]];
  if (fi > 0) points.push([fi, 1]);
  if (fo > 0) {
    const outStart = Math.max(fi, dur - fo);
    points.push([outStart, 1], [dur, 0]);
  } else {
    points.push([dur, 1]);
  }
  return points;
}

/** Breakpoints for the crossfade with the previous and next clips. */
function crossfadeEnvelope(clips, i) {
  const dur = clipDuration(clips[i]);
  const inX = crossfadeOf(clips, i);
  const outX = i + 1 < clips.length ? crossfadeOf(clips, i + 1) : 0;
  const points = [[0, inX > 0 ? 0 : 1]];
  if (inX > 0) points.push([inX, 1]);
  if (outX > 0) {
    const outStart = Math.max(inX, dur - outX);
    points.push([outStart, 1], [dur, 0]);
  } else {
    points.push([dur, 1]);
  }
  return points;
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
 * what she hears is what gets exported.
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
    const fade = context.createGain();
    const blend = context.createGain();
    src.connect(fade).connect(blend).connect(destination);

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

function playProgram(fromTime = 0) {
  const { total } = layout(state.clips);
  if (total <= 0) return;
  stopPlayback();
  const context = ctx();
  const when = context.currentTime + 0.08;   // small lead so nothing is late
  const nodes = scheduleProgram(context, context.destination, when, fromTime);
  if (!nodes.length) { toast('Add some music files first'); return; }
  playing = { nodes, startedAt: when, fromTime, mode: 'program', total };
  $('btnPlayLabel').textContent = 'Pause';
  tickPlayhead();
}

function playClipAudition(clip, fromSource) {
  const entry = library.get(clip.file);
  if (!entry || !entry.buffer) { toast('That file is not loaded'); return; }
  stopPlayback();
  const context = ctx();
  const src = context.createBufferSource();
  src.buffer = entry.buffer;
  src.connect(context.destination);
  const from = clamp(fromSource, clip.srcStart, clip.srcEnd);
  const when = context.currentTime + 0.05;
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
      if (at >= playing.total) { stopPlayback(); return; }
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
  const efficiency = CODEC_EFFICIENCY[codec] || 1;

  // Nothing measurable and not a known lossless format — say so rather than
  // implying it's fine.
  let kind = (!lossless && bitrate === null) ? 'unknown' : 'good';
  if (!lossless && bitrate !== null) {
    // Judge on the MP3-equivalent figure; display the real one.
    const effective = bitrate * efficiency;
    if (effective < QUALITY.minBitrate) kind = 'poor';
    else if (effective < QUALITY.goodBitrate) kind = 'caution';
  }
  if (sampleRate !== null && kind !== 'unknown') {
    if (sampleRate < QUALITY.minSampleRate) kind = 'poor';
    else if (sampleRate < QUALITY.goodSampleRate && kind === 'good') kind = 'caution';
  }

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

function drawWave(canvas, peaks, duration, t0, t1, color) {
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
    const y0 = mid - mx * mid * 0.94;
    const y1 = mid - mn * mid * 0.94;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* --------------------------------------------------------------- library */

async function addFiles(fileList) {
  const files = Array.from(fileList).filter(
    (f) => /audio|\.(mp3|wav|flac|m4a|ogg|opus|aac|webm|aiff?)$/i.test(f.type + f.name));
  if (!files.length) { toast('No audio files in that drop'); return; }

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
    li.appendChild(row);
    list.appendChild(li);
  }
}

/* ----------------------------------------------------------------- clips */

function pushUndo() {
  undoStack.push(JSON.stringify(state.clips));
  if (undoStack.length > 60) undoStack.shift();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) { toast('Nothing to undo'); return; }
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

function moveClip(fromIndex, toIndex) {
  if (fromIndex === toIndex || toIndex < 0 || toIndex >= state.clips.length) return;
  pushUndo();
  const [clip] = state.clips.splice(fromIndex, 1);
  state.clips.splice(toIndex, 0, clip);
  if (state.clips.length) state.clips[0].crossfade = 0;
  refresh();
}

/* -------------------------------------------------------------- timeline */

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

    el.ondragstart = (e) => { el.classList.add('dragging'); e.dataTransfer.setData('text/plain', String(i)); };
    el.ondragend = () => el.classList.remove('dragging');
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      moveClip(Number(e.dataTransfer.getData('text/plain')), i);
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

  drawWave(canvas, entry ? entry.peaks : null, duration, 0, duration, css('--wave'));

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
    i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
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

  const maxFade = Math.max(0.1, clipDuration(clip));
  for (const [key, slider, label] of [
    ['fadeIn', $('fadeIn'), $('valFadeIn')],
    ['fadeOut', $('fadeOut'), $('valFadeOut')],
    ['crossfade', $('crossfade'), $('valCrossfade')],
  ]) {
    slider.max = String(Math.min(10, maxFade).toFixed(1));
    slider.value = String(clip[key] || 0);
    label.textContent = `${(clip[key] || 0).toFixed(1)}s`;
  }
  // the first clip has nothing before it to blend into
  $('crossfadeWrap').classList.toggle('hidden', state.clips.indexOf(clip) === 0);
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
    })),
  };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(project()));
  } catch (_) { /* private mode, or quota — Save project still works */ }
}

function loadProject(data) {
  state.name = data.name || 'my program';
  // The stored time wins over the level's current table value, so reopening an
  // old program never silently retargets it because a rulebook number changed.
  state.level = data.level || CUSTOM_LEVEL;
  state.targetSeconds = data.targetSeconds || 135;
  state.toleranceSeconds = data.toleranceSeconds || 10;
  const level = findLevel(state.level);
  if (level && level.seconds !== state.targetSeconds) {
    state.level = CUSTOM_LEVEL;
    toast(`This program targets ${fmtShort(state.targetSeconds)}, which no longer matches ${level.label}`, 6000);
  }
  state.clips = (data.clips || []).map((c) => ({
    id: uid(),
    file: c.file,
    title: c.title || String(c.file).replace(/\.[^.]+$/, ''),
    srcStart: c.srcStart || 0,
    srcEnd: c.srcEnd || 0,
    fadeIn: c.fadeIn || 0,
    fadeOut: c.fadeOut || 0,
    crossfade: c.crossfade || 0,
  }));
  state.selected = state.clips.length ? state.clips[0].id : null;
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
    $('exportDialog').classList.add('hidden');
  } catch (err) {
    toast(`Could not make the file: ${err.message}`);
  } finally {
    go.disabled = false;
    progress.classList.add('hidden');
    bar.style.width = '0';
  }
}

/* ----------------------------------------------------------- help popups */

let helpReturnFocus = null;

function openHelp(topic) {
  const source = document.querySelector(`#helpSources [data-help="${topic}"]`);
  if (!source) return;
  $('helpTitle').textContent = source.dataset.title;
  $('helpBody').innerHTML = source.innerHTML;
  helpReturnFocus = document.activeElement;
  $('helpModal').classList.remove('hidden');
  $('helpClose').focus();
}

function closeHelp() {
  $('helpModal').classList.add('hidden');
  // Send focus back where it came from, so keyboard users don't lose their place.
  if (helpReturnFocus && helpReturnFocus.focus) helpReturnFocus.focus();
  helpReturnFocus = null;
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
    showLengthWarning(total);

    // Exporting at 320k cannot recover detail a bad source never had, so say so
    // here rather than after she has taken the file to the rink.
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
    $('exportDialog').classList.remove('hidden');
  };
  $('btnExportCancel').onclick = () => $('exportDialog').classList.add('hidden');
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
  if (e.key === 'Escape') {
    if (!$('helpModal').classList.contains('hidden')) { closeHelp(); return; }
    if (!$('startDialog').classList.contains('hidden')) { closeStartDialog(); return; }
    for (const id of ['exportDialog']) {
      if (!$(id).classList.contains('hidden')) {
        $(id).classList.add('hidden');
        return;
      }
    }
  }
  // A dialog is open — let it have the keyboard.
  if (!$('helpModal').classList.contains('hidden')) return;
  if (!$('startDialog').classList.contains('hidden')) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const clip = selectedClip();
  const nudge = e.shiftKey ? 1 : 0.1;

  if (e.code === 'Space') { e.preventDefault(); playing ? stopPlayback() : playFromPlayhead(); return; }
  if (e.key === 'Home') { e.preventDefault(); stopPlayback(); seekTo(0); return; }
  if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); return; }
  if (!clip) return;

  if (e.key === 'i' || e.key === 'I') {
    pushUndo(); clip.srcStart = clamp(state.cursor, 0, clip.srcEnd - 0.1); refresh();
  } else if (e.key === 'o' || e.key === 'O') {
    const entry = library.get(clip.file);
    pushUndo();
    clip.srcEnd = clamp(state.cursor, clip.srcStart + 0.1, entry ? entry.duration : clip.srcEnd);
    refresh();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); removeClip(clip.id);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    pushUndo();
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
    clipDuration, crossfadeOf, layout,
    fadeEnvelope, crossfadeEnvelope, valueAt,
    parseClock, exportFileName, fmt, fmtShort, clamp,
    codecOf, qualityLabel, qualityDetail,
    id3Size, oggAudioStart, readMpegFrame, parseFrameHeader,
    unsupportedReasons, LAME_URL, LAME_SRI,
  };
}
