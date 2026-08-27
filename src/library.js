/* The songs on the left, and how files get in and stay in.
 *
 * Decoding dropped or picked files, drawing the list, and — where the browser
 * allows it — keeping the file handles in IndexedDB so the same songs can be
 * reconnected next time instead of hunted for again.
 */
'use strict';

/**
 * Take files somebody brought from outside into the project folder first.
 *
 * A project is a folder. A song decoded from wherever it happened to be sitting
 * is a song the project does not have — the program names it, the folder does
 * not hold it, and next time it opens with a hole in it. So the file is copied
 * in and the copy is what gets decoded; nothing here ever reads the original
 * twice or depends on it staying where it was.
 *
 * The name can change on the way in — one already taken gets a number — which
 * is why the folder is read again afterwards rather than the sent names being
 * assumed.
 */
async function addFromOutside(fileList, folder) {
  const wanted = [];
  for (const file of Array.from(fileList)) {
    try {
      const named = await folder.importFile(file.name, await readFileBytes(file));
      if (named) wanted.push(named);
    } catch (_) {
      /* One file that will not copy is not a reason to drop the rest, and the
         missing-music notice already says what the program cannot find. */
    }
  }
  if (!wanted.length) return [];

  await openHostMedia();
  return wanted.map((name) => library.get(name)).filter(Boolean);
}

/**
 * Put songs into the library, decoding each one.
 *
 * `fromFolder` says these are already the project's own — read out of the media
 * folder rather than brought from somewhere else — and so must not be copied
 * back into it. Everything else arrives from a drop, a picker or a reconnected
 * handle, and gets copied first when a shell is holding the project.
 */
async function addFiles(fileList, { fromFolder = false } = {}) {
  const folder = typeof hostProject === 'function' ? hostProject() : null;
  if (folder && !fromFolder && typeof folder.importFile === 'function') {
    return addFromOutside(fileList, folder);
  }

  // The type and the name are asked separately. Testing a regex against the
  // two concatenated let "audio" match anywhere in either, so a file called
  // audiobook.txt was accepted and then failed to decode. Browsers also report
  // no type at all for .opus and .webm, which is why the extension is a second
  // chance rather than a formality.
  const files = Array.from(fileList).filter(
    (f) => /^audio\//i.test(f.type) || AUDIO_EXTENSIONS.test(f.name),
  );
  if (!files.length) {
    toast('No audio files in that drop');
    return;
  }
  let shortened = 0;
  const wrongFile = [];

  for (const file of files) {
    if (library.has(file.name)) continue;
    library.set(file.name, {
      name: file.name,
      buffer: null,
      peaks: null,
      duration: 0,
      state: 'loading',
    });
  }
  renderLibrary();

  for (const file of files) {
    const entry = library.get(file.name);
    if (entry.buffer) continue;
    try {
      const bytes = await readFileBytes(file);
      // Copy a window at the first audio frame before decoding — decodeAudioData
      // detaches the buffer, and the source bitrate exists only in those bytes,
      // not in the decoded PCM. The window has to start past the ID3v2 tag,
      // which is ~430 KB on anything with embedded artwork.
      // Ogg keeps its cover art in the comment header rather than an ID3 tag,
      // so ask whichever container this is where its audio really starts.
      const tagEnd = id3Size(bytes) || oggAudioStart(bytes);
      const head = bytes.slice(tagEnd, Math.min(bytes.byteLength, tagEnd + 32768));
      /* Before decoding, for the same reason as the window above: the tags live
         in these bytes and decodeAudioData takes the buffer away. */
      entry.tags = readTags(bytes);
      const buffer = await ctx().decodeAudioData(bytes);
      entry.buffer = buffer;
      entry.duration = buffer.duration;
      entry.peaks = computePeaks(buffer);
      entry.quality = analyzeSource(head, tagEnd, file, buffer);
      entry.bytes = file.size;
      entry.fingerprint = fingerprint(head);
      entry.state = 'ready';
      const complaint = describeWrongFile(state.expectedFiles.get(file.name), entry);
      if (complaint) wrongFile.push(complaint);
      // Now that there is a real duration, the trims can finally be checked
      // against it. Silently playing silence off the end is the alternative.
      shortened += clampClipsToFile(state.clips, entry);
    } catch (err) {
      entry.state = 'error';
      toast(`Could not read ${file.name}`);
    }
    renderLibrary();
    updateMissingNotice();
    updateExportAvailability();
    renderTimeline();
    drawScrubber();
    drawClipEditor();
  }
  updateBudget();
  /* Said before anything about trimming: if the wrong song has been handed
     over, every other number on screen is about the wrong song too. */
  if (wrongFile.length) {
    toast(
      wrongFile.length === 1
        ? wrongFile[0]
        : `${wrongFile.length} songs are not the ones this program was built from — ` +
            'check them before you use it',
      7000,
    );
  }
  if (shortened) {
    save();
    toast(
      shortened === 1
        ? 'One song asked for more music than its file holds, so it was shortened to fit'
        : `${shortened} songs asked for more music than their files hold, so they were shortened to fit`,
      6000,
    );
  }
  /* What is now playable of what was asked for, in the order it was dropped, so
     a drop onto the timeline can add exactly those. Looked up rather than
     collected in the loop above, which skips files that were already loaded —
     dropping one of those again should still put it in the program. */
  return files.map((file) => library.get(file.name)).filter((entry) => entry && entry.buffer);
}

