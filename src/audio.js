/* Making sound, and writing it out.
 *
 * One AudioContext plays the program by scheduling every clip ahead of time
 * with its own gain envelope; export renders the same schedule offline and
 * encodes it. The two paths share the envelope math in program.js so what you
 * hear and what you get are built the same way.
 */
'use strict';

let audio = null; // AudioContext, created on first gesture
let playing = null; // {nodes, startedAt, fromTime, mode}
let rafId = 0;
let mp3Ready = false;

function ctx() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  if (audio.state === 'suspended') audio.resume();
  return audio;
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
    if (start + dur <= fromTime) return; // entirely in the past

    const skip = Math.max(0, fromTime - start);
    const clipT0 = when + (start - fromTime); // may be before `when`
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
      try {
        node.stop();
      } catch (_) {
        /* already ended */
      }
    }
    playing = null;
  }
  cancelAnimationFrame(rafId);
  $('btnPlayLabel').textContent = 'Play';
  drawScrubber(); // the playhead stays where it is, so Space resumes there
}

/** `until` stops playback at a point in program time, for auditioning a join. */
function playProgram(fromTime = 0, until = Infinity) {
  const { total } = layout(state.clips);
  if (total <= 0) return;
  stopPlayback();
  const context = ctx();
  const when = context.currentTime + 0.08; // small lead so nothing is late
  const nodes = scheduleProgram(context, context.destination, when, fromTime);
  if (!nodes.length) {
    toast('Add some music files first');
    return;
  }
  playing = { nodes, startedAt: when, fromTime, mode: 'program', total, until };
  $('btnPlayLabel').textContent = 'Pause';
  tickPlayhead();
}

/**
 * Play one clip on its own, from a point inside it.
 *
 * Its level and its own fades are applied, because hearing what this song will
 * sound like is the entire point, and auditioning at full volume a song you
 * have just set to 40% tells you nothing. The blend is not applied: that belongs
 * to the join rather than to the song, and there is no previous song here to
 * blend with.
 */
