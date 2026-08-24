#!/usr/bin/env node
/**
 * Browser checks. Real Chrome, real DOM, real Web Audio.
 *
 *   npm run test:dom
 *
 * Separate from `npm test`, and opt-in for the same reason `--net` is: it needs
 * something the unit suite does not — a browser on the machine — and a suite
 * that fails when Chrome is missing is one people stop trusting.
 *
 * These cover the half of app.js that the unit tests cannot reach: dialogs and
 * focus, the audio graph, key handling, and the flows that only exist as a
 * sequence of clicks. Two of the bugs fixed in #6 and #7 were found by doing
 * exactly this by hand, which is the argument for doing it automatically.
 *
 * They assert on page state, never on how long something took.
 */
'use strict';

const { open } = require('./browser.js');
const { SETUP } = require('./fixtures.js');

let passed = 0;
const failures = [];
let page = null;

async function check(name, body) {
  try {
    await body();
    passed++;
  } catch (err) {
    failures.push(`${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}expected ${b}, got ${a}`);
}

function near(actual, expected, tol, what = '') {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${what}expected ~${expected} (±${tol}), got ${actual}`);
  }
}

function ok(cond, message) {
  if (!cond) throw new Error(message);
}

/** Run an expression in the page. */
const run = (js) => page.evaluate(js);

async function main() {
  const session = await open();
  page = session.page;

  try {
    await run(SETUP);

    /* ------------------------------------------------------------ startup */

    await check('the page starts clean, with all three scripts loaded', async () => {
      const state = await run(`
        return {
          scripts: [...document.querySelectorAll('script[src]')]
            .map(s => s.getAttribute('src')).filter(s => !s.startsWith('http')),
          crossFile: ['clamp', 'analyseBeats', 'qualityKind', 'layout']
            .map(n => typeof window[n] === 'function' || typeof eval(n) === 'function'),
        };
      `);
      eq(state.scripts, ['analysis.js', 'formats.js', 'app.js'], 'load order: ');
      eq(state.crossFile, [true, true, true, true], 'every cross-file name resolves: ');
      eq(session.page.consoleErrors(), [], 'the page logged errors on startup: ');
    });

    await check('the start dialog is unskippable on a first visit', async () => {
      // A program should begin with a name and a length rather than defaults
      // nobody chose, so at startup Escape and the backdrop must not dismiss it.
      const result = await run(`
        localStorage.clear();
        openStartDialog(false);
        const before = window.__visible('startDialog');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const afterEscape = window.__visible('startDialog');
        __id('startDialog').click();
        const afterBackdrop = window.__visible('startDialog');
        startDismissable = true;
        __id('startDialog').classList.add('hidden');
        return { before, afterEscape, afterBackdrop };
      `);
      eq(result, { before: true, afterEscape: true, afterBackdrop: true },
        'the startup dialog must not be dismissable: ');
    });

    /* --------------------------------------------------------------- undo */

    await check('a held key is one undo step, and spares the history', async () => {
      /* The bug this covers: every repeat pushed its own snapshot, and the
         stack is sixty deep, so two seconds on the arrow key emptied it and
         took every earlier edit with it. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        state.selected = state.clips[0].id;
        refresh();
        undoStack.length = 0; endUndoRun();

        for (let i = 0; i < 3; i++) { pushUndo(); state.clips[0].srcEnd -= 1; }
        const historyBefore = undoStack.length;
        const endBeforeHold = state.clips[0].srcEnd;

        for (let i = 0; i < 40; i++) window.__key('ArrowRight', { repeat: true });
        const afterHold = undoStack.length;
        const moved = +(state.clips[0].srcEnd - endBeforeHold).toFixed(3);

        undo();
        return {
          historyBefore, afterHold, moved,
          restoredWholeHold: Math.abs(state.clips[0].srcEnd - endBeforeHold) < 1e-9,
          historyLeft: undoStack.length,
        };
      `);
      eq(result.historyBefore, 3);
      eq(result.afterHold, 4, 'forty repeats should add exactly one entry: ');
      ok(result.moved > 0, 'the arrow key did not actually move anything');
      ok(result.restoredWholeHold, 'one undo should put back the whole hold');
      eq(result.historyLeft, 3, 'the earlier edits must survive: ');
    });

    /* ------------------------------------------------------------ dialogs */

    await check('a dialog owns the keyboard while it is open', async () => {
      // The export dialog used to be left out of this, so Space, Delete and the
      // trim keys still reached the programme behind it.
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)], ['b.mp3', window.__tone(330, 30)]]);
        state.selected = state.clips[1].id;
        refresh();
        __id('btnExport').focus();
        __id('btnExport').click();

        const clipsBefore = state.clips.length;
        const endBefore = state.clips[1].srcEnd;
        window.__key('ArrowRight');
        window.__key('Delete');
        window.__key(' ', { code: 'Space' });
        return {
          open: window.__visible('exportDialog'),
          clipsUnchanged: state.clips.length === clipsBefore,
          trimUnchanged: state.clips[1].srcEnd === endBefore,
          notPlaying: playing === null,
        };
      `);
      eq(result, { open: true, clipsUnchanged: true, trimUnchanged: true, notPlaying: true },
        'editing keys reached the programme behind the dialog: ');
    });

    await check('focus is trapped in the dialog and handed back on Escape', async () => {
      const result = await run(`
        const card = document.querySelector('#exportDialog .modal-card');
        const items = [...card.querySelectorAll('button, input, select, [href], [tabindex]:not([tabindex="-1"])')]
          .filter(el => !el.disabled && el.offsetParent !== null);
        const tab = (shift) => document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));

        items[items.length - 1].focus(); tab(false);
        const wrappedToFirst = document.activeElement === items[0];
        items[0].focus(); tab(true);
        const wrappedToLast = document.activeElement === items[items.length - 1];

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return {
          focusables: items.length,
          wrappedToFirst,
          wrappedToLast,
          closed: !window.__visible('exportDialog'),
          focusReturnedTo: document.activeElement.id,
        };
      `);
      ok(result.focusables >= 3, `only ${result.focusables} focusable controls in the dialog`);
      ok(result.wrappedToFirst, 'Tab off the last control escaped the dialog');
      ok(result.wrappedToLast, 'Shift-Tab off the first control escaped the dialog');
      ok(result.closed, 'Escape did not close the dialog');
      eq(result.focusReturnedTo, 'btnExport', 'focus went somewhere other than back: ');
    });

    /* ------------------------------------------------------------- export */

    await check('a programme that would distort warns before it encodes', async () => {
      /* The peak is measured after the render and before the encode, so a
         distorted programme is caught before a file anyone might take to a
         competition exists. Nothing is written to disk here: download is
         replaced for the duration. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20, 0.3)], ['b.mp3', window.__tone(330, 20, 0.3)]]);
        const realDownload = window.download;
        const saved = [];
        window.download = (blob, name) => saved.push(name);
        try {
          state.clips[0].gain = 4;              // 0.3 * 4 = 1.2, past full scale
          refresh();
          __id('btnExport').click();
          const warnedBeforeClicking = window.__visible('clipWarning');
          await doExport();
          const first = {
            warned: window.__visible('clipWarning'),
            button: __id('btnExportGo').textContent,
            danger: __id('btnExportGo').classList.contains('danger-solid'),
            files: saved.length,
          };
          await doExport();
          return { warnedBeforeClicking, first, filesAfterSecond: saved.length };
        } finally {
          window.download = realDownload;
          __id('exportDialog').classList.add('hidden');
        }
      `);
      eq(result.warnedBeforeClicking, false, 'the warning should not precede the attempt: ');
      eq(result.first.warned, true, 'a clipping programme must warn: ');
      eq(result.first.files, 0, 'nothing may be encoded on the first click: ');
      eq(result.first.button, 'Save it anyway');
      ok(result.first.danger, 'the way through should not look like the routine path');
      eq(result.filesAfterSecond, 1, 'the second click must go through: ');
    });

    await check('a programme that does not distort is saved straight away', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20, 0.3)]]);
        const realDownload = window.download;
        const saved = [];
        window.download = (blob, name) => saved.push(name);
        try {
          __id('btnExport').click();
          await doExport();
          return { warned: window.__visible('clipWarning'), files: saved.length };
        } finally {
          window.download = realDownload;
          __id('exportDialog').classList.add('hidden');
        }
      `);
      eq(result, { warned: false, files: 1}, 'a clean programme must not be nagged: ');
    });

    /* ------------------------------------------------------------ library */

    await check('a file can only be removed once the programme stops using it', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20)], ['b.mp3', window.__tone(330, 20)]]);
        window.__addToLibrary('spare.mp3', window.__tone(440, 10));
        renderLibrary();
        const buttons = () => [...document.querySelectorAll('#libraryList li')].map(li => ({
          file: li.querySelector('.lib-title').textContent,
          removable: ![...li.querySelectorAll('button')].find(b => b.textContent === 'Remove').disabled,
        }));
        const before = buttons();
        removeClip(state.clips[1].id);
        const after = buttons();
        const inUse = library.has('a.mp3');
        removeFromLibrary('a.mp3');
        return { before, after, stillThere: library.has('a.mp3') && inUse };
      `);
      eq(result.before.map((b) => b.removable), [false, false, true],
        'only the unused file should be removable: ');
      eq(result.after.find((b) => b.file === 'b.mp3').removable, true,
        'taking a clip out should free its file: ');
      ok(result.stillThere, 'a file still in the programme was removed anyway');
    });

    /* -------------------------------------------------------- audio graph */

    await check('auditioning a clip applies its level and its fades', async () => {
      /* It used to connect the source straight to the output, so a song set to
         40% auditioned at 100% — which teaches the wrong thing about the edit. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        const clip = state.clips[0];
        clip.srcStart = 2; clip.srcEnd = 20; clip.fadeIn = 3; clip.fadeOut = 4;
        clip.gain = dbToGain(-8);
        state.selected = clip.id;
        refresh();

        const context = ctx();
        /* Follow the graph that is actually built, not the nodes that happen to
           be constructed. Asserting the latter is how an earlier version of
           this check passed while the source was wired straight to the output
           and both gain nodes dangled unused. */
        const edges = [];
        const realConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (target) {
          edges.push({ from: this, to: target });
          return realConnect.apply(this, arguments);
        };
        let source = null;
        const realSource = context.createBufferSource.bind(context);
        context.createBufferSource = () => { source = realSource(); return source; };
        const realEnvelope = window.applyEnvelope;
        const envelopes = [];
        window.applyEnvelope = (param, points, t0, skip, now) => {
          envelopes.push({ points, skip: +skip.toFixed(3), param });
          return realEnvelope(param, points, t0, skip, now);
        };
        try {
          playClipAudition(clip, 8);           // six seconds into an 18s clip
          stopPlayback();

          // Walk from the source to whatever it eventually reaches.
          const chain = [source];
          for (;;) {
            const next = edges.find((e) => e.from === chain[chain.length - 1]);
            if (!next || chain.includes(next.to)) break;
            chain.push(next.to);
          }
          const levelNode = chain[1];
          const fadeNode = chain[2];
          return {
            path: chain.map((n) => n && n.constructor.name),
            level: levelNode && levelNode.gain ? +levelNode.gain.value.toFixed(4) : null,
            wanted: +clipGain(clip).toFixed(4),
            // The envelope has to be on the node that is actually in the path.
            envelopeOnChain: envelopes.length === 1 && fadeNode && envelopes[0].param === fadeNode.gain,
            skip: envelopes[0] && envelopes[0].skip,
            shape: envelopes[0] && envelopes[0].points,
          };
        } finally {
          AudioNode.prototype.connect = realConnect;
          context.createBufferSource = realSource;
          window.applyEnvelope = realEnvelope;
        }
      `);
      eq(result.path,
        ['AudioBufferSourceNode', 'GainNode', 'GainNode', 'AudioDestinationNode'],
        'the source must reach the output through a level node and a fade node: ');
      near(result.level, result.wanted, 1e-6, 'the level node must carry the clip gain: ');
      ok(result.envelopeOnChain, 'the fade envelope was applied to a node that is not in the path');
      eq(result.skip, 6, 'starting six seconds in: ');
      eq(result.shape, [[0, 0], [3, 1], [14, 1], [18, 0]], 'the fade shape: ');
    });

    await check('playing a join stops before the end of the programme', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__clicks(120, 30)], ['b.mp3', window.__clicks(120, 30)]]);
        state.clips[1].crossfade = 2;
        state.selected = state.clips[1].id;
        refresh();
        __id('btnPlayJoin').click();
        const armed = {
          from: +playing.fromTime.toFixed(3),
          until: +playing.until.toFixed(3),
          joinAt: +layout(state.clips).parts[1].start.toFixed(3),
          total: +playing.total.toFixed(3),
        };
        stopPlayback();
        playProgram(0);
        const plain = { stopAt: Math.min(playing.total, playing.until ?? Infinity) };
        stopPlayback();
        return { armed, plain };
      `);
      eq(result.armed.from, result.armed.joinAt - 4, 'four seconds of lead-in: ');
      eq(result.armed.until, result.armed.joinAt + 2 + 4, 'the tail runs from the end of the blend: ');
      ok(result.armed.until < result.armed.total, 'the preview should stop before the programme does');
      eq(result.plain.stopAt, result.armed.total, 'ordinary play must still run to the end: ');
    });

    /* -------------------------------------------------------------- busy */

    await check('the slow buttons show they are working, even unpainted', async () => {
      /* withBusy yields frames so the disabled state paints first. A hidden tab
         stops painting, so waiting only on a frame would hang forever with the
         work never run — which is what happened the first time this was tried. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20, 0.2)], ['b.mp3', window.__tone(330, 20, 0.05)]]);
        const button = __id('btnEvenOut');
        const seen = {};
        const started = Date.now();
        await withBusy(button, () => {
          seen.label = button.textContent;
          seen.disabled = button.disabled;
          evenOutLevels();
        });
        return {
          duringLabel: seen.label,
          duringDisabled: seen.disabled,
          afterLabel: button.textContent,
          afterDisabled: button.disabled,
          elapsed: Date.now() - started,
          gainsChanged: state.clips.map(c => +clipGain(c).toFixed(3)),
        };
      `);
      eq(result.duringLabel, 'Working…', 'the button should say so while it works: ');
      eq(result.duringDisabled, true, 'and refuse a second click: ');
      eq(result.afterLabel, 'Even out the volume', 'and go back afterwards: ');
      eq(result.afterDisabled, false);
      ok(result.elapsed < 10000, `withBusy took ${result.elapsed}ms — it may be waiting on a frame`);
      ok(result.gainsChanged.some((g) => g !== 1), 'evening out did nothing');
    });

    await check('the work still runs when frames never come', async () => {
      /* A hidden tab stops painting, so requestAnimationFrame never fires and
         waiting only on a frame leaves the button on "Working…" with the work
         never run at all. Headless Chrome does paint, so the only honest way to
         cover the case is to take frames away — which is exactly what a
         backgrounded tab does. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20, 0.2)], ['b.mp3', window.__tone(330, 20, 0.05)]]);
        const button = __id('btnEvenOut');
        const realRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = () => 0;      // a frame that never arrives
        try {
          let ran = false;
          const finished = await Promise.race([
            withBusy(button, () => { ran = true; }).then(() => 'finished'),
            new Promise(r => setTimeout(() => r('hung'), 4000)),
          ]);
          return { finished, ran, label: button.textContent, disabled: button.disabled };
        } finally {
          window.requestAnimationFrame = realRaf;
        }
      `);
      eq(result.finished, 'finished', 'withBusy hung with no frames to wait for: ');
      ok(result.ran, 'the work never ran');
      eq(result.label, 'Even out the volume', 'the button was left saying "Working…": ');
      eq(result.disabled, false, 'the button was left disabled: ');
    });

    /* ------------------------------------------------------------ reorder */

    await check('clips reorder by button, and ignore a stray drop', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20)], ['b.mp3', window.__tone(330, 20)],
                        ['c.mp3', window.__tone(440, 20)]]);
        state.clips.forEach((c, i) => { c.title = 'abc'[i]; });
        state.selected = state.clips[2].id;
        refresh();
        const order = () => state.clips.map(c => c.title).join('');
        const start = order();

        __id('btnMoveLeft').click();
        const afterLeft = order();
        __id('btnMoveLeft').click();
        const atFront = { order: order(), leftDisabled: __id('btnMoveLeft').disabled,
                          stillSelected: selectedClip().title };

        // A dragged text selection, and a dropped file: neither carries the
        // private type, and both used to move the first song.
        const blocks = () => [...document.querySelectorAll('.tl-clip')];
        for (const payload of ['some words', '1', '']) {
          const dt = new DataTransfer();
          dt.setData('text/plain', payload);
          blocks()[2].dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }
        const afterStrayDrops = order();

        // A real drag still works.
        const dt = new DataTransfer();
        blocks()[0].dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        blocks()[2].dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return { start, afterLeft, atFront, afterStrayDrops, afterRealDrag: order() };
      `);
      eq(result.start, 'abc');
      eq(result.afterLeft, 'acb', 'Move earlier should move it one place: ');
      eq(result.atFront.order, 'cab');
      eq(result.atFront.leftDisabled, true, 'at the front it should grey out: ');
      eq(result.atFront.stillSelected, 'c', 'selection must follow the clip: ');
      eq(result.afterStrayDrops, 'cab', 'a stray drop must not reorder anything: ');
      eq(result.afterRealDrag, 'abc', 'a real drag must still work: ');
    });

    /* ------------------------------------------------------------- clamps */

    await check('a clip is pulled back inside the file that arrives', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        state.clips[0].srcEnd = 200;                 // the file is only 30s
        const changed = clampClipsToFile(state.clips, library.get('a.mp3'));
        refresh();
        return { changed, srcEnd: state.clips[0].srcEnd, timer: __id('totalTime').textContent };
      `);
      eq(result.changed, 1);
      eq(result.srcEnd, 30, 'the trim must come back to the end of the file: ');
      eq(result.timer, '0:30.0', 'and the timer must stop claiming time that is not there: ');
    });

    /* -------------------------------------------------------------- close */

    await check('nothing logged an error along the way', async () => {
      const errors = session.page.consoleErrors();
      eq(errors, [], 'the page logged errors: ');
    });
  } finally {
    await session.close();
  }

  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  the browser checks could not run: ${err.message}\n`);
  process.exit(1);
});
