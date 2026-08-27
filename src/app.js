/* Skate Program Editor — everything runs in this tab.
 *
 * Audio files are read with the File API and decoded in memory. Nothing is
 * uploaded, and there is no server: opening index.html from disk is enough.
 *
 * The edit is saved as a project file: a small readable JSON document holding
 * the clip list and their trims and fades. That file is the artifact worth
 * committing to git — a few KB that diffs meaningfully, rather than a rendered
 * mixdown that goes stale.
 *
 * This file holds the state the rest of them read: the program itself, the
 * library, the undo stacks, the theme, saving and loading, and the wiring that
 * connects the page to all of it. The other src/*.js files are loaded before
 * it and share its scope.
 */
'use strict';

const STORE_KEY = 'skate.program.v1';

const state = {
  name: 'my program',
  level: 'usfs-juv', // id from LEVELS, or CUSTOM_LEVEL
  targetSeconds: 135,
  toleranceSeconds: 10,
  clips: [], // {id, file, title, srcStart, srcEnd, fadeIn, fadeOut, crossfade}
  selected: null, // clip id
  cursor: 0, // source-time position inside the selected clip's file
  playPosition: 0, // program-time position of the playhead, kept across stops
  // name -> {bytes, seconds, fingerprint} from the project file, so a song that
  // arrives can be checked against the one the edit was built from. Empty for a
  // program built in this sitting, where the question does not arise.
  expectedFiles: new Map(),
  /* Top-level keys from the project file this app does not understand — from a
     desktop shell, or a later version of the format. Held so `project` can put
     them back, because a save here must never erase what another tool wrote. */
  carried: {},
  // How the finished file was last made, when the project records it.
  exportSettings: null,
  /* Free text nothing here reads or writes yet, and the folder a desktop app
     keeps the audio in. Both are held so a project that carries them keeps
     carrying them. */
  notes: '',
  mediaDir: '',
};

const library = new Map(); // file name -> {name, buffer, peaks, duration, state}
const undoStack = [];
const redoStack = [];

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);

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
  try {
    value = localStorage.getItem(THEME_KEY);
  } catch (_) {
    /* private mode */
  }
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

  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-checked', String(button.dataset.themeChoice === mode));
  }
  $('themeNote').textContent =
    mode === 'auto'
      ? 'Auto follows whatever this computer is set to.'
      : `Always ${THEME_WORDS[mode].toLowerCase()}, whatever this computer is set to.`;
}

/** Take a choice from the menu, remember it, and repaint what the CSS cannot. */
function chooseTheme(mode) {
  if (!THEME_MODES.includes(mode)) return;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch (_) {
    /* private mode */
  }
  applyTheme(mode);
  /* The canvases hold colors that were resolved when they were drawn, so the
     stylesheet changing underneath them is not enough on its own. */
  repaintForTheme();
}

/* ------------------------------------------------------- settings menu */

/** Open or shut the settings menu, and say which for anything listening. */
function setSettingsOpen(open) {
  $('settingsMenu').classList.toggle('hidden', !open);
  $('btnSettings').setAttribute('aria-expanded', String(open));
  if (open) describeStored();
}

function settingsOpen() {
  return !$('settingsMenu').classList.contains('hidden');
}

/**
 * Say what this browser is holding, in the plainest terms available.
 *
 * Worth stating rather than implying: the editor keeps the program between
 * visits, and on Chrome and Edge it also keeps a way back to the song files.
 * Neither is obvious, and on a rink's shared laptop both are worth being able
 * to get rid of.
 */
function describeStored() {
  const parts = [];
  /* An empty shell is written back on the first refresh after anything is
     cleared, so "is there a key" is not the question — "is there any work in
     it" is. Reporting a program that has nothing in it would make the button
     look broken right after it had worked. */
  let clips = 0;
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) clips = (JSON.parse(stored).clips || []).length;
  } catch (_) {
    /* private mode, or something we did not write */
  }
  if (clips) parts.push('the program you are working on');
  if (rememberedNames.size) {
    parts.push(
      rememberedNames.size === 1
        ? 'a way back to 1 song file'
        : `a way back to ${rememberedNames.size} song files`,
    );
  }
  $('forgetNote').textContent = parts.length
    ? `This browser is keeping ${parts.join(' and ')}. Your music itself is never uploaded.`
    : 'This browser is not keeping anything from the editor right now.';
  $('btnForget').disabled = !parts.length;
}

/**
 * Drop everything the editor has put in this browser.
 *
 * The program on screen goes too, and it has to: `save()` writes on the next
 * edit, so clearing storage while a program is still loaded would simply put
 * it back a moment later. Colors and the sidebar are left alone — they are
 * preferences, not anything anyone needs cleared off a shared machine.
 */