function playClipAudition(clip, fromSource) {
  const entry = library.get(clip.file);
  if (!entry || !entry.buffer) {
    toast('That file is not loaded');
    return;
  }
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
    if (elapsed < 0) {
      rafId = requestAnimationFrame(step);
      return;
    }

    if (playing.mode === 'program') {
      const at = Math.min(playing.fromTime + elapsed, playing.total);
      state.playPosition = at;
      $('playhead').textContent = fmt(at);
      drawScrubber();
      const stopAt = Math.min(playing.total, playing.until ?? Infinity);
      if (at >= stopAt) {
        stopPlayback();
        return;
      }
    } else {
      const at = playing.fromTime + elapsed;
      state.cursor = at;
      drawClipEditor();
      if (at >= playing.clip.srcEnd) {
        stopPlayback();
        return;
      }
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
    const weak =
      entry && entry.quality && (entry.quality.kind === 'caution' || entry.quality.kind === 'poor');
    if (weak && !seen.has(clip.file)) {
      seen.set(clip.file, entry);
    }
  }
  return [...seen.values()];
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Set once the warning has been shown and the choice made, so the second click
   on "Save it anyway" goes through instead of warning again. Reset every time
   the dialog opens. */
let clippingAccepted = false;

/** Ask about clipping again: what was too loud may have been turned down. */
function forgetClippingChoice() {
  clippingAccepted = false;
}

/**
 * Say that the program is too loud to store cleanly, and what fixes it.
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
    `Your program is ${fmt(total)}. ${level ? `For ${level.label} the` : 'The'} ` +
    `music needs to be between ${fmt(lo)} and ${fmt(hi)}.`;
  $('lengthWarnFix').textContent = tooLong
    ? 'Trim the start or end of a song, or blend two songs together more to ' + 'overlap them.'
    : 'Add more music, or reduce a blend so the songs overlap less.';
  return true;
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
  view.setUint16(20, 1, true); // PCM
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

/**
 * Encode the rendered program to MP3.
 *
 * The work happens in a worker the encoder starts for itself, so there is no
 * loop here to yield from and nothing to keep the page responsive by hand.
 * Progress comes from the packets as they come out.
 */
async function encodeMp3(buffer, onProgress) {
  if (!mp3Lib) throw new Error('the MP3 encoder never arrived — save as WAV instead');
  const { Output, Mp3OutputFormat, BufferTarget, AudioBufferSource } = mp3Lib;

  const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
  const total = buffer.duration;
  const source = new AudioBufferSource({
    codec: 'mp3',
    /* 320 kbps, as before. `quality` is what this library would rather be
       given, but a named quality is a promise about how it sounds and this is
       a promise about the file — the same bitrate that has been shipping. */
    bitrate: MP3_BITRATE,
    onEncodedPacket: (packet) => {
      if (total > 0) onProgress(clamp(packet.timestamp / total, 0, 1));
    },
  });
  output.addAudioTrack(source);

  await output.start();
  await source.add(buffer);
  source.close();
  await output.finalize();

  onProgress(1);
  return new Blob([output.target.buffer], { type: 'audio/mpeg' });
}

async function renderProgram() {
  const { total } = layout(state.clips);
  if (total <= 0) throw new Error('there is no music in the program yet');
  const missing = state.clips.filter((c) => !library.get(c.file)?.buffer);
  if (missing.length) {
    throw new Error(
      `${missing.length} song${missing.length === 1 ? ' is' : 's are'} still missing`,
    );
  }

  const offline = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
  scheduleProgram(offline, offline.destination, 0, 0);
  return offline.startRendering();
}

async function doExport() {
  const format = $('exportFormat').value;
  try {
    localStorage.setItem(FORMAT_KEY, format);
  } catch (_) {
    /* private mode */
  }
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
    // the peak here means a distorted program is caught before any of that,
    // and before a file anyone might take to a competition exists.
    if (clipsOnExport(peakOf(channelsOf(rendered))) && !clippingAccepted) {
      clippingAccepted = true; // saying "anyway" once is enough
      showClippingWarning();
      return;
    }

    let blob, ext;
    if (format === 'mp3') {
      blob = await encodeMp3(rendered, (p) => {
        bar.style.width = `${40 + p * 58}%`;
      });
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

/** Play from the playhead, wrapping to the start if it sits at the very end. */
function playFromPlayhead() {
  const { total } = layout(state.clips);
  playProgram(state.playPosition >= total - 0.05 ? 0 : state.playPosition);
}

/**
 * Gray out "Make music file" whenever it could only fail. Better to show the
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
    reason =
      `${missing} song${missing === 1 ? ' is' : 's are'} still missing — ` +
      `add the file${missing === 1 ? '' : 's'} first`;
  }

  button.disabled = Boolean(reason);
  button.title = reason || 'Make the finished music file to take to the competition';
}

/*
 * MP3 encoder. Browsers can decode MP3 but none of them can create one —
 * WebCodecs now exposes an AudioEncoder everywhere, and `mp3` is not among the
 * codecs any of them will encode — so the encoder has to come from somewhere.
 * It is LAME either way; the only question is what runs it.
 *
 * This is LAME compiled to WebAssembly, and it encodes in a worker it starts
 * for itself. Both halves matter. The pure-JS port that came before it ran on
 * the main thread and froze the page in half-second blocks — on the one
 * operation nobody can afford to have look broken — and this is about three
 * times faster besides.
 *
 * It is a file in this repository rather than something fetched from a CDN, so
 * the editor works with no network at all once the page is open, and there is
 * no third party who can change what it does. `tools/build-mp3-encoder.js`
 * builds it and can prove the committed bytes are what its sources produce.
 *
 * Loaded on the way past rather than with the page: it is 400 KB that most
 * sessions never reach for, and nothing about starting up needs it. If it is
 * slow the editor is already usable, and if it fails to load at all the export
 * dialog says so and offers WAV.
 */
const MP3_BITRATE = 320000;
const MP3_ENCODER_FILE = 'src/vendor/mp3-encoder.js';

let mp3Lib = null; // the library itself, once it is there

function tryLoadMp3Encoder() {
  const script = document.createElement('script');
  script.src = MP3_ENCODER_FILE;
  script.async = true;
  script.onload = async () => {
    try {
      const lib = window.MediabunnyMp3;
      /* Never override a browser that has grown its own MP3 encoder. None has
         yet; the day one does, its encoder is the better one to use. */
      if (!(await lib.canEncodeAudio('mp3'))) lib.registerMp3Encoder();
      mp3Ready = await lib.canEncodeAudio('mp3', {
        numberOfChannels: 2,
        sampleRate: SR,
        bitrate: MP3_BITRATE,
      });
      if (mp3Ready) mp3Lib = lib;
    } catch (_) {
      /* Loaded, but not something this app can encode with. Same outcome as
         never arriving, and the same thing to say about it. */
      mp3Ready = false;
    }
    updateExportOptions();
  };
  script.onerror = updateExportOptions;
  document.head.appendChild(script);
}

/* Whichever format was used last. Not a setting anyone has to find — picking
   WAV and being handed MP3 again next time is the app overruling a choice that
   was already made, which is the only reason this is remembered at all. */
const FORMAT_KEY = 'skate.exportFormat';

function updateExportOptions() {
  const select = $('exportFormat');
  const mp3Option = select.querySelector('option[value=mp3]');
  mp3Option.disabled = !mp3Ready;
  let last = null;
  try {
    last = localStorage.getItem(FORMAT_KEY);
  } catch (_) {
    /* private mode */
  }
  if (mp3Ready) {
    mp3Option.textContent = "MP3 — smaller, usually what's asked for";
    select.value = last === 'wav' ? 'wav' : 'mp3';
    $('exportNote').textContent = 'MP3 is what most competitions ask for.';
  } else {
    mp3Option.textContent = 'MP3 — could not be loaded';
    select.value = 'wav';
    $('exportNote').textContent =
      'The MP3 encoder could not be reached, so only WAV is available right now. ' +
      'WAV plays anywhere, it is just a much larger file.';
  }
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    audio,
    playing,
    rafId,
    mp3Ready,
    ctx,
    applyEnvelope,
    scheduleProgram,
    stopPlayback,
    playProgram,
    playClipAudition,
    tickPlayhead,
    weakSources,
    download,
    clippingAccepted,
    forgetClippingChoice,
    showClippingWarning,
    showLengthWarning,
    channelsOf,
    encodeWav,
    encodeMp3,
    MP3_BITRATE,
    renderProgram,
    doExport,
    playFromPlayhead,
    updateExportAvailability,
    MP3_ENCODER_FILE,
    tryLoadMp3Encoder,
    FORMAT_KEY,
    updateExportOptions,
  };
}
