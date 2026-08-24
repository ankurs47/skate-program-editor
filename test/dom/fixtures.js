/**
 * Page-side setup, as source to be evaluated in the browser.
 *
 * The editor only ever gets audio from a file the user picked, and a headless
 * page has no file picker. So these build the same thing decoding would have
 * produced — an AudioBuffer, its peaks, and a quality verdict — and put it in
 * the library directly. Everything downstream of `library.set` is then the real
 * code path.
 */
'use strict';

/** Helpers installed into the page once, before any check runs. */
const SETUP = `
  // A click on every beat: broadband, short, and easy for the beat detector.
  window.__clicks = (bpm, seconds, amplitude = 1) => {
    const buf = ctx().createBuffer(2, Math.round(seconds * 44100), 44100);
    let s = 12345;
    const rnd = () => (s ^= s << 13, s >>>= 0, s ^= s >> 17, s ^= s << 5, s >>>= 0, s / 4294967296);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let t = 0; t < seconds; t += 60 / bpm) {
        const at = Math.round(t * 44100);
        for (let i = 0; i < 1300 && at + i < d.length; i++) {
          d[at + i] += amplitude * Math.exp(-i / 265) * (rnd() * 2 - 1);
        }
      }
    }
    return buf;
  };

  // A steady tone, for level work where a predictable peak matters.
  window.__tone = (hz, seconds, amplitude = 0.3) => {
    const buf = ctx().createBuffer(2, Math.round(seconds * 44100), 44100);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = amplitude * Math.sin(2 * Math.PI * hz * i / 44100);
    }
    return buf;
  };

  window.__addToLibrary = (name, buffer) => {
    library.set(name, {
      name, buffer, duration: buffer.duration, peaks: computePeaks(buffer), state: 'ready',
      quality: {
        kind: qualityKind({ bitrate: 256, sampleRate: 44100, codec: 'mp3' }),
        bitrate: 256, sampleRate: 44100, channels: 2, lossless: false,
        codec: 'mp3', notes: [], estimated: false, vbr: false,
      },
    });
  };

  /* Put the editor in a known state: past the start dialog, with a program of
     the given songs. Called at the top of every check, so no check can be made
     to pass or fail by one that ran before it. */
  window.__reset = (songs = []) => {
    stopPlayback();
    library.clear();
    undoStack.length = 0;
    endUndoRun();
    startDismissable = true;
    for (const id of ['startDialog', 'exportDialog', 'helpModal', 'clipWarning']) {
      document.getElementById(id).classList.add('hidden');
    }
    state.name = 'test program';
    state.level = 'usfs-juv';
    state.targetSeconds = 135;
    state.toleranceSeconds = 10;
    state.clips = [];
    state.selected = null;
    state.playPosition = 0;
    state.cursor = 0;
    for (const [name, buffer] of songs) window.__addToLibrary(name, buffer);
    for (const [name] of songs) addClip(library.get(name));
    refresh();
  };

  // A real keydown, of the shape the browser sends. \`repeat\` is what a held
  // key sets, and the undo coalescing exists entirely because of it.
  window.__key = (key, opts = {}) => document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));

  window.__id = (id) => document.getElementById(id);
  window.__visible = (id) => !document.getElementById(id).classList.contains('hidden');
  true;
`;

module.exports = { SETUP };
