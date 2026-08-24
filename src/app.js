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
/* One list, two shapes: the file picker wants extensions with dots, and the
   drop handler wants something to test a name against. */
const AUDIO_EXTENSION_LIST = [
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.webm', '.aif', '.aiff',
];
const AUDIO_EXTENSIONS =
  new RegExp(`(${AUDIO_EXTENSION_LIST.map((e) => `\\${e}`).join('|')})$`, 'i');
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
  // name -> {bytes, seconds, fingerprint} from the project file, so a song that
  // arrives can be checked against the one the edit was built from. Empty for a
  // programme built in this sitting, where the question does not arise.
  expectedFiles: new Map(),
};

const library = new Map();   // file name -> {name, buffer, peaks, duration, state}
const undoStack = [];
const redoStack = [];

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

/**
 * A colour from the stylesheet.
 *
 * Cached, because `getComputedStyle` forces the browser to resolve style before
 * it can answer, and the drawing code asks for four to eight colours every
 * animation frame while something is playing. The values only change when the
 * theme does, which is a thing we are told about.
 */
const palette = new Map();

function css(name) {
  if (!palette.has(name)) {
    palette.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }
  return palette.get(name);
}

/**
 * Forget the cached colours and repaint, for when the theme changes underneath.
 *
 * The strip and the list only rebuild when their contents change, and a theme
 * change is invisible to that test — so the caches saying "already drawn" have
 * to be cleared as well, or the new colours never reach the canvases.
 */
function repaintForTheme() {
  palette.clear();
  libraryShape = null;
  timelineShape = null;
  renderLibrary();
  renderTimeline();
  drawScrubber();
  drawClipEditor();
}

/* ----------------------------------------------------------------- theme */

/* Three modes, not two. "auto" is the default and means the page keeps
   following whatever the computer is set to, including when that flips at
   dusk — a plain light/dark switch throws that away the first time it is
   touched. The stored value is read by the guide page too, which is why the
   key and the three names are spelled the same in both. */
const THEME_KEY = 'skate.theme';
const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_WORDS = { auto: 'Auto', light: 'Light', dark: 'Dark' };

/** The stored mode, or 'auto' when nothing valid is stored. */
function storedTheme() {
  let value = null;
  try { value = localStorage.getItem(THEME_KEY); } catch (_) { /* private mode */ }
  return THEME_MODES.includes(value) ? value : 'auto';
}

/**
 * Put `mode` on the root element, where the stylesheet is watching for it.
 *
 * 'auto' removes the attribute rather than setting it to anything: the media
 * query is the default, and an attribute of "auto" would just be a value the
 * CSS has to know to ignore.
 */
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);

  const button = $('btnTheme');
  if (!button) return;
  button.dataset.mode = mode;
  $('themeLabel').textContent = THEME_WORDS[mode];
  const next = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
  button.title = mode === 'auto'
    ? `Colours follow this computer. Switch to ${THEME_WORDS[next].toLowerCase()}.`
    : `Colours are set to ${THEME_WORDS[mode].toLowerCase()}. Switch to ${THEME_WORDS[next].toLowerCase()}.`;
  button.setAttribute('aria-label', button.title);
}

/** Step to the next mode, remember it, and repaint what the CSS cannot. */
function cycleTheme() {
  const mode = THEME_MODES[(THEME_MODES.indexOf(storedTheme()) + 1) % THEME_MODES.length];
  try { localStorage.setItem(THEME_KEY, mode); } catch (_) { /* private mode */ }
  applyTheme(mode);
  /* The canvases hold colours that were resolved when they were drawn, so the
     stylesheet changing underneath them is not enough on its own. */
  repaintForTheme();
}

/* ------------------------------------------------------- the music sidebar */

/* Collapsing it is a view preference rather than part of the programme, so it
   lives beside the theme in storage and never touches the project file. */
const LIBRARY_KEY = 'skate.musicPanel';

