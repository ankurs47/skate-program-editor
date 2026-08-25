/* One clip, up close.
 *
 * The waveform with its trim handles and fades, and the three things that act
 * on a selection: moving it, aligning its join to a beat, and levelling the
 * loudness across the program.
 */
'use strict';

/* ---------------------------------------------------------- clip editor */

function drawClipEditor() {
  const clip = selectedClip();
  const editor = $('editor');
  editor.classList.toggle('hidden', !clip);
  if (!clip) return;

  $('editorTitle').textContent = clip.title;
  $('editorTitle').title = clip.title; // CSS cuts the heading short when it is long
  const entry = library.get(clip.file);
  const canvas = $('clipCanvas');
  const duration = entry && entry.buffer ? entry.duration : Math.max(clip.srcEnd, 1);

  drawWave(
    canvas,
    entry ? entry.peaks : null,
    duration,
    0,
    duration,
    css('--wave'),
    clipGain(clip),
  );

  const { g, w, h } = fitCanvas(canvas);
  const x = (t) => (t / duration) * w;

  /* Fade everything outside the kept region back towards the panel it sits on.
     This used to be a flat rgba(0,0,0,.35), which reads as "dimmed" over a dark
     panel and as a heavy gray slab over a light one — the discarded audio ended
     up louder than the audio being kept. Painting the panel color over it
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
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
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
 * The two order buttons, grayed at the ends of the program.
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

/** Play across the selected clip's join with the one before it. */
function previewJoin() {
  const range = joinPreviewRange(state.clips, state.clips.indexOf(selectedClip()));
  if (!range) return;
  seekTo(range.from);
  playProgram(range.from, range.until);
}

function updateAlignAvailability() {
  const button = $('btnAlignJoin');
  const clip = selectedClip();
  const i = clip ? state.clips.indexOf(clip) : -1;
  const prev = i > 0 ? state.clips[i - 1] : null;
  const ready = prev && library.get(prev.file)?.buffer && library.get(clip.file)?.buffer;

  button.disabled = !ready;
  button.title = ready
    ? 'Moves this cut and the end of the song before it by up to 2.5 seconds each, ' +
      'so they land on a beat — or, if the music has no steady beat, where a ' +
      'phrase ends'
    : 'Add both songs first';

  const play = $('btnPlayJoin');
  play.disabled = !ready;
  play.title = ready
    ? 'Plays the few seconds either side of this join, so you can hear how the ' +
      'two songs meet without hunting for it on the bar above'
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
  if (!prevEntry?.buffer || !entry?.buffer) {
    toast('Add both songs first');
    return;
  }

  const was = clip.crossfade || 0;
  const result = suggestJoinForBuffers(prevEntry.buffer, prev.srcEnd, entry.buffer, clip.srcStart, {
    crossfade: was,
    // The blend slider tops out at 10s and cannot outlast either clip.
    maxCrossfade: Math.min(10, clipDuration(prev), clipDuration(clip)),
    outRoom: joinRoom(prev, prevEntry, 'end'),
    incRoom: joinRoom(clip, entry, 'start'),
  });

  const moves =
    result.ok &&
    (Math.abs(result.endShift) >= 0.005 ||
      Math.abs(result.startShift) >= 0.005 ||
      Math.abs(result.crossfade - was) >= 0.005);
  if (moves) {
    pushUndo();
    prev.srcEnd = clamp(prev.srcEnd + result.endShift, prev.srcStart + 0.1, prevEntry.duration);
    clip.srcStart = clamp(clip.srcStart + result.startShift, 0, clip.srcEnd - 0.1);
    clip.crossfade = Math.max(0, result.crossfade);
    refresh();
  }
  toast(describeJoin(result, was), 4200);
}

function updateEvenOutAvailability() {
  const button = $('btnEvenOut');
  const ready = state.clips.filter((c) => library.get(c.file)?.buffer).length;
  const reason =
    state.clips.length < 2
      ? 'Add at least two songs first'
      : ready < 2
        ? 'Some songs still need to be added'
        : '';
  button.disabled = Boolean(reason);
  button.title =
    reason ||
    'Sets each song so they all sound about equally loud, without letting any of them distort';
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
    state.clips.forEach((clip, i) => {
      if (usable[i]) clip.gain = clamp(gains[i], 0, MAX_GAIN);
    });
    refresh();
  }
  toast(
    describeLevels({
      matched,
      short: short.length,
      unmeasured: usable.filter((u) => !u).length,
    }),
    4200,
  );
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
    const grab = (duration / canvas.getBoundingClientRect().width) * 8; // 8px in seconds

    if (Math.abs(t - clip.srcStart) < grab) dragging = 'start';
    else if (Math.abs(t - clip.srcEnd) < grab) dragging = 'end';
    else {
      state.cursor = t;
      drawClipEditor();
      return;
    }

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
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* never captured */
    }
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

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    drawClipEditor,
    updateOrderAvailability,
    moveSelected,
    previewJoin,
    updateAlignAvailability,
    alignSelectedJoin,
    updateEvenOutAvailability,
    evenOutLevels,
    bindClipCanvas,
    updateBudget,
  };
}
