/* Colors read from the stylesheet, and the two things every canvas needs.
 *
 * The theme lives in CSS custom properties, so the drawing code has to ask the
 * page what a color currently is rather than hold its own copy. Those lookups
 * are cached, and the cache is dropped whenever the theme changes.
 */
'use strict';

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
    let mn = 1,
      mx = -1;
    for (let i = ia; i < ib; i++) {
      if (peaks[i * 2] < mn) mn = peaks[i * 2];
      if (peaks[i * 2 + 1] > mx) mx = peaks[i * 2 + 1];
    }
    if (mx < mn) {
      mn = 0;
      mx = 0;
    }
    const y0 = mid - clamp(mx * gain, -1, 1) * mid * 0.94;
    const y1 = mid - clamp(mn * gain, -1, 1) * mid * 0.94;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

/**
 * A color from the stylesheet.
 *
 * Cached, because `getComputedStyle` forces the browser to resolve style before
 * it can answer, and the drawing code asks for four to eight colors every
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
 * Forget the cached colors and repaint, for when the theme changes underneath.
 *
 * The strip and the list only rebuild when their contents change, and a theme
 * change is invisible to that test — so the caches saying "already drawn" have
 * to be cleared as well, or the new colors never reach the canvases.
 */
function repaintForTheme() {
  palette.clear();
  forgetLibraryShape();
  forgetTimelineShape();
  renderLibrary();
  renderTimeline();
  drawScrubber();
  drawClipEditor();
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fitCanvas,
    drawWave,
    palette,
    css,
    repaintForTheme,
  };
}