/** Show or hide the music sidebar, and remember which. */
function setLibraryCollapsed(collapsed) {
  document.querySelector('main').classList.toggle('library-collapsed', collapsed);
  const button = $('btnLibraryToggle');
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = collapsed ? 'Show the music list' : 'Hide the music list';
  button.setAttribute('aria-label', button.title);
  try { localStorage.setItem(LIBRARY_KEY, collapsed ? 'collapsed' : 'open'); }
  catch (_) { /* private mode */ }
  /* Every canvas is sized from its box, and the box just changed by 300px.
     Nothing fires a resize event for a class change, so they are redrawn by
     hand — without this the waveforms stay at the old width until the window
     itself is resized. */
  renderTimeline();
  drawScrubber();
  drawClipEditor();
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
  const wrongFile = [];

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
      entry.bytes = file.size;
      entry.fingerprint = fingerprint(head);
      entry.state = 'ready';
      const complaint = describeWrongFile(state.expectedFiles.get(file.name), entry);
      if (complaint) wrongFile.push(complaint);
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
  /* Said before anything about trimming: if the wrong song has been handed
     over, every other number on screen is about the wrong song too. */
  if (wrongFile.length) {
    toast(wrongFile.length === 1 ? wrongFile[0]
      : `${wrongFile.length} songs are not the ones this program was built from — `
        + 'check them before you use it', 7000);
  }
  if (shortened) {
    save();
    toast(shortened === 1
      ? 'One song asked for more music than its file holds, so it was shortened to fit'
      : `${shortened} songs asked for more music than their files hold, so they were shortened to fit`,
    6000);
  }
  /* What is now playable of what was asked for, in the order it was dropped, so
     a drop onto the timeline can add exactly those. Looked up rather than
     collected in the loop above, which skips files that were already loaded —
     dropping one of those again should still put it in the programme. */
  return files
    .map((file) => library.get(file.name))
    .filter((entry) => entry && entry.buffer);
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

/* Nothing about the list changes as often as it was being rebuilt. It is in
   `refresh()` because whether a file can be removed depends on whether the
   programme still uses it — but that answer, and everything else on show here,
   changes far less often than `refresh()` is called. */
let libraryShape = null;

function librarySignature() {
  return [...library.values()]
    .map((entry) => [
      entry.name,
      entry.state,
      Math.round(entry.duration),
      entry.quality ? entry.quality.kind : '',
      entry.peaks ? 1 : 0,
      clipsUsing(entry.name),                  // whether Remove is available
    ].join(':'))
    .join('|');
}

function renderLibrary() {
  const signature = librarySignature();
  if (signature === libraryShape) return;
  libraryShape = signature;

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

/**
 * Everything an undo has to put back.
 *
 * Not just the clips. Renaming the programme or changing the event used to be
 * outside the stack entirely, so picking the wrong level lost the length you
 * had been working to with no way back — the one number the whole edit is aimed
 * at. These are the same fields the project file records, for the same reason.
 */
function undoSnapshot() {
  return JSON.stringify({
    name: state.name,
    level: state.level,
    targetSeconds: state.targetSeconds,
    toleranceSeconds: state.toleranceSeconds,
    clips: state.clips,
  });
}

function pushUndo(tag = null) {
  const now = Date.now();
  if (tag !== null && tag === undoRun.tag && now - undoRun.at < UNDO_COALESCE_MS) {
    undoRun.at = now;      // the gesture continues; its opening snapshot stands
    return;
  }
  undoRun = { tag, at: now };
  undoStack.push(undoSnapshot());
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  // A new edit is a new branch of history: whatever was undone to get here is
  // no longer reachable, and offering to redo it would put back something that
  // never followed from this state.
  redoStack.length = 0;
}

/** End any run of coalesced edits, so the next one starts a fresh entry. */
function endUndoRun() {
  undoRun = { tag: null, at: 0 };
}

/**
 * Step back, handing over the state to apply, or null when there is nowhere to
 * go. Separate from `undo()` because the stacks are worth testing without a DOM
 * to apply the result to.
 */
function takeUndo() {
  if (!undoStack.length) return null;
  const previous = undoStack.pop();
  redoStack.push(undoSnapshot());
  endUndoRun();
  return previous;
}

/** The same, forwards. */
function takeRedo() {
  if (!redoStack.length) return null;
  const next = redoStack.pop();
  undoStack.push(undoSnapshot());
  endUndoRun();
  return next;
}

/**
 * Put a snapshot back on screen.
 *
 * `takeUndo` and `takeRedo` end the coalescing run before this is reached:
 * without that, nudging again straight after an undo would be folded into the
 * run whose snapshot had just been popped, and that second edit could not be
 * undone at all.
 */
function applySnapshot(json) {
  const saved = JSON.parse(json);
  state.name = saved.name;
  state.level = saved.level;
  state.targetSeconds = saved.targetSeconds;
  state.toleranceSeconds = saved.toleranceSeconds;
  state.clips = saved.clips;
  if (!state.clips.some((c) => c.id === state.selected)) {
    state.selected = state.clips.length ? state.clips[state.clips.length - 1].id : null;
  }
  $('programName').value = state.name;
  syncLevelPicker();
  refresh();
}

function undo() {
  const previous = takeUndo();
  if (previous === null) { toast('Nothing to undo'); return; }
  applySnapshot(previous);
}

function redo() {
  const next = takeRedo();
  if (next === null) { toast('Nothing to redo'); return; }
  applySnapshot(next);
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

/* What the strip's elements were built for. Dragging a slider changes numbers,
   not structure — but the whole strip was being torn down and rebuilt on every
   input event, which at pointer rate meant hundreds of elements and canvases a
   second, each with fresh handlers attached. This is how the two are told
   apart: anything in the signature needs new elements, anything else only needs
   the existing ones updated. */
let timelineShape = null;

function timelineSignature(clips, parts) {
  return clips.map((clip, i) => [
    clip.id,
    clip.file,
    clip.title,
    clip.id === state.selected ? 1 : 0,
    library.get(clip.file)?.buffer ? 1 : 0,
    parts[i].xf >= MIN_CROSSFADE ? 1 : 0,      // whether a blend marker is shown
  ].join(':')).join('|');
}

/**
 * Redraw every clip's waveform, at most once per animation frame.
 *
 * Drawing is the expensive half and a pointer can fire several input events
 * inside one frame, so doing it on each of them is work nobody ever sees. The
 * old code deferred each canvas separately, which was worse than it looked: the
 * next event replaced the whole strip first, so those callbacks painted into
 * canvases that had already been thrown away.
 */
let timelineWaveFrame = 0;

function drawTimelineWaves() {
  const blocks = $('timeline').querySelectorAll('.tl-clip');
  state.clips.forEach((clip, i) => {
    const canvas = blocks[i] && blocks[i].querySelector('canvas');
    const entry = library.get(clip.file);
    if (!canvas || !entry || !entry.peaks) return;
    drawWave(canvas, entry.peaks, entry.duration, clip.srcStart, clip.srcEnd,
      clip.id === state.selected ? css('--wave-sel') : css('--wave'));
  });
}

function scheduleTimelineWaves() {
  if (timelineWaveFrame) return;
  timelineWaveFrame = requestAnimationFrame(() => {
    timelineWaveFrame = 0;
    drawTimelineWaves();
  });
}

/**
 * Update what the existing blocks say, without replacing any of them.
 *
 * Text and widths are cheap and go in straight away, so the strip never lags a
 * frame behind the slider. The waveforms follow on the next frame.
 */
function syncTimelineMetrics(parts, total) {
  const wrap = $('timeline');
  const blocks = wrap.querySelectorAll('.tl-clip');
  const markers = wrap.querySelectorAll('.tl-xf');
  let marker = 0;

  state.clips.forEach((clip, i) => {
    if (parts[i].xf >= MIN_CROSSFADE && markers[marker]) {
      const tag = markers[marker++];
      tag.textContent = `↔ ${parts[i].xf.toFixed(1)}s`;
      tag.title = `blends ${parts[i].xf.toFixed(1)}s into the previous clip`;
    }
    const el = blocks[i];
    if (!el) return;
    const share = total > 0 ? parts[i].dur / total : 1 / state.clips.length;
    el.style.flex = `${share.toFixed(4)} 1 0`;

    const entry = library.get(clip.file);
    el.querySelector('.tl-dur').textContent =
      entry && entry.buffer ? fmt(parts[i].dur) : 'file missing';
  });
  scheduleTimelineWaves();
}

function renderTimeline() {
  const wrap = $('timeline');
  const { parts, total } = layout(state.clips);
  $('timelineEmpty').classList.toggle('hidden', state.clips.length > 0);

  const signature = timelineSignature(state.clips, parts);
  if (signature === timelineShape && wrap.querySelectorAll('.tl-clip').length === state.clips.length) {
    syncTimelineMetrics(parts, total);
    return;
  }
  timelineShape = signature;
  wrap.innerHTML = '';

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
  });
  scheduleTimelineWaves();
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

  /* Fade everything outside the kept region back towards the panel it sits on.
     This used to be a flat rgba(0,0,0,.35), which reads as "dimmed" over a dark
     panel and as a heavy grey slab over a light one — the discarded audio ended
     up louder than the audio being kept. Painting the panel colour over it
     instead washes the waveform out in either theme, which is what dimming is
     supposed to look like. */
  g.save();
  g.globalAlpha = 0.62;
  g.fillStyle = css('--panel');
  g.fillRect(0, 0, x(clip.srcStart), h);
  g.fillRect(x(clip.srcEnd), 0, w - x(clip.srcEnd), h);
  g.restore();

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

/** One record per song the programme uses, for the project file. */
function usedFiles() {
  const names = [...new Set(state.clips.map((c) => c.file))];
  return names.map((name) => {
    const entry = library.get(name);
    const known = entry && entry.fingerprint ? entry : state.expectedFiles.get(name);
    return {
      name,
      bytes: known && known.bytes ? known.bytes : null,
      seconds: known && known.duration ? Number(known.duration.toFixed(2))
        : (known && known.seconds) || null,
      fingerprint: (known && known.fingerprint) || null,
    };
  }).filter((f) => f.fingerprint);   // nothing useful to say about the rest
}

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
    /* What each song was, so opening this later can tell whether it has been
       handed the right one. Not where it was: a browser will not say where a
       file lives, and a handle to one cannot be written to a file. Kept beside
       the clips rather than on them, since several clips often cut up a single
       song and the answer is about the song. */
    files: usedFiles(),
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

function loadProject(data) {
  const read = readProject(data);
  state.name = read.name;
  state.level = read.level;
  state.targetSeconds = read.targetSeconds;
  state.toleranceSeconds = read.toleranceSeconds;
  state.clips = read.clips;
  state.expectedFiles = new Map(read.files.map((f) => [f.name, f]));
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

/* ------------------------------------------------------ remembering files */

/* A project holds the edit, not the music, so opening one has always meant
 * finding the song files again by hand. That is the biggest piece of friction
 * in the whole thing, and it exists because a browser cannot normally hold on
 * to a file after the tab closes.
 *
 * Where the File System Access API is available it can: the picker hands back a
 * handle rather than only bytes, the handle survives in IndexedDB, and asking
 * for it again is one click instead of one per song. The audio still never
 * leaves the machine — a handle is a reference to a file on disk, and reading
 * it needs the same permission it always did.
 *
 * It is an extra, not a foundation. Firefox and Safari have no picker, and the
 * API needs a secure context so it is absent when index.html is opened straight
 * off disk — which the ground rules say has to keep working. Everything below
 * is written so that when `canRememberFiles()` is false the app behaves exactly
 * as it did before: the hidden <input> does the picking, and the notice above
 * the timeline asks for the files by hand.
 */

const HANDLE_DB = 'skate.handles.v1';
const HANDLE_STORE = 'handles';

/** Names we hold a handle for, so the interface can ask without going async. */
const rememberedNames = new Set();

/** Can this browser give a file back after the tab has been closed? */
function canRememberFiles() {
  return typeof window.showOpenFilePicker === 'function'
    && typeof indexedDB !== 'undefined'
    && window.isSecureContext === true;
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Run one transaction and wait for it to land. Resolves null on any trouble. */
async function withHandles(mode, work) {
  if (!canRememberFiles()) return null;
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, mode);
      let value;
      Promise.resolve(work(tx.objectStore(HANDLE_STORE), (v) => { value = v; }))
        .catch(reject);
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (_) {
    // Private browsing, a blocked upgrade, storage turned off — none of it is
    // worth an error in front of anyone. The app simply does not remember.
    return null;
  }
}

function rememberHandle(name, handle) {
  rememberedNames.add(name);
  return withHandles('readwrite', (store) => { store.put(handle, name); });
}

function forgetHandle(name) {
  rememberedNames.delete(name);
  return withHandles('readwrite', (store) => { store.delete(name); });
}

/** Every remembered handle, as name → handle. */
function storedHandles() {
  return withHandles('readonly', (store, keep) => {
    const request = store.getAll();
    const names = store.getAllKeys();
    request.onsuccess = () => {
      names.onsuccess = () => {
        const map = new Map();
        names.result.forEach((name, i) => map.set(name, request.result[i]));
        keep(map);
      };
    };
  });
}

/** Load the names we know about, so the missing-file notice can offer them. */
async function loadRememberedNames() {
  const handles = await storedHandles();
  if (!handles) return;
  for (const name of handles.keys()) rememberedNames.add(name);
  updateMissingNotice();
}

/** The picker's filter, built from the same list the drop handler tests against. */
function audioPickerTypes() {
  return [{ description: 'Music', accept: { 'audio/*': [...AUDIO_EXTENSION_LIST] } }];
}

/**
 * Ask for music files, remembering them where the browser allows it.
 *
 * Falls back to the hidden `<input type=file>`, which is what this always was
 * and what Firefox and Safari still get.
 */
async function pickFiles() {
  if (!canRememberFiles()) { $('fileInput').click(); return; }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ multiple: true, types: audioPickerTypes() });
  } catch (_) {
    return;              // the picker was closed; not an error
  }
  const files = [];
  for (const handle of handles) {
    try {
      files.push(await handle.getFile());
      await rememberHandle(handle.name, handle);
    } catch (_) { /* one unreadable file should not lose the rest */ }
  }
  if (files.length) await addFiles(files);
}