/** How many clips in the program are playing from this file. */
function clipsUsing(file) {
  return state.clips.filter((c) => c.file === file).length;
}

/**
 * Take a file back out of the list.
 *
 * Only when nothing in the program is using it. Removing a file the program
 * depends on would quietly gut the edit, so the button is shut rather than
 * guarded by a confirmation — the same choice as the export button, and for the
 * same reason. Dropping the entry is what actually releases the decoded audio,
 * which is around 90 MB for every four minutes of stereo, and until now there
 * was no way to release it at all.
 */
function removeFromLibrary(name) {
  infoOpen.delete(name);
  if (clipsUsing(name)) {
    toast('That song is in your program — take it out of the program first');
    return;
  }
  library.delete(name);
  renderLibrary();
}

/* Nothing about the list changes as often as it was being rebuilt. It is in
   `refresh()` because whether a file can be removed depends on whether the
   program still uses it — but that answer, and everything else on show here,
   changes far less often than `refresh()` is called. */
let libraryShape = null;

/* Which songs are showing what their file says about itself. Held out here
   because the list is rebuilt whenever anything about it changes, and a panel
   somebody opened should not close because a different song finished loading. */
const infoOpen = new Set();

/* The licensing service the ISU points skaters to. Kept here rather than inline
   so a check can hold the link to the shape it is supposed to have. */
const CLICKNCLEAR_SEARCH = 'https://music.clicknclear.com/en-gb/search';

/** Drop the "already drawn" cache, so the next render really redraws. */
function forgetLibraryShape() {
  libraryShape = null;
}

function librarySignature() {
  return [...library.values()]
    .map((entry) =>
      [
        entry.name,
        entry.state,
        Math.round(entry.duration),
        entry.quality ? entry.quality.kind : '',
        entry.peaks ? 1 : 0,
        clipsUsing(entry.name), // whether Remove is available
      ].join(':'),
    )
    .join('|');
}