async function forgetEverything() {
  resetProgram();
  library.clear();
  rememberedNames.clear();
  if (typeof indexedDB !== 'undefined') {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        const request = indexedDB.deleteDatabase(HANDLE_DB);
        request.onsuccess = finish;
        request.onerror = finish;
        /* A delete blocks while another tab holds the database open, and it
           never resolves until that tab lets go. Nothing here should wait on
           another tab, so it moves on. */
        request.onblocked = finish;
      } catch (_) {
        finish();
      }
    });
  }
  refresh();
  /* After the refresh, not before: refresh() runs save(), which would put an
     empty program straight back into the storage this just emptied. */
  try {
    localStorage.removeItem(STORE_KEY);
  } catch (_) {
    /* private mode */
  }
  describeStored();
  toast('Forgotten. Nothing from the editor is left in this browser.');
}

/* ------------------------------------------------------- the music sidebar */

/* Collapsing it is a view preference rather than part of the program, so it
   lives beside the theme in storage and never touches the project file. */
const LIBRARY_KEY = 'skate.musicPanel';

/** Show or hide the music sidebar, and remember which. */
function setLibraryCollapsed(collapsed) {
  document.querySelector('main').classList.toggle('library-collapsed', collapsed);
  const button = $('btnLibraryToggle');
  button.setAttribute('aria-expanded', String(!collapsed));
  button.title = collapsed ? 'Show the music list' : 'Hide the music list';
  button.setAttribute('aria-label', button.title);
  try {
    localStorage.setItem(LIBRARY_KEY, collapsed ? 'collapsed' : 'open');
  } catch (_) {
    /* private mode */
  }
  /* Every canvas is sized from its box, and the box just changed by 300px.
     Nothing fires a resize event for a class change, so they are redrawn by
     hand — without this the waveforms stay at the old width until the window
     itself is resized. */
  renderTimeline();
  drawScrubber();
  drawClipEditor();
}

/* ----------------------------------------------------------------- clips */

/* A held key repeats about thirty times a second. One snapshot per repeat fills
   a sixty-deep stack in two seconds and pushes every earlier edit off the end —
   which is the one thing an undo stack exists to prevent.

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
 * Not just the clips. The name and the event are in here too: left outside the
 * stack, picking the wrong level loses the length you were working to with no
 * way back — the one number the whole edit is aimed at. These are the same
 * fields the project file records, for the same reason.
 */
function undoSnapshot() {
  return JSON.stringify({
    name: state.name,
    notes: state.notes,
    level: state.level,
    targetSeconds: state.targetSeconds,
    toleranceSeconds: state.toleranceSeconds,
    clips: state.clips,
  });
}

function pushUndo(tag = null) {
  const now = Date.now();
  if (tag !== null && tag === undoRun.tag && now - undoRun.at < UNDO_COALESCE_MS) {
    undoRun.at = now; // the gesture continues; its opening snapshot stands
    return;
  }
  undoRun = { tag, at: now };
  undoStack.push(undoSnapshot());
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  saveHistory();
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
  saveHistory();
  return previous;
}

/** The same, forwards. */
function takeRedo() {
  if (!redoStack.length) return null;
  const next = redoStack.pop();
  undoStack.push(undoSnapshot());
  saveHistory();
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
  state.notes = saved.notes || '';
  state.level = saved.level;
  state.targetSeconds = saved.targetSeconds;
  state.toleranceSeconds = saved.toleranceSeconds;
  state.clips = saved.clips;
  if (!state.clips.some((c) => c.id === state.selected)) {
    state.selected = state.clips.length ? state.clips[state.clips.length - 1].id : null;
  }
  $('programName').value = state.name;
  syncNotes();
  syncLevelPicker();
  refresh();
}

function undo() {
  const previous = takeUndo();
  if (previous === null) {
    toast('Nothing to undo');
    return;
  }
  applySnapshot(previous);
}

function redo() {
  const next = takeRedo();
  if (next === null) {
    toast('Nothing to redo');
    return;
  }
  applySnapshot(next);
}