/**
 * Handles for files that were dropped, where the browser offers them.
 *
 * Dropping is the other way music arrives, and it would be odd for it to be the
 * forgetful one. The files themselves are read as before either way.
 */
async function rememberDropped(transfer) {
  if (!canRememberFiles() || !transfer.items) return;
  const items = [...transfer.items].filter((item) => item.kind === 'file');
  for (const item of items) {
    if (typeof item.getAsFileSystemHandle !== 'function') return;
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === 'file') await rememberHandle(handle.name, handle);
    } catch (_) { /* nothing to remember */ }
  }
}

/**
 * Is this the song the project was built from? One sentence if not, else null.
 *
 * Matching is by file name because that is all a browser gives us, and two
 * different songs can easily share one — "track01.mp3" from two albums, or a
 * re-download at a different quality. Rebuilding a programme around the wrong
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
  const length = isFinite(was) && was > 0 && Math.abs(was - now) > 1
    ? ` — this one is ${fmtShort(now)}, the program was built from ${fmtShort(was)}`
    : '';
  return `“${entry.name}” is not the song this program was built from${length}`;
}

/** Files in the program that are not loaded, by name. */
function missingFiles() {
  return [...new Set(
    state.clips.filter((c) => !library.get(c.file)?.buffer).map((c) => c.file))];
}

