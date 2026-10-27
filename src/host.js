/* The desktop shell, when the page is running inside one.
 *
 * The editor is a web page first and has to stay one: opened from disk, with no
 * server and nothing installed. A desktop shell can offer what a browser will
 * not — a folder it owns, files it can read back without asking, and a way to
 * bring music in — so it hands the page a single object and the page checks for
 * it. Everything that object makes possible sits behind `hostPresent()`, and
 * with no host the page is exactly what it was before this file existed.
 *
 * This is the same shape the app already uses for everything else it cannot
 * count on. `canRememberFiles()` gates the File System Access path,
 * `unsupportedReasons()` inventories what a browser is missing, and the rule in
 * AGENTS.md is to feature-detect rather than to sniff. A shell is one more
 * capability that may or may not be there.
 *
 * Nothing else reads `window.skateHost` directly. It goes through here so there
 * is one place that decides whether a host is usable, and one place to look
 * when the answer is wrong.
 */
'use strict';

/* The shape this app knows how to talk to. A shell announcing anything else is
   ignored rather than half-used: a bridge whose methods mean something other
   than what they say is worse than no bridge, and the page works without one. */
const HOST_VERSION = 1;

/* What has to be there before any of it is called. A shell that offers a
   project but no way to read one is not offering a project. */
const HOST_PROJECT_METHODS = ['name', 'read', 'write', 'media', 'open'];

/* What a project may also offer. Each is checked where it is used, and its
   absence means doing what a browser would. Listed so docs/host.md and the fake
   shell the tests use can be held to the same set. */
const HOST_PROJECT_OPTIONAL = ['importFile', 'discard', 'readHistory', 'writeHistory', 'onAdded'];

/* What the shell itself may offer, beside the project. */
const HOST_OPTIONAL = ['connect'];

/* The names a shell may take from this code under Node, through app.js. Anything
   else exported is free to change; these are an interface, and a shell is built
   against them. Held to docs/host.md, and each to being exported, by a check. */
const SHELL_EXPORTS = [
  'HOST_VERSION',
  'HOST_PROJECT_METHODS',
  'HOST_PROJECT_OPTIONAL',
  'HOST_OPTIONAL',
  'hostPresent',
  'LEVELS',
  'findLevel',
  'layout',
  'readProject',
  'AUDIO_EXTENSIONS',
  'FORMAT',
  'FORMAT_VERSION',
  'SCHEMA_URL',
];

/**
 * The host object, or null when there isn't a usable one.
 *
 * Checked every time rather than cached: the page is loaded by the shell, so
 * the object is there before any of this runs, but a cache would make the
 * failure mode "reload the app" instead of "fix the shell".
 */
function host() {
  const given = typeof window === 'undefined' ? null : window.skateHost;
  if (!given || typeof given !== 'object') return null;
  if (given.version !== HOST_VERSION) return null;
  const project = given.project;
  if (!project || typeof project !== 'object') return null;
  for (const method of HOST_PROJECT_METHODS) {
    if (typeof project[method] !== 'function') return null;
  }
  return given;
}

/** Is this page running inside a desktop shell? */
function hostPresent() {
  return host() !== null;
}

/** The project folder the shell owns, or null. */
function hostProject() {
  const given = host();
  return given ? given.project : null;
}

/**
 * The shell's way of saying the folder changed, or null.
 *
 * There used to be a `hostImport()` beside this, and a button in the page that
 * a shell named and the page rendered. That is gone: bringing music in is the
 * shell's own affair now, done in its own interface, and the page has no
 * business owning a control for it.
 *
 * What is left is the half the page genuinely needs. Something appeared in the
 * folder; read the folder again. The page is told rather than polling, and
 * what it is handed is only what the folder cannot say for itself — a title,
 * and where the song came from.
 */
function hostAdded() {
  const project = hostProject();
  return project && typeof project.onAdded === 'function' ? project.onAdded : null;
}

/**
 * Hand the shell what it may ask of the page, if it takes it. Says whether it
 * did.
 *
 * The other direction of the bridge. Before this, a shell closing a project ran
 * the page's flush by name, and renaming that function broke closing without
 * breaking anything a browser would notice. Handed over, it is part of the
 * interface: listed in docs/host.md, and held there by a check.
 */
function hostConnect(editor) {
  const given = host();
  if (!given || typeof given.connect !== 'function') return false;
  given.connect(editor);
  return true;
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    HOST_VERSION,
    HOST_PROJECT_METHODS,
    HOST_PROJECT_OPTIONAL,
    HOST_OPTIONAL,
    SHELL_EXPORTS,
    host,
    hostPresent,
    hostProject,
    hostAdded,
    hostConnect,
  };
}