function addClip(entry) {
  pushUndo();
  const clip = {
    id: uid(),
    file: entry.name,
    title: songTitle({ title: entry.tags && entry.tags.title }, entry.name),
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
  if (state.clips.length) state.clips[0].crossfade = 0; // nothing to blend into
  refresh();
}

function moveClip(fromIndex, toIndex) {
  const next = reordered(state.clips, fromIndex, toIndex);
  if (!next) return;
  pushUndo();
  state.clips = next;
  if (state.clips.length) state.clips[0].crossfade = 0; // nothing to blend into
  refresh();
}

/**
 * Run a piece of analysis that takes long enough to look like a hang.
 *
 * Measuring a four-minute program is around half a second, and lining up a
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
    const go = () => {
      if (!settled) {
        settled = true;
        done();
      }
    };
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

/* ------------------------------------------------------------ persistence */

/**
 * What to record about each song the program uses.
 *
 * Starts from what the project file already said about it — a source a desktop
 * shell recorded, and anything else this app has never heard of — and writes the
 * measured fields over the top. Rebuilding the record from scratch instead is
 * how a field another tool wrote gets erased by the next save here.
 *
 * A song with nothing but a name is dropped, because there is nothing useful to
 * say about it. A song with only a source is kept: not yet decoded is a normal
 * state, and it is exactly the record that lets the file be found again.
 */
function usedSongs() {
  const names = [...new Set(state.clips.map((c) => c.file))];
  return names
    .map((name) => {
      const stored = state.expectedFiles.get(name) || {};
      const entry = library.get(name);
      const measured = entry && entry.fingerprint ? entry : stored;
      return {
        ...stored,
        name,
        /* What the project already said wins over what the file says: a title
           set by hand or by a desktop shell is a decision, and a tag is a
           guess the file came with. */
        title: songTitle(
          { title: stored.title || (entry && entry.tags && entry.tags.title) },
          name,
        ),
        bytes: measured.bytes || null,
        seconds: measured.duration
          ? Number(measured.duration.toFixed(2))
          : measured.seconds || null,
        fingerprint: measured.fingerprint || null,
      };
    })
    .filter((song) => Object.keys(song).some((key) => key !== 'name' && song[key] != null));
}

/**
 * The program as a document, in the words the interface uses.
 *
 * Song, start, end, blend, decibels — not the names the drawing and audio code
 * carries internally. The file is read and edited by hand, so the plain-language
 * rule that applies to everything on screen applies to it too.
 */
function project() {
  const level = findLevel(state.level);
  return {
    // First, so it is the first thing an editor sees and the first thing a
    // person opening the file reads.
    $schema: SCHEMA_URL,
    format: FORMAT,
    version: FORMAT_VERSION,
    name: state.name,
    event: {
      level: state.level,
      // Denormalized on purpose: if the rulebook table changes, an old project
      // still knows the length it was actually built to.
      label: level ? level.label : 'Custom',
      targetSeconds: state.targetSeconds,
      toleranceSeconds: state.toleranceSeconds,
    },
    /* What each song was, so opening this later can tell whether it has been
       handed the right one. Not where it was: a browser will not say where a
       file lives, and a handle to one cannot be written to a file. A desktop
       shell can, and records it here as a source. */
    songs: usedSongs(),
    clips: state.clips.map((c) => ({
      id: c.id,
      song: c.file,
      /* Only when the clip is called something other than its song. Three clips
         cut from one song repeating its name three times says nothing, and
         renaming the song would then mean editing every one of them. */
      ...(c.title && c.title !== songTitle(state.expectedFiles.get(c.file), c.file)
        ? { title: c.title }
        : {}),
      start: Number(c.srcStart.toFixed(3)),
      end: Number(c.srcEnd.toFixed(3)),
      fadeIn: Number((c.fadeIn || 0).toFixed(2)),
      fadeOut: Number((c.fadeOut || 0).toFixed(2)),
      blend: Number((c.crossfade || 0).toFixed(2)),
      /* Clamped to the slider's own range on the way out as well, so the file
         never carries a level the interface cannot show or the reader would
         clamp on the way back in. */
      gainDb: Number(clamp(gainToDb(clipGain(c)), LEVEL_SLIDER.min, LEVEL_SLIDER.max).toFixed(2)),
    })),
    ...(state.exportSettings ? { export: state.exportSettings } : {}),
    ...(state.notes ? { notes: state.notes } : {}),
    ...(state.mediaDir ? { mediaDir: state.mediaDir } : {}),
    /* Last, so a key this app has never heard of is put back where it was found
       rather than overwriting one it does understand. */
    ...state.carried,
  };
}

/* How long to wait before writing the project to a folder a shell owns.
   `save()` runs on every edit, and typing a program name is an edit a letter —
   which localStorage will absorb and a file on disk will not. */
const HOST_SAVE_DELAY = 400;
let hostSaveTimer = null;
let hostSaveFailed = false;

/**
 * Write the project out now, if a shell is holding one waiting, and say how it
 * went.
 *
 * Called when the page is being hidden or closed, because the wait above is the
 * one window in which an edit exists nowhere but in memory — and by a shell
 * about to close the project, which needs to know whether everything reached
 * the folder before it lets the window go.
 *
 * `saved` is the honest answer to "is the folder up to date". It is false only
 * when a write was actually refused, which is the one case where closing loses
 * work and the one case worth interrupting somebody about.
 */
async function flushHostSave() {
  const folder = hostProject();
  if (!folder) return { saved: true, hosted: false };
  if (hostSaveTimer !== null) {
    clearTimeout(hostSaveTimer);
    hostSaveTimer = null;
    try {
      await folder.write(project());
    } catch (err) {
      reportHostSaveFailure(err);
      return { saved: false, hosted: true };
    }
  }
  /* The history rides along. It is written on a slower rhythm than the
     program, so a close is the moment it is most likely to be behind. */
  if (historyTimer !== null) {
    clearTimeout(historyTimer);
    historyTimer = null;
    if (typeof folder.writeHistory === 'function') {
      try {
        await folder.writeHistory(historyNow());
      } catch (_) {
        /* Losing the history is not losing the work. */
      }
    }
  }

  /* A write that failed earlier is still a folder out of date, even if there is
     nothing pending now. */
  return { saved: !hostSaveFailed, hosted: true };
}

/* How long to wait before writing the undo history out. Slower than the
   program itself on purpose: the program is small and is the thing that must
   not be lost, while the history is sixty snapshots of it and only has to
   survive the app closing. Writing both on every keystroke would be writing a
   hundred kilobytes to say that one clip moved. */
const HISTORY_DELAY = 2500;
let historyTimer = null;

/**
 * The undo history as it goes to disk.
 *
 * `current` is the snapshot the two stacks are relative to. Without it a
 * history could be applied to a program it never described — the file edited
 * by hand between sessions, or opened by a copy of the app that saved
 * something else — and undoing would put back a state that never preceded this
 * one. That is not an undo, it is a substitution.
 */
function historyNow() {
  return { current: undoSnapshot(), undo: [...undoStack], redo: [...redoStack] };
}

/** Hand the history to the shell, if it is holding one. */
function saveHistory() {
  const folder = hostProject();
  if (!folder || typeof folder.writeHistory !== 'function') return;
  if (historyTimer !== null) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = null;
    Promise.resolve(folder.writeHistory(historyNow())).catch(() => {
      /* A history that cannot be written is a session you cannot step back
         through after a restart. Everything else still works, and saying so
         once an edit is not worth the interruption. */
    });
  }, HISTORY_DELAY);
}

