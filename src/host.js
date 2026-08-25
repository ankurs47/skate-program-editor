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
 * A way to bring music in that the shell provides, or null.
 *
 * Deliberately not called "YouTube". The page knows a shell may offer a route
 * to more music and renders whatever it calls itself; what that route actually
 * is belongs to the shell and is none of the editor's business.
 */
function hostImport() {
  const given = host();
  const offered = given ? given.import : null;
  if (!offered || typeof offered.run !== 'function') return null;
  return {
    label: typeof offered.label === 'string' && offered.label.trim() ? offered.label : 'Add music',
    run: offered.run,
    onAdded: typeof offered.onAdded === 'function' ? offered.onAdded : null,
  };
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    HOST_VERSION,
    HOST_PROJECT_METHODS,
    host,
    hostPresent,
    hostProject,
    hostImport,
  };
}
