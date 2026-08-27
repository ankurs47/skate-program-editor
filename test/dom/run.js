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
 * These cover the half of the app that the unit tests cannot reach: dialogs and
 * focus, the audio graph, key handling, and the flows that only exist as a
 * sequence of clicks. Two of the bugs fixed in #6 and #7 were found by doing
 * exactly this by hand, which is the argument for doing it automatically.
 *
 * They assert on page state, never on how long something took.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { open } = require('./browser.js');
const { SETUP } = require('./fixtures.js');
// The one list of script files, so this cannot drift from what the page loads.
const { app, SCRIPTS } = require('../harness.js');

let passed = 0;
const failures = [];
let page = null;

/* What the budget checks measured, so CI can report the numbers this run
   produced rather than any written down by hand. */
const metrics = {};

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

    await check('the page starts clean, with every script loaded', async () => {
      const state = await run(`
        return {
          /* The encoder is injected rather than listed in the page, and it may
             or may not have arrived by now — either way it is not what this
             check is about. The export check below is what proves it loads. */
          scripts: [...document.querySelectorAll('script[src]')]
            .map(s => s.getAttribute('src'))
            .filter(s => !s.startsWith('http') && !s.startsWith('src/vendor/')),
          crossFile: ['clamp', 'analyzeBeats', 'qualityKind', 'layout', 'drawWave',
            'playProgram', 'renderLibrary', 'renderTimeline', 'drawClipEditor',
            'openDialog', 'refresh']
            .map(n => typeof window[n] === 'function' || typeof eval(n) === 'function'),
        };
      `);
      eq(state.scripts, SCRIPTS, 'load order: ');
      eq(state.crossFile, new Array(11).fill(true), 'every cross-file name resolves: ');
      eq(session.page.consoleErrors(), [], 'the page logged errors on startup: ');
    });

    await check('collapsing the music panel frees the column and nothing else', async () => {
      /* The first version of this hid `.panel-head > :not(.lib-toggle)` without
         scoping it to #library, which took the Program header — Even out, Play,
         Stop — off the screen along with the sidebar. Reclaimed width alone
         would not have caught that. */
      const out = await run(`
        /* Shared page again: start expanded whatever the last check left. */
        setLibraryCollapsed(false);
        const main = document.querySelector('main');
        const button = document.getElementById('btnLibraryToggle');
        const width = () => Math.round(document.getElementById('scrubber').getBoundingClientRect().width);
        /* Count the controls, not the headers. An emptied .panel-head is still
           an element with an offsetParent, so counting headers stayed at three
           while Play and Stop were off the screen — the check could not fail. */
        const heads = () => [...document.querySelectorAll('.panel-head *')]
          .filter(e => e.offsetParent && !e.closest('#library')).length;
        const spot = () => { const r = button.getBoundingClientRect();
          return Math.round(r.left) + ',' + Math.round(r.top); };
        const before = { w: width(), heads: heads(), spot: spot(),
                         expanded: button.getAttribute('aria-expanded') };
        button.click();
        const after = { w: width(), heads: heads(), spot: spot(),
                        expanded: button.getAttribute('aria-expanded'),
                        stored: localStorage.getItem('skate.musicPanel'),
                        listShown: !!document.getElementById('libraryList').offsetParent };
        button.click();
        const back = { w: width(), expanded: button.getAttribute('aria-expanded') };
        localStorage.removeItem('skate.musicPanel');
        return { before, after, back };
      `);
      ok(
        out.after.w > out.before.w,
        `collapsing gave the workspace no room: ${out.before.w} -> ${out.after.w}`,
      );
      eq(out.after.heads, out.before.heads, 'a panel header disappeared with the sidebar: ');
      eq(out.after.listShown, false, 'the music list is still on screen when collapsed: ');
      eq(out.after.stored, 'collapsed', 'the choice is remembered: ');
      eq(
        [out.before.expanded, out.after.expanded, out.back.expanded],
        ['true', 'false', 'true'],
        'aria-expanded: ',
      );
      eq(out.back.w, out.before.w, 'expanding again did not restore the width: ');
      /* The button is the only way back, so it must not move when it is used —
         collapsed it is the one thing left on screen, and a control that shifts
         is one you have to go looking for the second time. */
      eq(out.after.spot, out.before.spot, 'the toggle moved when the panel collapsed: ');
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
      eq(
        result,
        { before: true, afterEscape: true, afterBackdrop: true },
        'the startup dialog must not be dismissable: ',
      );
    });

    /* -------------------------------------------------------- empty state */

    await check('an empty program says the step that can actually be taken', async () => {
      /* "Pick a song on the left" is only an instruction if there is a song on
         the left. With nothing added it points at an empty panel, so the first
         run has to offer adding music instead. Both messages live in the page
         and one is chosen between them; the risk is that the choosing stops
         happening and whichever is written first wins for ever. */
      const out = await run(`
        window.__reset([]);
        const wrap = document.getElementById('timelineWrap');
        const shown = () => [...document.querySelectorAll('#timelineEmpty [data-when]')]
          .filter(n => n.getClientRects().length)
          .map(n => n.dataset.when)
          .filter((v, i, a) => a.indexOf(v) === i);
        const snap = () => ({
          mode: wrap.dataset.mode,
          shown: shown(),
          text: document.getElementById('timelineEmpty').innerText.replace(/\\s+/g, ' ').trim(),
          play: document.getElementById('btnPlay').disabled,
          stop: document.getElementById('btnStop').disabled,
          scrubHelp: document.querySelector('.scrub-help').getClientRects().length > 0,
          height: Math.round(wrap.getBoundingClientRect().height),
        });

        const first = snap();

        /* The routes out of the empty state have to be real buttons, not
           instructions about buttons elsewhere. Both are checked by watching
           what they reach rather than by opening a file dialog, which is not
           something a headless browser will show. */
        let picked = 0;
        const realPick = window.showOpenFilePicker;
        /* Either route into the picker counts: the File System Access API where
           the browser has it, the hidden <input> where it does not. */
        if (realPick) window.showOpenFilePicker = () => { picked++; return Promise.reject(new Error('none')); };
        const fileInput = document.getElementById('fileInput');
        const realFileClick = fileInput.click;
        fileInput.click = () => { picked++; };
        const projectInput = document.getElementById('projectInput');
        let loaded = 0;
        const realProjectClick = projectInput.click;
        projectInput.click = () => { loaded++; };

        document.getElementById('btnEmptyAdd').click();
        document.getElementById('btnEmptyLoad').click();
        const reached = { picked, loaded };

        if (realPick) window.showOpenFilePicker = realPick;
        fileInput.click = realFileClick;
        projectInput.click = realProjectClick;

        /* Music in the library but nothing in the program — __reset adds a clip
           for every song it is given, which is the state after this one. */
        window.__reset([]);
        window.__addToLibrary('a.mp3', window.__tone(220, 30));
        refresh();
        const withMusic = snap();

        addClip(library.get('a.mp3'));
        refresh();
        const withClip = snap();

        return { first, withMusic, withClip, reached };
      `);

      eq(out.first.mode, 'start', 'a first run should offer adding music: ');
      eq(out.first.shown, ['start'], 'only the first-run message belongs on a first run: ');
      ok(
        !/Pick a song on the left/.test(out.first.text),
        `a first run still points at the empty panel: "${out.first.text}"`,
      );
      ok(out.first.play && out.first.stop, 'Play and Stop offer themselves with nothing to play');
      ok(!out.first.scrubHelp, 'the scrubber explains itself with nothing to scrub');

      ok(out.reached.picked > 0, 'Add your music reached no file picker');
      ok(out.reached.loaded > 0, 'Load a saved project reached no project input');

      eq(out.withMusic.mode, 'pick', 'with music and no clips, say how to add one: ');
      eq(out.withMusic.shown, ['pick'], 'the first-run message outstayed the first run: ');
      ok(
        /Pick a song on the left/.test(out.withMusic.text),
        `no instruction once there is a song to pick: "${out.withMusic.text}"`,
      );
      ok(
        out.first.height > out.withMusic.height,
        `the first-run card is cramped into the strip: ${out.first.height} vs ${out.withMusic.height}`,
      );

      eq(out.withClip.mode, 'none', 'the empty state outstayed the empty program: ');
      eq(out.withClip.shown, [], 'an empty-state message is showing over a real program: ');
      ok(!out.withClip.play, 'Play stayed off with a clip to play');
      ok(out.withClip.scrubHelp, 'the scrubber lost its explanation');
    });

    await check('a note is saved with the program and comes back with it', async () => {
      /* The one field here nothing else reads. It still has to survive a save,
         restore on reload, sit inside undo the way the program name does, and
         go away with the program it belonged to. */
      const out = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        const box = document.getElementById('notesBox');
        const area = document.getElementById('programNotes');

        const closedToStart = { open: box.open, value: area.value };

        // Typed, not assigned: the input event is what the app listens for.
        area.value = 'coach wants the slow part longer';
        area.dispatchEvent(new Event('input', { bubbles: true }));
        const typed = { state: state.notes, stored: JSON.parse(localStorage.getItem('skate.program.v1')).notes };

        // Reopening the saved project brings it back, and shows it.
        box.open = false;
        loadProject(JSON.parse(localStorage.getItem('skate.program.v1')));
        const reopened = { open: box.open, value: area.value, state: state.notes };

        // A second burst of typing, then undo, restores the first.
        area.value = 'and a cleaner cut into the finish';
        area.dispatchEvent(new Event('input', { bubbles: true }));
        endUndoRun();
        undo();
        const undone = { state: state.notes, value: area.value };

        startNewProgram();
        const fresh = { state: state.notes, value: area.value, open: box.open };

        return { closedToStart, typed, reopened, undone, fresh };
      `);

      eq(
        out.closedToStart,
        { open: false, value: '' },
        'a program with no note should say nothing: ',
      );
      eq(out.typed.state, 'coach wants the slow part longer', 'typing did not reach the program: ');
      eq(out.typed.stored, 'coach wants the slow part longer', 'the note was not saved: ');
      eq(
        out.reopened.state,
        'coach wants the slow part longer',
        'the note did not survive a reload: ',
      );
      eq(
        out.reopened.value,
        'coach wants the slow part longer',
        'the note did not reach the box: ',
      );
      ok(out.reopened.open, 'a project carrying a note opened with it hidden');
      eq(out.undone.state, 'coach wants the slow part longer', 'undo did not put the note back: ');
      eq(out.undone.value, 'coach wants the slow part longer', 'undo did not reach the box: ');
      eq(out.fresh, { state: '', value: '', open: false }, 'a new program kept the old note: ');
    });

    await check('a song shows what its file says about itself', async () => {
      /* The tags are read from bytes the browser hands over once and then takes
         away, so the only place this can be checked end to end is here. The
         panel is built from text out of somebody's file, which is why it is
         asserted as text rather than as markup. */
      const out = await run(`
        window.__reset([]);
        const ctx = new AudioContext();
        const buf = ctx.createBuffer(2, ctx.sampleRate * 20, ctx.sampleRate);
        library.set('track03.m4a', {
          name: 'track03.m4a', buffer: buf, peaks: computePeaks(buf), duration: 20,
          bytes: 700000, quality: { kind: 'good', label: 'Good', detail: '' },
          fingerprint: 'x', state: 'ready',
          tags: { title: 'Adagio in G minor', composer: 'Tomaso Albinoni', year: '1958' },
        });
        libraryShape = null;
        renderLibrary();

        const item = document.querySelector('#libraryList li');
        const info = [...item.querySelectorAll('button')].find(b => b.textContent === 'Info');
        const panel = () => item.querySelector('.lib-tags');
        const shut = { expanded: info.getAttribute('aria-expanded'), hidden: panel().hidden };
        info.click();
        const open = {
          expanded: info.getAttribute('aria-expanded'),
          hidden: panel().hidden,
          text: panel().innerText.replace(/\\s+/g, ' ').trim(),
        };

        /* Rebuilding the list must not shut a panel somebody opened — the list
           is redrawn whenever anything in it changes. */
        libraryShape = null;
        renderLibrary();
        const survived = document.querySelector('#libraryList .lib-tags').hidden;

        const heading = document.querySelector('#libraryList .lib-title').textContent;
        const fileLine = document.querySelector('#libraryList .lib-file').textContent;

        // A song with nothing to say offers no button at all.
        library.set('bare.mp3', {
          name: 'bare.mp3', buffer: buf, peaks: computePeaks(buf), duration: 20,
          bytes: 1000, quality: { kind: 'good', label: 'Good', detail: '' },
          fingerprint: 'y', state: 'ready', tags: {},
        });
        libraryShape = null;
        renderLibrary();
        const bare = [...document.querySelectorAll('#libraryList li')][1];
        const bareHasInfo = [...bare.querySelectorAll('button')].some(b => b.textContent === 'Info');

        const rights = item.querySelector('.lib-rights').href;

        /* Everything above works on a library entry built here, which leaves
           the actual reading of a file untested — a mutation that stopped the
           tags being read at all survived exactly that way. So: a real ID3 tag
           on the front of a file, handed to addFiles the way a drop would.

           The audio is deliberately not decodable. Tags are read before the
           decode, so a file that will not play still says what it claims to be,
           and this needs no encoder to build. */
        const id3 = (title, composer) => {
          const text = (s) => [...new TextEncoder().encode(s)];
          const frame = (name, value) => {
            const body = [3, ...text(value), 0];
            return [...text(name), (body.length >> 24) & 255, (body.length >> 16) & 255,
              (body.length >> 8) & 255, body.length & 255, 0, 0, ...body];
          };
          const frames = [...frame('TIT2', title), ...frame('TCOM', composer)];
          const n = frames.length;
          return new Uint8Array([...text('ID3'), 3, 0, 0,
            (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127, ...frames]);
        };
        await addFiles([new File([id3('Bolero', 'Maurice Ravel')], 'track07.mp3')]);
        const readFromFile = library.get('track07.mp3');
        const fromFile = {
          title: readFromFile && readFromFile.tags && readFromFile.tags.title,
          composer: readFromFile && readFromFile.tags && readFromFile.tags.composer,
          // Found by the file name under it, not by position: the list holds
          // whatever earlier parts of this check put there.
          named: [...document.querySelectorAll('#libraryList li')]
            .filter((li) => li.querySelector('.lib-file'))
            .filter((li) => li.querySelector('.lib-file').textContent === 'track07.mp3')
            .map((li) => li.querySelector('.lib-title').textContent)[0],
        };

        return { fromFile, shut, open, survived, heading, fileLine, bareHasInfo, rights,
                 bareHeading: bare.querySelector('.lib-title').textContent };
      `);

      eq(out.shut, { expanded: 'false', hidden: true }, 'the panel should start shut: ');
      eq(out.open.expanded, 'true', 'the button did not say it had opened: ');
      eq(out.open.hidden, false, 'the panel stayed hidden: ');
      ok(/Adagio in G minor/.test(out.open.text), `no title in the panel: "${out.open.text}"`);
      // Case-insensitive: the labels are uppercased by the stylesheet, and a
      // check on what the panel says should not depend on how it is styled.
      ok(/Composer Tomaso Albinoni/i.test(out.open.text), `no composer: "${out.open.text}"`);
      ok(/1958/.test(out.open.text), `no year: "${out.open.text}"`);
      eq(out.survived, false, 'redrawing the list shut a panel that was open: ');

      eq(out.heading, 'Adagio in G minor', 'the song is still named after its file: ');
      eq(out.fileLine, 'track03.m4a', 'the file name has to stay visible: ');

      const link = new URL(out.rights);
      eq(link.origin + link.pathname, app.CLICKNCLEAR_SEARCH, 'the rights link moved: ');
      eq(link.searchParams.get('search'), 'Adagio in G minor', 'it does not look up this song: ');
      eq(link.searchParams.get('entity'), 'tracks');
      /* A real search URL from the site also carries a label filter and a year
         range. Either would quietly hide most of what a song might match, so
         nothing beyond what is being looked for belongs here. */
      eq(
        [...link.searchParams.keys()].sort(),
        ['entity', 'search'],
        'the link narrows the search: ',
      );

      /* The reading itself, not just the showing: these come off a real tag on
         a real file that went in through addFiles. */
      eq(out.fromFile.title, 'Bolero', 'the tag on an added file was never read: ');
      eq(out.fromFile.composer, 'Maurice Ravel', 'the composer was never read: ');
      eq(out.fromFile.named, 'Bolero', 'a file that will not play still says what it is: ');

      ok(!out.bareHasInfo, 'a song with nothing to say still offered an Info button');
      eq(out.bareHeading, 'bare.mp3', 'a song with no title should show its file name: ');
    });

    /* ------------------------------------------------------- a desktop host */

    await check("a desktop shell's folder opens as the program, music and all", async () => {
      /* The one thing a folder buys that a browser cannot: the project and its
         songs arrive together, so nobody is asked to find three files they
         already have. Driven with a fake shell — the bridge is only an object,
         so none of this needs Electron to be checked. */
      const out = await run(`
        window.__reset([]);
        const bytes = await window.encodeWav(window.__tone(220, 4)).arrayBuffer();
        const written = [];
        window.skateHost = {
          version: HOST_VERSION,
          project: {
            name: () => 'my 2027 junior long',
            read: async () => ({
              format: FORMAT, version: FORMAT_VERSION, name: 'from a folder',
              event: { level: 'usfs-juv', targetSeconds: 135, toleranceSeconds: 10 },
              songs: [{ name: 'opening.wav', title: 'Adagio in G minor' }],
              clips: [{ id: 'a', song: 'opening.wav', start: 0, end: 3 }],
            }),
            write: async (doc) => { written.push(doc); },
            media: async () => [{ name: 'opening.wav' }],
            open: async () => bytes,
          },
        };
        /* Bringing music in is the shell's own affair, done in its own
           interface. What the page still needs is to be told the folder
           changed — see the arrival below. */
        window.skateHost.project.onAdded = (fn) => { window.__tellPage = fn; };

        const seen = hostPresent();
        bindHostAdded();

        await openHostProject();
        const noButtons = document.querySelectorAll('#btnImport, #btnEmptyImport').length;
        const opened = {
          name: state.name,
          clips: state.clips.length,
          title: state.clips.length ? state.clips[0].title : null,
          decoded: !!(library.get('opening.wav') && library.get('opening.wav').buffer),
          missing: !document.getElementById('missingNotice').classList.contains('hidden'),
        };

        /* Saving goes to the folder and nowhere else: two copies of one program,
           one of them invisible, is how they come to disagree. */
        localStorage.removeItem('skate.program.v1');
        state.name = 'edited';
        save();
        const beforeWait = { writes: written.length, local: localStorage.getItem('skate.program.v1') };
        await new Promise((done) => setTimeout(done, 600));
        const afterWait = { writes: written.length, name: written.length ? written[0].name : null,
                            local: localStorage.getItem('skate.program.v1') };

        /* And the arrival itself, followed through: the shell says a song
           landed, and the page reads the folder again rather than trusting the
           account of it. bindHostAdded is the join between those two, and
           without exercising it a version that quietly returns before
           subscribing passes every other check. */
        const heard = typeof window.__tellPage === 'function';
        if (heard) {
          await window.__tellPage({
            name: 'arrived.m4a',
            title: 'Bolero',
            source: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=x' },
          });
        }
        const remembered = state.expectedFiles.get('arrived.m4a') || null;

        delete window.skateHost;
        return { seen, heard, remembered, noButtons, opened, beforeWait, afterWait };
      `);

      ok(out.seen, 'the shell was not found');
      /* The page renders no control for this any more. A shell that can fetch
         music has its own interface; a button here would be the page
         describing something it does not own. */
      eq(out.noButtons, 0, 'the page still has a shell-supplied import button: ');
      ok(out.heard, 'the shell offered to say when the folder changed and nobody listened');
      ok(out.remembered, 'the shell said a song arrived and the page did nothing with it');
      eq(out.remembered.title, 'Bolero', 'what the shell knew about it was dropped: ');

      eq(out.opened.name, 'from a folder', 'the project in the folder did not open: ');
      eq(out.opened.clips, 1, 'the program came back empty: ');
      eq(out.opened.title, 'Adagio in G minor', 'the song title in the folder was lost: ');
      ok(out.opened.decoded, 'the music in the folder was not decoded');
      ok(!out.opened.missing, 'a folder that holds the music still asked for it');

      eq(out.beforeWait.writes, 0, 'a folder was written to on the keystroke: ');
      eq(out.afterWait.writes, 1, 'the folder was never written to: ');
      eq(out.afterWait.name, 'edited', 'what reached the folder was not the edit: ');
      eq(out.afterWait.local, null, 'the program was also left in localStorage: ');
    });

    await check('inside a shell the page stops offering to manage the project', async () => {
      /* In a browser this page is the whole application and has to be able to
         start a program, save one and open one, because nothing else can.
         Inside a shell all three happen before this page exists — the folder is
         the project and which project is a question answered on a landing page
         — so a button here would either do nothing or quietly disagree with the
         folder it is sitting in. */
      const out = await run(`
        window.__reset([]);
        const before = PROJECT_CONTROLS.map((id) => ({
          id,
          hidden: document.getElementById(id).classList.contains('hidden'),
        }));

        window.skateHost = {
          version: HOST_VERSION,
          project: {
            name: () => 'a folder', read: async () => null, write: async () => {},
            media: async () => [], open: async () => new ArrayBuffer(0),
          },
        };
        hideProjectControls();
        const after = PROJECT_CONTROLS.map((id) => ({
          id,
          hidden: document.getElementById(id).classList.contains('hidden'),
        }));

        /* And the first-run dialog stays shut. The name and the event were
           answered before this page loaded. */
        const dialogHidden = document.getElementById('startDialog').classList.contains('hidden');

        /* And put back when the shell goes, which is what makes this safe to
           run on a page other checks share. */
        delete window.skateHost;
        hideProjectControls();
        const restored = PROJECT_CONTROLS.map((id) => ({
          id,
          hidden: document.getElementById(id).classList.contains('hidden'),
        }));

        return { before, after, dialogHidden, restored };
      `);

      /* Every one of them is on screen for a browser, or this proves nothing. */
      eq(
        out.before.filter((c) => c.hidden).map((c) => c.id),
        [],
        'these were already hidden without a shell, so hiding them shows nothing: ',
      );
      eq(
        out.after.filter((c) => !c.hidden).map((c) => c.id),
        [],
        'a shell is hosting the page and these are still offered: ',
      );
      ok(out.dialogHidden, 'the first-run dialog opened inside a shell');
      /* And back again with the shell gone. A function that can hide a control
         and not show it makes the page depend on what ran before it. */
      eq(
        out.restored.filter((c) => c.hidden).map((c) => c.id),
        [],
        'the shell went away and these stayed hidden: ',
      );
    });

    await check('a file from outside is handed to the shell, not written here', async () => {
      /* This page cannot write a file and must not pretend to. What it does is
         hand the bytes over and use the name that comes back — which may not be
         the name it sent, because one already taken gets a number.

         And a shell that offers no way to take a file keeps the old behavior,
         because that is what every browser is. */
      const out = await run(`
        window.__reset([]);
        const bytes = await window.encodeWav(window.__tone(220, 1)).arrayBuffer();
        const asked = [];

        const host = (extra) => ({
          version: HOST_VERSION,
          project: {
            name: () => 'a folder', read: async () => null, write: async () => {},
            media: async () => [{ name: 'opening (2).wav' }],
            open: async () => bytes,
            ...extra,
          },
        });

        /* A shell that takes files: it is asked, and its answer is what the
           library ends up keyed by. */
        window.skateHost = host({
          importFile: async (name, data) => {
            asked.push({ name, bytes: data.byteLength });
            return 'opening (2).wav';
          },
        });
        const added = await addFiles([new File([bytes], 'opening.wav', { type: 'audio/wav' })]);
        const throughShell = {
          asked: asked.length,
          sentName: asked.length ? asked[0].name : null,
          sentBytes: asked.length ? asked[0].bytes > 0 : false,
          keyedAs: added.length ? added[0].name : null,
        };

        /* A shell with no way to take one: the old path, unchanged. */
        window.__reset([]);
        window.skateHost = host({});
        const plain = await addFiles([new File([bytes], 'straight in.wav', { type: 'audio/wav' })]);
        const withoutShell = { added: plain.length, keyedAs: plain.length ? plain[0].name : null };

        delete window.skateHost;
        return { throughShell, withoutShell };
      `);

      eq(out.throughShell.asked, 1, 'the shell was not asked to take the file: ');
      eq(out.throughShell.sentName, 'opening.wav', 'it sent the wrong name: ');
      ok(out.throughShell.sentBytes, 'it sent no bytes, so there was nothing to copy');
      /* The name that came back, not the one that went out. A shell that had to
         number the file would otherwise be writing one song and the program
         naming another. */
      eq(out.throughShell.keyedAs, 'opening (2).wav', 'it kept the name it sent: ');

      eq(out.withoutShell.added, 1, 'a shell that cannot take files broke adding one: ');
      eq(out.withoutShell.keyedAs, 'straight in.wav', 'the old path renamed something: ');
    });

    await check('with no shell, the page is exactly the page it was', async () => {
      /* The guarantee the whole bridge rests on. Everything above is asked for
         through hostPresent(), so with nothing offering a host none of it can
         run — the editor is a web page, opened from a file, as it always was. */
      const out = await run(`
        delete window.skateHost;
        window.__reset([]);
        bindHostAdded();

        localStorage.removeItem('skate.program.v1');
        state.name = 'no shell here';
        save();
        const stored = JSON.parse(localStorage.getItem('skate.program.v1') || 'null');

        return {
          present: hostPresent(),
          project: hostProject(),
          importer: hostAdded(),
          storedName: stored && stored.name,
          routes: [...document.querySelectorAll('#timelineEmpty .empty-actions button')]
            .filter((b) => !b.classList.contains('hidden'))
            .map((b) => b.textContent),
        };
      `);

      eq(out.present, false, 'a host was found with nothing offering one: ');
      eq(out.project, null);
      eq(out.importer, null);
      eq(out.storedName, 'no shell here', 'saving stopped going to localStorage: ');
      eq(
        out.routes,
        ['Add your music', 'Load a saved project'],
        'the empty state has to be what it was: ',
      );
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

    await check('undo and redo walk the same steps, by either shortcut', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        state.selected = state.clips[0].id;
        refresh();
        undoStack.length = 0; redoStack.length = 0; endUndoRun();

        const ends = [];
        for (let i = 0; i < 3; i++) {
          pushUndo(); endUndoRun();
          state.clips[0].srcEnd -= 5;
          ends.push(state.clips[0].srcEnd);
        }
        const at = () => state.clips[0].srcEnd;

        window.__key('z', { ctrlKey: true });
        window.__key('z', { ctrlKey: true });
        const backTwice = at();
        window.__key('z', { ctrlKey: true, shiftKey: true });   // redo
        const forwardShift = at();
        window.__key('y', { ctrlKey: true });                   // redo, the Windows way
        const forwardCtrlY = at();
        return { ends, backTwice, forwardShift, forwardCtrlY, redoLeft: redoStack.length };
      `);
      eq(result.backTwice, result.ends[0], 'two undos should land two edits back: ');
      eq(result.forwardShift, result.ends[1], 'Ctrl+Shift+Z should step forward: ');
      eq(result.forwardCtrlY, result.ends[2], 'Ctrl+Y should too: ');
      eq(result.redoLeft, 0, 'and there should be nothing further forward: ');
    });

    await check('undo puts back the target length, not just the clips', async () => {
      /* Choosing the wrong event must not lose the length being worked to with
         nothing to get it back — the timer is the number the edit is for. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        applyLevel('usfs-juv');
        undoStack.length = 0; redoStack.length = 0; endUndoRun();
        const before = {
          target: state.targetSeconds,
          picker: __id('targetLength').value,
          timer: __id('budgetDelta').textContent,
        };

        // What the dropdown does when a different event is chosen.
        __id('targetLength').value = 'usfs-sr';
        __id('targetLength').dispatchEvent(new Event('change'));
        const changed = { target: state.targetSeconds, picker: __id('targetLength').value };

        undo();
        const undone = {
          target: state.targetSeconds,
          picker: __id('targetLength').value,
          timer: __id('budgetDelta').textContent,
        };
        redo();
        return { before, changed, undone, redone: state.targetSeconds };
      `);
      eq(result.before.target, 135, 'Juvenile is 2:15: ');
      eq(result.changed.target, 240, 'Senior is 4:00: ');
      eq(result.undone.target, result.before.target, 'undo must restore the length: ');
      eq(result.undone.picker, result.before.picker, 'and the dropdown must follow it: ');
      eq(result.undone.timer, result.before.timer, 'and so must the timer: ');
      eq(result.redone, 240, 'redo must put the new event back: ');
    });

    await check('typing a program name is one undo step, not one per letter', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        state.name = 'start';
        __id('programName').value = 'start';
        undoStack.length = 0; redoStack.length = 0; endUndoRun();

        const field = __id('programName');
        for (const text of ['s', 'sk', 'ska', 'skat', 'skate']) {
          field.value = text;
          field.dispatchEvent(new Event('input'));
        }
        const afterTyping = { name: state.name, steps: undoStack.length };
        undo();
        return { afterTyping, afterUndo: state.name, field: __id('programName').value };
      `);
      eq(result.afterTyping.name, 'skate');
      eq(result.afterTyping.steps, 1, 'five keystrokes should be one undo step: ');
      eq(result.afterUndo, 'start', 'undo should go back to the whole earlier name: ');
      eq(result.field, 'start', 'and the field must show it: ');
    });

    /* ------------------------------------------------------------ dialogs */

    await check('a dialog owns the keyboard while it is open', async () => {
      // The export dialog included: leave one out and Space, Delete and the
      // trim keys still reach the program behind it.
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
      eq(
        result,
        { open: true, clipsUnchanged: true, trimUnchanged: true, notPlaying: true },
        'editing keys reached the program behind the dialog: ',
      );
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

    await check('a program that would distort warns before it encodes', async () => {
      /* The peak is measured after the render and before the encode, so a
         distorted program is caught before a file anyone might take to a
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
      eq(result.first.warned, true, 'a clipping program must warn: ');
      eq(result.first.files, 0, 'nothing may be encoded on the first click: ');
      eq(result.first.button, 'Save it anyway');
      ok(result.first.danger, 'the way through should not look like the routine path');
      eq(result.filesAfterSecond, 1, 'the second click must go through: ');
    });

    await check('a program that does not distort is saved straight away', async () => {
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
      eq(result, { warned: false, files: 1 }, 'a clean program must not be nagged: ');
    });

    /* ------------------------------------------------------------ library */

    await check('a file can only be removed once the program stops using it', async () => {
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
      eq(
        result.before.map((b) => b.removable),
        [false, false, true],
        'only the unused file should be removable: ',
      );
      eq(
        result.after.find((b) => b.file === 'b.mp3').removable,
        true,
        'taking a clip out should free its file: ',
      );
      ok(result.stillThere, 'a file still in the program was removed anyway');
    });

    /* ------------------------------------------------ replacing a song */

    await check('Replace is offered on exactly the songs Remove is not', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(1)]]);
        window.__addToLibrary('spare.mp3', window.__tune(2));
        renderLibrary();
        return [...document.querySelectorAll('#libraryList li')].map(li => ({
          file: li.dataset.song,
          canReplace: [...li.querySelectorAll('button')].some(b => b.textContent === 'Replace'),
          canRemove: ![...li.querySelectorAll('button')].find(b => b.textContent === 'Remove').disabled,
          swappable: li.classList.contains('swappable'),
        }));
      `);
      eq(
        result,
        [
          { file: 'a.mp3', canReplace: true, canRemove: false, swappable: true },
          { file: 'spare.mp3', canReplace: false, canRemove: true, swappable: false },
        ],
        'one or the other, never both and never neither: ',
      );
    });

    await check('a better copy of the same song keeps every trim', async () => {
      const result = await run(`
        window.__reset([['rough.mp3', window.__tune(4, 20)]]);
        state.clips[0].srcStart = 3;
        state.clips[0].srcEnd = 12;
        state.clips[0].fadeIn = 1.5;
        state.clips[0].gain = 0.5;
        refresh();
        const before = { ...state.clips[0] };

        /* The same music, quieter and with a touch of distortion — what a
           different encode of one recording looks like. */
        const better = window.__tune(4, 20, (v) => v * 0.7 + (v > 0 ? 0.003 : -0.003));
        await offerReplacement('rough.mp3', window.__asFile('good.wav', better));
        const dialogOpen = window.__visible('replaceDialog');
        const button = document.getElementById('btnReplaceGo').textContent;
        const verdicts = [...document.querySelectorAll('#replaceChecks .check')]
          .map(li => li.className.replace('check is-', ''));
        await applyReplacement();

        const after = state.clips[0];
        return {
          dialogOpen, button, verdicts,
          closed: !window.__visible('replaceDialog'),
          plays: after.file,
          keptTrim: after.srcStart === before.srcStart && after.srcEnd === before.srcEnd,
          keptFade: after.fadeIn === before.fadeIn,
          keptGain: after.gain === before.gain,
          oldKept: library.has('rough.mp3'),
          newThere: library.has('good.wav'),
          nothingUsesOld: clipsUsing('rough.mp3'),
        };
      `);
      ok(result.dialogOpen, 'the dialog should have opened before anything changed');
      eq(result.button, 'Replace', 'a clean swap should not read as a warning: ');
      ok(!result.verdicts.includes('warn'), `nothing should warn, got ${result.verdicts}`);
      eq(result.plays, 'good.wav', 'the clip should play from the new file: ');
      ok(result.keptTrim, 'the trim was not kept');
      ok(result.keptFade, 'the fade was not kept');
      ok(result.keptGain, 'the level was not kept');
      ok(result.newThere, 'the new song should be in the list');
      ok(
        result.oldKept,
        'the song replaced should stay in the list, so undo has something to go back to',
      );
      eq(result.nothingUsesOld, 0, 'but nothing should play from it any more: ');
      ok(result.closed, 'the dialog should have closed');
    });

    await check('a replacement can be undone, music and all', async () => {
      const result = await run(`
        window.__reset([['rough.mp3', window.__tune(4, 20)]]);
        state.clips[0].srcStart = 3;
        state.clips[0].srcEnd = 12;
        refresh();
        const better = window.__tune(4, 20, (v) => v * 0.7);
        await offerReplacement('rough.mp3', window.__asFile('good.wav', better));
        await applyReplacement();
        const swapped = state.clips[0].file;
        undo();
        const back = state.clips[0];
        return {
          swapped,
          plays: back.file,
          /* The whole point: whatever the clips point at after an undo has to
             still be in the list, or the program comes back with a hole in it. */
          playable: library.has(back.file) && !!library.get(back.file).buffer,
          keptTrim: back.srcStart === 3 && back.srcEnd === 12,
        };
      `);
      eq(result.swapped, 'good.wav', 'the swap should have happened first: ');
      eq(result.plays, 'rough.mp3', 'undo should put the original song back: ');
      ok(result.playable, 'undo left the program playing from a song that is not there');
      ok(result.keptTrim, 'the trims should have survived the round trip');
    });

    await check('a title that was only a file name does not follow the music', async () => {
      const result = await run(`
        window.__reset([['track03.mp3', window.__tune(4, 20)]]);
        /* What loading a project does: a title is written down for every song,
           and for a file with no tags it is just the name without the
           extension. That is not a decision anybody made. */
        state.expectedFiles.set('track03.mp3', { name: 'track03.mp3', title: 'track03' });
        state.clips[0].title = 'track03';

        await offerReplacement('track03.mp3', window.__asFile('adagio.wav', window.__tune(4, 20)));
        await applyReplacement();
        return {
          clip: state.clips[0].title,
          recorded: state.expectedFiles.get('adagio.wav'),
          inProject: project().songs.map((s) => [s.name, s.title]),
        };
      `);
      eq(result.clip, 'adagio', "the clip should take the new file's name, not keep the old: ");
      eq(result.recorded, { name: 'adagio.wav' }, 'and nothing should be carried over: ');
      eq(result.inProject, [['adagio.wav', 'adagio']], 'the project should say the same: ');
    });

    await check('a name somebody chose survives the swap', async () => {
      const result = await run(`
        window.__reset([['track03.mp3', window.__tune(4, 20)]]);
        state.expectedFiles.set('track03.mp3', { name: 'track03.mp3', title: 'Adagio in G minor' });
        state.clips[0].title = 'Adagio in G minor';
        /* And a second clip renamed by hand, which is a different decision and
           has to survive too. */
        addClip(library.get('track03.mp3'));
        state.clips[1].title = 'the slow bit';

        await offerReplacement('track03.mp3', window.__asFile('better.wav', window.__tune(4, 20)));
        await applyReplacement();
        return {
          followed: state.clips[0].title,
          renamed: state.clips[1].title,
          recorded: state.expectedFiles.get('better.wav').title,
          plays: state.clips.map((c) => c.file),
        };
      `);
      eq(result.followed, 'Adagio in G minor', 'a chosen name should follow the music: ');
      eq(result.renamed, 'the slow bit', 'a clip renamed by hand should keep its name: ');
      eq(result.recorded, 'Adagio in G minor', 'and the project should still record it: ');
      eq(result.plays, ['better.wav', 'better.wav'], 'both clips should play the new file: ');
    });

    await check('a different song warns, and the button says so', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(11, 20)]]);
        await offerReplacement('a.mp3', window.__asFile('other.wav', window.__tune(29, 20)));
        const song = [...document.querySelectorAll('#replaceChecks .check')]
          .find(li => li.classList.contains('is-warn'));
        return {
          open: window.__visible('replaceDialog'),
          button: document.getElementById('btnReplaceGo').textContent,
          warned: song ? song.querySelector('.check-head').textContent : null,
          focused: document.activeElement.id,
          stillPlaying: state.clips[0].file,
        };
      `);
      eq(result.open, true);
      eq(result.button, 'Replace anyway', 'a warning should change what the button offers: ');
      ok(/not look like the same recording/i.test(result.warned || ''), `warned: ${result.warned}`);
      eq(result.focused, 'btnReplaceCancel', 'the safe option should take focus: ');
      eq(result.stillPlaying, 'a.mp3', 'nothing should have changed yet: ');
    });

    await check('cancelling a replacement changes nothing at all', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(11, 20)]]);
        const before = JSON.stringify(state.clips);
        await offerReplacement('a.mp3', window.__asFile('other.wav', window.__tune(29, 20)));
        document.getElementById('btnReplaceCancel').click();
        return {
          closed: !window.__visible('replaceDialog'),
          clipsUnchanged: JSON.stringify(state.clips) === before,
          libraryUnchanged: [...library.keys()].join(),
        };
      `);
      eq(result, { closed: true, clipsUnchanged: true, libraryUnchanged: 'a.mp3' });
    });

    await check('Escape closes the replace dialog like every other one', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(11, 20)]]);
        await offerReplacement('a.mp3', window.__asFile('other.wav', window.__tune(29, 20)));
        window.__key('Escape');
        return { closed: !window.__visible('replaceDialog'), plays: state.clips[0].file };
      `);
      eq(result, { closed: true, plays: 'a.mp3' });
    });

    await check('the same file offered again is refused rather than swapped in', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(11, 20)]]);
        /* Give the song a fingerprint, which decoding would have. The file
           offered is built from the same bytes, so it fingerprints the same. */
        const file = window.__asFile('a.mp3', window.__tune(11, 20));
        const first = await readSong(file);
        library.get('a.mp3').fingerprint = first.fingerprint;
        await offerReplacement('a.mp3', window.__asFile('copy.wav', window.__tune(11, 20)));
        return {
          open: window.__visible('replaceDialog'),
          library: [...library.keys()].join(),
        };
      `);
      eq(result.open, false, 'there is nothing to decide about identical bytes: ');
      eq(result.library, 'a.mp3', 'and nothing should have been added: ');
    });

    await check('a file that starts later moves every trim to match', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(6, 20)]]);
        state.clips[0].srcStart = 5;
        state.clips[0].srcEnd = 12;
        refresh();

        /* The same music with half a second of silence in front, which is what
           a fresh download of one song routinely is. */
        const song = window.__tune(6, 20);
        const later = ctx().createBuffer(2, song.length + Math.round(0.5 * 44100), 44100);
        for (let c = 0; c < 2; c++) {
          later.getChannelData(c).set(song.getChannelData(c), Math.round(0.5 * 44100));
        }
        await offerReplacement('a.mp3', window.__asFile('later.wav', later));
        const timing = [...document.querySelectorAll('#replaceChecks .check')]
          .map(li => li.querySelector('.check-head').textContent)
          .find(t => /starts/.test(t));
        await applyReplacement();
        return { timing, srcStart: state.clips[0].srcStart, srcEnd: state.clips[0].srcEnd };
      `);
      ok(/later/.test(result.timing || ''), `should say the music moved: ${result.timing}`);
      near(result.srcStart, 5.5, 0.08, 'the trim should have moved with the music: ');
      near(result.srcEnd, 12.5, 0.08, 'and so should its end: ');
    });

    await check(
      'a shorter file shortens what will not fit rather than playing silence',
      async () => {
        const result = await run(`
        window.__reset([['a.mp3', window.__tune(8, 30)]]);
        state.clips[0].srcStart = 2;
        state.clips[0].srcEnd = 25;
        refresh();
        await offerReplacement('a.mp3', window.__asFile('short.wav', window.__tune(8, 15)));
        const heads = [...document.querySelectorAll('#replaceChecks .check.is-warn .check-head')]
          .map(el => el.textContent);
        const button = document.getElementById('btnReplaceGo').textContent;
        await applyReplacement();
        return { heads, button, srcEnd: state.clips[0].srcEnd, duration: library.get('short.wav').duration };
      `);
        ok(
          result.heads.some((h) => /runs past the end/i.test(h)),
          `should say what will not fit, got ${JSON.stringify(result.heads)}`,
        );
        eq(result.button, 'Replace anyway');
        ok(
          result.srcEnd <= result.duration + 0.01,
          `the clip should have been brought inside the file: ${result.srcEnd} of ${result.duration}`,
        );
      },
    );

    /* -------------------------------------------------------- audio graph */

    await check('auditioning a clip applies its level and its fades', async () => {
      /* Connected straight to the output, a song set to 40% would audition at
         100% — which teaches the wrong thing about the edit. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        const clip = state.clips[0];
        clip.srcStart = 2; clip.srcEnd = 20; clip.fadeIn = 3; clip.fadeOut = 4;
        clip.gain = dbToGain(-8);
        state.selected = clip.id;
        refresh();

        const context = ctx();
        /* Follow the graph that is actually built, not the nodes that happen to
           be constructed. Asserting the latter passes while the source is wired
           straight to the output and both gain nodes dangle unused. */
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
      eq(
        result.path,
        ['AudioBufferSourceNode', 'GainNode', 'GainNode', 'AudioDestinationNode'],
        'the source must reach the output through a level node and a fade node: ',
      );
      near(result.level, result.wanted, 1e-6, 'the level node must carry the clip gain: ');
      ok(result.envelopeOnChain, 'the fade envelope was applied to a node that is not in the path');
      eq(result.skip, 6, 'starting six seconds in: ');
      eq(
        result.shape,
        [
          [0, 0],
          [3, 1],
          [14, 1],
          [18, 0],
        ],
        'the fade shape: ',
      );
    });

    await check('playing a join stops before the end of the program', async () => {
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
      eq(
        result.armed.until,
        result.armed.joinAt + 2 + 4,
        'the tail runs from the end of the blend: ',
      );
      ok(
        result.armed.until < result.armed.total,
        'the preview should stop before the program does',
      );
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
      ok(
        result.elapsed < 10000,
        `withBusy took ${result.elapsed}ms — it may be waiting on a frame`,
      );
      ok(
        result.gainsChanged.some((g) => g !== 1),
        'evening out did nothing',
      );
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
        // private type, so neither may move a song.
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
      eq(result.atFront.leftDisabled, true, 'at the front it should gray out: ');
      eq(result.atFront.stillSelected, 'c', 'selection must follow the clip: ');
      eq(result.afterStrayDrops, 'cab', 'a stray drop must not reorder anything: ');
      eq(result.afterRealDrag, 'abc', 'a real drag must still work: ');
    });

    /* -------------------------------------------------- remembering files */

    await check('a remembered file is offered back instead of a picker', async () => {
      /* The friction this removes: a project holds the edit but not the music,
         so opening one has always meant finding every song by hand again. */
      const result = await run(`
        window.__reset([]);
        rememberedNames.clear();
        state.clips = [
          { id: '1', file: 'kept.mp3', title: 'kept', srcStart: 0, srcEnd: 30,
            fadeIn: 0, fadeOut: 0, crossfade: 0, gain: 1 },
          { id: '2', file: 'lost.mp3', title: 'lost', srcStart: 0, srcEnd: 30,
            fadeIn: 0, fadeOut: 0, crossfade: 0, gain: 1 },
        ];
        refresh();
        const noneRemembered = {
          notice: window.__visible('missingNotice'),
          reconnect: window.__visible('btnReconnect'),
          missing: missingFiles(),
        };

        rememberedNames.add('kept.mp3');
        updateMissingNotice();
        const someRemembered = {
          reconnect: window.__visible('btnReconnect'),
          label: __id('btnReconnect').textContent,
        };

        rememberedNames.add('lost.mp3');
        updateMissingNotice();
        const allRemembered = { label: __id('btnReconnect').textContent };

        rememberedNames.clear();
        return { noneRemembered, someRemembered, allRemembered, supported: canRememberFiles() };
      `);
      ok(
        result.supported,
        'Chrome should support this; the check below covers browsers that do not',
      );
      eq(result.noneRemembered.missing, ['kept.mp3', 'lost.mp3']);
      eq(result.noneRemembered.notice, true, 'missing files must still be announced: ');
      eq(
        result.noneRemembered.reconnect,
        false,
        'nothing is remembered, so there is nothing to offer: ',
      );
      eq(result.someRemembered.reconnect, true);
      eq(
        result.someRemembered.label,
        'Open 1 of them again',
        'when only some can come back, say so rather than promising all: ',
      );
      eq(result.allRemembered.label, 'Open the music again');
    });

    await check('a handle survives being put away and fetched back', async () => {
      // The store is what makes this work at all across a reload.
      const result = await run(`
        const name = 'round-trip-' + Date.now() + '.mp3';
        // A real handle cannot be made without a picker, and a picker cannot be
        // driven from here — but what is being checked is the store, so a plain
        // structured-cloneable stand-in exercises exactly that.
        await rememberHandle(name, { kind: 'file', name, marker: 'stored' });
        const all = await storedHandles();
        const found = all && all.get(name);
        await forgetHandle(name);
        const after = await storedHandles();
        return {
          stored: found ? found.marker : null,
          remembered: rememberedNames.has(name),
          goneAfterForget: !(after && after.has(name)),
        };
      `);
      eq(result.stored, 'stored', 'the handle did not come back out of storage: ');
      eq(result.goneAfterForget, true, 'forgetting must actually forget: ');
    });

    await check('without the API everything falls back to the file picker', async () => {
      /* Firefox and Safari have no picker, and it is absent over file:// too,
         which the ground rules say has to keep working. Nothing above may
         become load-bearing. */
      const result = await run(`
        window.__reset([]);
        const realPicker = window.showOpenFilePicker;
        delete window.showOpenFilePicker;
        let clicked = 0;
        const input = __id('fileInput');
        const realClick = input.click.bind(input);
        input.click = () => { clicked++; };
        try {
          const supported = canRememberFiles();
          rememberedNames.add('anything.mp3');
          state.clips = [{ id: '1', file: 'anything.mp3', title: 'a', srcStart: 0, srcEnd: 10,
            fadeIn: 0, fadeOut: 0, crossfade: 0, gain: 1 }];
          refresh();
          const offered = window.__visible('btnReconnect');

          await pickFiles();               // must fall through to the input
          const afterPick = clicked;
          await reconnectMissing();        // must fall through as well
          const afterReconnect = clicked;

          // And storage must stay quiet rather than throwing.
          const stored = await storedHandles();
          rememberedNames.clear();
          return { supported, offered, afterPick, afterReconnect, stored };
        } finally {
          window.showOpenFilePicker = realPicker;
          input.click = realClick;
        }
      `);
      eq(result.supported, false, 'with no picker the feature must report itself unavailable: ');
      eq(result.offered, false, 'and must not offer to reopen anything: ');
      eq(result.afterPick, 1, 'Add files must still open the ordinary picker: ');
      eq(result.afterReconnect, 2, 'and so must the missing-file button: ');
      eq(result.stored, null, 'storage must decline quietly rather than throw: ');
    });

    await check('the picker asks for the formats the app can actually read', async () => {
      const result = await run(`
        const types = audioPickerTypes();
        return { types, list: AUDIO_EXTENSION_LIST,
                 matches: AUDIO_EXTENSION_LIST.every(e => AUDIO_EXTENSIONS.test('song' + e)) };
      `);
      eq(result.types.length, 1);
      const accepted = result.types[0].accept['audio/*'];
      for (const ext of ['.mp3', '.wav', '.webm', '.opus']) {
        ok(accepted.includes(ext), `the picker does not offer ${ext}`);
      }
      ok(
        result.matches,
        'the picker list and the drop filter disagree — they are built from one list',
      );
    });

    /* -------------------------------------------------------------- drops */

    await check('music dropped anywhere on the page is taken', async () => {
      /* Not just the small box under the list: a blanket preventDefault
         everywhere else would mean a drop on the timeline did nothing. */
      const result = await run(`
        window.__reset([]);
        // A real DataTransfer carrying a file, as a drag from the desktop does.
        const drop = (target) => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(64)], 'dropped.mp3', { type: 'audio/mpeg' }));
          target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          return dt;
        };
        // addFiles is what a drop reaches; stub it so nothing has to decode.
        const realAddFiles = window.addFiles;
        const seen = [];
        window.addFiles = async (list) => { seen.push([...list].map(f => f.name)); return []; };
        try {
          drop(__id('scrubber'));
          drop(document.querySelector('#timelineWrap'));
          drop(document.body);
          await new Promise(r => setTimeout(r, 0));
          return { drops: seen.length, names: seen.flat() };
        } finally {
          window.addFiles = realAddFiles;
        }
      `);
      eq(result.drops, 3, 'a drop on the scrubber, the timeline and the page should all count: ');
      eq(result.names, ['dropped.mp3', 'dropped.mp3', 'dropped.mp3']);
    });

    await check('a drop on the timeline also puts the song in the program', async () => {
      const result = await run(`
        window.__reset([]);
        window.__addToLibrary('dropped.mp3', window.__tone(220, 12));
        const realAddFiles = window.addFiles;
        window.addFiles = async () => [library.get('dropped.mp3')];
        try {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(64)], 'dropped.mp3', { type: 'audio/mpeg' }));
          document.querySelector('#timelineWrap').dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 0));
          const onTimeline = state.clips.map(c => c.file);

          // The same drop on the library side adds the file but not a clip.
          state.clips = []; refresh();
          const dt2 = new DataTransfer();
          dt2.items.add(new File([new Uint8Array(64)], 'dropped.mp3', { type: 'audio/mpeg' }));
          __id('dropzone').dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 0));
          return { onTimeline, onLibrary: state.clips.map(c => c.file) };
        } finally {
          window.addFiles = realAddFiles;
        }
      `);
      eq(result.onTimeline, ['dropped.mp3'], 'dropping on the timeline should add it: ');
      eq(result.onLibrary, [], 'dropping on the list should not: ');
    });

    await check('dragging a clip is not mistaken for dropping a file', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20)], ['b.mp3', window.__tone(330, 20)]]);
        const realAddFiles = window.addFiles;
        let called = 0;
        window.addFiles = async () => { called++; return []; };
        try {
          const blocks = [...document.querySelectorAll('.tl-clip')];
          const dt = new DataTransfer();
          blocks[0].dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
          blocks[1].dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 0));
          return { called, order: state.clips.map(c => c.file), dropping: document.body.classList.contains('dropping') };
        } finally {
          window.addFiles = realAddFiles;
        }
      `);
      eq(result.called, 0, 'a clip reorder must not be read as a file drop: ');
      eq(result.order, ['b.mp3', 'a.mp3'], 'and the reorder itself must still happen: ');
      eq(result.dropping, false, 'the page must not be left highlighted: ');
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

    /* --------------------------------------------------- the render path */

    /* Budgets, not stopwatches. Wall-clock differs by machine and by what else
       the machine is doing, so these count the things that actually cost the
       time and are the same everywhere: elements built, forced style reads, and
       waveforms drawn. Each number below was a real measurement before the work
       that brought it down, and the assertion is what stops it climbing back.

       Measured on four clips, sixty input events — one second of dragging. */

    await check('dragging a slider rebuilds nothing and re-reads no styles', async () => {
      const result = await run(`
        window.__reset([
          ['a.mp3', window.__tone(220, 200)], ['b.mp3', window.__tone(330, 200)],
          ['c.mp3', window.__tone(440, 200)], ['d.mp3', window.__tone(550, 200)],
        ]);
        state.clips[1].crossfade = 2;
        state.selected = state.clips[1].id;
        refresh();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        let styleReads = 0, created = 0, timelineWaves = 0;
        const realGCS = window.getComputedStyle;
        const realCreate = document.createElement.bind(document);
        const realDrawWave = window.drawWave;
        window.getComputedStyle = function (...a) { styleReads++; return realGCS.apply(this, a); };
        document.createElement = (tag) => { created++; return realCreate(tag); };
        window.drawWave = (canvas, ...rest) => {
          if (canvas && canvas.closest && canvas.closest('#timeline')) timelineWaves++;
          return realDrawWave(canvas, ...rest);
        };
        try {
          const clip = selectedClip();
          const drag = () => {
            const started = performance.now();
            for (let i = 0; i < 60; i++) {
              clip.crossfade = 1 + (i % 20) * 0.05;    // never crosses MIN_CROSSFADE
              drawClipEditor(); renderTimeline(); updateBudget();
            }
            return performance.now() - started;
          };
          /* Warm up, then keep the best of several. A first pass pays for cold
             code and cold canvases, and a shared machine can be interrupted at
             any moment — the best sample is the one closest to the work itself,
             which is the only part worth reporting. The counts below are taken
             from the measured passes and do not vary between them. */
          drag();
          styleReads = 0; created = 0; timelineWaves = 0;
          let blockingMs = Infinity;
          for (let i = 0; i < 5; i++) blockingMs = Math.min(blockingMs, drag());
          blockingMs = +blockingMs.toFixed(1);
          // The counts are per pass, so report one pass's worth.
          styleReads = Math.round(styleReads / 5);
          created = Math.round(created / 5);
          timelineWaves = Math.round(timelineWaves / 5);
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          return { styleReads, created, timelineWaves, blockingMs, clips: state.clips.length };
        } finally {
          window.getComputedStyle = realGCS;
          document.createElement = realCreate;
          window.drawWave = realDrawWave;
        }
      `);
      metrics.drag = {
        events: 60,
        clips: result.clips,
        elementsCreated: result.created,
        forcedStyleReads: result.styleReads,
        timelineWaveDraws: result.timelineWaves,
        blockingMs: result.blockingMs,
        wasElements: 1140,
        wasStyleReads: 480,
        wasWaveDraws: 240,
        wasBlockingMs: 35.9,
      };
      eq(
        result.created,
        0,
        'sixty input events built elements — the strip is being rebuilt again: ',
      );
      eq(
        result.styleReads,
        0,
        'the stylesheet was read during drawing; the color cache is not being used: ',
      );
      ok(
        result.timelineWaves <= result.clips * 4,
        `${result.timelineWaves} waveform draws for ${result.clips} clips over sixty events — ` +
          'they are meant to coalesce to about one batch a frame (it was 240)',
      );
    });

    await check('a refresh that changes nothing rebuilds nothing', async () => {
      /* refresh() redraws the library because whether a file can be removed
         depends on the program using it — but that answer changes far less
         often than refresh is called. */
      const result = await run(`
        window.__reset([
          ['a.mp3', window.__tone(220, 200)], ['b.mp3', window.__tone(330, 200)],
          ['c.mp3', window.__tone(440, 200)], ['d.mp3', window.__tone(550, 200)],
        ]);
        refresh();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        let created = 0, styleReads = 0;
        const realGCS = window.getComputedStyle;
        const realCreate = document.createElement.bind(document);
        window.getComputedStyle = function (...a) { styleReads++; return realGCS.apply(this, a); };
        document.createElement = (tag) => { created++; return realCreate(tag); };
        try {
          const idle = () => {
            const started = performance.now();
            for (let i = 0; i < 30; i++) refresh();
            return performance.now() - started;
          };
          idle();                                   // warm up, as above
          created = 0; styleReads = 0;
          let blockingMs = Infinity;
          for (let i = 0; i < 5; i++) blockingMs = Math.min(blockingMs, idle());
          blockingMs = +blockingMs.toFixed(1);
          created = Math.round(created / 5);
          styleReads = Math.round(styleReads / 5);
          return { created, styleReads, blockingMs };
        } finally {
          window.getComputedStyle = realGCS;
          document.createElement = realCreate;
        }
      `);
      metrics.refresh = {
        calls: 30,
        elementsCreated: result.created,
        forcedStyleReads: result.styleReads,
        blockingMs: result.blockingMs,
        wasElements: 1530,
        wasStyleReads: 750,
        wasBlockingMs: 30.1,
      };
      eq(result.created, 0, 'thirty idle refreshes built elements (it was 1530): ');
      eq(result.styleReads, 0, 'and read the stylesheet (it was 750): ');
    });

    await check('but a real change still rebuilds what it must', async () => {
      // The budgets above are only worth having if the caches still notice work.
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 60)], ['b.mp3', window.__tone(330, 60)]]);
        refresh();
        const count = () => document.querySelectorAll('#timeline .tl-clip').length;
        const libRows = () => document.querySelectorAll('#libraryList li').length;

        const before = { blocks: count(), rows: libRows(), names: state.clips.map(c => c.title) };
        removeClip(state.clips[1].id);
        const afterRemove = { blocks: count(), rows: libRows() };

        window.__addToLibrary('c.mp3', window.__tone(440, 60));
        renderLibrary();
        const afterNewFile = { rows: libRows() };

        addClip(library.get('c.mp3'));
        state.clips[0].title = 'renamed';
        renderTimeline();
        const afterRename = {
          blocks: count(),
          firstName: document.querySelector('#timeline .tl-name').textContent,
        };
        /* A blend crossing MIN_CROSSFADE adds or removes a marker between the
           blocks, which is a change of structure hiding inside a change of
           number — the one case where dragging a slider does need a rebuild. */
        const markers = () => document.querySelectorAll('#timeline .tl-xf').length;
        state.clips[1].crossfade = 0; renderTimeline();
        const noBlend = markers();
        state.clips[1].crossfade = 2; renderTimeline();
        const blended = markers();
        state.clips[1].crossfade = 0; renderTimeline();
        const backToNone = markers();

        return { before, afterRemove, afterNewFile, afterRename, noBlend, blended, backToNone };
      `);
      eq(result.before.blocks, 2, 'two clips, two blocks: ');
      eq(result.afterRemove.blocks, 1, 'removing a clip must remove its block: ');
      eq(result.afterNewFile.rows, 3, 'a new file must appear in the list: ');
      eq(result.afterRename.blocks, 2);
      eq(result.afterRename.firstName, 'renamed', 'a retitled clip must show its new name: ');
      eq(result.noBlend, 0, 'a hard cut shows no blend marker: ');
      eq(result.blended, 1, 'turning a blend on must add one: ');
      eq(result.backToNone, 0, 'and turning it off again must take it away: ');
    });

    await check('changing the theme repaints rather than trusting the cache', async () => {
      /* The colors are cached and the strip only rebuilds when its contents
         change — neither of which notices a theme change, so it has to be told. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 60)]]);
        refresh();
        const before = css('--wave');
        palette.set('--wave', 'rgb(1, 2, 3)');        // stand in for a theme change
        const stale = css('--wave');
        repaintForTheme();
        return { before, stale, after: css('--wave'), cacheSize: palette.size };
      `);
      ok(result.stale === 'rgb(1, 2, 3)', 'the cache should have been consulted');
      eq(result.after, result.before, 'repainting must go back to the stylesheet: ');
      ok(result.cacheSize > 0, 'and fill the cache again as it draws');
    });

    await check('a program encodes to a real MP3, without freezing the page', async () => {
      /* The whole export path, in a suite that reaches no further than this
         machine: render, encode, and a file whose first bytes are an MPEG frame
         rather than whatever an error produced.

         The freeze is measured, not assumed. A 4 ms ticker cannot fire while
         the thread is busy, so the largest gap between its firings is the
         longest the page went unanswered. The bound is loose enough not to fail
         on a loaded CI machine, and tight enough that an encode running on the
         main thread could not pass it. */
      const out = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20)]]);

        /* Injected on the way past, so a check this early in a cold page can
           arrive before it does. */
        for (let i = 0; i < 100 && !mp3Ready; i++) {
          await new Promise((done) => setTimeout(done, 100));
        }
        if (!mp3Ready) return { encoderArrived: false };

        const rendered = await renderProgram();

        let last = performance.now(), longestFreeze = 0;
        const ticker = setInterval(() => {
          const now = performance.now();
          if (now - last > longestFreeze) longestFreeze = now - last;
          last = now;
        }, 4);
        const progress = [];
        const blob = await encodeMp3(rendered, (p) => progress.push(p));
        clearInterval(ticker);

        const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
        return {
          encoderArrived: true,
          type: blob.type,
          bytes: blob.size,
          seconds: rendered.duration,
          frameSync: head[0] === 0xff && (head[1] & 0xe0) === 0xe0,
          longestFreeze: Math.round(longestFreeze),
          progressCalls: progress.length,
          climbs: progress.every((v, i) => i === 0 || v >= progress[i - 1]),
        };
      `);
      eq(out.encoderArrived, true, 'the vendored encoder never loaded: ');
      eq(out.type, 'audio/mpeg', 'the blob is not labeled as an MP3: ');
      eq(out.frameSync, true, 'the file does not start with an MPEG frame header: ');
      ok(
        out.bytes > 20 * 1024 * out.seconds * 0.9,
        `${out.bytes} bytes is too small for ${out.seconds}s at 320 kbps`,
      );
      ok(out.progressCalls > 1, 'progress was never reported while encoding');
      eq(out.climbs, true, 'progress went backwards: ');
      ok(
        out.longestFreeze < 150,
        `the page froze for ${out.longestFreeze} ms — the encode is on the main thread`,
      );
    });

    await check('export reports finished even when the encoder stops short', async () => {
      /* The last `onProgress(1)` in `encodeMp3` is a promise this app makes
         about its own progress bar, not one it asks every encoder to keep.

         It needs an encoder that stops short to show at all: the one shipped
         here reports a final packet that lands on the end, so the bar reaches
         1 whether or not the app insists. Registering a short-counting one is
         what makes the difference visible — and it exercises the seam in a
         browser besides, which is the whole reason `registerMp3Encoder` is a
         public thing rather than a detail of loading. */
      const out = await run(`
        const real = mp3Encoder;
        const wasReady = mp3Ready;
        try {
          registerMp3Encoder({
            name: 'stops short',
            load: async () => true,
            encode: async (buffer, spec, onProgress) => {
              onProgress(0.25);
              onProgress(0.5);
              return new Blob([new Uint8Array(8)], { type: 'audio/mpeg' });
            },
          });
          mp3Ready = true;
          const seen = [];
          const buf = new OfflineAudioContext(2, 44100, 44100).createBuffer(2, 44100, 44100);
          const blob = await encodeMp3(buf, (p) => seen.push(p));
          return { last: seen[seen.length - 1], calls: seen.length, bytes: blob.size,
                   spec: { ...mp3Spec() } };
        } finally {
          mp3Encoder = real;
          mp3Ready = wasReady;
        }
      `);
      eq(out.last, 1, 'the bar was left wherever the encoder stopped counting: ');
      eq(out.calls, 3, 'the encoder reported twice, so the app should add one: ');
      eq(out.bytes, 8, "the registered encoder's file is not what came back: ");
      eq(
        out.spec,
        { sampleRate: 44100, numberOfChannels: 2, bitrate: 320000 },
        'an encoder is handed the wrong requirement: ',
      );
    });

    /* -------------------------------------------------------------- close */

    /* These four go last on purpose. They share the page with everything above
       and two of them are destructive — forgetting empties the library and the
       program that earlier checks build on, and the format one drives
       mp3Ready by hand. Run from the top they took a different unrelated check
       down on each run. */
    await check('the color choice sticks, and light beats a system set to dark', async () => {
      /* The system is emulated as dark for this one, because that is the only
         arrangement where the interesting half is visible: choosing light has
         to beat a media query that is actively asking for dark. Asserting the
         data-theme attribute proves nothing — JavaScript sets that whatever the
         stylesheet does — so this reads the background the page actually paints.

         Every check shares one page load, so the emulation and the stored mode
         are both handed back afterwards. */
      await session.page.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });
      try {
        const out = await run(`
          localStorage.removeItem('skate.theme');
          applyTheme('auto');
          const read = () => ({
            attr: document.documentElement.getAttribute('data-theme'),
            bg: getComputedStyle(document.body).backgroundColor,
            checked: [...document.querySelectorAll('[data-theme-choice]')]
              .filter(b => b.getAttribute('aria-checked') === 'true')
              .map(b => b.dataset.themeChoice),
            stored: localStorage.getItem('skate.theme'),
          });
          const seen = { auto: read() };
          for (const mode of ['light', 'dark', 'auto']) {
            document.querySelector('[data-theme-choice="' + mode + '"]').click();
            seen[mode === 'auto' ? 'backToAuto' : mode] = read();
          }
          localStorage.removeItem('skate.theme');
          applyTheme('auto');
          return seen;
        `);
        eq(out.auto.checked, ['auto'], 'nothing stored means auto: ');
        eq(out.auto.attr, null, 'auto should set no attribute: ');
        eq(out.light.checked, ['light'], 'exactly one option reads as chosen: ');
        eq(out.dark.stored, 'dark', 'the choice is remembered: ');
        eq(out.backToAuto.attr, null, 'auto again: ');

        // With the system asking for dark, auto and dark agree and light does not.
        eq(out.auto.bg, out.dark.bg, 'auto did not follow the system into dark: ');
        ok(
          out.light.bg !== out.dark.bg,
          `choosing light did not beat a system set to dark: both painted ${out.light.bg}`,
        );
        eq(out.backToAuto.bg, out.dark.bg, 'going back to auto did not follow the system: ');
      } finally {
        await session.page.send('Emulation.setEmulatedMedia', { features: [] });
      }
    });

    await check('the logo actually loads, rather than only being referenced', async () => {
      /* A unit check already asserts index.html points at the logo. Pointing at
         it is not the same as it arriving: the test server served .svg as
         octet-stream for months, so every check here ran against a broken-image
         box and none of them minded. naturalWidth is the difference between a
         reference and a picture. */
      const out = await run(`
        const img = document.querySelector('.topbar .logo');
        if (!img) return { found: false };
        if (!img.complete) await new Promise(r => { img.onload = r; img.onerror = r; });
        return { found: true, src: img.getAttribute('src'),
                 width: img.naturalWidth, height: img.naturalHeight };
      `);
      eq(out.found, true, 'no logo in the topbar: ');
      ok(
        out.width > 0 && out.height > 0,
        `the logo at ${out.src} did not decode: ${out.width}x${out.height}`,
      );
    });

    await check('the settings menu opens, closes, and says what is stored', async () => {
      const out = await run(`
        /* Shared page: start shut whatever anything above left behind. */
        setSettingsOpen(false);
        const button = document.getElementById('btnSettings');
        const menu = document.getElementById('settingsMenu');
        const shut = () => menu.classList.contains('hidden');
        const start = shut();
        button.click();
        const opened = { shut: shut(), expanded: button.getAttribute('aria-expanded'),
                         note: document.getElementById('forgetNote').textContent };
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const afterOutside = shut();
        button.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const afterEscape = shut();
        setSettingsOpen(false);
        return { start, opened, afterOutside, afterEscape };
      `);
      eq(out.start, true, 'the menu should begin shut: ');
      eq(out.opened.shut, false, 'clicking the gear did not open it: ');
      eq(out.opened.expanded, 'true', 'aria-expanded: ');
      ok(out.opened.note.length > 0, 'the menu says nothing about what is stored');
      eq(out.afterOutside, true, 'a click outside did not shut it: ');
      eq(out.afterEscape, true, 'Escape did not shut it: ');
    });

    await check('the export format defaults to MP3 and remembers only a real choice', async () => {
      /* MP3 is what competitions ask for, so it stays the default: nothing
         stored, a stale value, or anything unrecognized all land on MP3, and
         only a deliberate WAV comes back as WAV. When the encoder could not be
         reached there is no choice to make. */
      const out = await run(`
        const before = localStorage.getItem('skate.exportFormat');
        const ready = mp3Ready;
        const pick = (stored, encoder) => {
          if (stored === null) localStorage.removeItem('skate.exportFormat');
          else localStorage.setItem('skate.exportFormat', stored);
          mp3Ready = encoder;
          updateExportOptions();
          return document.getElementById('exportFormat').value;
        };
        const out = {
          nothingStored: pick(null, true),
          storedMp3: pick('mp3', true),
          storedWav: pick('wav', true),
          storedRubbish: pick('flac', true),
          noEncoder: pick('mp3', false),
          noEncoderAfterWav: pick('wav', false),
        };
        if (before === null) localStorage.removeItem('skate.exportFormat');
        else localStorage.setItem('skate.exportFormat', before);
        mp3Ready = ready;
        updateExportOptions();
        return out;
      `);
      eq(out.nothingStored, 'mp3', 'a first export should offer MP3: ');
      eq(out.storedMp3, 'mp3', 'MP3 was chosen last time: ');
      eq(out.storedWav, 'wav', 'WAV was chosen last time: ');
      eq(out.storedRubbish, 'mp3', 'an unrecognized stored value should fall back to MP3: ');
      eq(out.noEncoder, 'wav', 'without the encoder only WAV is possible: ');
      eq(out.noEncoderAfterWav, 'wav', 'without the encoder only WAV is possible: ');
    });

    await check('forgetting leaves nothing behind, and says so afterwards', async () => {
      /* refresh() calls save(), so clearing storage before it runs puts an empty
         program straight back — the first version did exactly that and the
         menu went on claiming there was something stored. */
      const out = await run(`
        state.clips = [{ id: 'x', title: 'a song', file: 'a song.mp3',
          srcStart: 0, srcEnd: 10, fadeIn: 0, fadeOut: 0, crossfade: 0, gain: 1 }];
        save();
        describeStored();
        const before = { stored: !!localStorage.getItem('skate.program.v1'),
                         note: document.getElementById('forgetNote').textContent,
                         disabled: document.getElementById('btnForget').disabled };
        await forgetEverything();
        const after = { stored: !!localStorage.getItem('skate.program.v1'),
                        clips: state.clips.length,
                        note: document.getElementById('forgetNote').textContent,
                        disabled: document.getElementById('btnForget').disabled };
        return { before, after };
      `);
      eq(out.before.stored, true, 'nothing was stored to begin with: ');
      eq(out.before.disabled, false, 'the button was dead while there was work to forget: ');
      eq(out.after.stored, false, 'the program was written back after being cleared: ');
      eq(out.after.clips, 0, 'the program is still on screen: ');
      eq(out.after.disabled, true, 'the button is still live with nothing left to forget: ');
      ok(out.after.note !== out.before.note, 'the menu still claims the same thing is stored');
    });

    await check('nothing logged an error along the way', async () => {
      const errors = session.page.consoleErrors();
      eq(errors, [], 'the page logged errors: ');
    });
  } finally {
    // Shutting the browser down must never decide whether the run passed, and
    // must never swallow the report — a cleanup failure once hid fifteen
    // results and reported only itself.
    try {
      await session.close();
    } catch (err) {
      console.error(`  (the browser did not shut down cleanly: ${err.message})`);
    }
  }

  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  console.log(`\n${passed} passed, ${failures.length} failed`);

  const at = process.argv.indexOf('--report');
  if (at >= 0 && process.argv[at + 1]) {
    const file = process.argv[at + 1];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          suite: 'browser',
          passed,
          failed: failures.length,
          failures: failures.map((f) => f.split('\n')[0]),
          metrics,
        },
        null,
        2,
      )}\n`,
    );
  }

  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  the browser checks could not run: ${err.message}\n`);
  process.exit(1);
});