/**
 * Put back the undo history a folder was left with.
 *
 * Refused unless it describes the program that was just loaded. A history whose
 * `current` does not match is a history of some other version of this file, and
 * applying it would let somebody undo into a program that never existed.
 */
function restoreHistory(saved) {
  undoStack.length = 0;
  redoStack.length = 0;
  if (!saved || typeof saved !== 'object') return false;
  if (saved.current !== undoSnapshot()) return false;
  const clean = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);
  undoStack.push(...clean(saved.undo).slice(-UNDO_DEPTH));
  redoStack.push(...clean(saved.redo).slice(-UNDO_DEPTH));
  return true;
}

/* Said once, not once per keystroke: a folder that cannot be written to will
   fail on every edit, and a toast a second is not information. */
function reportHostSaveFailure() {
  if (hostSaveFailed) return;
  hostSaveFailed = true;
  toast('Could not save to the project folder — your editing is still here', 6000);
}

function save() {
  const folder = hostProject();
  if (folder) {
    /* The folder is the project. Nothing goes to localStorage: two copies of
       one program, one of them invisible, is how they come to disagree. */
    if (hostSaveTimer !== null) clearTimeout(hostSaveTimer);
    hostSaveTimer = setTimeout(() => {
      hostSaveTimer = null;
      Promise.resolve(folder.write(project())).catch(reportHostSaveFailure);
    }, HOST_SAVE_DELAY);
    return;
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(project()));
  } catch (_) {
    /* private mode, or quota — Save project still works */
  }
}