function renderLibrary() {
  const signature = librarySignature();
  if (signature === libraryShape) return;
  libraryShape = signature;

  const list = $('libraryList');
  list.innerHTML = '';
  for (const entry of library.values()) {
    const li = document.createElement('li');
    if (entry.state === 'loading') li.classList.add('loading');

    /* What the song is called, with the file name under it when they differ.
       The title is what the program will show; the file name is what identifies
       it, what a project records, and what has to be found again later — so
       neither can be the only one on screen. */
    const named = (entry.tags && entry.tags.title) || '';
    const title = document.createElement('div');
    title.className = 'lib-title';
    title.textContent = named || entry.name;
    li.appendChild(title);
    if (named && named !== entry.name) {
      const file = document.createElement('div');
      file.className = 'lib-file';
      file.textContent = entry.name;
      li.appendChild(file);
    }

    if (entry.peaks) {
      const canvas = document.createElement('canvas');
      canvas.height = 28;
      li.appendChild(canvas);
      requestAnimationFrame(() =>
        drawWave(canvas, entry.peaks, entry.duration, 0, entry.duration, css('--wave')),
      );
    }

    const row = document.createElement('div');
    row.className = 'lib-row';
    const dur = document.createElement('span');
    dur.className = 'lib-dur';
    dur.textContent =
      entry.state === 'loading'
        ? 'reading…'
        : entry.state === 'error'
          ? 'unreadable'
          : fmtShort(entry.duration);
    row.appendChild(dur);

    if (entry.quality) {
      const badge = document.createElement('span');
      badge.className = `badge ${entry.quality.kind}`;
      badge.textContent = qualityLabel(entry.quality);
      badge.title = qualityDetail(entry.quality);
      row.insertBefore(badge, row.firstChild);
    }

    if (entry.state === 'ready') {
      const add = document.createElement('button');
      add.className = 'small';
      add.textContent = 'Add to program';
      add.onclick = () => addClip(entry);
      row.appendChild(add);
    }

    const drop = document.createElement('button');
    drop.className = 'small danger';
    drop.textContent = 'Remove';
    const used = clipsUsing(entry.name);
    drop.disabled = used > 0;
    drop.title = used
      ? `This song is in your program ${used === 1 ? 'once' : `${used} times`} — ` +
        'take it out of the program first'
      : 'Take this file out of the list and give back the memory it is holding. ' +
        'Your program is untouched, and nothing is deleted from your computer.';
    drop.onclick = () => removeFromLibrary(entry.name);
    row.appendChild(drop);

    /* What the file says about itself, when it says anything. Competition entry
       forms ask for the title and often the composer, and a file called
       track03.mp3 will not tell you either. */
    const tags = entry.tags || {};
    const known = TAG_LABELS.filter(([key]) => tags[key]);
    let panel = null;
    if (known.length) {
      const shown = infoOpen.has(entry.name);
      const info = document.createElement('button');
      info.className = 'small';
      info.textContent = 'Info';
      info.title = 'What this file says about itself';
      info.setAttribute('aria-expanded', String(shown));
      row.insertBefore(info, drop);

      panel = document.createElement('dl');
      panel.className = 'lib-tags';
      panel.hidden = !shown;
      for (const [key, label] of known) {
        const name = document.createElement('dt');
        name.textContent = label;
        const value = document.createElement('dd');
        // textContent, never innerHTML: this is text out of somebody's file.
        value.textContent = tags[key];
        panel.append(name, value);
      }
      /* Where the ISU points skaters to clear the rights to a piece of music,
         opened on a search for this song so the answer is one click away rather
         than a name to retype.

         Only the two parameters that say what is being looked for. A real
         search URL also carries a label filter and a year range, and both would
         quietly hide most of what the song might match. */
      const rights = document.createElement('a');
      rights.className = 'lib-rights';
      rights.href = `${CLICKNCLEAR_SEARCH}?entity=tracks&search=${encodeURIComponent(named || entry.name.replace(/\.[^.]+$/, ''))}`;
      rights.target = '_blank';
      rights.rel = 'noopener noreferrer';
      rights.textContent = 'Look up the rights on ClicknClear';
      panel.append(rights);

      info.onclick = () => {
        const open = !infoOpen.has(entry.name);
        if (open) infoOpen.add(entry.name);
        else infoOpen.delete(entry.name);
        panel.hidden = !open;
        info.setAttribute('aria-expanded', String(open));
      };
    }

    li.appendChild(row);
    if (panel) li.appendChild(panel);
    list.appendChild(li);
  }
}

