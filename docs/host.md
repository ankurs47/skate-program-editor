# The desktop shell interface

How a desktop shell hosts this editor, in both directions. The editor is a web
page first: everything here is optional, and with no shell the page is exactly
the page it always was.

This document describes the interface **as it is**, including the parts that
are awkward, and then the [conventions](#conventions) everything added to it
follows. Where it is going is under [Planned](#planned), with the issue for each
step. `test/app.test.js` holds the method tables below to `src/host.js` and to
the fake shell in `test/fake-host.js`, so this cannot quietly describe an
interface the code no longer has.

## The rules it rests on

- **One object, read in one place.** A shell puts a single object on
  `window.skateHost`. Only `src/host.js` reads it, and it decides whether the
  object is usable at all.
- **A shell that does not fit is ignored, not half-used.** A wrong `version`, a
  missing `project`, or a required method missing means no shell: the page runs
  as a web page. A bridge whose methods mean something other than they say is
  worse than none.
- **Optional means detected.** Every optional method is checked with `typeof`
  where it is used, and the page does what a browser would do when it is absent.
- **The page never writes a file.** It hands bytes and documents to the shell,
  and uses the names the shell answers with.
- **The folder is the truth.** When the folder changes, the page reads it again
  rather than trusting an account of what changed.

## Finding the shell

```js
window.skateHost = {
  version: 1,
  project: {/* required and optional methods below */},
  connect(editor) {
    /* optional: what the page hands over */
  },
};
```

`version` must equal `HOST_VERSION` in `src/host.js`, as a number. It changes
only when an existing method starts to mean something different. Adding an
optional method is not a reason to change it.

`project` is the folder the shell owns. The folder is the project: the program
file, its music, and its undo history all live there, and which folder it is
was decided before the page loaded.

### Required

Without all five, `project` is not a project and the shell is ignored.

| Method       | Returns                                  | The editor uses it to                        |
| ------------ | ---------------------------------------- | -------------------------------------------- |
| `name()`     | the folder's name                        | nothing yet — required, but never called     |
| `read()`     | the project document, or `null`          | open the program when the page starts        |
| `write(doc)` | anything; a rejection is a failure       | save the program, 400 ms after the last edit |
| `media()`    | `[{ name, bytes }]`, or names as strings | list the songs in the folder                 |
| `open(name)` | the file's bytes, as an `ArrayBuffer`    | decode a song from the folder                |

- **`read()`** returns the document as JSON would parse it — the format in
  `docs/program.skate.schema.json`. `null` means a folder with no program in it
  yet. A rejection shows "Could not read the project in this folder" and the
  page starts empty.
- **`write(doc)`** is handed exactly what `project()` builds, the same document
  **Save project** downloads in a browser. Fields the editor does not know are
  in it unchanged, so a shell's own fields survive. The first failure shows
  "Could not save to the project folder — your editing is still here", once
  for each run of failures. `flushHostSave()` reports the folder out of date
  until a later write lands, which brings it fully up to date again ([#130]).
- **`media()`** lists only what the editor could decode. `bytes` is not used
  yet. Called when the page starts and again whenever the folder changes; songs
  already decoded are not opened twice.
- **`open(name)`** is only ever asked for a name `media()` listed. A rejection
  skips that song, and the program shows it as missing.

### Optional

| Method                    | Returns                                 | The editor uses it to                            |
| ------------------------- | --------------------------------------- | ------------------------------------------------ |
| `importFile(name, bytes)` | the name the file was stored under      | copy a song brought from outside into the folder |
| `discard(name)`           | `{ ok: true }`, or `{ ok: false, why }` | be rid of a song the program no longer uses      |
| `readHistory()`           | `{ current, undo, redo }`, or `null`    | restore undo after the project opens             |
| `writeHistory(history)`   | anything                                | keep undo, 2.5 s after the last edit             |
| `onAdded(listener)`       | nothing                                 | hear that a song arrived in the folder           |

- **`importFile(name, bytes)`** gets the file's name and its bytes as an
  `ArrayBuffer`. The answer may differ from `name` — one already taken gets a
  number, and a shell may answer with a file it already holds that it judges to
  be the same one — and the page uses the answer, never the name it sent. A
  falsy answer or a rejection skips that file. Without this method a dropped
  song is decoded in memory only, as in a browser, and the folder never gets it.
- **`discard(name)`** is asked when a song leaves the list and when a song is
  replaced by a better copy, never for a song the program still plays. What it
  means is the shell's decision — moving the file to the trash, say, rather
  than deleting it. A `why` is shown to the user as written. The page does not
  wait for it.
- **`readHistory()`** is applied only if its `current` matches the program just
  read; otherwise it describes some other version of the file and is ignored.
  `undo` and `redo` are lists of strings, at most sixty each. A rejection means
  no history.
- **`writeHistory(history)`** is handed what `readHistory()` should give back.
  Failures are ignored: losing the history is not losing the work.
- **`onAdded(listener)`** is called once, at startup. The shell calls
  `listener(entry)` whenever a song lands in the folder by some route the page
  did not start. `entry` is `{ name, title?, source? }` — whatever the shell
  knows that the file cannot say. Other fields are kept as they are. All of it
  goes into the project once a clip uses the song. The page then reads `media()`
  again.

### Beside the project

Optional, on `skateHost` itself rather than on `project`.

| Method            | Returns | The editor uses it to                              |
| ----------------- | ------- | -------------------------------------------------- |
| `connect(editor)` | nothing | hand over what the shell may ask of the page below |

- **`connect(editor)`** is called once, at startup, after the shell is found
  and before the project is read — so a shell closing early can still ask for a
  flush. `editor` is described under [Called by the shell](#called-by-the-shell).
  A shell keeps it for as long as the page is open; it is the only way the shell
  reaches into the page.

## What changes inside a shell

- **Save project**, **Load project**, **New**, the empty screen's **Load a saved
  project**, and **Forget it all** are hidden (`PROJECT_CONTROLS`). The folder is
  the project, and which project is answered before the page loads.
- The first-run dialog never opens.
- Nothing is kept in `localStorage`; the folder is the only copy.
- Removing or replacing a song asks `discard`, and the wording says the file
  goes to the trash rather than that nothing on the computer is touched.

## Called by the shell

The `editor` the page hands to `connect`. The shell calls nothing in the page
any other way — not a global by name, not a script it injects.

| Method              | Returns                           | Meaning                                                               |
| ------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `flush()`           | `{ saved, hosted }`               | write anything waiting, now, and say whether the folder is up to date |
| `state()`           | the state, below                  | what a menu needs to know, right now                                  |
| `onState(listener)` | a function that stops it          | hear every change to the state                                        |
| `run(id)`           | nothing; rejects if it cannot run | run one of the commands below                                         |

- **`flush()`** is what a shell asks before it closes a project. An edit made
  in the last moment before closing is waiting out the save delay and exists
  nowhere but in memory; this writes it, and the undo history with it. `saved`
  is false only when a write was refused — the one case where closing loses
  work, and the one worth interrupting a close for. `hosted` is false when the
  page has no shell, which only happens if the shell went away after connecting.
- **`state()`** is read off what the page shows, so it can only describe what is
  on screen. A shell reads it once after connecting, then follows `onState`.
- **`onState(listener)`** calls `listener(state)` whenever anything in the state
  changes — after the change, once for a burst of them, and never for nothing.
  It keeps working while the window is hidden, so a shell hears an export finish
  in the background.
- **`run(id)`** does what the control for that command does, by clicking it, so
  a menu item cannot behave differently from the button. It rejects with
  `{ code: 'not-found' }` for an id that is not a command, and
  `{ code: 'refused' }` for one whose `enabled` is false — including while a
  dialog is open, which owns the page until it closes.

### State

```js
{
  name: 'my 2026 junior long program',  // the program name
  hasProgram: true,                      // at least one song in the program
  playing: false,                        // the program or a song is playing
  exporting: { progress: 0.4 },          // or null; progress is 0 to 1
  commands: [                            // every command below, in this order
    { id: 'program.undo', label: 'Undo', keys: 'Mod+Z', enabled: true },
    { id: 'colors.dark', label: 'Dark', keys: null, enabled: true, checked: false },
    // ...
  ],
}
```

- **`label`** is the control's own wording, read off it — so it changes when
  the control does: **Play** becomes **Pause** while playing, and **Hide the
  music list** becomes **Show the music list**. A shell should show the label
  it is given rather than keep its own.
- **`keys`** is the page's own key for the command, or null. `Mod` means Ctrl,
  or ⌘ on a Mac. It is a hint for showing beside the item; whether a shell's
  menu also answers that key is the shell's choice, and a single key like
  `Space` or `[` should stay with the page, which knows when a text field has
  the keyboard.
- **`checked`** is present only on a command that is one of a set of choices —
  the colors — and says which is chosen.

### Commands

| Id                | What it does                                 | Keys          |
| ----------------- | -------------------------------------------- | ------------- |
| `program.undo`    | **Undo**                                     | `Mod+Z`       |
| `program.redo`    | **Redo**                                     | `Mod+Shift+Z` |
| `program.evenOut` | **Even out the volume**                      |               |
| `program.export`  | **Make music file** — opens its dialog       |               |
| `playback.toggle` | **Play**, or **Pause** while playing         | `Space`       |
| `playback.stop`   | **Stop**                                     |               |
| `clip.play`       | **Play this song**, the selected one         |               |
| `join.play`       | **Play this join**, before the selected song |               |
| `clip.previous`   | select the song before                       | `[`           |
| `clip.next`       | select the song after                        | `]`           |
| `view.music`      | **Hide the music list**, or show it          |               |
| `colors.auto`     | colors follow the computer                   |               |
| `colors.light`    | light colors                                 |               |
| `colors.dark`     | dark colors                                  |               |
| `help.basics`     | open the help on the basics                  |               |
| `help.tips`       | open the tips                                |               |
| `help.saving`     | open the help on saving                      |               |
| `help.quality`    | open the help on sound quality               |               |
| `help.keys`       | open the keyboard shortcuts                  |               |

Ids are never reused for something different (convention 7). A command added
here is added to the end of the list, so a shell that shows them in order shows
the new one last rather than shuffling the rest.

## What a shell reads from the editor's code

A shell may run the editor's pure code under Node, by requiring `src/app.js`,
which gathers every file's exports. These names are the interface; everything
else exported is free to change. `SHELL_EXPORTS` in `src/host.js` lists them.

| Name                    | What it is                                                  |
| ----------------------- | ----------------------------------------------------------- |
| `HOST_VERSION`          | the version a bridge must announce                          |
| `HOST_PROJECT_METHODS`  | the project methods a bridge must offer                     |
| `HOST_PROJECT_OPTIONAL` | the project methods a bridge may offer                      |
| `HOST_OPTIONAL`         | the methods a bridge may offer beside the project           |
| `HOST_COMMANDS`         | the commands, in order; each `id` as under Commands         |
| `hostPresent`           | whether the editor would accept `window.skateHost` as it is |
| `LEVELS`                | the events and their program lengths, grouped               |
| `findLevel`             | an event by its id, or null                                 |
| `layout`                | where each clip falls in program time, and the total length |
| `readProject`           | a project document read the way the page reads one          |
| `AUDIO_EXTENSIONS`      | which file names the editor treats as music                 |
| `FORMAT`                | the `format` every project document carries                 |
| `FORMAT_VERSION`        | the newest project format this editor reads and writes      |
| `SCHEMA_URL`            | the `$schema` every project document points at              |

## Offered but not used

A shell may offer `reveal(name)`, showing a song's file in the system's file
manager. The editor never calls it, and it is not part of what `src/host.js`
checks.

## Conventions

How everything added to this interface behaves. The methods above predate
these; where one differs, it is named and stays as it is until a version change
gives a reason to break it.

1. **One way to fail.** A method that cannot do what it was asked rejects with
   `{ code, message }`. `code` is one of `not-found`, `refused`, `busy` or
   `unavailable`. `message` is for logs, not for people: the page decides what
   the user is told, so the plain-language rule lives in one place.
   `discard` answers `{ ok: false, why }` instead, and its `why` is shown as
   written — the one exception.
2. **Plain data across the bridge.** Arguments and answers are what structured
   cloning carries: objects, arrays, strings, numbers, booleans, `null`, and
   `ArrayBuffer` for bytes. No class instances, and functions only as
   listeners. Times are seconds. Songs are named by their file name in the
   project, never by a path, and the page is never handed a path.
3. **Listening can be stopped.** Every `on…(listener)` returns a function that
   removes that listener. `onAdded` returns nothing, and a page that bound it
   twice would hear everything twice.
4. **An order of events.** The page loads; finds the shell; reads the program,
   then the music; says it is ready ([#134]); edits, writing each change after a
   short delay; is asked to flush; is closed. A shell does not show the program
   before ready, and does not close it without a flush.
5. **One writer, whole documents.** Every write is the whole program, and the
   page never has two writes waiting on one another — a newer one replaces an
   older one not yet sent. The shell applies them in the order they arrive. One
   page writes to a project at a time; a shell asked to open a project another
   window already has open either brings that window forward or refuses.
6. **Changes from outside are told, not guessed.** Besides a song arriving, a
   shell may say the program file changed on disk — edited by hand, or a git
   checkout — or that a song disappeared. The page then reads the folder again,
   and asks before replacing a program that has unsaved edits of its own.
7. **Commands have stable names.** Each command the page offers has an id such
   as `program.undo` or `clip.takeOut`, a label in the interface's own words,
   and a shortcut hint. An id is never reused for something different. A
   command may take a target — `{ clip: id }` or `{ song: name }` — and acts on
   that rather than on the selection ([#133]). Whether it can run now comes from
   the state the page reports, never from the shell's own guess.
8. **Capabilities, both ways.** The shell lists what it offers in
   `skateHost.capabilities`, and the page answers with what it supports, so a
   shell can leave out a menu item an older editor cannot do. Adding a method or
   a capability does not change `version`; changing what an existing one means
   does. A method on its way out is marked deprecated here for one release
   before it goes, and every change is listed in the changelog below.
9. **Settings belong to the app.** Where a shell offers somewhere to keep them,
   the page's own settings — colors, the export format, whether the music list
   is collapsed — go there rather than into the page's browser storage, so they
   survive the app being reinstalled and are the same in every window.

## Planned

In order. Each lands in this document when it lands in the code.

1. **Commands that take a target** ([#133]): `run(id, target)`, for a menu
   on one clip or song.
2. **Ready** ([#134]): the page says when the program is on screen.
3. **Capabilities**: `skateHost.capabilities`, as in convention 8.
4. **A native menu** ([#123]): with one, the page hides the header items the menu
   covers.
5. **Music files** ([#125]): `writeExport(name, bytes, details)` hands the finished
   file to the shell instead of downloading it.
6. **The guide** ([#122]) and **confirmations** ([#135]): the page asks the
   shell to show the guide rather than navigating away from the program, and to
   confirm destructive actions natively. The color choice ([#127]) is already in
   the state, as the `checked` on the `colors.*` commands.

## Changelog

- **Version 1, commands and state** ([#121]). `editor.state()`,
  `editor.onState(listener)` and `editor.run(id)`, and the commands listed
  above.

- **Version 1, `connect`** ([#120]). `skateHost.connect(editor)` added, with
  `editor.flush()`. A shell no longer calls the page's `flushHostSave()` by
  name; it is not part of the interface. The Node exports a shell may use are
  declared as `SHELL_EXPORTS`.
- **Version 1.** `project` with `name`, `read`, `write`, `media` and `open`
  required, and `importFile`, `discard`, `readHistory`, `writeHistory` and
  `onAdded` optional. Written down for the first time ([#129]); no method
  changed.

[#120]: https://github.com/ankurs47/skate-program-editor/issues/120
[#121]: https://github.com/ankurs47/skate-program-editor/issues/121
[#122]: https://github.com/ankurs47/skate-program-editor/issues/122
[#123]: https://github.com/ankurs47/skate-program-editor/issues/123
[#125]: https://github.com/ankurs47/skate-program-editor/issues/125
[#127]: https://github.com/ankurs47/skate-program-editor/issues/127
[#129]: https://github.com/ankurs47/skate-program-editor/issues/129
[#130]: https://github.com/ankurs47/skate-program-editor/issues/130
[#133]: https://github.com/ankurs47/skate-program-editor/issues/133
[#134]: https://github.com/ankurs47/skate-program-editor/issues/134
[#135]: https://github.com/ankurs47/skate-program-editor/issues/135