function loadProject(data) {
  const read = readProject(data);
  /* A version this app does not understand is the one thing not guessed at.
     Reading it anyway would produce a program that looks plausible and is
     wrong, which is worse than not opening it. */
  if (read.unsupported) {
    toast(
      `This project was saved by a newer version of the editor. ` +
        `Update the app, or open it where it was made.`,
      6000,
    );
    return false;
  }
  /* Whatever gesture was in progress is over: a different program is being
     opened. Without this, typing before a load and typing after it fold into
     one undo step that spans two programs, and undoing lands somewhere that
     was never on screen. */
  endUndoRun();
  state.name = read.name;
  state.level = read.level;
  state.targetSeconds = read.targetSeconds;
  state.toleranceSeconds = read.toleranceSeconds;
  state.clips = read.clips;
  state.expectedFiles = new Map(read.songs.map((s) => [s.name, s]));
  state.carried = read.carried;
  state.exportSettings = read.exportSettings;
  state.notes = read.notes;
  state.mediaDir = read.mediaDir;
  state.selected = state.clips.length ? state.clips[0].id : null;
  if (read.retargeted) {
    toast(
      `This program targets ${fmtShort(state.targetSeconds)}, ` +
        `which no longer matches ${read.retargeted.label}`,
      6000,
    );
  }
  $('programName').value = state.name;
  syncNotes();
  syncLevelPicker();
  refresh();

  // The persistent notice above the timeline does the telling now.
  return true;
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
  const name =
    (state.name || 'my program')
      .replace(/[\\/:*?"<>|]+/g, ' ') // rejected by Windows or POSIX
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/[\u0000-\u001f]+/g, ' ') // control characters
      .replace(/\s+/g, ' ')
      .slice(0, 90)
      .replace(/^[.\s]+|[.\s]+$/g, '') || // Windows rejects these at either end
    'my program';
  const t = Math.max(0, Math.round(state.targetSeconds));
  const length = `${Math.floor(t / 60)}-${String(t % 60).padStart(2, '0')}`;
  return `${name} (${length}).${extension}`;
}

/** Files in the program that are not loaded, by name. */
function missingFiles() {
  return [...new Set(state.clips.filter((c) => !library.get(c.file)?.buffer).map((c) => c.file))];
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
  /* Everything the last project said about its songs goes too. Kept, a new
     program with a song of the same name would inherit the old one's record of
     it — its fingerprint, and where a shell said it came from. */
  state.expectedFiles.clear();
  state.carried = {};
  state.exportSettings = null;
  state.notes = '';
  state.mediaDir = '';
  $('programNotes').value = '';
  $('notesBox').open = false;
  $('playhead').textContent = '0:00.0';
  try {
    localStorage.removeItem(STORE_KEY);
  } catch (_) {
    /* private mode */
  }
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
  syncNotes();
  syncLevelPicker();
  allowStartDismissal(); // the choice has been made
  $('startDialog').classList.add('hidden');
  refresh();
  toast(
    library.size
      ? 'Ready — add songs from the list on the left'
      : 'Ready — add your music on the left to begin',
  );
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
     one click for the whole program rather than finding each song again.
     Everywhere else this button never appears and the notice reads as it
     always did. */
  const back = reconnectableFiles();
  $('btnReconnect').classList.toggle('hidden', back.length === 0);
  if (back.length) {
    $('btnReconnect').textContent =
      back.length === missing.length ? 'Open the music again' : `Open ${back.length} of them again`;
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

/* ----------------------------------------------------------- level picker */

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
     how a brand new program gets its length — and starting one should not
     leave a step on a stack that resetProgram has just emptied. */
  select.onchange = () => {
    pushUndo();
    applyLevel(select.value);
  };
  $('customLength').onchange = () => {
    const seconds = parseClock($('customLength').value);
    if (seconds === null) {
      toast('Enter a time like 3:10');
      $('customLength').value = fmtShort(state.targetSeconds);
      return;
    }
    if (seconds === state.targetSeconds) return; // nothing to record
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

/* ----------------------------------------------------------------- wiring */

/**
 * Put the note on screen, and open the disclosure when there is one to read.
 *
 * Only ever opens. Closing here would shut the box under someone who had opened
 * it to write, since every keystroke saves and comes back through this.
 */
function syncNotes() {
  $('programNotes').value = state.notes;
  if (state.notes) $('notesBox').open = true;
}

function syncLevelPicker() {
  const select = $('targetLength');
  const custom = $('customLength');
  const isCustom = state.level === CUSTOM_LEVEL || !findLevel(state.level);
  select.value = isCustom ? CUSTOM_LEVEL : state.level;
  custom.classList.toggle('hidden', !isCustom);
  if (isCustom) custom.value = fmtShort(state.targetSeconds);
}

function bind() {
  buildLevelPicker();

  $('programName').value = state.name;
  syncNotes();
  // Tagged, so a name being typed is one undo step rather than one per letter.
  // The snapshot is taken before the assignment, so it holds the old name.
  $('programName').oninput = (e) => {
    pushUndo('program-name');
    state.name = e.target.value;
    save();
  };

  /* The wait before a folder is written is the one window where an edit is
     only in memory. `pagehide` is the event that still fires when a window is
     closed, which `beforeunload` cannot be relied on for. */
  if (hostPresent()) {
    window.addEventListener('pagehide', flushHostSave);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushHostSave();
    });
  }

  // The same shape as the name above, for the same reason.
  $('programNotes').oninput = (e) => {
    pushUndo('program-notes');
    state.notes = e.target.value;
    save();
  };

  $('btnAddFiles').onclick = pickFiles;
  $('btnAddMissing').onclick = pickFiles;
  /* The same two routes as the topbar, put where someone with an empty program
     is already looking. */
  $('btnEmptyAdd').onclick = pickFiles;
  $('btnEmptyLoad').onclick = () => $('projectInput').click();
  bindHostAdded();
  hideProjectControls();
  $('btnReconnect').onclick = reconnectMissing;

  $('btnNew').onclick = () => openStartDialog(true);
  $('fileInput').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  bindFileDrops();

  $('btnPlay').onclick = () => (playing ? stopPlayback() : playFromPlayhead());
  $('btnStop').onclick = () => {
    stopPlayback();
    seekTo(0);
  };
  $('btnPreviewClip').onclick = () => {
    const clip = selectedClip();
    if (clip) playClipAudition(clip, state.cursor > clip.srcStart ? state.cursor : clip.srcStart);
  };
  $('btnRemoveClip').onclick = () => {
    if (state.selected) removeClip(state.selected);
  };
  $('btnMoveLeft').onclick = () => moveSelected(-1);
  $('btnMoveRight').onclick = () => moveSelected(1);
  $('btnPlayJoin').onclick = previewJoin;
  $('btnAlignJoin').onclick = () => withBusy($('btnAlignJoin'), alignSelectedJoin);
  $('btnEvenOut').onclick = () => withBusy($('btnEvenOut'), evenOutLevels);

  {
    const slider = $('level');
    let editing = false;
    const begin = () => {
      if (!editing) {
        pushUndo();
        editing = true;
      }
    };
    slider.addEventListener('pointerdown', begin);
    slider.addEventListener('keydown', begin);
    slider.oninput = () => {
      const clip = selectedClip();
      if (!clip) return;
      begin();
      clip.gain = clamp(dbToGain(Number(slider.value)), 0, MAX_GAIN);
      drawClipEditor();
    };
    slider.onchange = () => {
      editing = false;
      save();
    };
  }

  for (const key of ['fadeIn', 'fadeOut', 'crossfade']) {
    const slider = $(key);
    let editing = false;
    // Snapshot before the gesture starts, not after — pushing undo on `change`
    // would capture the already-modified value and make undo a no-op.
    const begin = () => {
      if (!editing) {
        pushUndo();
        editing = true;
      }
    };
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
    slider.onchange = () => {
      editing = false;
      save();
    };
  }

  $('btnExport').onclick = () => {
    const { total } = layout(state.clips);
    if (total <= 0) {
      toast('Add some music to your program first');
      return;
    }
    $('exportSummary').textContent =
      `${fmt(total)} — target ${fmtShort(state.targetSeconds)} ±${state.toleranceSeconds}s`;
    // A fresh look at the program: whatever was too loud last time may have
    // been turned down since.
    forgetClippingChoice();
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
        name.textContent =
          entry.name + (entry.quality.notes.length ? ` (${entry.quality.notes.join(', ')})` : '');
        row.appendChild(name);
        box.appendChild(row);
      }
      const tail = document.createElement('p');
      tail.className = 'hint';
      tail.textContent =
        'Saving at higher quality will not fix this — you need ' +
        'a better copy of the song itself. You can carry on anyway.';
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
    download(
      new Blob([JSON.stringify(project(), null, 2) + '\n'], { type: 'application/json' }),
      exportFileName('json'),
    );
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
  window.addEventListener('resize', () => {
    renderTimeline();
    drawScrubber();
    drawClipEditor();
  });
  $('btnSettings').onclick = () => setSettingsOpen(!settingsOpen());
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.onclick = () => chooseTheme(button.dataset.themeChoice);
  }
  $('btnForget').onclick = forgetEverything;
  /* Anywhere outside shuts it. The menu is not modal — it sits over a page you
     can still use — so a click meant for the editor should land there and close
     the menu, not be swallowed by a backdrop. */
  document.addEventListener('pointerdown', (e) => {
    if (!settingsOpen()) return;
    /* Not every event target is an Element — a pointerdown can arrive on the
       document itself, which has no closest(). */
    const inside = e.target instanceof Element && e.target.closest('.menu-wrap');
    if (!inside) setSettingsOpen(false);
  });
  $('btnLibraryToggle').onclick = () =>
    setLibraryCollapsed(!document.querySelector('main').classList.contains('library-collapsed'));
  /* The colors are cached, so a change of system theme has to say so. Only
     reaches anything while the mode is 'auto' — with an explicit choice the CSS
     ignores the system, and the repaint is harmless. */
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaintForTheme);
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  // The menu is the shallowest thing on screen, so it goes first.
  if (e.key === 'Escape' && settingsOpen()) {
    setSettingsOpen(false);
    $('btnSettings').focus();
    return;
  }

  // Escape closes whichever dialog is open, wherever focus happens to be.
  if (e.key === 'Escape' && closeTopDialog()) return;

  // A dialog is open — it owns the keyboard, and Tab stays inside it. Every
  // dialog, the export one included: leave one out and Space, Delete and the
  // trim keys all still reach the program behind it.
  const dialog = openDialog();
  if (dialog) {
    trapFocus(e, dialog.querySelector('.modal-card') || dialog);
    return;
  }

  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const clip = selectedClip();
  const nudge = e.shiftKey ? 1 : 0.1;

  if (e.code === 'Space') {
    e.preventDefault();
    if (playing) stopPlayback();
    else playFromPlayhead();
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    stopPlayback();
    seekTo(0);
    return;
  }
  const modifier = e.ctrlKey || e.metaKey;
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  if (modifier && key === 'z') {
    e.preventDefault();
    // Shift+Z is the redo nearly everywhere; Ctrl+Y is the Windows one. Both.
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (modifier && key === 'y') {
    e.preventDefault();
    redo();
    return;
  }
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
    e.preventDefault();
    removeClip(clip.id);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    pushUndo(`nudge-end:${clip.id}`);
    clip.srcEnd = Math.max(clip.srcStart + 0.1, clip.srcEnd + dir * nudge);
    refresh();
  } else if (e.key === '[' || e.key === ']') {
    const i = state.clips.indexOf(clip);
    const next = state.clips[i + (e.key === ']' ? 1 : -1)];
    if (next) {
      state.selected = next.id;
      state.cursor = next.srcStart;
      refresh();
    }
  }
}