/** Missing files we could offer to fetch back without asking for a picker. */
function reconnectableFiles() {
  return canRememberFiles() ? missingFiles().filter((name) => rememberedNames.has(name)) : [];
}

/**
 * Fetch the missing music back from the handles we kept.
 *
 * Has to be called from a click: asking for permission again needs a gesture,
 * which is the whole reason this is a button rather than something that happens
 * quietly on load. One prompt covers every file, so it is one click rather than
 * one per song, which is the point of the exercise.
 */
async function reconnectMissing() {
  const wanted = reconnectableFiles();
  if (!wanted.length) { $('fileInput').click(); return; }

  const handles = await storedHandles();
  if (!handles) { $('fileInput').click(); return; }

  const files = [];
  const gone = [];
  const refused = [];
  for (const name of wanted) {
    const handle = handles.get(name);
    if (!handle) continue;
    try {
      let allowed = await handle.queryPermission({ mode: 'read' });
      if (allowed !== 'granted') allowed = await handle.requestPermission({ mode: 'read' });
      if (allowed !== 'granted') { refused.push(name); continue; }
      files.push(await handle.getFile());
    } catch (_) {
      // Moved, renamed or deleted since. Forget it rather than offering it again.
      gone.push(name);
    }
  }
  // Only what is really unreachable is forgotten. A refusal is a decision that
  // can be taken differently in a moment, and offering it again is the point.
  for (const name of gone) await forgetHandle(name);

  if (files.length) {
    await addFiles(files);
    if (gone.length || refused.length) toast(describeReconnect({ files, gone, refused }), 7000);
    return;
  }
  toast(describeReconnect({ files, gone, refused }), 7000);
  updateMissingNotice();
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
      ? `${names(gone)} is not where it was — it may have been moved, renamed or deleted. `
        + 'Use Add files to find it'
      : `${gone.length} songs are not where they were — they may have been moved, `
        + 'renamed or deleted. Use Add files to find them';
  }
  if (!files.length && refused.length && !gone.length) {
    return 'Permission to read the music was not given, so nothing was opened. '
      + 'Try again and choose Allow, or use Add files';
  }
  if (!files.length) {
    return 'Could not open the music again — use Add files to find it';
  }
  const opened = files.length === 1 ? 'Opened one song' : `Opened ${files.length} songs`;
  if (gone.length && refused.length) {
    return `${opened}. ${gone.length} could not be found and ${refused.length} were not allowed`;
  }
  if (gone.length) {
    return `${opened}, but ${names(gone)} could not be found — use Add files for `
      + (gone.length === 1 ? 'it' : 'those');
  }
  return `${opened}, but permission was not given for ${refused.length} of them`;
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
  redoStack.length = 0;
  endUndoRun();
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
  const missing = missingFiles();
  $('missingNotice').classList.toggle('hidden', missing.length === 0);
  if (missing.length) {
    $('missingList').textContent = missing.join(' · ');
  }

  /* Where the browser can hand a file back, offer that instead of a picker:
     one click for the whole programme rather than finding each song again.
     Everywhere else this button never appears and the notice reads as it
     always did. */
  const back = reconnectableFiles();
  $('btnReconnect').classList.toggle('hidden', back.length === 0);
  if (back.length) {
    $('btnReconnect').textContent = back.length === missing.length
      ? 'Open the music again'
      : `Open ${back.length} of them again`;
    $('btnReconnect').title = `Uses the files you opened before: ${back.join(', ')}`;
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

  /* The snapshot goes here rather than inside applyLevel, because that is also
     how a brand new programme gets its length — and starting one should not
     leave a step on a stack that resetProgram has just emptied. */
  select.onchange = () => { pushUndo(); applyLevel(select.value); };
  $('customLength').onchange = () => {
    const seconds = parseClock($('customLength').value);
    if (seconds === null) {
      toast('Enter a time like 3:10');
      $('customLength').value = fmtShort(state.targetSeconds);
      return;
    }
    if (seconds === state.targetSeconds) return;   // nothing to record
    pushUndo();
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

/** Is this drag carrying files from outside, rather than one of our own clips? */
function draggingFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

/**
 * Accept music dropped anywhere on the page.
 *
 * It used to be the small box under the list only, and everywhere else had a
 * blanket preventDefault so nothing happened at all — including on the timeline,
 * which is the obvious thing to aim at. A drop on the timeline also puts the
 * songs in the programme, because that is plainly what was meant by it.
 *
 * `dragenter` and `dragleave` fire for every element the pointer crosses, so
 * the highlight is driven by a depth count rather than by the last event seen.
 */
function bindFileDrops() {
  let depth = 0;
  const show = (on) => document.body.classList.toggle('dropping', on);

  document.addEventListener('dragenter', (e) => {
    if (!draggingFiles(e)) return;
    depth++;
    show(true);
  });
  document.addEventListener('dragleave', (e) => {
    if (!draggingFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  // Without this the browser navigates to the file instead of handing it over.
  document.addEventListener('dragover', (e) => e.preventDefault());

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    show(false);
    if (!draggingFiles(e)) return;      // a clip being reordered; not our business

    // Read these now: the awaits below outlive the event, and dataTransfer is
    // emptied once the handler returns.
    const ontoTimeline = Boolean(e.target.closest && e.target.closest('#timelineWrap'));
    const dropped = e.dataTransfer.files;
    await rememberDropped(e.dataTransfer);
    const added = await addFiles(dropped);
    if (ontoTimeline) for (const entry of added) addClip(entry);
  });
}

function bind() {
  buildLevelPicker();

  $('programName').value = state.name;
  // Tagged, so a name being typed is one undo step rather than one per letter.
  // The snapshot is taken before the assignment, so it holds the old name.
  $('programName').oninput = (e) => {
    pushUndo('program-name');
    state.name = e.target.value;
    save();
  };

  $('btnAddFiles').onclick = pickFiles;
  $('btnAddMissing').onclick = pickFiles;
  $('btnReconnect').onclick = reconnectMissing;

  $('btnNew').onclick = () => openStartDialog(true);
  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  bindFileDrops();

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
  $('btnTheme').onclick = cycleTheme;
  $('btnLibraryToggle').onclick = () =>
    setLibraryCollapsed(!document.querySelector('main').classList.contains('library-collapsed'));
  /* The colours are cached, so a change of system theme has to say so. Only
     reaches anything while the mode is 'auto' — with an explicit choice the CSS
     ignores the system, and the repaint is harmless. */
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaintForTheme);
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
  const modifier = e.ctrlKey || e.metaKey;
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  if (modifier && key === 'z') {
    e.preventDefault();
    // Shift+Z is the redo nearly everywhere; Ctrl+Y is the Windows one. Both.
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (modifier && key === 'y') { e.preventDefault(); redo(); return; }
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
  /* The head already set the attribute; this catches the button up with it. */
  applyTheme(storedTheme());

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

  let collapsed = false;
  try { collapsed = localStorage.getItem(LIBRARY_KEY) === 'collapsed'; }
  catch (_) { /* private mode */ }
  setLibraryCollapsed(collapsed);

  refresh();
  // Which files we could offer to reopen is a question for storage, so the
  // notice above the timeline is updated again once the answer arrives. It is
  // never waited on: the editor has to start whether or not it comes back.
  loadRememberedNames();
  // Only interrupt when there is no work to come back to.
  if (!saved || !(saved.clips || []).length) openStartDialog(false);
}

/* In a browser, start. Under Node — the test suite — export the pure logic
   instead, so the maths can be checked without a DOM.
 *
 * In the browser the three files share one global scope, so app.js can call
 * into analysis.js and formats.js by name and nothing has to be wired up. Node
 * gives each file its own module scope instead, and those bare names would go
 * unresolved the moment a test called anything here — so they are put on the
 * global object first. This is the only place the split costs anything.
 */
if (typeof document !== 'undefined') {
  init();
} else if (typeof module !== 'undefined' && module.exports) {
  const analysis = require('./analysis.js');
  const formats = require('./formats.js');
  Object.assign(global, analysis, formats);

  module.exports = {
    ...analysis,
    ...formats,
    state, LEVELS, CUSTOM_LEVEL,
    allLevels, findLevel,
    clipDuration, crossfadeOf, layout, reordered, clampClipsToFile, MIN_CLIP,
    joinPreviewRange, JOIN_PREVIEW, clipsOnExport,
    fadeEnvelope, crossfadeEnvelope, valueAt, rampEnvelope,
    joinRoom,
    clipGain, MAX_GAIN,
    parseClock, exportFileName, fmt, fmtShort,
    project, readProject,
    undoStack, redoStack, pushUndo, endUndoRun, UNDO_COALESCE_MS, UNDO_DEPTH,
    undoSnapshot, takeUndo, takeRedo,
    clipsUsing, missingFiles, describeWrongFile, describeReconnect, usedFiles,
    AUDIO_EXTENSION_LIST, AUDIO_EXTENSIONS, audioPickerTypes,
    unsupportedReasons, LAME_URL, LAME_SRI,
  };
}
