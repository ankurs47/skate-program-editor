/* The program laid end to end, and the ruler under it.
 *
 * Rebuilding the strip of clips is expensive, so it is skipped whenever a
 * fingerprint of what would be drawn has not changed; the ruler and playhead
 * are repainted on their own.
 */
'use strict';

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

/** Drop the "already drawn" cache, so the next render really redraws. */
function forgetTimelineShape() {
  timelineShape = null;
}

function timelineSignature(clips, parts) {
  return clips
    .map((clip, i) =>
      [
        clip.id,
        clip.file,
        clip.title,
        clip.id === state.selected ? 1 : 0,
        library.get(clip.file)?.buffer ? 1 : 0,
        parts[i].xf >= MIN_CROSSFADE ? 1 : 0, // whether a blend marker is shown
      ].join(':'),
    )
    .join('|');
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
    drawWave(
      canvas,
      entry.peaks,
      entry.duration,
      clip.srcStart,
      clip.srcEnd,
      clip.id === state.selected ? css('--wave-sel') : css('--wave'),
    );
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
  if (
    signature === timelineShape &&
    wrap.querySelectorAll('.tl-clip').length === state.clips.length
  ) {
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
      state.playPosition = parts[i].start; // jump the playhead to this clip
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
      if (from === '') return; // not one of our blocks
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
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* not captured */
    }
    if (wasPlaying) playProgram(state.playPosition);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CLIP_DRAG_TYPE,
    timelineShape,
    forgetTimelineShape,
    timelineSignature,
    timelineWaveFrame,
    drawTimelineWaves,
    scheduleTimelineWaves,
    syncTimelineMetrics,
    renderTimeline,
    scrubberSpan,
    tickStep,
    drawScrubber,
    seekTo,
    bindScrubber,
  };
}