/* What a project is, where it lives and which one is open — questions this page
   answers for itself in a browser and does not get asked at all inside a shell.
   There the folder is the project, and choosing between projects happens before
   this page is loaded. */
const PROJECT_CONTROLS = [
  'btnSaveProject', // the folder already holds the file
  'btnLoadProject', // opening one is the shell's landing page
  'btnNew', // so is starting one
  'btnEmptyLoad',
  'storageSection', // "Forget it all" clears storage a hosted page does not use
];

/**
 * Take away the controls that belong to whoever owns the project.
 *
 * In a browser this page is the whole application: it has to be able to start a
 * program, save one and open one, because nothing else can. Inside a shell all
 * three happen somewhere else, before this page exists — so a button here would
 * either do nothing useful or quietly disagree with the folder.
 *
 * Hidden rather than removed, and hidden from one list, so what is gone and why
 * is a single thing to read.
 *
 * Says what is true either way rather than only ever hiding. A function that
 * can take a button away and not put it back leaves what is on screen depending
 * on the order things were called in — which is exactly how this first went
 * wrong, with a browser check finding a control still gone after the shell it
 * was hidden for had been deleted.
 */
function hideProjectControls() {
  const hosted = hostPresent();
  for (const id of PROJECT_CONTROLS) {
    const element = $(id);
    if (element) element.classList.toggle('hidden', hosted);
  }
}

