#!/usr/bin/env node
/**
 * Regenerate the screenshot the README shows.
 *
 *   node tools/screenshot.js
 *
 * Driven rather than hand-captured, for two reasons. A screenshot taken by hand
 * goes stale silently — the interface moves and the picture in the README keeps
 * showing last year's — and one taken at whatever size the window happened to be
 * comes out unreadable at the width GitHub renders it. This pins both: a 1440x900
 * viewport at 2x, and a program built from the same numbers every time.
 *
 * The audio is synthesized. Shipping real music would mean shipping someone's
 * recording, and a pure tone draws as a flat band rather than a waveform — so
 * these have beats and phrasing, which is what makes the picture look like the
 * thing the app is actually for.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { open } = require('../test/dom/browser.js');

const SHOT = path.join(__dirname, '..', 'docs', 'screenshot.png');
const CARD = path.join(__dirname, '..', 'docs', 'social-card.png');

/* A program that shows the tool doing its job: three songs, a blend at each
   join, and a total inside the allowed window so the timer reads green. A
   screenshot of an error state would be a strange thing to lead with. */
const SETUP = `
  localStorage.clear();
  document.getElementById('startDialog').classList.add('hidden');
  const ctx = new AudioContext();

  // beats plus phrase-length swells, so the peaks vary the way music does
  function music(sec, bpm, hz, arc) {
    const sr = ctx.sampleRate, b = ctx.createBuffer(2, sr * sec, sr), beat = 60 / bpm;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr, u = t / sec;
        const hit = Math.exp(-((t % beat) / beat) * 7) * 0.75 + 0.25;
        const phrase = 0.55 + 0.45 * Math.sin(u * Math.PI * 4 - 1.2);
        const shape = arc === 'up' ? 0.35 + 0.65 * u
          : arc === 'down' ? 1 - 0.5 * u
          : 0.6 + 0.4 * Math.sin(u * Math.PI);
        const carrier = Math.sin(2 * Math.PI * hz * t) * 0.6
          + Math.sin(2 * Math.PI * hz * 1.5 * t) * 0.4;
        d[i] = carrier * 0.55 * hit * phrase * shape;
      }
    }
    return b;
  }

  for (const [name, sec, bpm, hz, arc, kind, label] of [
    ['opening theme.mp3', 96, 132, 220, 'up',   'good',    'Good'],
    ['the slow part.mp3', 84,  84, 165, 'arc',  'good',    'Good'],
    ['big finish.mp3',    74, 150, 330, 'down', 'caution', 'Fair'],
  ]) {
    const buffer = music(sec, bpm, hz, arc);
    library.set(name, { name, buffer, peaks: computePeaks(buffer), duration: sec,
      bytes: sec * 40000, quality: { kind, label, detail: '256 kbps MP3, 44.1 kHz' },
      fingerprint: 'shot' + hz });
  }

  state.name = 'junior long program';
  state.level = 'usfs-jr';
  state.targetSeconds = 210;
  state.toleranceSeconds = 10;
  state.clips = [
    { id: 'a', title: 'opening theme', file: 'opening theme.mp3',
      srcStart: 6, srcEnd: 80, fadeIn: 1.2, fadeOut: 0, crossfade: 0, gain: 1 },
    { id: 'b', title: 'the slow part', file: 'the slow part.mp3',
      srcStart: 12, srcEnd: 82, fadeIn: 0, fadeOut: 0, crossfade: 1.8, gain: 0.82 },
    { id: 'c', title: 'big finish', file: 'big finish.mp3',
      srcStart: 4, srcEnd: 72, fadeIn: 0, fadeOut: 2.6, crossfade: 1.4, gain: 1 },
  ];
  state.selected = 'b';
  chooseTheme('dark');
  document.getElementById('programName').value = state.name;
  document.getElementById('targetLength').value = 'usfs-jr';
  refresh();
  return {
    total: document.getElementById('totalTime').textContent,
    verdict: document.getElementById('budgetDelta').textContent,
    height: Math.ceil(document.querySelector('main').getBoundingClientRect().bottom),
  };
`;

function write(file, base64, size) {
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`\n  ${path.relative(process.cwd(), file)} — ${size}, ${kb} KB`);
}

async function main() {
  const session = await open({ url: '/index.html' });
  try {
    /* A real desktop viewport at 2x, so the text survives being shown at about
       880px wide on GitHub. Left to the window, this comes out illegible. */
    await session.page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    const shown = await session.page.evaluate(SETUP);
    if (!/good to go/.test(shown.verdict)) {
      throw new Error(`the program should land inside the window, got "${shown.verdict}"`);
    }

    // Crop to the app rather than the window: trailing empty page is not content.
    const height = Math.min(shown.height + 12, 900);
    const shot = await session.page.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1440, height, scale: 2 },
      captureBeyondViewport: true,
    });

    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    write(SHOT, shot.data, `${1440 * 2}x${height * 2}`);
    console.log(`  ${shown.total} · ${shown.verdict}`);

    /* The link preview card, at exactly 1200x630 — 1.91:1, which is what
       Facebook, LinkedIn and X crop to. Two earlier attempts were wrong in
       different ways: 1280x640 is 2:1 and gets its sides cropped, and rendering
       this one at 2x for sharpness produced 2400x1260, which validators flag
       and platforms resize themselves. It is a thumbnail; the canonical size
       beats a clever one. The screenshot above stays at 2x, because that one is
       looked at large. */
    await session.page.send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 630,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await session.page.send('Page.navigate', { url: `${session.origin}/tools/social-card.html` });
    await session.page.evaluate(`
      await new Promise(r => (document.readyState === 'complete' ? r() : addEventListener('load', r)));
      await Promise.all([...document.images].map(i => i.complete
        ? Promise.resolve() : new Promise(r => { i.onload = i.onerror = r; })));
      if (![...document.images].every(i => i.naturalWidth > 0)) throw new Error('the logo did not load');
      return true;
    `);
    const card = await session.page.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 },
    });
    write(CARD, card.data, '1200x630');
    console.log('');
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(`\n  the screenshot could not be taken: ${err.message}\n`);
  process.exit(1);
});
