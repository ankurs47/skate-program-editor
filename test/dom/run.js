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
const { SHOT, stage, readStamp } = require('../../tools/screenshot.js');
const { fakeHost } = require('../fake-host.js');
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
    // The one fake shell, the same function the unit tests use, as source.
    await run(`
      window.__fakeHost = (options = {}) =>
        (${fakeHost.toString()})({ version: HOST_VERSION, ...options });
      return true;
    `);

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

    await check('New empties the song list unless asked to keep it', async () => {
      const out = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)], ['b.mp3', window.__tone(330, 30)]]);
        const listed = () => document.querySelectorAll('#libraryList li').length;
        const before = listed();

        document.getElementById('btnNew').click();
        const offered = !document.getElementById('startKeepWrap').classList.contains('hidden');
        const ticked = document.getElementById('startKeepSongs').checked;
        document.getElementById('startKeepSongs').checked = true;
        document.getElementById('btnStartNew').click();
        const kept = { songs: library.size, listed: listed(), clips: state.clips.length };

        document.getElementById('btnNew').click();
        document.getElementById('btnStartNew').click();
        const cleared = { songs: library.size, listed: listed(), clips: state.clips.length };

        document.getElementById('btnNew').click();
        const offeredEmpty = !document.getElementById('startKeepWrap').classList.contains('hidden');
        document.getElementById('startDialog').classList.add('hidden');

        return { before, offered, ticked, kept, cleared, offeredEmpty };
      `);
      eq(out.before, 2, 'the fixture songs did not reach the list: ');
      ok(out.offered, 'New with songs loaded did not offer to keep them');
      ok(!out.ticked, 'keeping the songs should be off by default');
      eq(out.kept, { songs: 2, listed: 2, clips: 0 }, 'ticking Keep did not keep the songs: ');
      eq(out.cleared, { songs: 0, listed: 0, clips: 0 }, 'New did not empty the song list: ');
      ok(!out.offeredEmpty, 'with no songs there is nothing to offer to keep');
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
        const fake = window.__fakeHost({
          project: {
            format: FORMAT, version: FORMAT_VERSION, name: 'from a folder',
            event: { level: 'usfs-juv', targetSeconds: 150, toleranceSeconds: 10 },
            songs: [{ name: 'opening.wav', title: 'Adagio in G minor' }],
            clips: [{ id: 'a', song: 'opening.wav', start: 0, end: 3 }],
          },
          media: { 'opening.wav': bytes },
        });
        const written = () => fake.calls.filter(([method]) => method === 'write').map(([, doc]) => doc);
        window.skateHost = fake.host;

        /* Bringing music in is the shell's own affair, done in its own
           interface. What the page still needs is to be told the folder
           changed — see the arrival below. */
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
        const beforeWait = { writes: written().length, local: localStorage.getItem('skate.program.v1') };
        await new Promise((done) => setTimeout(done, 600));
        const afterWait = { writes: written().length, name: written().length ? written()[0].name : null,
                            local: localStorage.getItem('skate.program.v1') };

        /* And the arrival itself, followed through: the shell says a song
           landed, and the page reads the folder again rather than trusting the
           account of it. bindHostAdded is the join between those two, and
           without exercising it a version that quietly returns before
           subscribing passes every other check. */
        const heard = fake.listening() > 0;
        await fake.arrive({
          name: 'arrived.m4a',
          title: 'Bolero',
          source: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=x' },
        });
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

    await check(
      'a shell about to close gets every edit written, and hears if one was not',
      async () => {
        /* A shell asks for a flush before it lets a project window go, through
         what connect handed it (docs/host.md). An edit waiting out the save
         delay exists nowhere but in memory, so this is the one moment work can
         be lost — and saved: false is the one answer worth interrupting a
         close for. */
        const out = await run(`
        window.__reset([]);
        const fake = window.__fakeHost({ project: { name: 'before', clips: [] } });
        window.skateHost = fake.host;
        hostConnect(hostEditor());
        await openHostProject();

        pushUndo();
        state.name = 'edited just now';
        save();
        const pending = fake.calls.filter(([m]) => m === 'write').length;
        const flushed = await fake.editor().flush();
        const kept = {
          pending,
          flushed,
          written: fake.folder.project && fake.folder.project.name,
          history: !!fake.folder.history && fake.folder.history.current === undoSnapshot(),
        };

        /* A folder that refuses the write. */
        const refusing = window.__fakeHost({
          project: { name: 'before', clips: [] },
          with: { write: async () => { throw new Error('the disk is full'); } },
        });
        window.skateHost = refusing.host;
        state.name = 'never reaches the folder';
        save();
        const refused = await flushHostSave();

        /* And then takes one. Each write is the whole program, so the folder
           is up to date again — once, a single refusal was reported for the
           rest of the session (#130). Both routes a write takes are asked. */
        const recovered = {};
        let disk = window.__fakeHost({ project: { name: 'before', clips: [] } });
        window.skateHost = disk.host;
        state.name = 'reaches it on the close';
        save();
        recovered.byFlush = await flushHostSave();

        window.skateHost = refusing.host;
        save();
        await flushHostSave();
        disk = window.__fakeHost({ project: { name: 'before', clips: [] } });
        window.skateHost = disk.host;
        state.name = 'reaches it on its own';
        save();
        await new Promise((done) => setTimeout(done, 600));
        recovered.written = disk.folder.project && disk.folder.project.name;
        recovered.byDelay = await flushHostSave();

        delete window.skateHost;
        const noShell = await flushHostSave();
        return { kept, refused, recovered, noShell };
      `);

        eq(
          out.kept.pending,
          0,
          'the edit was written before the save delay, so this proves nothing: ',
        );
        eq(out.kept.flushed, { saved: true, hosted: true }, 'a flush with a waiting edit: ');
        eq(out.kept.written, 'edited just now', 'the waiting edit never reached the folder: ');
        ok(out.kept.history, 'the undo history waiting to be written was dropped on close');
        eq(out.refused, { saved: false, hosted: true }, 'a refused write was reported as saved: ');
        eq(out.recovered.byFlush, { saved: true, hosted: true }, 'a write on close that landed: ');
        eq(out.recovered.written, 'reaches it on its own', 'the delayed write never landed: ');
        eq(out.recovered.byDelay, { saved: true, hosted: true }, 'a delayed write that landed: ');
        eq(out.noShell, { saved: true, hosted: false }, 'with no shell: ');
      },
    );

    await check("a shell runs the page's commands and hears every change", async () => {
      /* What a native menu is built from (docs/host.md, Commands and State).
         Every command is the click of a real control, so the assertions are
         on what the page then shows — not on a command having been called. */
      const out = await run(`
        window.__reset([['a.mp3', window.__tune(1)], ['b.mp3', window.__tune(2)]]);
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoAvailability();
        state.selected = state.clips[0].id;
        refresh();
        const fake = window.__fakeHost();
        window.skateHost = fake.host;
        hostConnect(hostEditor());
        const editor = fake.editor();
        const find = (s, id) => s.commands.find((c) => c.id === id);
        const settle = () => new Promise((done) => setTimeout(done, 30));
        const refusal = (id) => editor.run(id).then(() => null, (why) => why);

        const first = editor.state();
        const heard = [];
        const stop = editor.onState((s) => heard.push(s));

        const ids = first.commands.map((c) => c.id);
        const start = {
          hasProgram: first.hasProgram,
          undo: find(first, 'program.undo'),
          previous: find(first, 'clip.previous').enabled,
          next: find(first, 'clip.next').enabled,
          play: find(first, 'playback.toggle').label,
          music: find(first, 'view.music').label,
          unknown: await refusal('no.such.thing'),
          refused: await refusal('program.undo'),
        };

        // A real edit, then the menu's Undo puts it back.
        const fadeBefore = state.clips[0].fadeIn;
        pushUndo();
        state.clips[0].fadeIn = fadeBefore + 1.5;
        refresh();
        await settle();
        const undoAfterEdit = find(editor.state(), 'program.undo').enabled;
        await editor.run('program.undo');
        const undone = state.clips[0].fadeIn === fadeBefore;

        await editor.run('clip.next');
        const selectedNext = state.selected === state.clips[1].id;
        await editor.run('clip.previous');
        const selectedBack = state.selected === state.clips[0].id;

        // The label follows the control: the shell is told, and shows it.
        await editor.run('view.music');
        await settle();
        const musicHidden = find(heard.at(-1), 'view.music').label;
        await editor.run('view.music');

        const was = document.querySelector('[data-theme-choice][aria-checked="true"]').dataset.themeChoice;
        await editor.run('colors.dark');
        await settle();
        const dark = find(heard.at(-1), 'colors.dark').checked;
        const light = find(heard.at(-1), 'colors.light').checked;
        chooseTheme(was);

        // A dialog owns the page: every command reads disabled and is refused.
        await editor.run('help.basics');
        await settle();
        const whileOpen = {
          help: !document.getElementById('helpModal').classList.contains('hidden'),
          anyEnabled: heard.at(-1).commands.some((c) => c.enabled),
          refused: await refusal('program.evenOut'),
        };
        closeTopDialog();

        // An export in progress, as the dialog shows it.
        document.getElementById('exportProgress').classList.remove('hidden');
        document.getElementById('exportBar').style.width = '40%';
        const exporting = editor.state().exporting;
        document.getElementById('exportProgress').classList.add('hidden');
        document.getElementById('exportBar').style.width = '0';

        await settle();
        const before = heard.length;
        stop();
        await editor.run('view.music');
        await settle();
        await editor.run('view.music');
        await settle();
        const afterStop = heard.length - before;

        delete window.skateHost;
        return { ids, start, undoAfterEdit, undone, selectedNext, selectedBack, musicHidden,
                 dark, light, whileOpen, exporting, afterStop };
      `);

      // Song commands exist only for one song, and reach a shell with it instead.
      const expected = await run(
        "return HOST_COMMANDS.filter((c) => c.target !== 'song').map((c) => c.id);",
      );
      eq(out.ids, expected, 'the state lists the commands, in order: ');
      ok(out.start.hasProgram, 'a program with two songs reads as empty');
      eq(out.start.undo.label, 'Undo', 'the label is not the button wording: ');
      eq(out.start.undo.keys, 'Mod+Z');
      eq(out.start.undo.enabled, false, 'Undo with nothing to undo: ');
      eq(out.start.previous, false, 'Previous song on the first song: ');
      eq(out.start.next, true, 'Next song on the first of two: ');
      eq(out.start.play, 'Play');
      eq(out.start.music, 'Hide the music list');
      eq(out.start.unknown && out.start.unknown.code, 'not-found', 'an unknown command: ');
      eq(out.start.refused && out.start.refused.code, 'refused', 'a disabled command ran: ');
      ok(out.undoAfterEdit, 'Undo stayed disabled after an edit');
      ok(out.undone, 'the menu Undo did not undo');
      ok(out.selectedNext && out.selectedBack, 'Next and Previous song did not move the selection');
      eq(out.musicHidden, 'Show the music list', 'the shell was not told the label changed: ');
      ok(out.dark && !out.light, 'the shell was not told the colors changed');
      ok(out.whileOpen.help, 'the help command opened nothing');
      eq(out.whileOpen.anyEnabled, false, 'commands read enabled behind an open dialog: ');
      eq(out.whileOpen.refused && out.whileOpen.refused.code, 'refused', 'ran behind a dialog: ');
      eq(out.exporting, { progress: 0.4 }, 'an export in progress: ');
      eq(out.afterStop, 0, 'a listener kept hearing after it stopped: ');
    });

    await check(
      'a shell is told when the program is on screen, not when the music is',
      async () => {
        /* A shell shows its window on this (docs/host.md). Too early and an
         empty editor fills in on screen; held until every song has decoded and
         a window waits seconds for nothing anyone needs yet. */
        const out = await run(`
        window.__reset([]);
        const bytes = await window.encodeWav(window.__tone(220, 2)).arrayBuffer();
        const program = {
          format: FORMAT, version: FORMAT_VERSION, name: 'from a folder',
          songs: [{ name: 'a.wav' }],
          clips: [{ id: 'a', song: 'a.wav', start: 0, end: 1.5 }],
        };
        const fake = window.__fakeHost({ project: program, media: { 'a.wav': bytes } });
        window.skateHost = fake.host;
        await openHostProject();
        const order = fake.calls.map(([method]) => method);
        const ready = fake.calls.filter(([method]) => method === 'ready');

        // A folder that cannot be read still gets its window shown.
        const broken = window.__fakeHost({
          with: { read: async () => { throw new Error('not a program'); } },
        });
        window.skateHost = broken.host;
        await openHostProject();
        const readyAnyway = broken.calls.filter(([method]) => method === 'ready').length;

        // And a shell that does not ask is not told.
        window.skateHost = window.__fakeHost({ omit: ['ready'] }).host;
        let threw = null;
        try { await openHostProject(); } catch (e) { threw = String(e); }

        delete window.skateHost;
        window.__reset([]);
        return { order, times: ready.length, shown: ready.length ? ready[0][1] : null,
                 readyAnyway, threw };
      `);
        eq(out.times, 1, 'times the shell was told: ');
        eq(out.shown, { clipsShown: 1 }, 'the program was not on screen when the shell was told: ');
        ok(
          out.order.indexOf('ready') < out.order.indexOf('open'),
          `the shell was kept waiting for the music: ${out.order.join(', ')}`,
        );
        eq(out.readyAnyway, 1, 'a folder that could not be read never said it was ready: ');
        eq(out.threw, null, 'a shell without ready broke opening: ');
      },
    );

    await check('inside a shell the guide opens beside the program, not in its place', async () => {
      /* A link that navigated the page would replace the program, with no way
         back but a link that reloads it (docs/host.md, openGuide). A listener
         on the window hears the click after the page has, records whether the
         page stopped it — and then stops it regardless, so a failure here
         cannot take the rest of the checks away with the page. */
      const out = await run(`
        let prevented = null;
        const guard = (e) => {
          if (e.target instanceof Element && e.target.closest('a[href^="docs/help.html"]')) {
            prevented = e.defaultPrevented;
            e.preventDefault();
          }
        };
        window.addEventListener('click', guard);
        const link = document.querySelector('a[href="docs/help.html"]');
        try {
          const fake = window.__fakeHost();
          window.skateHost = fake.host;
          link.click();
          const hosted = { prevented, asked: fake.calls.filter(([m]) => m === 'openGuide') };

          // A section named after the #, as an in-app link to one would.
          const deep = document.createElement('a');
          deep.href = 'docs/help.html#saving';
          deep.textContent = 'how saving works';
          document.body.appendChild(deep);
          deep.click();
          deep.remove();
          const section = fake.calls.filter(([m]) => m === 'openGuide').at(-1);

          // Through the command a shell's Help menu runs.
          hostConnect(hostEditor());
          await fake.editor().run('help.guide');
          const byCommand = fake.calls.filter(([m]) => m === 'openGuide').length;

          // With no shell, a link is a link.
          delete window.skateHost;
          prevented = null;
          link.click();
          return { hosted, section, byCommand, plain: prevented };
        } finally {
          delete window.skateHost;
          window.removeEventListener('click', guard);
        }
      `);
      eq(out.hosted.prevented, true, 'the link navigated the page inside a shell: ');
      eq(out.hosted.asked, [['openGuide', null]], 'the shell was not asked to show the guide: ');
      eq(out.section, ['openGuide', 'saving'], 'the section after # was lost: ');
      eq(out.byCommand, 3, 'the help.guide command did not reach the shell: ');
      eq(out.plain, false, 'with no shell the guide link stopped being a link: ');
    });

    await check(
      'a finished music file is handed to the shell, and downloads if it is not kept',
      async () => {
        /* docs/host.md, writeExport. The bytes handed over are the file — a WAV
         that says RIFF — not a promise of one, and a shell that cannot keep it
         costs nobody the file: it downloads as it always did. */
        const out = await run(`
        window.__reset([['a.mp3', window.__tone(220, 2, 0.3)]]);
        const realDownload = window.download;
        const downloaded = [];
        window.download = (blob, name) => downloaded.push(name);
        const make = async () => {
          __id('btnExport').click();
          __id('exportFormat').value = 'wav';
          await doExport();
          __id('exportDialog').classList.add('hidden');
        };
        try {
          const fake = window.__fakeHost();
          window.skateHost = fake.host;
          await make();
          const [[name, kept]] = [...fake.folder.exports];
          const head = new TextDecoder().decode(new Uint8Array(kept.bytes).slice(0, 4));
          const handed = { name, head, details: kept.details, downloaded: downloaded.length,
                           said: __id('toast').textContent };

          const refusing = window.__fakeHost({
            with: { writeExport: async () => { throw new Error('the disk is full'); } },
          });
          window.skateHost = refusing.host;
          await make();
          const fellBack = downloaded.length;
          return { handed, fellBack };
        } finally {
          delete window.skateHost;
          window.download = realDownload;
        }
      `);
        ok(/\.wav$/.test(out.handed.name), `kept under the wrong name: ${out.handed.name}`);
        eq(out.handed.head, 'RIFF', 'what the shell was handed is not a WAV file: ');
        eq(out.handed.details.format, 'wav');
        near(out.handed.details.seconds, 2, 0.05, 'the length handed over: ');
        eq(out.handed.details.targetSeconds, 150, 'the target handed over: ');
        eq(out.handed.downloaded, 0, 'the file also downloaded, so it exists twice: ');
        ok(out.handed.said.includes(out.handed.name), 'the page did not say what it was kept as');
        eq(out.fellBack, 1, 'a shell that could not keep the file lost it: ');
      },
    );

    await check("a shell with its own menu takes the header's copies of it away", async () => {
      /* docs/host.md, capabilities. The help topics, Settings, the guide and
         GitHub are all in a shell's menu, so the header does not offer them a
         second time — and what is hidden still runs, through the menu. */
      const out = await run(`
        const shown = () => MENU_COVERED.map(
          (s) => !document.querySelector(s).classList.contains('hidden'));
        const before = shown();

        const fake = window.__fakeHost({ capabilities: ['menu', 'something-later'] });
        window.skateHost = fake.host;
        hideMenuCovered();
        const withMenu = shown();
        hostConnect(hostEditor());
        await fake.editor().run('help.keys');
        const helpOpened = !document.getElementById('helpModal').classList.contains('hidden');
        closeTopDialog();

        // A shell with no menu leaves the header alone.
        window.skateHost = window.__fakeHost().host;
        hideMenuCovered();
        const noMenu = shown();

        // And the shell going away puts everything back.
        window.skateHost = fake.host;
        hideMenuCovered();
        delete window.skateHost;
        hideMenuCovered();
        const after = shown();
        return { before, withMenu, helpOpened, noMenu, after };
      `);
      eq(out.before, [true], 'hidden in a plain browser, so hiding proves nothing: ');
      eq(out.withMenu, [false], "the header kept the menu's copies: ");
      ok(out.helpOpened, 'a hidden help topic could not be reached from the menu');
      eq(out.noMenu, [true], 'a shell without a menu lost its header: ');
      eq(out.after, [true], 'the shell went and the header stayed hidden: ');
    });

    await check(
      'a right-click on a clip or a song is a menu of its own, run on that one',
      async () => {
        /* docs/host.md, contextMenu and run(id, target). Asserted on what the
         page then shows — the order, the list — not on a command being sent. */
        const out = await run(`
        window.__reset([['a.mp3', window.__tune(1)], ['b.mp3', window.__tune(2)]]);
        window.__addToLibrary('spare.mp3', window.__tune(3));
        state.selected = state.clips[0].id;
        refresh();
        const fake = window.__fakeHost();
        window.skateHost = fake.host;
        hostConnect(hostEditor());
        const editor = fake.editor();
        const order = () => state.clips.map((c) => c.file);
        const refusal = (id, target) => editor.run(id, target).then(() => null, (why) => why.code);
        const menus = () => fake.calls.filter(([m]) => m === 'contextMenu');

        // A right-click on the second block: that clip, selected, and its commands.
        const second = state.clips[1].id;
        const block = document.querySelector('.tl-clip[data-clip="' + second + '"]');
        const click = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        block.dispatchEvent(click);
        const [, clipTarget, clipItems] = menus().at(-1);
        const onClip = {
          stopped: click.defaultPrevented,
          target: clipTarget,
          selected: state.selected === second,
          ids: clipItems.map((c) => c.id),
          earlier: clipItems.find((c) => c.id === 'clip.moveEarlier').enabled,
          later: clipItems.find((c) => c.id === 'clip.moveLater').enabled,
        };

        // Run on a clip that is not the selected one: it is moved, not the other.
        state.selected = state.clips[0].id;
        refresh();
        await editor.run('clip.moveEarlier', { clip: second });
        const moved = order();

        // A song: its own menu, and Add to program runs on that song.
        const row = document.querySelector('#libraryList li[data-song="spare.mp3"]');
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const [, songTarget, songItems] = menus().at(-1);
        await editor.run('song.add', { song: 'spare.mp3' });
        const added = order();

        const refused = {
          noClip: await refusal('clip.moveLater', { clip: 'nonesuch' }),
          wrongKind: await refusal('program.undo', { clip: second }),
          songWithoutSong: await refusal('song.add'),
          inState: hostState().commands.some((c) => c.id.startsWith('song.')),
        };

        // With no shell offering a menu, a right-click is the browser's own.
        delete window.skateHost;
        const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        block.isConnected && block.dispatchEvent(plain);
        window.__reset([]);
        return { onClip, moved, songTarget, songIds: songItems.map((c) => c.id), added,
                 refused, plain: plain.defaultPrevented };
      `);
        ok(out.onClip.stopped, "the browser's own menu opened over the shell's");
        eq(out.onClip.target.clip !== undefined, true, 'the clip was not named: ');
        ok(out.onClip.selected, 'the right-clicked clip was not selected');
        eq(out.onClip.ids, [
          'clip.play',
          'join.play',
          'clip.moveEarlier',
          'clip.moveLater',
          'clip.remove',
        ]);
        eq([out.onClip.earlier, out.onClip.later], [true, false], 'the last of two moves later: ');
        eq(out.moved, ['b.mp3', 'a.mp3'], 'the clip pointed at did not move: ');
        eq(out.songTarget, { song: 'spare.mp3' });
        eq(out.songIds, ['song.add', 'song.replace', 'song.info', 'song.remove']);
        eq(out.added, ['b.mp3', 'a.mp3', 'spare.mp3'], 'Add to program did not add that song: ');
        eq(out.refused, {
          noClip: 'not-found',
          wrongKind: 'refused',
          songWithoutSong: 'refused',
          inState: false,
        });
        eq(out.plain, false, "with no shell, a right-click stopped being the browser's: ");
      },
    );

    await check(
      'inside a shell the page behaves like an app, and in a browser like a page',
      async () => {
        /* Asserted on the computed style, which is what anybody sees, rather
         than on the attribute — a rule that stopped matching would leave the
         attribute set and the page unchanged. */
        const out = await run(`
        const look = () => ({
          marked: document.documentElement.hasAttribute('data-shell'),
          // A button that is never disabled, which shows the arrow anyway.
          button: getComputedStyle(document.getElementById('btnAddFiles')).cursor,
          page: getComputedStyle(document.body).userSelect,
          field: getComputedStyle(document.getElementById('programName')).userSelect,
        });
        const browser = look();
        window.skateHost = window.__fakeHost().host;
        markShell();
        const shell = look();
        delete window.skateHost;
        markShell();
        return { browser, shell, after: look() };
      `);
        eq(out.browser, { marked: false, button: 'pointer', page: 'auto', field: 'auto' });
        eq(out.shell.marked, true, 'the page was not marked as inside a shell: ');
        eq(out.shell.button, 'default', 'a button still shows the pointing hand: ');
        eq(out.shell.page, 'none', 'the interface can still be selected like a document: ');
        ok(out.shell.field !== 'none', 'a text field could not be selected inside a shell');
        eq(out.after, out.browser, 'the shell went and the page stayed an app: ');
      },
    );

    await check("the keyboard's media keys and the system's controls run the program", async () => {
      /* The handlers are captured as they are handed over, then pressed, and
         judged by what the page then does — playing, stopped, which song is
         selected — and by what the system is told is playing. */
      const out = await run(`
        window.__reset([['a.mp3', window.__tune(1)], ['b.mp3', window.__tune(2)]]);
        state.name = 'my 2026 junior long program';
        state.selected = state.clips[0].id;
        refresh();
        const got = {};
        bindMediaSession({ setActionHandler: (action, handler) => { got[action] = handler; } });
        const session = navigator.mediaSession;

        got.play();
        const played = { playing: Boolean(playing), told: session.playbackState };
        got.pause();
        const paused = { playing: Boolean(playing), told: session.playbackState };
        got.nexttrack();
        const next = state.selected === state.clips[1].id;
        got.previoustrack();
        const previous = state.selected === state.clips[0].id;
        state.playPosition = 30;
        got.stop();
        const stopped = state.playPosition;
        return { actions: Object.keys(got).sort(), played, paused, next, previous, stopped,
                 title: session.metadata && session.metadata.title };
      `);
      eq(out.actions, ['nexttrack', 'pause', 'play', 'previoustrack', 'stop']);
      eq(out.played, { playing: true, told: 'playing' }, 'play: ');
      eq(out.paused, { playing: false, told: 'paused' }, 'pause: ');
      ok(out.next && out.previous, 'next and previous did not move the selection');
      eq(out.stopped, 0, 'stop did not go back to the start, as the Stop button does: ');
      eq(out.title, 'my 2026 junior long program', 'the system is not told what is playing: ');
    });

    await check('the page is named for the program in it', async () => {
      /* A tab among several, or a desktop shell's window, then says which
         program is open — and a shell's title bar follows it (docs/host.md).
         An empty program in a browser is the site, and keeps its own title. */
      const out = await run(`
        const site = 'Skate Program Editor — cut figure skating music online';
        window.__reset([]);
        const empty = document.title;

        window.__reset([['a.mp3', window.__tune(1)]]);
        state.name = 'my 2026 junior long program';
        refresh();
        const named = document.title;

        // Typed, letter by letter, as the field reports it.
        const field = document.getElementById('programName');
        field.value = 'short program';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const typed = document.title;

        state.name = '   ';
        refresh();
        const blank = document.title;

        // In a shell the folder is the program, even before it has music.
        window.__reset([]);
        window.skateHost = window.__fakeHost().host;
        state.name = 'my 2026 junior long program';
        refresh();
        const hosted = document.title;
        delete window.skateHost;
        window.__reset([]);

        return { site, empty, named, typed, blank, hosted };
      `);
      eq(out.empty, out.site, 'an empty program in a browser renamed the site: ');
      eq(out.named, 'my 2026 junior long program — Skate Program Editor');
      eq(out.typed, 'short program — Skate Program Editor', 'typing the name left the title: ');
      eq(out.blank, out.site, 'a blank name left a dash with nothing before it: ');
      eq(out.hosted, 'my 2026 junior long program — Skate Program Editor', 'in a shell: ');
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

        window.skateHost = window.__fakeHost().host;
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
        const other = await window.encodeWav(window.__tone(330, 1)).arrayBuffer();

        /* A shell that takes files, already holding one by that name: it is
           asked, numbers the new one, and its answer is what the library ends
           up keyed by. */
        const fake = window.__fakeHost({ media: { 'opening.wav': other } });
        window.skateHost = fake.host;
        const added = await addFiles([new File([bytes], 'opening.wav', { type: 'audio/wav' })]);
        const asked = fake.calls
          .filter(([method]) => method === 'importFile')
          .map(([, name, data]) => ({ name, bytes: data.byteLength }));
        const throughShell = {
          asked: asked.length,
          sentName: asked.length ? asked[0].name : null,
          sentBytes: asked.length ? asked[0].bytes > 0 : false,
          keyedAs: added.length ? added[0].name : null,
        };

        /* A shell with no way to take one: the old path, unchanged. */
        window.__reset([]);
        window.skateHost = window.__fakeHost({ omit: ['importFile'] }).host;
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
      eq(result.before.target, 150, 'Juvenile is 2:30: ');
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

    await check('an exported MP3 decodes to the program that went in', async () => {
      /* The checks around this one prove a file came out and never look inside
         it, and a well-formed MP3 of silence would pass all of them. Rebuilding
         the vendored encoder is exactly the change that could produce one, so
         the file is decoded and measured: a 20s 0.3-amplitude sine at 220 Hz
         has to come back as 20s of stereo with that tone in it and nothing
         else. MP3 pads the start and end, hence a duration tolerance. */
      const out = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20, 0.3)]]);
        const realDownload = window.download;
        const saved = [];
        window.download = (blob, name) => saved.push({ blob, name });
        let bytes;
        try {
          __id('btnExport').click();
          __id('exportFormat').value = 'mp3';
          await doExport();
          bytes = await saved[0].blob.arrayBuffer();
        } finally {
          window.download = realDownload;
          __id('exportDialog').classList.add('hidden');
        }

        const decoded = await new OfflineAudioContext(2, 44100, 44100).decodeAudioData(bytes);

        /* Amplitude of one frequency, over the middle half so the padding at
           either end does not count. */
        const amplitudeAt = (x, hz) => {
          const w = 2 * Math.PI * hz / decoded.sampleRate;
          const a = Math.floor(x.length / 4), b = Math.floor(x.length * 3 / 4);
          let re = 0, im = 0;
          for (let i = a; i < b; i++) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
          return 2 * Math.hypot(re, im) / (b - a);
        };
        const channels = [];
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          const x = decoded.getChannelData(c);
          let sum = 0;
          for (const v of x) sum += v * v;
          channels.push({
            rms: Math.sqrt(sum / x.length),
            at220: amplitudeAt(x, 220),
            at440: amplitudeAt(x, 440),
            at1000: amplitudeAt(x, 1000),
          });
        }
        return {
          count: saved.length,
          type: saved[0].blob.type,
          seconds: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels,
        };
      `);
      eq(out.count, 1, 'one file should have been saved: ');
      eq(out.type, 'audio/mpeg', 'the export was not an MP3: ');
      near(out.seconds, 20, 0.1, 'the decoded file is the wrong length: ');
      eq(out.sampleRate, 44100, 'the sample rate changed: ');
      eq(out.channels.length, 2, 'the export is not stereo: ');
      out.channels.forEach((ch, c) => {
        // 0.3 / √2 ≈ 0.212 for a sine; the encoder shaves a little off.
        near(ch.rms, 0.21, 0.01, `channel ${c} is not as loud as what went in: `);
        near(ch.at220, 0.3, 0.01, `channel ${c} lost its 220 Hz tone: `);
        ok(ch.at440 < 0.005, `channel ${c} has energy at 440 Hz: ${ch.at440}`);
        ok(ch.at1000 < 0.005, `channel ${c} has energy at 1000 Hz: ${ch.at1000}`);
      });
    });

    await check('the encoder makes the same file it made when it was last read', async () => {
      /* The check above is deliberately loose — a tolerance of 0.01 — so a
         rebuilt encoder that changes what export produces passes it. 1.58.1
         did exactly that: it moved every sample by up to one count in 32767,
         and the only way anyone knew was by measuring by hand. This pins the
         bytes, so a rebuild that changes them says so and one that does not
         needs no reading at all.

         The encoder is handed a buffer built here rather than a rendered
         program, so the hash covers the encoder and nothing in front of it:
         Chrome's own rendering may change between versions, and that is not
         what this is about. No tags either, which would carry the app's
         version. The signal is two tones, a sweep and a near-full-scale burst,
         different on each side, so scaling, stereo and the loud end all show.

         When this fails after a rebuild, the output really did change. Read the
         release notes for why, compare the check above by hand against the
         old bundle, and only then write the new hash here. */
      const out = await run(`
        if (!mp3Ready) return { ready: false };
        const sr = 44100, n = 3 * sr;
        const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < n; i++) {
            const t = i / sr;
            const tones = 0.2 * Math.sin(2 * Math.PI * (c ? 330 : 220) * t)
              + 0.1 * Math.sin(2 * Math.PI * 2500 * t);
            const sweep = 0.15 * Math.sin(2 * Math.PI * (100 * t + 1500 * t * t));
            d[i] = t > 2 && t < 2.5 ? 0.98 * Math.sin(2 * Math.PI * 440 * t) : tones + sweep;
          }
        }
        const blob = await mp3Encoder.encode(buf, mp3Spec(), () => {});
        const bytes = await blob.arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          ready: true,
          size: bytes.byteLength,
          sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
        };
      `);
      ok(out.ready, 'no MP3 encoder loaded, so there is nothing to compare');
      eq(
        out,
        {
          ready: true,
          size: 121364,
          sha256: 'e8620d0f61de9729e0584ab25d2a578d10c038d2a835f7985df195b402d8b91c',
        },
        'the MP3 encoder now writes different bytes for the same input: ',
      );
    });

    /* ------------------------------------------------------------ library */

    await check('a file can only be removed once the program stops using it', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20)], ['b.mp3', window.__tone(330, 20)]]);
        window.__addToLibrary('spare.mp3', window.__tone(440, 10));
        renderLibrary();
        const buttons = () => [...document.querySelectorAll('#libraryList li')].map(li => ({
          file: li.querySelector('.lib-title').textContent,
          removable: !li.querySelector('[data-action="remove"]').disabled,
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

    await check('an exported file can be turned back into the program', async () => {
      /* The whole point of the chunk, and only checkable here: a real render,
         a real encode, and the app's own reader on the far side. */
      const out = await run(`
        window.__reset([['nocturne.wav', window.__tone(220, 6)], ['tango.wav', window.__tone(330, 6)]]);
        state.name = 'my 2027 junior long';
        state.level = 'usfs-jr';
        state.targetSeconds = 210;
        state.toleranceSeconds = 10;
        state.clips[0].srcStart = 1; state.clips[0].srcEnd = 4;
        library.get('nocturne.wav').tags = { artist: 'Chopin' };
        refresh();

        const rendered = await renderProgram();
        const plain = new Uint8Array(await encodeWav(rendered).arrayBuffer());
        const told = new Uint8Array(
          await encodeWav(rendered, tagsForExport(), project()).arrayBuffer(),
        );

        const back = readProjectChunk(told);
        return {
          /* The audio has to be untouched. Both files carry the same samples
             from byte 44, and the described one is only longer. */
          /* Everything except the RIFF size field, which has to change: it is
             the length of the file and the file is longer. That one field is
             the only difference before the samples, which is the whole reason
             the chunks go after the data rather than before it. */
          sameBeforeSize: plain.slice(0, 4).every((b, i) => b === told[i]),
          sameAfterSize: plain.slice(8, 44).every((b, i) => b === told[8 + i]),
          sizeGrew:
            new DataView(told.buffer).getUint32(4, true) -
            new DataView(plain.buffer).getUint32(4, true),
          dataAt36: String.fromCharCode(...told.slice(36, 40)),
          sameAudio: plain.slice(44).every((b, i) => b === told[44 + i]),
          longerBy: told.length - plain.length,
          /* And the program comes back. */
          name: back && back.name,
          clips: back ? back.clips.length : 0,
          songs: back ? back.songs.map((s) => s.name) : null,
          /* A file exported without asking carries nothing at all. */
          plainCarriesNothing: readProjectChunk(plain) === null,
        };
      `);
      eq(out.dataAt36, 'data', 'the data chunk moved, so samples no longer start at 44: ');
      ok(out.sameBeforeSize && out.sameAfterSize, 'something other than the RIFF size changed');
      eq(out.sizeGrew, out.longerBy, 'the declared size does not match how much longer it is: ');
      ok(out.sameAudio, 'the audio bytes changed');
      ok(out.longerBy > 0 && out.longerBy < 4096, `the tags cost ${out.longerBy} bytes`);
      eq(out.name, 'my 2027 junior long', 'the program did not come back: ');
      eq(out.clips, 2);
      eq(out.songs, ['nocturne.wav', 'tango.wav']);
      ok(out.plainCarriesNothing, 'an export nobody asked to describe carried a program anyway');
    });

    await check('exporting honors the box, and nothing else decides it', async () => {
      /* The check above this one calls `encodeWav` directly with arguments it
         chooses, which proves the encoder can do both and proves nothing about
         which one an export asks for. A mutation that made `doExport` describe
         every file survived exactly that gap — on the one line where getting it
         wrong puts a skater's name in every copy of their music. So this drives
         the real export, both ways, through the button. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 3)]]);
        state.name = 'my 2027 junior long';
        state.clips[0].srcEnd = 2;
        refresh();

        /* The one thing that cannot happen in a test: handing a file to the
           browser. Swapped for something that keeps it. */
        const realDownload = window.download;
        const saved = [];
        window.download = (blob, name) => saved.push({ blob, name });

        const runExport = async (describe) => {
          document.getElementById('exportFormat').value = 'wav';
          document.getElementById('exportTags').checked = describe;
          saved.length = 0;
          await doExport();
          const bytes = new Uint8Array(await saved[0].blob.arrayBuffer());
          return { carries: readProjectChunk(bytes) !== null, bytes: bytes.length };
        };

        const off = await runExport(false);
        const on = await runExport(true);

        window.download = realDownload;
        localStorage.removeItem(TAGS_KEY);
        return { off, on };
      `);
      eq(out.off.carries, false, 'an export nobody asked to describe carried the program: ');
      eq(out.on.carries, true, 'an export that was asked to describe carried nothing: ');
      ok(
        out.on.bytes > out.off.bytes,
        `the described file is not larger: ${out.on.bytes} vs ${out.off.bytes}`,
      );
    });

    await check('the export dialog remembers whether to describe the program', async () => {
      const out = await run(`
        localStorage.removeItem(TAGS_KEY);
        updateExportOptions();
        const first = document.getElementById('exportTags').checked;

        localStorage.setItem(TAGS_KEY, 'yes');
        updateExportOptions();
        const remembered = document.getElementById('exportTags').checked;

        localStorage.setItem(TAGS_KEY, 'no');
        updateExportOptions();
        const off = document.getElementById('exportTags').checked;

        localStorage.removeItem(TAGS_KEY);
        return { first, remembered, off };
      `);
      /* Off unless somebody turned it on. What goes in includes whatever was
         typed as the program's name, which is often a skater's own. */
      eq(out.first, false, 'describing the program was on by default: ');
      eq(out.remembered, true, 'a choice to describe was not remembered: ');
      eq(out.off, false);
    });

    await check('the music stops when the program it is playing goes', async () => {
      /* Every clip is handed to Web Audio ahead of time, which is what makes
         playback gapless and what makes it outlive the program it came from.
         Six ways of taking that program away, all of which left the sound
         going with an empty timeline behind it. */
      const gone = {
        'the clip being played is removed': `removeClip(state.clips[0].id);`,
        'its song is taken out of the list': `state.clips = []; refresh(); removeFromLibrary('a.wav');`,
        'another project is loaded': `loadProject({ format: 'skate-program', version: 1,
             name: 'other', event: { level: 'usfs-jr' }, songs: [], clips: [] });`,
        'the song underneath it is replaced': `
             await offerReplacement('a.wav', window.__asFile('b.wav', window.__tune(9, 20)));
             await applyReplacement();`,
        'it is undone away': `undo();`,
        'everything is forgotten': `forgetEverything();`,
      };
      for (const [what, action] of Object.entries(gone)) {
        const out = await run(`
          window.__reset([['a.wav', window.__tune(4, 20)]]);
          state.clips[0].srcEnd = 15;
          refresh();
          playProgram(0);
          const started = playing !== null;
          ${action}
          return {
            started,
            stillPlaying: playing !== null,
            button: document.getElementById('btnPlayLabel').textContent,
          };
        `);
        ok(out.started, `nothing was playing before ${what}`);
        eq(out.stillPlaying, false, `the music carried on when ${what}: `);
        eq(out.button, 'Play', `the button still offered to pause when ${what}: `);
      }
    });

    await check(
      'the music carries on through the changes people make while listening',
      async () => {
        /* The other half, and the reason the test is what a clip *is* rather than
         anything about it. Adjusting a level or a fade while the program plays
         is a thing people do on purpose; so is opening the New dialog and then
         thinking better of it, which changes nothing at all until it is
         answered. */
        const kept = {
          'a level and a fade are changed': `
             state.clips[0].gain = 0.5; state.clips[0].fadeIn = 2; refresh();`,
          'a trim is dragged': `state.clips[0].srcEnd = 12; refresh();`,
          'the New dialog is opened but not answered': `openStartDialog(true);`,
        };
        for (const [what, action] of Object.entries(kept)) {
          const out = await run(`
          window.__reset([['a.wav', window.__tune(4, 20)]]);
          state.clips[0].srcEnd = 15;
          refresh();
          playProgram(0);
          ${action}
          const out = { stillPlaying: playing !== null };
          stopPlayback();
          closeTopDialog();
          return out;
        `);
          eq(out.stillPlaying, true, `the music stopped when ${what}: `);
        }
      },
    );
    await check('a fade never outlasts the clip it is on', async () => {
      /* Four things read this number and they all used to disagree once a trim
         had made the clip shorter than its fade: the label said 8.0s, the
         slider sat at 3 because its max had moved under it, the envelope
         applied 3, and the project file recorded 8. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.clips[0].srcStart = 0; state.clips[0].srcEnd = 20;
        state.clips[0].fadeIn = 8;
        state.selected = state.clips[0].id;
        refresh();

        const read = () => ({
          stored: state.clips[0].fadeIn,
          slider: Number(document.getElementById('fadeIn').value),
          label: document.getElementById('valFadeIn').textContent,
          applied: fadeEnvelope(state.clips[0])[1][0],
          inFile: project().clips[0].fadeIn,
        });

        const before = read();
        state.clips[0].srcEnd = 3;
        refresh();
        return { before, after: read() };
      `);
      eq(out.before.stored, 8, 'the fade did not survive being set: ');
      const a = out.after;
      eq(a.stored, 3, 'the stored fade did not come in with the trim: ');
      eq(a.slider, 3);
      eq(a.label, '3.0s', 'the label still claims a fade nobody can hear: ');
      eq(a.applied, 3);
      eq(a.inFile, 3, 'the project file still records the fade that was thrown away: ');
    });

    await check('dragging a trim handle brings the fade in as it goes', async () => {
      /* The drag deliberately avoids `refresh` — it runs at pointer rate and
         `refresh` saves — so the clamp has to be repeated on that path. Without
         it the number is wrong for exactly as long as somebody is watching it. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.clips[0].srcStart = 0; state.clips[0].srcEnd = 25;
        state.clips[0].fadeOut = 6;
        state.selected = state.clips[0].id;
        refresh();

        const canvas = document.getElementById('clipCanvas');
        const box = canvas.getBoundingClientRect();
        const at = (t) => box.left + (t / 30) * box.width;
        const move = (t) =>
          canvas.dispatchEvent(new PointerEvent('pointermove', {
            clientX: at(t), clientY: box.top + box.height / 2, bubbles: true, pointerId: 1,
          }));

        canvas.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: at(25), clientY: box.top + box.height / 2, bubbles: true, pointerId: 1,
        }));
        move(2);
        const midDrag = {
          stored: state.clips[0].fadeOut,
          label: document.getElementById('valFadeOut').textContent,
          duration: Number(clipDuration(state.clips[0]).toFixed(2)),
        };
        canvas.dispatchEvent(new PointerEvent('pointerup', {
          clientX: at(2), clientY: box.top + box.height / 2, bubbles: true, pointerId: 1,
        }));
        return midDrag;
      `);
      ok(out.duration < 6, `the drag did not shorten the clip: ${out.duration}s`);
      ok(
        out.stored <= out.duration + 0.01,
        `the fade stayed at ${out.stored}s on a ${out.duration}s clip`,
      );
      eq(out.label, `${out.stored.toFixed(1)}s`, 'the label disagrees with the value: ');
    });

    await check('a blend keeps its value but never overstates it', async () => {
      /* The other half of the same disagreement, handled the other way round.
         A blend belongs to a pair, so the stored value is left alone — the clip
         on the other side can grow again — and the label says what is really
         being applied rather than what is written down. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)], ['b.wav', window.__tone(330, 30)]]);
        state.clips[0].srcEnd = 1.5;
        state.clips[1].crossfade = 9;
        state.selected = state.clips[1].id;
        refresh();
        return {
          stored: state.clips[1].crossfade,
          label: document.getElementById('valCrossfade').textContent,
          applied: Number(crossfadeOf(state.clips, 1).toFixed(2)),
        };
      `);
      eq(out.stored, 9, 'the blend was thrown away rather than left for later: ');
      eq(out.applied, 1.5, 'the blend is limited by the clip before it: ');
      eq(out.label, '1.5s', 'the label claims a blend longer than either clip: ');
    });

    await check('a trim key says no rather than flattening the clip', async () => {
      /* The clip canvas draws the whole file, so a marker outside the kept
         region is one click away — and clicking ahead to hear what comes next
         is a normal thing to do. Pressing I there used to collapse ten seconds
         of trimming into a tenth of a second without a word. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.clips[0].srcStart = 10; state.clips[0].srcEnd = 20;
        state.selected = state.clips[0].id;
        refresh();

        const canvas = document.getElementById('clipCanvas');
        const box = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: box.left + box.width * 0.9, clientY: box.top + box.height / 2,
          bubbles: true, pointerId: 1,
        }));
        const marker = state.cursor;

        /* One reused element, not one per message — so it is emptied rather
           than removed, which would take the app's only way of speaking. */
        const line = document.getElementById('toast');
        line.textContent = '';
        const undoBefore = undoStack.length;
        window.__key('i');

        return {
          marker,
          kept: { start: state.clips[0].srcStart, end: state.clips[0].srcEnd },
          said: line.classList.contains('hidden') ? '' : line.textContent,
          /* A refused key must not leave a step behind, or Ctrl-Z undoes
             nothing and looks broken. */
          undoGrew: undoStack.length - undoBefore,
        };
      `);
      ok(
        out.marker > 20,
        `the marker landed inside the clip, so this proves nothing: ${out.marker}`,
      );
      eq(out.kept, { start: 10, end: 20 }, 'the clip was trimmed anyway: ');
      ok(/past the end/.test(out.said), `nothing was said about it: "${out.said}"`);
      eq(out.undoGrew, 0, 'a refused key still pushed an undo step: ');
    });

    await check('a trim key with a marker it can use still works', async () => {
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.clips[0].srcStart = 10; state.clips[0].srcEnd = 20;
        state.selected = state.clips[0].id;
        refresh();

        state.cursor = 12;
        window.__key('i');
        const afterIn = { start: state.clips[0].srcStart, end: state.clips[0].srcEnd };

        state.cursor = 25;
        window.__key('o');
        const afterOut = { start: state.clips[0].srcStart, end: state.clips[0].srcEnd };

        undo();
        return { afterIn, afterOut, undone: { start: state.clips[0].srcStart, end: state.clips[0].srcEnd } };
      `);
      eq(out.afterIn, { start: 12, end: 20 }, 'I did not move the start: ');
      eq(out.afterOut, { start: 12, end: 25 }, 'O did not move the end: ');
      eq(out.undone, { start: 12, end: 20 }, 'undo did not step back exactly one trim: ');
    });

    await check(
      'a browser that will not keep the work says so, once and then standing',
      async () => {
        /* This was silent, while the app told people they did not need to save
         because the browser remembers on its own. In a private window that
         promise is simply not kept. */
        const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 10)]]);
        const line = document.getElementById('toast');
        const notice = document.getElementById('storageNotice');
        line.textContent = ''; line.classList.add('hidden');

        const quiet = { toast: line.textContent, notice: !notice.classList.contains('hidden') };

        const real = localStorage.setItem.bind(localStorage);
        localStorage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
        save();
        const first = {
          toast: line.classList.contains('hidden') ? '' : line.textContent,
          notice: !notice.classList.contains('hidden'),
        };

        /* Every later edit refuses too. Saving runs after each one, so
           complaining every time would be a toast every few seconds — which is
           why this was left silent in the first place. */
        line.textContent = ''; line.classList.add('hidden');
        state.clips[0].srcEnd = 5;
        refresh();
        const later = {
          toast: line.classList.contains('hidden') ? '' : line.textContent,
          notice: !notice.classList.contains('hidden'),
          offersSave: !!document.getElementById('btnSaveNow'),
        };

        localStorage.setItem = real;
        return { quiet, first, later };
      `);
        eq(out.quiet.notice, false, 'the notice was up before anything went wrong: ');
        eq(out.quiet.toast, '');
        ok(/will not keep your work/.test(out.first.toast), `said nothing: "${out.first.toast}"`);
        eq(out.first.notice, true, 'nothing standing was left behind after the toast: ');
        eq(out.later.toast, '', 'it complained a second time: ');
        eq(out.later.notice, true, 'the notice went away while the trouble had not: ');
        ok(out.later.offersSave, 'the notice names Save project but does not offer it');
      },
    );

    await check('a browser that keeps the work says nothing at all', async () => {
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 10)]]);
        save();
        state.clips[0].srcEnd = 5;
        refresh();
        return {
          notice: !document.getElementById('storageNotice').classList.contains('hidden'),
          stored: !!localStorage.getItem(STORE_KEY),
        };
      `);
      eq(out.notice, false, 'a working browser was told it is not keeping anything: ');
      eq(out.stored, true, 'the program was not actually written: ');
    });

    await check('a blend survives being moved to the front and back again', async () => {
      /* `crossfadeOf` already refuses to apply a blend to the first clip, so
         zeroing the stored value bought nothing and cost the number. Reordering
         three songs to try an order and putting them back left every blend at
         zero and the program quietly longer. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)], ['b.wav', window.__tone(330, 30)]]);
        state.clips[1].crossfade = 2.5;
        refresh();
        const started = { blends: state.clips.map(c => c.crossfade),
                          length: Math.round(layout(state.clips).total) };

        moveClip(1, 0);
        const atFront = {
          blends: state.clips.map(c => c.crossfade),
          applied: crossfadeOf(state.clips, 0),
          length: Math.round(layout(state.clips).total),
        };

        moveClip(0, 1);
        const back = { blends: state.clips.map(c => c.crossfade),
                       length: Math.round(layout(state.clips).total) };
        return { started, atFront, back };
      `);
      eq(out.started.blends, [0, 2.5]);
      eq(out.atFront.blends, [2.5, 0], 'the blend was thrown away on the way to the front: ');
      eq(out.atFront.applied, 0, 'a first clip blended into nothing: ');
      eq(out.atFront.length, 60, 'a blend was applied to the first clip after all: ');
      eq(out.back.blends, [0, 2.5], 'the blend did not come back: ');
      eq(out.back.length, out.started.length, 'the program did not return to its own length: ');
    });

    await check('taking a clip out leaves the blends of the ones that remain', async () => {
      const out = await run(`
        window.__reset([
          ['a.wav', window.__tone(220, 30)],
          ['b.wav', window.__tone(330, 30)],
          ['c.wav', window.__tone(440, 30)],
        ]);
        state.clips[1].crossfade = 2;
        state.clips[2].crossfade = 3;
        refresh();
        removeClip(state.clips[0].id);
        return { blends: state.clips.map(c => c.crossfade), applied: crossfadeOf(state.clips, 0) };
      `);
      eq(out.blends, [2, 3], 'removing the first clip wiped the blend of the one behind it: ');
      eq(out.applied, 0, 'the new first clip is blending into nothing: ');
    });

    await check('the file records no blend on the first clip, whatever is held', async () => {
      /* The format says so plainly — "Zero for the first clip" — and every
         reader of it assumes it. The value stays in memory so a reorder can
         give it back; only saving while the song sits at the front lets it go. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)], ['b.wav', window.__tone(330, 30)]]);
        state.clips[0].crossfade = 4;
        state.clips[1].crossfade = 2.5;
        refresh();
        const doc = project();
        return { written: doc.clips.map(c => c.blend), held: state.clips.map(c => c.crossfade) };
      `);
      eq(out.held, [4, 2.5], 'the value was not kept in memory: ');
      eq(out.written, [0, 2.5], 'the first clip was written with a blend: ');
    });

    /* ------------------------------------------------ replacing a song */

    await check('a song taken out of the list is taken out of the folder too', async () => {
      /* A list that forgets a song while the folder goes on holding it is a
         project quietly accumulating music nothing plays. And a browser, which
         has no folder, must keep the behavior it always had — there is no file
         there to be rid of, and pretending otherwise would be inventing one. */
      const out = await run(`
        window.__reset([]);
        const discarded = (fake) =>
          fake.calls.filter(([method]) => method === 'discard').map(([, name]) => name);

        let fake = window.__fakeHost({ media: { 'spare.mp3': new ArrayBuffer(8) } });
        window.skateHost = fake.host;
        window.__addToLibrary('spare.mp3', window.__tone(330, 5));
        removeFromLibrary('spare.mp3');
        const hosted = { discarded: discarded(fake), gone: !library.has('spare.mp3') };

        /* A song the program plays is refused, and nothing is asked of the
           folder — the refusal has to come before the file, not after. */
        window.__reset([['used.mp3', window.__tone(220, 5)]]);
        fake = window.__fakeHost({ media: { 'used.mp3': new ArrayBuffer(8) } });
        window.skateHost = fake.host;
        removeFromLibrary('used.mp3');
        const refused = { discarded: discarded(fake), stillThere: library.has('used.mp3') };

        /* And a shell that offers no way to be rid of one keeps the old
           behavior, which is what every plain browser is. */
        window.__reset([]);
        window.skateHost = window.__fakeHost({ omit: ['discard'] }).host;
        window.__addToLibrary('spare.mp3', window.__tone(330, 5));
        let threw = null;
        try { removeFromLibrary('spare.mp3'); } catch (e) { threw = String(e.message); }
        const withoutShell = { gone: !library.has('spare.mp3'), threw };

        delete window.skateHost;
        return { hosted, refused, withoutShell };
      `);
      eq(out.hosted.discarded, ['spare.mp3'], 'the folder was not asked to be rid of the song: ');
      ok(out.hosted.gone, 'the song stayed in the list');
      eq(out.refused.discarded, [], 'a song the program plays had its file deleted: ');
      ok(out.refused.stillThere, 'a song the program plays was removed from the list');
      ok(out.withoutShell.gone, 'a plain browser could not remove a song');
      eq(out.withoutShell.threw, null, 'removing without a shell threw: ');
    });

    await check('a replaced song takes its file with it, but never the new one', async () => {
      const out = await run(`
        window.__reset([['rough.mp3', window.__tune(4, 20)]]);
        const fake = window.__fakeHost({ media: { 'rough.mp3': new ArrayBuffer(8) } });
        window.skateHost = fake.host;

        const better = window.__tune(4, 20, (v) => v * 0.7);
        await offerReplacement('rough.mp3', window.__asFile('good.wav', better));
        await applyReplacement();

        const out = {
          discarded: fake.calls.filter(([method]) => method === 'discard').map(([, name]) => name),
          plays: state.clips[0].file,
          /* Still in the list, so the swap can be undone. The file is in the
             trash and the audio is in this page's memory. */
          oldStillLoaded: library.has('rough.mp3'),
          undoWorks: (() => { undo(); return state.clips[0].file === 'rough.mp3'; })(),
        };
        delete window.skateHost;
        return out;
      `);
      eq(out.discarded, ['rough.mp3'], 'the replaced file was not sent to the trash: ');
      ok(!out.discarded.includes('good.wav'), 'the new file was deleted');
      ok(out.oldStillLoaded, 'the replaced song left the list, so undo has nothing to go back to');
      ok(out.undoWorks, 'the swap could not be undone');
    });

    await check('Replace is offered on exactly the songs Remove is not', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(1)]]);
        window.__addToLibrary('spare.mp3', window.__tune(2));
        renderLibrary();
        return [...document.querySelectorAll('#libraryList li')].map(li => ({
          file: li.dataset.song,
          canReplace: [...li.querySelectorAll('button')].some(b => b.textContent === 'Replace'),
          canRemove: !li.querySelector('[data-action="remove"]').disabled,
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

    await check('a song in the program says so on its card, and how often', async () => {
      /* #107. Which buttons were offered was the only clue, and the reason
         Remove was grayed lived in a tooltip a touchscreen never shows. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(1)], ['b.mp3', window.__tune(2)]]);
        addClip(library.get('b.mp3'));
        window.__addToLibrary('spare.mp3', window.__tune(3));
        renderLibrary();
        return [...document.querySelectorAll('#libraryList li')].map((li) => {
          const tag = li.querySelector('.lib-used');
          const remove = li.querySelector('[data-action="remove"]');
          return { file: li.dataset.song, tag: tag ? tag.textContent : null,
                   removeShown: !remove.classList.contains('hidden') };
        });
      `);
      eq(result, [
        { file: 'a.mp3', tag: 'In program', removeShown: false },
        { file: 'b.mp3', tag: 'In program twice', removeShown: false },
        { file: 'spare.mp3', tag: null, removeShown: true },
      ]);
    });

    await check('a card plays its whole song, untouched, and stops when asked', async () => {
      /* #118. The list is the songs as they are: the whole file from the top,
         straight to the output with no level node between — asserted on the
         graph that was built. Any other playback stops it, and it stops them. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20)]]);
        state.clips[0].srcStart = 3; state.clips[0].gain = dbToGain(-8); refresh();
        const context = ctx();
        const edges = [];
        const realConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (target) {
          edges.push({ from: this, to: target });
          return realConnect.apply(this, arguments);
        };
        let source = null, started = null;
        const realSource = context.createBufferSource.bind(context);
        context.createBufferSource = () => {
          source = realSource();
          const realStart = source.start.bind(source);
          source.start = (...args) => { started = args.slice(1); return realStart(...args); };
          return source;
        };
        const play = () => document.querySelector('#libraryList li[data-song="a.mp3"] .lib-play');
        try {
          play().click();
          const on = { mode: playing && playing.mode, pressed: play().getAttribute('aria-pressed'),
                       to: edges.filter((e) => e.from === source).map((e) => e.to.constructor.name),
                       started };
          play().click();
          const off = { playing: Boolean(playing), pressed: play().getAttribute('aria-pressed') };
          play().click();
          playProgram(0);
          const overtaken = { mode: playing && playing.mode, pressed: play().getAttribute('aria-pressed') };
          stopPlayback();
          return { on, off, overtaken };
        } finally {
          AudioNode.prototype.connect = realConnect;
          context.createBufferSource = realSource;
          stopPlayback();
        }
      `);
      eq(result.on.mode, 'song', 'the card did not play its song: ');
      eq(result.on.pressed, 'true', 'the card does not show it is playing: ');
      eq(result.on.to, ['AudioDestinationNode'], 'the list played it through something: ');
      eq(result.on.started, [0], 'not the whole song from the top: ');
      eq(result.off, { playing: false, pressed: 'false' }, 'a second click did not pause it: ');
      eq(
        result.overtaken,
        { mode: 'program', pressed: 'false' },
        'the program did not take over: ',
      );
    });

    await check('the song player shows how far it has got', async () => {
      const result = await run(`
        window.__reset([]);
        window.__addToLibrary('a.mp3', window.__tone(220, 80));
        forgetLibraryShape(); renderLibrary();
        const read = () => ({
          bar: __id('songPlayerProgress').style.width,
          time: __id('songTime').textContent,
          seek: __id('songSeek').value,
        });
        toggleSong('a.mp3');
        // Left to play, the playhead's own tick moves it along.
        await new Promise((r) => setTimeout(r, 500));
        const moving = read();
        // And at a known point, what that tick shows.
        showSongProgress('a.mp3', 20);
        const at20 = read();
        stopSong();
        return { moving, at20 };
      `);
      ok(
        parseFloat(result.moving.bar) > 0 && / \/ 1:20$/.test(result.moving.time),
        `playing did not show any progress: ${JSON.stringify(result.moving)}`,
      );
      eq(result.at20, { bar: '25%', time: '0:20 / 1:20', seek: '20' }, 'a quarter of the way in: ');
    });

    await check('the song player pauses, carries on, seeks, stops and closes', async () => {
      /* ▶ on a card opens the player over the page: Pause and Play keep the
         place, the bar and the waveform move it, Stop goes back to the start,
         × closes it, and anything else playing closes it the way one song
         stops another. Only the card's ▶ is on the card. */
      const result = await run(`
        window.__reset([['other.mp3', window.__tone(330, 20)]]);
        window.__addToLibrary('a.mp3', window.__tone(220, 80));
        forgetLibraryShape(); renderLibrary();
        const li = document.querySelector('#libraryList li[data-song="a.mp3"]');
        const box = __id('songPlayer');
        const read = () => ({
          open: !box.classList.contains('hidden'),
          button: __id('btnSongPause').textContent,
          mode: playing ? playing.mode : null,
          from: playing ? +playing.fromTime.toFixed(1) : null,
          time: __id('songTime').textContent,
        });
        const closed = read();
        li.querySelector('.lib-play').click();
        const opened = { ...read(), title: __id('songPlayerTitle').textContent,
                         onCard: li.querySelectorAll('input, .lib-player').length };

        // Pause where it is, move the bar while paused, and Play from there.
        __id('btnSongPause').click();
        const paused = read();
        const seek = __id('songSeek');
        seek.value = '40';
        seek.dispatchEvent(new Event('input'));
        seek.dispatchEvent(new Event('change'));
        const sought = read();
        __id('btnSongPause').click();
        const resumed = read();

        // Moved while playing, it plays on from where it is let go.
        seek.value = '60';
        seek.dispatchEvent(new Event('input'));
        seek.dispatchEvent(new Event('change'));
        const jumped = read();

        __id('btnSongStop').click();
        const stopped = read();
        __id('btnSongClose').click();
        const shut = read();

        // Anything else playing closes it.
        li.querySelector('.lib-play').click();
        playProgram(0);
        const overtaken = read();
        stopPlayback();

        // A dialog like the others: focus goes in, Escape and the dimmed page
        // close it, and focus comes back to the card's ▶.
        const play = li.querySelector('.lib-play');
        play.focus();
        play.click();
        const focusIn = document.activeElement && document.activeElement.id;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const escaped = { ...read(), focusBack: document.activeElement === play };
        play.click();
        box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const backdrop = read();
        return { closed, opened, paused, sought, resumed, jumped, stopped, shut, overtaken,
                 focusIn, escaped, backdrop };
      `);
      eq(result.focusIn, 'btnSongPause', 'the keyboard did not go into the player: ');
      eq(
        [result.escaped.open, result.escaped.mode, result.escaped.focusBack],
        [false, null, true],
        'Escape: ',
      );
      eq(
        [result.backdrop.open, result.backdrop.mode],
        [false, null],
        'a click on the dimmed page: ',
      );
      eq(result.closed.open, false, 'a player open before anything played: ');
      eq(
        result.opened,
        {
          open: true,
          button: 'Pause',
          mode: 'song',
          from: 0,
          time: '0:00 / 1:20',
          title: 'a.mp3',
          onCard: 0,
        },
        '▶ did not open a playing player: ',
      );
      eq(
        [result.paused.open, result.paused.button, result.paused.mode],
        [true, 'Play', null],
        'Pause: ',
      );
      eq(
        [result.sought.time, result.sought.mode],
        ['0:40 / 1:20', null],
        'moving the bar while paused: ',
      );
      eq(
        [result.resumed.mode, result.resumed.from],
        ['song', 40],
        'Play did not carry on from the bar: ',
      );
      eq([result.jumped.mode, result.jumped.from], ['song', 60], 'moving it while playing: ');
      eq(
        [result.stopped.open, result.stopped.mode, result.stopped.time],
        [true, null, '0:00 / 1:20'],
        'Stop: ',
      );
      eq([result.shut.open, result.shut.mode], [false, null], '×: ');
      eq(
        [result.overtaken.open, result.overtaken.mode],
        [false, 'program'],
        'the program playing: ',
      );
    });

    await check('a card keeps Remove in its corner and only what applies on its row', async () => {
      /* The card had grown to four buttons beside a badge, a length and a tag.
         Remove is the corner ×, there only while nothing in the program uses
         the song; the row has Add to program, Replace when the program uses
         it, and Info when the file says something about itself. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tune(1)]]);
        library.get('a.mp3').tags = { title: 'A song', artist: 'Somebody' };
        window.__addToLibrary('spare.mp3', window.__tune(2));
        forgetLibraryShape(); renderLibrary();
        const rowOf = (name) => [...document.querySelectorAll(
          '#libraryList li[data-song="' + name + '"] .lib-row button')].map((b) => b.textContent);
        const corner = (name) => {
          const x = document.querySelector('#libraryList li[data-song="' + name + '"] .lib-remove');
          return { shown: !x.classList.contains('hidden'), name: controlLabel(x) };
        };
        const forShell = ['song.replace', 'song.info', 'song.remove'].map((id) =>
          describeCommand(HOST_COMMANDS.find((c) => c.id === id), false, { song: 'spare.mp3' }));
        return {
          rows: { used: rowOf('a.mp3'), spare: rowOf('spare.mp3') },
          remove: { used: corner('a.mp3'), spare: corner('spare.mp3') },
          removeForShell: { label: forShell[2].label, enabled: forShell[2].enabled },
        };
      `);
      eq(
        result.rows,
        { used: ['Add to program', 'Replace', 'Info'], spare: ['Add to program'] },
        'the card rows: ',
      );
      eq(
        result.remove,
        { used: { shown: false, name: 'Remove' }, spare: { shown: true, name: 'Remove' } },
        'the corner ×: ',
      );
      eq(
        result.removeForShell,
        { label: 'Remove', enabled: true },
        'a shell’s right-click lost Remove: ',
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

    await check('the part that was cut away can be heard, at the song’s level', async () => {
      /* #118. From outside the trims the audition plays the original, from
         there to the end of the file with no fades, so the cut-away part can be
         judged — through the same level node, built and connected, not merely
         constructed. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 30)]]);
        const clip = state.clips[0];
        clip.srcStart = 2; clip.srcEnd = 20; clip.fadeIn = 3; clip.fadeOut = 4;
        clip.gain = dbToGain(-8);
        state.selected = clip.id;
        refresh();

        const context = ctx();
        const edges = [];
        const realConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (target) {
          edges.push({ from: this, to: target });
          return realConnect.apply(this, arguments);
        };
        let source = null;
        let started = null;
        const realSource = context.createBufferSource.bind(context);
        context.createBufferSource = () => {
          source = realSource();
          const realStart = source.start.bind(source);
          source.start = (when, offset, duration) => {
            started = { offset, duration: +duration.toFixed(3) };
            return realStart(when, offset, duration);
          };
          return source;
        };
        const realEnvelope = window.applyEnvelope;
        let envelopes = 0;
        window.applyEnvelope = (...args) => { envelopes++; return realEnvelope(...args); };
        try {
          playClipAudition(clip, 0.5);         // before the start trim
          const until = playing.until;
          stopPlayback();
          const chain = [source];
          for (;;) {
            const next = edges.find((e) => e.from === chain[chain.length - 1]);
            if (!next || chain.includes(next.to)) break;
            chain.push(next.to);
          }
          return {
            path: chain.map((n) => n && n.constructor.name),
            level: +chain[1].gain.value.toFixed(4),
            wanted: +clipGain(clip).toFixed(4),
            started, until, envelopes,
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
        'the original must still reach the output through the level node: ',
      );
      near(result.level, result.wanted, 1e-6, 'the song’s level was not applied: ');
      eq(result.started, { offset: 0.5, duration: 29.5 }, 'not played from there to the end: ');
      eq(result.until, 30, 'the marker would stop at the trim: ');
      eq(result.envelopes, 0, 'fades were applied to the part that was cut: ');
    });

    await check('Play this clip becomes Stop this clip while it plays, and stops it', async () => {
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(220, 20)]]);
        const button = __id('btnPreviewClip');
        const read = () => ({ label: button.textContent, mode: playing ? playing.mode : null });
        const before = read();
        button.click();
        const during = read();
        button.click();
        const after = read();
        // Started some other way — a double-click — the button still stops it.
        playClipAudition(state.clips[0], 5);
        button.click();
        const fromElsewhere = read();

        // Start marker to end marker, wherever the waveform's marker is.
        const clip = state.clips[0];
        clip.srcStart = 3; clip.srcEnd = 12; state.cursor = 0.5; refresh();
        button.click();
        const bounds = { from: playing.fromTime, until: playing.until };
        stopPlayback();
        return { before, during, after, fromElsewhere, bounds };
      `);
      eq(result.bounds, { from: 3, until: 12 }, 'not the clip between its markers: ');
      eq(result.before, { label: 'Play this clip', mode: null });
      eq(result.during, { label: 'Stop this clip', mode: 'clip' }, 'while it plays: ');
      eq(result.after, { label: 'Play this clip', mode: null }, 'pressed again: ');
      eq(
        result.fromElsewhere,
        { label: 'Play this clip', mode: null },
        'started by double-click: ',
      );
    });

    await check(
      'the arrow keys trim whichever end was last touched, and stay in the file',
      async () => {
        /* Real key and pointer events from Chrome's input layer, so the press
           lands wherever focus really is and the grab goes through the canvas's
           own pointer handling. A freshly added song ends at the end of its
           file, which is where the old nudge ran straight past into silence
           and the start could not be nudged at all. */
        const press = async (key, code) => {
          for (const type of ['rawKeyDown', 'keyUp']) {
            await page.send('Input.dispatchKeyEvent', {
              type,
              key,
              code,
              windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39, i: 73 }[key],
            });
          }
        };
        const tap = async ({ x, y }) => {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await page.send('Input.dispatchMouseEvent', {
              type,
              x,
              y,
              button: 'left',
              clickCount: 1,
            });
          }
        };
        const read = () =>
          run(`return { start: +state.clips[0].srcStart.toFixed(2),
                      end: +state.clips[0].srcEnd.toFixed(2), edge: getActiveEdge() };`);

        await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.selected = state.clips[0].id;
        setActiveEdge('end');
        refresh();
        document.activeElement.blur();
      `);
        const fresh = await read();

        // Already at the end of the file: nothing to move to, so nothing moves.
        await press('ArrowRight', 'ArrowRight');
        const atLimit = await read();
        await press('ArrowLeft', 'ArrowLeft');
        const endNudged = await read();

        // Grabbing the start handle makes it the one the arrows move.
        const start = await run(`const r = __id('clipCanvas').getBoundingClientRect();
                                 return { x: r.left + 1, y: r.top + r.height / 2 };`);
        await tap(start);
        await press('ArrowRight', 'ArrowRight');
        const afterGrab = await read();

        // So does setting it with I.
        await run(`setActiveEdge('end'); state.cursor = 3;`);
        await press('i', 'KeyI');
        await press('ArrowRight', 'ArrowRight');
        const afterI = await read();

        eq(fresh, { start: 0, end: 30, edge: 'end' });
        eq(atLimit.end, 30, 'the end ran past the end of the file: ');
        eq(endNudged, { start: 0, end: 29.9, edge: 'end' }, 'the end did not move: ');
        eq(afterGrab, { start: 0.1, end: 29.9, edge: 'start' }, 'after grabbing the start: ');
        eq(afterI, { start: 3.1, end: 29.9, edge: 'start' }, 'after setting the start with I: ');
      },
    );

    await check('O while the program plays ends the song where it is being heard', async () => {
      /* The waveform marker used to move only for Play this song, so pressing O
         during the program trimmed to wherever it was last clicked — or, as
         here with the marker at 0, refused outright. */
      const press = async (key, code, keyCode) => {
        for (const type of ['rawKeyDown', 'keyUp']) {
          await page.send('Input.dispatchKeyEvent', {
            type,
            key,
            code,
            windowsVirtualKeyCode: keyCode,
          });
        }
      };
      await run(`
        window.__reset([['a.wav', window.__tone(220, 30)], ['b.wav', window.__tone(330, 30)]]);
        state.clips[0].srcStart = 5; state.clips[0].srcEnd = 25;
        state.selected = state.clips[0].id;
        state.cursor = 0;
        refresh();
        seekTo(0);
        document.activeElement.blur();
      `);
      await press(' ', 'Space', 32);
      await run(`
        const t0 = performance.now();
        while (!(state.playPosition > 0.3) && performance.now() - t0 < 5000) {
          await new Promise((r) => setTimeout(r, 50));
        }
      `);
      await press(' ', 'Space', 32); // stop, so the marker holds still to compare
      const heard = await run(`return {
        playPosition: state.playPosition,
        cursor: state.cursor,
        expected: songTimeAt(state.clips, 0, state.playPosition),
      };`);
      await press('o', 'KeyO', 79);
      const end = await run(`return state.clips[0].srcEnd;`);

      ok(heard.playPosition > 0.3, `the program never played: ${heard.playPosition}`);
      near(heard.cursor, heard.expected, 1e-6, 'the marker did not follow the program: ');
      near(end, heard.expected, 1e-6, 'O did not end the song where it was heard: ');
    });

    await check('the waveform marker and the program playhead move together', async () => {
      /* Two markers that did not know about each other: clicking the waveform
         left Space playing from somewhere else, and clicking the bar left I and
         O trimming to somewhere else. Real clicks, through each canvas's own
         pointer handling. */
      const tap = async ({ x, y }) => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
        }
      };
      await run(`
        window.__reset([['a.wav', window.__tone(220, 30)], ['b.wav', window.__tone(330, 30)]]);
        state.clips[0].srcStart = 5; state.clips[0].srcEnd = 25;
        state.clips[1].crossfade = 0;
        state.selected = state.clips[0].id;
        refresh();
        seekTo(0);
      `);
      const onWave = (t) =>
        run(`const r = __id('clipCanvas').getBoundingClientRect();
             return { x: r.left + r.width * ${t} / 30, y: r.top + r.height / 2 };`);
      const onBar = (t) =>
        run(`const r = __id('scrubber').getBoundingClientRect();
             return { x: r.left + r.width * ${t} / scrubberSpan(), y: r.top + r.height / 2 };`);
      const read = () =>
        run(
          `return { cursor: +state.cursor.toFixed(1), playhead: +state.playPosition.toFixed(1) };`,
        );

      await tap(await onWave(15)); // 10 s into the kept part
      const inKept = await read();
      await tap(await onWave(2)); // trimmed out: not in the program
      const trimmedOut = await read();
      await tap(await onBar(8)); // 8 s into the program, so 13 s into the song
      const fromBar = await read();
      await tap(await onBar(30)); // the second song: this one's marker stays
      const otherSong = await read();

      eq(inKept, { cursor: 15, playhead: 10 }, 'clicking the waveform: ');
      eq(trimmedOut, { cursor: 2, playhead: 10 }, 'clicking the trimmed-out part: ');
      eq(fromBar, { cursor: 13, playhead: 8 }, 'clicking the bar: ');
      eq(otherSong, { cursor: 13, playhead: 30 }, 'clicking the bar in another song: ');
    });

    await check('the waveform marker shows in the trimmed-out part too', async () => {
      /* Measured off the canvas: the column the marker is in must differ from
         the one beside it. Without a marker both are the same dimmed waveform,
         which is what the trimmed-out part looked like with one set there. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.clips[0].srcStart = 10; state.clips[0].srcEnd = 25;
        state.selected = state.clips[0].id;
        refresh();
        const canvas = __id('clipCanvas');
        const g = canvas.getContext('2d');
        const column = (t) => {
          const x = Math.round((t / 30) * canvas.width);
          return [...g.getImageData(x, 2, 1, 1).data].join(',');
        };
        const differs = (t) => {
          state.cursor = t;
          drawClipEditor();
          const at = column(t);
          return at !== column(t + 0.5);
        };
        return { before: differs(4), inside: differs(15), after: differs(28) };
      `);
      eq(out.inside, true, 'the marker does not show inside the song, so this cannot tell: ');
      eq(out.before, true, 'no marker before the start of the song: ');
      eq(out.after, true, 'no marker after the end of the song: ');
    });

    await check('Undo and Redo buttons work, and say when there is nothing to do', async () => {
      /* A tablet has no Ctrl+Z, so these are the only undo there. A slider is
         the edit that reaches only save() rather than refresh(), so it is the
         one most likely to leave the buttons out of date. */
      const out = await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.selected = state.clips[0].id;
        refresh();
        undoStack.length = 0; redoStack.length = 0; refresh();
        const buttons = () => ({ undo: !__id('btnUndo').disabled, redo: !__id('btnRedo').disabled });
        const fresh = buttons();

        const slider = __id('fadeOut');
        slider.dispatchEvent(new Event('pointerdown'));
        slider.value = '3';
        slider.dispatchEvent(new Event('input'));
        slider.dispatchEvent(new Event('change'));
        const edited = { ...buttons(), fade: state.clips[0].fadeOut };

        __id('btnUndo').click();
        const undone = { ...buttons(), fade: state.clips[0].fadeOut };
        __id('btnRedo').click();
        const redone = { ...buttons(), fade: state.clips[0].fadeOut };
        return { fresh, edited, undone, redone };
      `);
      eq(out.fresh, { undo: false, redo: false }, 'with no history: ');
      eq(out.edited, { undo: true, redo: false, fade: 3 }, 'after moving a slider: ');
      eq(out.undone, { undo: false, redo: true, fade: 0 }, 'after Undo: ');
      eq(out.redone, { undo: true, redo: false, fade: 3 }, 'after Redo: ');
    });

    await check('a start or end time can be typed in', async () => {
      /* Real typing through Chrome's input layer: the field has to take the
         keys rather than the editor's shortcuts, and Enter has to commit. */
      const key = async (name, code, keyCode) => {
        for (const type of ['rawKeyDown', 'keyUp']) {
          await page.send('Input.dispatchKeyEvent', {
            type,
            key: name,
            code,
            windowsVirtualKeyCode: keyCode,
          });
        }
      };
      const typeInto = async (id, text) => {
        await run(`__id('${id}').focus();`);
        await page.send('Input.insertText', { text });
      };
      const read = () =>
        run(`return { start: state.clips[0].srcStart, end: state.clips[0].srcEnd,
                      shown: __id('lblEnd').value, toast: (__id('toast') || {}).textContent };`);
      await run(`
        window.__reset([['a.wav', window.__tone(220, 30)]]);
        state.selected = state.clips[0].id;
        refresh();
        undoStack.length = 0; refresh();
      `);

      await typeInto('lblStart', '0:04.5');
      await key('Enter', 'Enter', 13);
      const started = await read();

      // "1:00" is past this 30 s file, so the end goes to the end of the file.
      await typeInto('lblEnd', '1:00');
      await key('Enter', 'Enter', 13);
      const pastEnd = await read();

      // Escape leaves the time as it was.
      await typeInto('lblEnd', '0:10');
      await key('Escape', 'Escape', 27);
      const escaped = await read();

      // An end before the start is refused, and the field shows the real end.
      await typeInto('lblEnd', '0:02');
      await key('Enter', 'Enter', 13);
      const refused = await read();

      const undone = await run(`undo(); return state.clips[0].srcStart;`);

      eq(started.start, 4.5, 'the typed start did not apply: ');
      eq(pastEnd.end, 30, 'a time past the file should give all of it: ');
      eq(pastEnd.shown, '0:30.0', 'the field should show where the end went: ');
      eq(escaped.end, 30, 'Escape changed the end: ');
      eq(escaped.shown, '0:30.0');
      eq(refused.end, 30, 'an end before the start was accepted: ');
      eq(refused.shown, '0:30.0', 'the refused time was left in the field: ');
      eq(undone, 0, 'typing a time is not one undo step: ');
    });

    await check('zoomed in, one arrow press visibly moves the handle', async () => {
      /* Measured off the canvas: the column the active handle is painted in,
         found by its color, before and after a press. On a whole four-minute
         song a tenth of a second is under half a pixel, which is the complaint
         this answers; zoomed in it has to be a visible move. Real keys and a
         real click, so the hit-testing is checked against the same zoom. */
      const press = async (key, code, keyCode) => {
        for (const type of ['rawKeyDown', 'keyUp']) {
          await page.send('Input.dispatchKeyEvent', {
            type,
            key,
            code,
            windowsVirtualKeyCode: keyCode,
          });
        }
      };
      const tap = async ({ x, y }) => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
        }
      };
      /* Columns of the top row painted in the accent color at full strength:
         the active handle's bar, and nothing else reaches the top row. */
      const handle = () =>
        run(`
          const c = __id('clipCanvas'); const g = c.getContext('2d');
          const probe = document.createElement('canvas').getContext('2d');
          probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
          probe.fillRect(0, 0, 1, 1);
          const [r, gr, b] = probe.getImageData(0, 0, 1, 1).data;
          const row = g.getImageData(0, 1, c.width, 1).data;
          const hits = [];
          for (let x = 0; x < c.width; x++) {
            const i = x * 4;
            if (Math.abs(row[i] - r) + Math.abs(row[i + 1] - gr) + Math.abs(row[i + 2] - b) < 12 && row[i + 3] > 250) hits.push(x);
          }
          const rect = c.getBoundingClientRect();
          const mid = hits.length ? hits.reduce((s, v) => s + v, 0) / hits.length : null;
          return { x: mid, screenX: mid === null ? null : rect.left + (mid / c.width) * rect.width,
                   y: rect.top + rect.height / 2 };`);
      const left = () => press('ArrowLeft', 'ArrowLeft', 37);

      await run(`
        window.__reset([['long.wav', window.__tone(220, 240)]]);
        state.clips[0].srcEnd = 200;
        state.selected = state.clips[0].id;
        setActiveEdge('end');
        refresh();
        document.activeElement.blur();
      `);
      const whole0 = await handle();
      await left();
      const whole1 = await handle();

      for (let i = 0; i < 3; i++) await press('=', 'Equal', 187); // 8x: thirty seconds across
      const zoomed0 = await handle();
      await left();
      const zoomed1 = await handle();
      const view = await run(`const v = clipView(state.clips[0]); return { span: v.to - v.from,
        zoomOutOn: !__id('btnZoomOut').disabled };`);

      // The end handle, found where it is painted, is the one a click grabs.
      await run(
        `setActiveEdge('start'); drawClipEditor(); setActiveEdge('end'); drawClipEditor();`,
      );
      const end = await handle();
      await run(`setActiveEdge('start'); drawClipEditor();`);
      await tap({ x: end.screenX, y: end.y });
      const grabbed = await run(`return getActiveEdge();`);

      // The marker moved far off screen brings the view with it.
      const followed = await run(`
        seekTo(10);
        const v = clipView(state.clips[0]);
        return v.from <= state.cursor && state.cursor <= v.to;`);

      for (let i = 0; i < 3; i++) await press('-', 'Minus', 189);
      const back = await run(`const v = clipView(state.clips[0]);
        return { from: v.from, to: v.to, zoomOutOff: __id('btnZoomOut').disabled };`);

      ok(whole0.x !== null && zoomed0.x !== null, 'the active handle was not found on the canvas');
      ok(
        Math.abs(whole1.x - whole0.x) < 1.5,
        `on the whole song a nudge should be sub-pixel here: ${whole1.x - whole0.x}`,
      );
      near(view.span, 30, 1e-6, 'three presses of + should show thirty seconds: ');
      ok(view.zoomOutOn, 'zoom out is not offered while zoomed in');
      ok(
        whole0.x - whole1.x < zoomed0.x - zoomed1.x && zoomed0.x - zoomed1.x >= 2,
        `zoomed in, a nudge moved the handle ${zoomed0.x - zoomed1.x} px`,
      );
      eq(grabbed, 'end', 'a click on the painted handle did not grab it: ');
      ok(followed, 'the view did not follow the marker');
      eq(back, { from: 0, to: 240, zoomOutOff: true }, 'zooming out again: ');
    });

    await check('removing a song with a key says so, and Undo brings it back whole', async () => {
      /* Backspace reaches this from a focused button, which is how it was found:
         a song gone with nothing on screen to say so. A real keypress, so the
         path is the one a person takes. */
      await run(`
        window.__reset([['a.wav', window.__tone(220, 30)], ['b.wav', window.__tone(330, 30)]]);
        state.clips[1].srcStart = 3; state.clips[1].srcEnd = 21; state.clips[1].fadeOut = 2;
        state.selected = state.clips[1].id;
        refresh();
        __id('btnMoveLeft').focus();
      `);
      for (const type of ['rawKeyDown', 'keyUp']) {
        await page.send('Input.dispatchKeyEvent', {
          type,
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        });
      }
      const out = await run(`
        const after = { count: state.clips.length, said: __id('toast').textContent,
                        shown: !__id('toast').classList.contains('hidden') };
        __id('btnUndo').click();
        const c = state.clips.find((x) => x.file === 'b.wav');
        return { after, back: c && { start: c.srcStart, end: c.srcEnd, fadeOut: c.fadeOut } };
      `);
      eq(out.after.count, 1, 'the song was not removed: ');
      ok(out.after.shown, 'nothing was shown when the song was removed');
      ok(
        out.after.said.includes('“b”') && out.after.said.includes('Undo'),
        `the message should name the song and the way back: ${out.after.said}`,
      );
      eq(out.back, { start: 3, end: 21, fadeOut: 2 }, 'Undo did not bring the song back whole: ');
    });

    await check('moving an end shows a close-up of it, and only while it moves', async () => {
      /* A real drag on the end handle and a real arrow press. The close-up has
         to be on screen and has to change as the end moves — a panel that
         appears but keeps a stale picture would be no use for placing a cut. */
      const mouse = async (type, x, y) =>
        page.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: 1,
        });
      const shown = () =>
        run(`const c = __id('clipCloseup');
          if (c.classList.contains('hidden')) return null;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let s = 0; for (let i = 0; i < d.length; i++) s = (s * 31 + d[i]) >>> 0;
          return s;`);
      const at = await run(`
        window.__reset([['long.wav', window.__clicks(97, 240)]]);
        state.clips[0].srcEnd = 200;
        state.selected = state.clips[0].id;
        refresh();
        document.activeElement.blur();
        const r = __id('clipCanvas').getBoundingClientRect();
        return { x: r.left + (200 / 240) * r.width, y: r.top + r.height / 2, px: r.width / 240 };`);

      const before = await shown();
      await mouse('mousePressed', at.x, at.y);
      const pressed = await shown();
      await mouse('mouseMoved', at.x - at.px * 3, at.y); // about three seconds earlier
      const dragged = await shown();
      await mouse('mouseReleased', at.x - at.px * 3, at.y);
      const released = await shown();

      for (const type of ['rawKeyDown', 'keyUp']) {
        await page.send('Input.dispatchKeyEvent', {
          type,
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          windowsVirtualKeyCode: 37,
        });
      }
      const nudged = await shown();
      const goneLater = await run(`
        const t0 = performance.now();
        while (!__id('clipCloseup').classList.contains('hidden') && performance.now() - t0 < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
        return __id('clipCloseup').classList.contains('hidden');`);

      // Zoomed in about as far already, it would only repeat the waveform.
      const zoomedIn = await run(`
        zoomClip(64); showCloseup('end');
        const hidden = __id('clipCloseup').classList.contains('hidden');
        hideCloseup(); zoomClip(1 / 64);
        return hidden;`);

      eq(before, null, 'the close-up is up before anything moved: ');
      ok(pressed !== null, 'grabbing the end handle did not show the close-up');
      ok(dragged !== null && dragged !== pressed, 'the close-up did not change as the end moved');
      eq(released, null, 'the close-up stayed after letting go: ');
      ok(nudged !== null, 'an arrow press did not show the close-up');
      ok(goneLater, 'the close-up never went away after a nudge');
      ok(zoomedIn, 'the close-up showed over a waveform already zoomed that far');
    });

    await check('a silence before a song delays it, and the blend gives way', async () => {
      /* Through the slider, and onto the sources that are actually started:
         a gap that only moved the timeline would show a silence and play none. */
      const result = await run(`
        window.__reset([['a.wav', window.__tone(220, 10)], ['b.wav', window.__tone(330, 10)]]);
        state.clips[1].crossfade = 1.5;
        state.selected = state.clips[1].id;
        refresh();
        const slider = __id('gap');
        slider.value = '3';
        slider.dispatchEvent(new Event('input'));
        slider.dispatchEvent(new Event('change'));

        const starts = [];
        const realStart = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (when) {
          starts.push(+when.toFixed(3));
          return realStart.apply(this, arguments);
        };
        try {
          const offline = new OfflineAudioContext(2, 44100, 44100);
          scheduleProgram(offline, offline.destination, 0, 0);
        } finally {
          AudioBufferSourceNode.prototype.start = realStart;
        }
        const marker = document.querySelector('#timeline .tl-xf');
        const out = {
          gap: state.clips[1].gap,
          blendKept: state.clips[1].crossfade,
          blendDisabled: __id('crossfade').disabled,
          label: __id('valGap').textContent,
          marker: marker && marker.textContent,
          starts,
          total: layout(state.clips).total,
        };
        undo();
        out.undone = gapOf(state.clips, 1);
        return out;
      `);
      eq(result.gap, 3, 'the slider did not set the silence: ');
      eq(result.label, '3.0s');
      eq(result.blendKept, 1.5, 'the blend should be kept for when the silence goes: ');
      ok(result.blendDisabled, 'the blend slider still offers a blend that would not happen');
      eq(result.marker, '… 3.0s', 'the strip does not show the silence: ');
      eq(result.starts, [0, 13], 'the second song must start after the first and the silence: ');
      eq(result.total, 23);
      eq(result.undone, 0, 'undo did not take the silence back out: ');
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
      /* Starts with a program: an empty one takes dropped songs wherever they
         land (the next check), so only a program that exists can tell a drop on
         the strip from a drop on the list. */
      const result = await run(`
        window.__reset([['a.mp3', window.__tone(330, 12)]]);
        window.__addToLibrary('dropped.mp3', window.__tone(220, 12));
        const realAddFiles = window.addFiles;
        window.addFiles = async () => [library.get('dropped.mp3')];
        const dropOn = async (target) => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(64)], 'dropped.mp3', { type: 'audio/mpeg' }));
          target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 0));
          return state.clips.map(c => c.file);
        };
        try {
          const onTimeline = await dropOn(document.querySelector('#timelineWrap'));
          state.clips = state.clips.slice(0, 1); refresh();
          const onLibrary = await dropOn(__id('libraryList'));
          return { onTimeline, onLibrary };
        } finally {
          window.addFiles = realAddFiles;
        }
      `);
      eq(result.onTimeline, ['a.mp3', 'dropped.mp3'], 'dropping on the timeline should add it: ');
      eq(result.onLibrary, ['a.mp3'], 'dropping on the list should not: ');
    });

    await check('songs brought to an empty program become it, in order, as one edit', async () => {
      /* #106. However they arrive — the picker's input, or a drop anywhere — the
         songs given to an empty program are its running order. Once there is a
         program, the same pick only adds to the list. */
      const result = await run(`
        window.__reset([]);
        window.__addToLibrary('one.mp3', window.__tone(220, 12));
        window.__addToLibrary('two.mp3', window.__tone(330, 12));
        window.__addToLibrary('three.mp3', window.__tone(440, 12));
        undoStack.length = 0; redoStack.length = 0;
        const realAddFiles = window.addFiles;
        window.addFiles = async (list) => [...list].map((f) => library.get(f.name));
        const files = (...names) =>
          names.map((n) => new File([new Uint8Array(64)], n, { type: 'audio/mpeg' }));
        try {
          await addSongs(files('one.mp3', 'two.mp3'));
          const picked = { clips: state.clips.map(c => c.file), undos: undoStack.length,
                           selected: state.clips.findIndex(c => c.id === state.selected) };
          await addSongs(files('three.mp3'));
          const later = state.clips.map(c => c.file);

          undo();
          const afterUndo = state.clips.length;
          return { picked, later, afterUndo };
        } finally {
          window.addFiles = realAddFiles;
        }
      `);
      eq(result.picked.clips, ['one.mp3', 'two.mp3'], 'an empty program did not take the songs: ');
      eq(result.picked.undos, 1, 'adding them was not one edit: ');
      eq(result.picked.selected, 0, 'the first song is not the one selected: ');
      eq(result.later, ['one.mp3', 'two.mp3'], 'a song added mid-edit changed the program: ');
      eq(result.afterUndo, 0, 'one Undo did not take the whole first pick back: ');
    });

    await check(
      'an empty program shows the first step and not the controls for a program',
      async () => {
        /* #109. Grayed-out buttons beside the empty card were six things to read
         before the one that could be pressed. */
        const result = await run(`
        const shown = () => ({
          undo: !document.querySelector('.undo-buttons').classList.contains('hidden'),
          evenOut: !__id('btnEvenOut').classList.contains('hidden'),
          transport: !document.querySelector('.transport').classList.contains('hidden'),
          notes: !__id('notesBox').classList.contains('hidden'),
          dropzone: !__id('dropzone').classList.contains('hidden'),
        });
        window.__reset([]);
        undoStack.length = 0; redoStack.length = 0; state.notes = ''; refresh();
        const empty = shown();
        window.__reset([['a.mp3', window.__tone(220, 12)]]);
        const program = shown();
        // Removing the last song leaves Undo, which is the way back to it.
        removeClip(state.clips[0].id);
        const emptied = shown();
        return { empty, program, emptied };
      `);
        eq(
          result.empty,
          { undo: false, evenOut: false, transport: false, notes: false, dropzone: false },
          'with nothing yet: ',
        );
        eq(
          result.program,
          { undo: true, evenOut: true, transport: true, notes: true, dropzone: true },
          'with a program: ',
        );
        eq(result.emptied.undo, true, 'the last song removed and no Undo to bring it back: ');
        eq(result.emptied.transport, false, 'nothing to play, and Play is still there: ');
      },
    );

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
      /* `limits` are the same numbers the assertions below use, read from here
         rather than written out again in the summary: a budget the comment
         reports and a budget CI enforces must not be able to disagree. Named
         for the gesture, because this app has three things a person would call
         dragging — this slider, a trim handle on the clip editor, and a block
         being reordered — and only this one is measured. */
      metrics.crossfadeDrag = {
        label: 'Crossfade slider',
        detail: `60 input events, ${result.clips} clips`,
        elementsCreated: result.created,
        forcedStyleReads: result.styleReads,
        timelineWaveDraws: result.timelineWaves,
        blockingMs: result.blockingMs,
        limits: {
          elementsCreated: 0,
          forcedStyleReads: 0,
          timelineWaveDraws: result.clips * 4,
        },
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
      metrics.idleRefresh = {
        label: 'Idle refreshes',
        detail: '30 calls, nothing changed',
        elementsCreated: result.created,
        forcedStyleReads: result.styleReads,
        blockingMs: result.blockingMs,
        limits: { elementsCreated: 0, forcedStyleReads: 0 },
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

    await check('the help menu opens, closes, and shuts behind a topic', async () => {
      const out = await run(`
        /* Shared page: start shut whatever anything above left behind. */
        setHelpMenuOpen(false);
        const button = document.getElementById('btnHelp');
        const menu = document.getElementById('helpMenu');
        const shut = () => menu.classList.contains('hidden');
        const start = shut();
        button.click();
        const opened = { shut: shut(), expanded: button.getAttribute('aria-expanded') };
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const afterOutside = shut();
        button.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const afterEscape = shut();

        // A topic opens its help, shuts the menu, and Close lands back on Help.
        button.click();
        menu.querySelector('.help-btn[data-help="tips"]').click();
        const topic = {
          menuShut: shut(),
          title: document.getElementById('helpTitle').textContent,
        };
        closeTopDialog();
        topic.focus = document.activeElement && document.activeElement.id;
        setHelpMenuOpen(false);
        return { start, opened, afterOutside, afterEscape, topic };
      `);
      eq(out.start, true, 'the menu should begin shut: ');
      eq(out.opened.shut, false, 'clicking Help did not open it: ');
      eq(out.opened.expanded, 'true', 'aria-expanded: ');
      eq(out.afterOutside, true, 'a click outside did not shut it: ');
      eq(out.afterEscape, true, 'Escape did not shut it: ');
      eq(out.topic.menuShut, true, 'choosing a topic left the menu open: ');
      ok(out.topic.title.length > 0, 'choosing a topic opened no help');
      eq(out.topic.focus, 'btnHelp', 'closing the help lost the keyboard: ');
    });

    await check('clearing this browser asks first, and Keep it changes nothing', async () => {
      const out = await run(`
        state.clips = [{ id: 'x', title: 'a song', file: 'a song.mp3',
          srcStart: 0, srcEnd: 10, fadeIn: 0, fadeOut: 0, crossfade: 0, gain: 1 }];
        save();
        document.getElementById('btnNew').click();
        document.getElementById('btnForget').click();
        const asked = {
          open: !document.getElementById('forgetDialog').classList.contains('hidden'),
          newShut: document.getElementById('startDialog').classList.contains('hidden'),
          focus: document.activeElement && document.activeElement.id,
          note: document.getElementById('forgetNote').textContent,
        };
        document.getElementById('btnForgetCancel').click();
        const kept = { shut: document.getElementById('forgetDialog').classList.contains('hidden'),
                       clips: state.clips.length,
                       stored: !!localStorage.getItem('skate.program.v1'),
                       focus: document.activeElement && document.activeElement.id };
        return { asked, kept };
      `);
      eq(out.asked.open, true, 'the button cleared without asking: ');
      eq(out.asked.newShut, true, 'the question opened on top of New: ');
      eq(out.kept.focus, 'btnNew', 'Keep it lost the keyboard: ');
      eq(out.asked.focus, 'btnForgetCancel', 'the safe answer is not under the keyboard: ');
      ok(
        out.asked.note.includes('program'),
        `the question does not name the program: ${out.asked.note}`,
      );
      eq(out.kept.shut, true, 'Keep it left the question open: ');
      eq(out.kept.clips, 1, 'Keep it cleared the program: ');
      eq(out.kept.stored, true, 'Keep it cleared what was stored: ');
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
                         disabled: document.getElementById('btnForgetGo').disabled };
        await forgetEverything();
        const after = { stored: !!localStorage.getItem('skate.program.v1'),
                        clips: state.clips.length,
                        note: document.getElementById('forgetNote').textContent,
                        disabled: document.getElementById('btnForgetGo').disabled };
        return { before, after };
      `);
      eq(out.before.stored, true, 'nothing was stored to begin with: ');
      eq(out.before.disabled, false, 'the button was dead while there was work to forget: ');
      eq(out.after.stored, false, 'the program was written back after being cleared: ');
      eq(out.after.clips, 0, 'the program is still on screen: ');
      eq(out.after.disabled, true, 'the button is still live with nothing left to forget: ');
      ok(out.after.note !== out.before.note, 'the menu still claims the same thing is stored');
    });

    await check('the README screenshot shows the interface as it is now', async () => {
      /* Its own browser, because the picture is staged from a clean page at a
         fixed viewport, and this one has been through every check above. */
      const shot = await open();
      let now;
      try {
        now = (await stage(shot)).fingerprint;
      } finally {
        await shot.close();
      }
      const then = readStamp(fs.readFileSync(SHOT));
      ok(
        then === now,
        'the interface has changed since docs/screenshot.png was taken — ' +
          'run `npm run screenshot` and commit the new picture',
      );
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