/**
 * Should the first run interrupt with a dialog?
 *
 * Only when there is no work to come back to, and never inside a shell — there
 * the name and the event were answered before this page loaded, and the folder
 * is already a project. A dialog asking both again would be asking somebody to
 * repeat themselves and then disagreeing with the file.
 *
 * Its own function because it is a rule rather than a line: buried in `init` it
 * could not be asked about, and a mutation that dropped the shell half of it
 * went unnoticed by every check there was.
 */
function shouldOfferStart(saved) {
  if (hostPresent()) return false;
  return !saved || !(saved.clips || []).length;
}

/**
 * Listen for music the shell brings in.
 *
 * No button. A shell that can fetch music has its own interface for doing it —
 * the page's part is to notice when the folder changed and read it again,
 * because the folder is the truth and one way of learning what is in it is
 * enough. What the shell hands over is what the folder cannot say: a title,
 * and where the song came from.
 */
function bindHostAdded() {
  const onAdded = hostAdded();
  if (!onAdded) return;
  onAdded(async (entry) => {
    await openHostMedia(entry);
    refresh();
  });
}

/**
 * Open the project a desktop shell is holding, and decode the music with it.
 *
 * The one thing a folder buys that a browser cannot: a project and its songs
 * arrive together, so the missing-files notice has nothing to say and nobody is
 * asked to find three files they already have.
 *
 * Files are handed to `addFiles` as ordinary File objects, which is the same
 * path a drop or the file picker takes — decoding, fingerprints, the quality
 * verdict and the waveform all happen exactly as they always did.
 */
async function openHostProject() {
  const folder = hostProject();
  if (!folder) return;
  try {
    const saved = await folder.read();
    if (saved) loadProject(saved);
  } catch (_) {
    toast('Could not read the project in this folder', 6000);
  }

  /* After the project and before anything can be edited. `loadProject` clears
     the stacks as it goes, so restoring earlier would only be undone by it. */
  if (typeof folder.readHistory === 'function') {
    try {
      restoreHistory(await folder.readHistory());
    } catch (_) {
      /* No history is a project you can still edit, only not step back past
         this moment. */
    }
  }

  await openHostMedia();
  refresh();
}

/**
 * Read the folder's music, decoding whatever is not already open.
 *
 * Apart from `openHostProject` because the two happen at different moments and
 * mean different things. Opening a folder is both: a program and its songs. A
 * song *arriving* — a shell finished fetching one — changes the media folder
 * and nothing else, and reloading the program from disk for it would throw away
 * whatever was being edited in the seconds it took.
 *
 * `added` is what the shell knows about the song that the file itself cannot
 * say: what it is called where it came from, and where that was. Recorded here
 * so it survives into the project file — see `usedSongs`, which spreads this
 * over what it measures. It appears in the saved file once a clip uses the
 * song, which is the point at which the song is part of the program.
 */