/* ------------------------------------------------------ remembering files */

/* A project holds the edit, not the music, so opening one has always meant
 * finding the song files again by hand. That is the biggest piece of friction
 * in the whole thing, and it exists because a browser cannot normally hold on
 * to a file after the tab closes.
 *
 * Where the File System Access API is available it can: the picker hands back a
 * handle rather than only bytes, the handle survives in IndexedDB, and asking
 * for it again is one click instead of one per song. The audio still never
 * leaves the machine — a handle is a reference to a file on disk, and reading
 * it needs the same permission it always did.
 *
 * It is an extra, not a foundation. Firefox and Safari have no picker, and the
 * API needs a secure context so it is absent when index.html is opened straight
 * off disk — which the ground rules say has to keep working. Everything below
 * is written so that when `canRememberFiles()` is false the app behaves exactly
 * as it did before: the hidden <input> does the picking, and the notice above
 * the timeline asks for the files by hand.
 */

const HANDLE_DB = 'skate.handles.v1';
const HANDLE_STORE = 'handles';

/** Names we hold a handle for, so the interface can ask without going async. */
const rememberedNames = new Set();

/** Can this browser give a file back after the tab has been closed? */
function canRememberFiles() {
  return (
    typeof window.showOpenFilePicker === 'function' &&
    typeof indexedDB !== 'undefined' &&
    window.isSecureContext === true
  );
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Run one transaction and wait for it to land. Resolves null on any trouble. */
async function withHandles(mode, work) {
  if (!canRememberFiles()) return null;
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, mode);
      let value;
      Promise.resolve(
        work(tx.objectStore(HANDLE_STORE), (v) => {
          value = v;
        }),
      ).catch(reject);
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (_) {
    // Private browsing, a blocked upgrade, storage turned off — none of it is
    // worth an error in front of anyone. The app simply does not remember.
    return null;
  }
}

function rememberHandle(name, handle) {
  rememberedNames.add(name);
  return withHandles('readwrite', (store) => {
    store.put(handle, name);
  });
}

function forgetHandle(name) {
  rememberedNames.delete(name);
  return withHandles('readwrite', (store) => {
    store.delete(name);
  });
}

/** Every remembered handle, as name → handle. */
function storedHandles() {
  return withHandles('readonly', (store, keep) => {
    const request = store.getAll();
    const names = store.getAllKeys();
    request.onsuccess = () => {
      names.onsuccess = () => {
        const map = new Map();
        names.result.forEach((name, i) => map.set(name, request.result[i]));
        keep(map);
      };
    };
  });
}

/** Load the names we know about, so the missing-file notice can offer them. */
async function loadRememberedNames() {
  const handles = await storedHandles();
  if (!handles) return;
  for (const name of handles.keys()) rememberedNames.add(name);
  updateMissingNotice();
}

/**
 * Ask for music files, remembering them where the browser allows it.
 *
 * Falls back to the hidden `<input type=file>`, which is what this always was
 * and what Firefox and Safari still get.
 */
async function pickFiles() {
  if (!canRememberFiles()) {
    $('fileInput').click();
    return;
  }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ multiple: true, types: audioPickerTypes() });
  } catch (_) {
    return; // the picker was closed; not an error
  }
  const files = [];
  for (const handle of handles) {
    try {
      files.push(await handle.getFile());
      await rememberHandle(handle.name, handle);
    } catch (_) {
      /* one unreadable file should not lose the rest */
    }
  }
  if (files.length) await addFiles(files);
}

/**
 * Handles for files that were dropped, where the browser offers them.
 *
 * Dropping is the other way music arrives, and it would be odd for it to be the
 * forgetful one. The files themselves are read as before either way.
 */
async function rememberDropped(transfer) {
  if (!canRememberFiles() || !transfer.items) return;
  const items = [...transfer.items].filter((item) => item.kind === 'file');
  for (const item of items) {
    if (typeof item.getAsFileSystemHandle !== 'function') return;
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === 'file') await rememberHandle(handle.name, handle);
    } catch (_) {
      /* nothing to remember */
    }
  }
}

