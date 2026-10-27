/**
 * One in-memory desktop shell, implementing the whole of docs/host.md.
 *
 * Used by the unit tests directly and by the browser checks as source: they
 * install `fakeHost.toString()` into the page, which is why the function closes
 * over nothing and is handed `version` rather than reading HOST_VERSION. A
 * change to the interface is then made here once, instead of in every check
 * that built its own half of a shell.
 *
 *   const fake = fakeHost({ version, project: doc, media: { 'a.wav': bytes } });
 *   window.skateHost = fake.host;
 *   ... fake.calls  every call made, as [method, ...args]
 *   ... fake.folder what the folder holds now
 *   ... fake.editor() what the page handed over through connect
 *   await fake.arrive({ name, title }, bytes)   a song lands from elsewhere
 *
 * `omit` takes optional methods away, to be a shell that does not offer them;
 * `with` replaces any method, for a shell that fails or answers oddly.
 */
'use strict';

function fakeHost({
  version,
  project = null,
  history = null,
  media = {},
  omit = [],
  with: replace = {},
}) {
  const folder = { project, history, media: new Map(Object.entries(media)) };
  const calls = [];
  const listeners = [];

  /* Numbered the way a shell numbers a name already taken: "a.wav" becomes
     "a (2).wav". The real one also answers with a file it already holds when it
     judges the two the same; this one never does, which only ever makes a test
     see more files, not fewer. */
  const freeName = (name) => {
    if (!folder.media.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    while (folder.media.has(`${stem} (${n})${ext}`)) n++;
    return `${stem} (${n})${ext}`;
  };

  const methods = {
    name: () => 'a folder',
    read: async () => folder.project,
    write: async (doc) => {
      folder.project = doc;
    },
    media: async () =>
      [...folder.media.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, bytes: folder.media.get(name).byteLength })),
    open: async (name) => {
      if (!folder.media.has(name)) throw new Error(`"${name}" is not in this folder`);
      return folder.media.get(name).slice(0);
    },
    importFile: async (name, bytes) => {
      const named = freeName(name);
      folder.media.set(named, bytes.slice(0));
      return named;
    },
    discard: async (name) => {
      if (!folder.media.delete(name)) return { ok: false, why: 'That song is not in this project' };
      return { ok: true };
    },
    readHistory: async () => folder.history,
    writeHistory: async (saved) => {
      folder.history = saved;
    },
    onAdded: (listener) => {
      listeners.push(listener);
    },
    ...replace,
  };
  for (const method of omit) delete methods[method];

  const record =
    (method, fn) =>
    (...args) => {
      calls.push([method, ...args]);
      return fn(...args);
    };
  const recorded = {};
  for (const [method, fn] of Object.entries(methods)) recorded[method] = record(method, fn);

  /* Beside the project: what the page hands over for the shell to call. */
  let editor = null;
  const host = { version, project: recorded };
  if (!omit.includes('connect')) {
    host.connect = record('connect', (given) => {
      editor = given;
    });
  }

  return {
    host,
    calls,
    folder,
    /** What the page handed over through `connect`, or null. */
    editor: () => editor,
    /** Who is listening for songs arriving. */
    listening: () => listeners.length,
    /** A song lands in the folder by a route the page did not start. */
    async arrive(entry, bytes) {
      if (bytes) folder.media.set(entry.name, bytes);
      for (const listener of listeners) await listener(entry);
    },
  };
}

module.exports = { fakeHost };