async function openHostMedia(added) {
  const folder = hostProject();
  if (!folder) return;

  if (added && typeof added === 'object' && added.name) {
    const known = state.expectedFiles.get(added.name) || {};
    state.expectedFiles.set(added.name, { ...known, ...added });
  }

  try {
    const songs = (await folder.media()) || [];
    const files = [];
    for (const song of songs) {
      const name = song && typeof song === 'object' ? song.name : song;
      if (!name) continue;
      /* Already decoded, so there is nothing to fetch. `addFiles` would skip it
         anyway, but only after its bytes had been read out of the folder and
         handed across — and the whole folder is read every time one song
         arrives. The same test it uses, so a file that failed to decode last
         time gets another go. */
      const open = library.get(name);
      if (open && open.buffer) continue;
      try {
        files.push(new File([await folder.open(name)], name));
      } catch (_) {
        /* one unreadable file is not a reason to open none of them */
      }
    }
    /* These came out of the media folder, so they are already the project's
       own and must not be copied back into it. */
    if (files.length) await addFiles(files, { fromFolder: true });
  } catch (_) {
    toast('Could not read the music in this folder', 6000);
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
  try {
    seen = localStorage.getItem(SMALL_SCREEN_KEY) === '1';
  } catch (_) {
    /* private mode */
  }
  if (!small || seen) return;

  $('smallScreen').classList.remove('hidden');
  $('btnDismissSmall').onclick = () => {
    $('smallScreen').classList.add('hidden');
    try {
      localStorage.setItem(SMALL_SCREEN_KEY, '1');
    } catch (_) {
      /* private mode */
    }
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
    return; // nothing below would work anyway
  }
  maybeWarnSmallScreen();

  bind();
  bindStartDialog();
  tryLoadMp3Encoder();

  let saved = null;
  const folder = hostProject();
  if (folder) {
    /* The folder is the project, so there is nothing to choose and nothing to
       find: it opens, and its music opens with it. Never waited on — the editor
       has to start whether or not the folder answers. */
    saved = { clips: [] }; // enough to keep the start dialog shut
    openHostProject();
  } else {
    try {
      const stored = localStorage.getItem(STORE_KEY);
      if (stored) {
        saved = JSON.parse(stored);
        loadProject(saved);
      }
    } catch (_) {
      /* start empty */
    }
  }

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(LIBRARY_KEY) === 'collapsed';
  } catch (_) {
    /* private mode */
  }
  setLibraryCollapsed(collapsed);

  refresh();
  // Which files we could offer to reopen is a question for storage, so the
  // notice above the timeline is updated again once the answer arrives. It is
  // never waited on: the editor has to start whether or not it comes back.
  loadRememberedNames();
  if (shouldOfferStart(saved)) openStartDialog(false);
}

/* In a browser, start. Under Node — the test suite — export the logic instead,
   so it can be checked without a page to run in.
 *
 * The script tags give every src/*.js file one shared scope in the browser, so
 * they call into each other by name and nothing has to be wired up. Node gives
 * each file a scope of its own, and those bare names would go unresolved the
 * moment a test called anything — so the whole set is gathered here and put on
 * the global object. Only this file requires the others; they reach back
 * through the globals below, which is the same single scope seen from Node.
 *
 * A name a file forgets to export shows up immediately: eslint builds its list
 * of shared globals from exactly this object, so referring to a missing one is
 * a no-undef error rather than something that fails at runtime.
 */
if (typeof document !== 'undefined') {
  init();
} else if (typeof module !== 'undefined' && module.exports) {
  const shared = Object.assign(
    {},
    require('./analysis.js'),
    require('./formats.js'),
    require('./program.js'),
    require('./host.js'),
    require('./canvas.js'),
    require('./mp3.js'),
    require('./audio.js'),
    require('./library.js'),
    require('./timeline.js'),
    require('./editor.js'),
    require('./dialogs.js'),
  );
  Object.assign(global, shared);

  module.exports = {
    ...shared,
    STORE_KEY,
    state,
    library,
    undoStack,
    redoStack,
    $,
    toast,
    THEME_KEY,
    THEME_MODES,
    THEME_WORDS,
    storedTheme,
    applyTheme,
    chooseTheme,
    setSettingsOpen,
    settingsOpen,
    describeStored,
    forgetEverything,
    LIBRARY_KEY,
    setLibraryCollapsed,
    UNDO_DEPTH,
    UNDO_COALESCE_MS,
    undoRun,
    undoSnapshot,
    HISTORY_DELAY,
    historyNow,
    restoreHistory,
    saveHistory,
    pushUndo,
    endUndoRun,
    takeUndo,
    takeRedo,
    applySnapshot,
    undo,
    redo,
    addClip,
    selectedClip,
    removeClip,
    moveClip,
    withBusy,
    usedSongs,
    project,
    save,
    loadProject,
    exportFileName,
    missingFiles,
    resetProgram,
    startNewProgram,
    updateMissingNotice,
    refresh,
    fillLevelOptions,
    buildLevelPicker,
    applyLevel,
    syncLevelPicker,
    bind,
    onKey,
    openHostMedia,
    bindHostAdded,
    PROJECT_CONTROLS,
    hideProjectControls,
    shouldOfferStart,
    unsupportedReasons,
    readFileBytes,
    SMALL_SCREEN_KEY,
    maybeWarnSmallScreen,
    init,
  };
  Object.assign(global, module.exports);
}