/** Missing files we could offer to fetch back without asking for a picker. */
function reconnectableFiles() {
  return canRememberFiles() ? missingFiles().filter((name) => rememberedNames.has(name)) : [];
}

/**
 * Fetch the missing music back from the handles we kept.
 *
 * Has to be called from a click: asking for permission again needs a gesture,
 * which is the whole reason this is a button rather than something that happens
 * quietly on load. One prompt covers every file, so it is one click rather than
 * one per song, which is the point of the exercise.
 */
async function reconnectMissing() {
  const wanted = reconnectableFiles();
  if (!wanted.length) {
    $('fileInput').click();
    return;
  }

  const handles = await storedHandles();
  if (!handles) {
    $('fileInput').click();
    return;
  }

  const files = [];
  const gone = [];
  const refused = [];
  for (const name of wanted) {
    const handle = handles.get(name);
    if (!handle) continue;
    try {
      let allowed = await handle.queryPermission({ mode: 'read' });
      if (allowed !== 'granted') allowed = await handle.requestPermission({ mode: 'read' });
      if (allowed !== 'granted') {
        refused.push(name);
        continue;
      }
      files.push(await handle.getFile());
    } catch (_) {
      // Moved, renamed or deleted since. Forget it rather than offering it again.
      gone.push(name);
    }
  }
  // Only what is really unreachable is forgotten. A refusal is a decision that
  // can be taken differently in a moment, and offering it again is the point.
  for (const name of gone) await forgetHandle(name);

  if (files.length) {
    await addFiles(files);
    if (gone.length || refused.length) toast(describeReconnect({ files, gone, refused }), 7000);
    return;
  }
  toast(describeReconnect({ files, gone, refused }), 7000);
  updateMissingNotice();
}

/** Is this drag carrying files from outside, rather than one of our own clips? */
function draggingFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

/**
 * Accept music dropped anywhere on the page.
 *
 * Anywhere, not just the small box under the list. The timeline is the obvious
 * thing to aim at, and a blanket preventDefault everywhere else would mean a
 * drop there did nothing at all. A drop on the timeline also puts the songs in
 * the program, because that is plainly what was meant by it.
 *
 * `dragenter` and `dragleave` fire for every element the pointer crosses, so
 * the highlight is driven by a depth count rather than by the last event seen.
 */
function bindFileDrops() {
  let depth = 0;
  const show = (on) => document.body.classList.toggle('dropping', on);

  document.addEventListener('dragenter', (e) => {
    if (!draggingFiles(e)) return;
    depth++;
    show(true);
  });
  document.addEventListener('dragleave', (e) => {
    if (!draggingFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  // Without this the browser navigates to the file instead of handing it over.
  document.addEventListener('dragover', (e) => e.preventDefault());

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    show(false);
    if (!draggingFiles(e)) return; // a clip being reordered; not our business

    // Read these now: the awaits below outlive the event, and dataTransfer is
    // emptied once the handler returns.
    const ontoTimeline = Boolean(e.target.closest && e.target.closest('#timelineWrap'));
    const dropped = e.dataTransfer.files;
    await rememberDropped(e.dataTransfer);
    const added = await addFiles(dropped);
    if (ontoTimeline) for (const entry of added) addClip(entry);
  });
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    addFiles,
    addFromOutside,
    clipsUsing,
    removeFromLibrary,
    libraryShape,
    CLICKNCLEAR_SEARCH,
    forgetLibraryShape,
    librarySignature,
    renderLibrary,
    HANDLE_DB,
    HANDLE_STORE,
    rememberedNames,
    canRememberFiles,
    openHandleDb,
    withHandles,
    rememberHandle,
    forgetHandle,
    storedHandles,
    loadRememberedNames,
    pickFiles,
    rememberDropped,
    reconnectableFiles,
    reconnectMissing,
    draggingFiles,
    bindFileDrops,
  };
}
