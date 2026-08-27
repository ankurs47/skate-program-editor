# Working on this repo

Notes for anyone — human or AI agent — making changes here. The bullets under
"Traps" are all real bugs that shipped or nearly shipped; they are the reason
this file exists.

## What this is

A browser tool for cutting figure skating program music. Three static files, no
build step, no runtime dependencies, no server. It is used by skaters and their
parents, not by audio engineers — the language in the interface is deliberately
plain, and jargon is treated as a bug.

```text
index.html       the page — stays at the root, see below
src/analysis.js  beats, phrases, loudness, is-this-the-same-recording — samples in, numbers out
src/formats.js   ID3/MPEG/Ogg parsing, the Good/Fair/Low verdict, better-or-worse
src/program.js   what a program is: clips, levels, envelopes, joins, project files
src/host.js      the desktop shell, when there is one — and nothing when there is not
src/canvas.js    colors read from the stylesheet, and the canvas helpers
src/mp3.js       which MP3 encoder this app uses — the only file that knows
src/audio.js     playback scheduling, offline render, WAV encoding, export
src/library.js   decoding files, the song list, remembered file handles
src/timeline.js  the clip strip, the ruler and the playhead
src/editor.js    one clip up close: trims, fades, align, even out, budget
src/dialogs.js   opening and closing modals, and trapping focus in them
src/app.js       state, undo, theme, saving, and the wiring that joins it up
src/style.css    theming via CSS custom properties, light and dark
docs/            help.html — the user guide, linked from the topbar;
                 development.md; docs.css, whose color tokens copy
                 style.css's and are held to them by a test
test/            231 checks, no dependencies — one file per testable script
test/dom/        browser checks and render budgets, driven over CDP
tools/           music-get.sh and .cmd — optional YouTube downloader, not the app
```

`index.html` stays at the repository root and two things keep it there. GitHub
Pages serves this repo from `/` — moving the page would break the published
address, which is the link in the README. And "clone it and open index.html" is
a ground rule, which is easiest to honor when the file is the first thing you
see. Everything it loads sits under `src/`.

`tools/` sits outside the rules below. Nothing in it ships, the editor never
calls it and does not know it exists, and it is the one place an external
dependency is acceptable — the wrappers do nothing but hand arguments to yt-dlp,
which the user installs themselves. The two scripts are the same tool written
twice, once for a shell and once for cmd; a change to one belongs in the other,
and a test asserts the flags that matter appear in both.

## Commands

```bash
npm install      # installs eslint and enables the pre-commit hook
npm test         # unit + wiring + asset checks
npm run lint
npm run check    # lint + unit tests
npm run test:net # also asks npm about the encoder's pinned versions
npm run test:dom # browser checks and render budgets — needs Chrome
npm run test:mutate  # break the code on purpose, check a test notices (~4 min)
```

`main` is protected: pull request required, CI must pass, applies to admins too.
The pre-commit hook runs lint and tests; `--no-verify` skips it.

Checks before every commit come from [pre-commit](https://pre-commit.com) — see
`.pre-commit-config.yaml`. `npm install` turns them on; without `pre-commit` on
the machine it says so and nothing checks your commits until CI does.

## Ground rules

- **No build step and no runtime dependencies.** Anyone must be able to clone
  and open `index.html`. The single exception is the MP3 encoder, which is
  generated — committed under `src/vendor/`, so what runs is still what is in
  the repository, and rebuilding it is a maintainer's job rather than a user's.
- **Audio never leaves the machine.** Files are read with the File API and
  decoded in memory. Nothing is uploaded, and nothing should become uploadable.
- **No personal information in shipped files.** There is a test asserting this.
  Placeholders use generic examples like "my 2026 junior long program".
- **Plain language in the interface.** "Make music file", not "Export". A word
  like _bitrate_, _codec_ or _render_ appearing in visible text is a defect.
  Technical detail belongs in tooltips.
- The app is a set of plain browser scripts, so their functions are global by
  design. `no-implicit-globals` is deliberately disabled — satisfying it would
  mean wrapping every one of them in an IIFE for no benefit.

## How the pieces fit

**The project file speaks the interface's language.** It is read and edited by
hand, so the plain-language rule that governs everything on screen governs it
too: song, start, end, blend, decibels — not `srcStart`, `crossfade` or a gain of
`0.398`. Clips are held in memory under the names the drawing and audio code has
always used, and `readProject` and `project` are the only place the two meet.

Two rules hold that boundary. **Fields this app does not understand are kept**,
top level and per song, so a save here never erases what a desktop shell wrote;
`state.carried` and `state.expectedFiles` carry them. And **a `version` newer
than `FORMAT_VERSION` is refused**, not guessed at — everything else falls back
rather than failing, because a hand-edited file should not be rejected over a
number that can be clamped, but a file whose fields may mean something else
would produce a program that looks right and is not.

**The key names in the schema belong to the editor. Everything else is fair
game, and a tool that is not the editor should keep its fields under a key named
for itself** — two tools that both add `notes` at the top level overwrite each
other, and preservation cannot help with that.

`docs/program.skate.schema.json` is shipped for other tools, maintained by hand,
and checked against a real `project()` document so it cannot quietly describe a
format that has moved on. Every file the app writes carries a `$schema` pointing
at it, and a check holds that URL to the schema's own `$id`, because a drifted
URL does not fail — it 404s and validation silently stops happening.

**Clips carry an id.** It is what lets anything refer to a clip and still mean
the same one after a save. The file is not trusted to have made them unique:
selecting and removing are by id, so `claimId` keeps the first to claim a name
and mints a fresh one for a repeat.

**`notes` goes into git.** The README suggests keeping project files in version
control, so anything written there is published. That is the reason there is no
field for a skater's name — see the check in `repo.test.js` that exists to keep
one out of this repository.

**A desktop shell is a capability, never a dependency.** If one is hosting the
page it puts a single object on `window.skateHost`; `src/host.js` is the only
file that reads it, and decides whether it is usable at all — a shell announcing
a version this app does not know, or a project it cannot read from, is ignored
rather than half-used. Everything a shell makes possible sits behind
`hostPresent()`, and with none the page is exactly the page it was: opened from
a file, no server, nothing installed. A browser check deletes the host and holds
it to that.

The bridge is deliberately not called YouTube, or Electron, or anything else.
The page knows a shell may own a project folder, and that the folder may change
under it — nothing more. Where the music came from is the shell's business.

There used to be a `hostImport()` here, and a button the page rendered under a
name the shell supplied. It is gone. A shell that can fetch music has its own
interface for it, and a control in this page for something this page does not
own was the page describing somebody else's app. What survives is
`hostAdded()`: the shell says the folder changed, and the page reads the folder
again, because the folder is the truth and one way of learning it is enough.

**With a folder, this page stops managing projects.** `PROJECT_CONTROLS` lists
what goes — Save, Load, New, the empty state's Load, and "Forget it all" — and
`hideProjectControls` says what is true either way rather than only ever hiding,
because a function that can take a control away and not put it back makes the
page depend on what ran before it. `shouldOfferStart` keeps the first-run dialog
shut for the same reason: the name and the event were answered before this page
loaded.

**This page never writes a file, and must not start.** A song brought from
outside goes to the shell through `importFile`, which puts it in the project
folder and answers with the name it ended up under — which may not be the name
that was sent, since one already taken gets a number. `addFiles` takes
`fromFolder` to tell the two directions apart: by the time both are `File`
objects nothing else can, and without it the folder's own songs get copied back
into it forever.

**Undo is persisted by the shell, and refused unless it fits.** `historyNow`
records `current`, the snapshot the stacks are relative to, and `restoreHistory`
applies a saved history only when that matches the program just loaded. Anything
else describes a different version of the file, and stepping back into a state
this program never came from is a substitution rather than an undo.

**The edit is data.** `state.clips` is an ordered list of
`{file, srcStart, srcEnd, fadeIn, fadeOut, crossfade}`. Everything else —
timeline, waveforms, playback, export — is derived from it. `layout()` is the
single place that turns clips into timeline positions; nothing should compute
positions independently.

**`crossfade` is an overlap with the _previous_ clip**, so blending makes the
program _shorter_. Clip durations therefore sum to more than the total length.
This trips people up constantly.

**Preview and export share one code path.** `scheduleProgram()` builds the Web
Audio graph for both live playback and the `OfflineAudioContext` render, so what
you hear is what you get. Do not add an export-only path.

**Two views, different jobs.** The clip strip is a _list_ — click to select,
drag to reorder, widths only roughly proportional. The scrubber below it is real
program time, where overlapping blocks are blends. Seeking uses the scrubber.

**Many files, one global scope.** `index.html` loads every `src/*.js` with a
plain script tag, and they share a single scope — so they call into each other
by name with nothing wired up. There is still no build step and no module
system. Nothing runs at load except `init()` at the very end of `app.js`, so the
load order is not load-bearing; it is kept in dependency order because it reads
better that way, and a test asserts the page and the harness agree on it.

The line that matters is the browser: `analysis.js`, `formats.js` and
`program.js` take samples, bytes, clips and settings and return numbers and
descriptions, and never touch the DOM or program state. A test asserts that,
because the split is only worth anything while it holds, and drift would not
break anything until someone tried to test the thing that had drifted. Anything
needing `$()`, `state` or `library` belongs in one of the others.

**Testability.** `app.js` calls `init()` under a browser; under Node every file
exports its own top-level names instead. Node gives each file its own module
scope rather than the shared one, so `app.js` requires them all and puts the
result on `global` — that bridge is the only thing the split costs. Keep new
pure logic out of DOM handlers, and add it to the export list at the bottom of
whichever file it is in. `eslint.config.js` derives each file's cross-file names
from those export blocks — every file is told about every name except its own —
so an export you forget shows up as `no-undef` where it is used.

A `let` that one file declares and another assigns is a mistake worth naming:
the browser shares the binding but Node only copies the value, and eslint
reports it as writing to a read-only global. Give the owning file a small
function that does the write, and call that instead.

**The browser checks are where the DOM half is tested.** `test/dom/` drives real
Chrome over the DevTools Protocol — no dependencies, because Node 22 has a
global `WebSocket` and Chrome speaks CDP over one. They cover what the unit
tests cannot reach: dialogs and focus, the audio graph, key handling, and flows
that only exist as a sequence of clicks. They are opt-in for the same reason
`--net` is, so `npm test` still works with no browser and no network.

Assert on the graph and on page state, never on how long something took or on
what came out of the speakers — nothing is audible headless. And assert on the
graph that was _built_, not the nodes that were constructed: a check watching
`createGain` passes happily while the source is wired straight to the output and
both gain nodes dangle unused. Every check
there has been confirmed to fail when the code it covers is deliberately broken,
which is the only evidence that a test is worth its runtime.

**A test that cannot fail is the failure mode to watch for here.** It has
happened three times: a check that watched two gain nodes being created stayed
green while the audio bypassed them both; a check on a frame fallback could not
fail because headless Chrome paints; a check that "a real change still rebuilds"
missed a stale marker left on screen. All three asserted on something _adjacent_
to the behavior rather than the behavior.

`test/mutations.json` is the guard against that: each entry names an invariant,
a one-line break that violates it, and the check that should catch it.
`npm run test:mutate` applies each in turn and reports `killed`, `SURVIVED` or
`STALE` — stale counting as a failure, because a mutation that no longer applies
is not evidence of anything. **When you add a check worth trusting, add the
mutation that proves it can fail.** It runs on every push to `main`, weekly, and
on demand; not on pull requests, where it would add minutes to every push and
break for reasons unrelated to the change.

**Write the anchor against the formatted file, not the one you typed.** Prettier
reflows a ternary and rewrites a quote on the way into the commit, and an anchor
matching the shape you wrote stops matching the shape that lands — silently,
because only a mutation run looks. Add the mutation, run the hooks, then check
the anchor still matches. `repo.test.js` checks every anchor on every commit for
exactly this reason, so the second it costs there is an afternoon it does not
cost in a mutation run.

**Run it in a worktree, which is what `npm run test:mutate` now does.** The
runner edits source files in place, so a run and an edit in the same tree ruin
each other: your change lands mid-run and its results describe a file nobody
wrote, then the runner's restore puts its own copy back over what you changed.
Both happened, twice, before `tools/mutate-worktree.sh` existed. It builds a
throwaway worktree from HEAD, so the tree you are working in is never touched
and you can keep editing while it runs — which also means **uncommitted work is
not tested**, and the script refuses to start rather than pretend otherwise.

`test/mutate.js` refuses to run anywhere but a throwaway worktree, so the way in
is the script. `npm run test:mutate:here` passes `--in-place` and is the way
past it, for the case the worktree cannot cover: uncommitted work a checkout of
HEAD would not contain. Touch nothing while that one runs — the danger is not
the mutating, it is that a `git add` or a commit in the middle records code
nobody wrote, and restoring afterwards does not unread what was already read.

The runner restores from a copy in memory, never with git: a `git checkout --`
takes uncommitted work with it.

The unit tests follow what can be tested without a DOM —
`test/analysis.test.js`, `test/formats.test.js` and `test/app.test.js`, the last
of which is mostly about `program.js` — plus three that are not about any one
source file: `assets.test.js` for the app's own wiring, `site.test.js` for what
gets published, `repo.test.js` for rules that hold everywhere.
`test/harness.js` holds `check`/`eq`/`near`/`ok`; `test/run.js` loads the files,
runs what they queued, and reports. A new test goes in the file matching the
code it covers. `check` queues rather than runs, which is what lets an async
body be an ordinary check — run on the spot, an async one was counted as passed
the moment it started and everything it went on to assert was thrown away.
Requiring `app.js` still gets everything, because it re-exports the others.

A check that reads source text reads `SCRIPTS`, not one file by name. This
matters most for a check that asserts something is _absent_: pointed at a single
file, it passes on the strength of not having looked.

**Beat detection answers with a confidence, and callers must honor it.**
`analyzeBeats()` finds a tempo and a beat grid in a window of samples;
`suggestJoin()` uses two of those to nudge a pair of cut points onto the beat.
Both are pure, and beat times are relative to the window they were measured in,
never to the song. The grid is _always_ found — on applause, on a held chord, on
silence — so `confidence` below `BEAT.minConfidence` means leave the edit alone.
Snapping a rubato piece to an invented grid is the worst outcome available here,
worse than doing nothing. `alignSelectedJoin()` is the only caller: it takes the
snapshot for undo _after_ deciding to act, so a declined suggestion doesn't leave
a no-op on the undo stack.

**The join button has two strategies, and beats is only the first.** Much
skating music — solo piano especially — has no steady pulse, and `analyzeBeats`
correctly refuses to name one. `suggestJoinForBuffers()` then falls back to
`suggestPhraseJoin()`, which cuts at phrase boundaries found from lulls in the
onset envelope and changes of harmony in a chroma curve. Both strategies return
the same shape of answer, distinguished by `reason`, so callers do not care
which ran — but the message to the user does say which, because it tells her
the music has no beat and that the advice for it is different. Only when both
decline does nothing happen.

**Loudness is measured on the kept part of a clip, never the whole file.** They
trimmed twenty seconds out of a four-minute song; the rest is not in the
program and must not influence its level. `measureClip()` takes the trim
bounds for that reason, and because the answer goes stale the moment anything is
re-trimmed, it is recomputed on demand rather than cached against the file — a
gating pass over thirty seconds is about 25 ms, which is cheaper than being
wrong. `solveGains()` then turns those measurements into one gain per clip.

**`gain` is a plain multiplier on the clip, applied by its own node.** It sits
before the fade and blend nodes in `scheduleProgram()` rather than being folded
into either, so the fade still runs 0 to 1 and the two sides of a crossfade
still sum to 1 whatever the levels are. Preview and export therefore get it for
free. The slider works in decibels, because that is what tracks how loud a
change _sounds_, but stores and shows the multiplier — `LEVEL_SLIDER` and the
`min`/`max` on the HTML input have to agree, and a test says so.

**A project cannot record where a file is, only what it was.** A browser will
not tell a page where a file lives — `File` has a name and nothing else — and a
`FileSystemFileHandle` is structured-cloneable but not JSON, so neither a path
nor a handle can go in the project file. What goes in instead is the `files`
section: a size, a length, and a `fingerprint()` of the bytes at the audio start,
which is enough to say "this is a different song with the same name". That
matters because the failure is silent: the trims still apply and the timer still
reads correctly around the wrong music. Fingerprints are taken from the audio
start, not the head of the file, so retagging does not make a file a stranger,
and FNV-1a rather than a digest because `crypto.subtle` needs a secure context
and this has to work over `file://`.

**Remembering files is an extra and must stay one.** `canRememberFiles()` gates
everything on the File System Access API being present in a secure context. In
practice that means Chrome and Edge — including from `file://`, which Chrome
treats as trustworthy, so opening the page from disk keeps the feature rather
than losing it. Firefox and Safari have no picker at all and take the fallback:
the hidden `<input>` does the picking and the notice asks for the files by hand,
exactly as before.

Feature-detect, never sniff the protocol. Chrome treats `file://` as a secure
context, so `showOpenFilePicker` and IndexedDB are both available there — a rule
written against the protocol would be wrong. There is a browser check that
deletes `showOpenFilePicker` and asserts the fallbacks still fire; do not let
anything above become load-bearing.

## Traps

- **A single MPEG sync word means nothing.** Compressed audio is full of `0xFF`
  bytes followed by high bits, so scanning Opus data will find a "frame" almost
  immediately and report a confident, wrong bitrate. `readMpegFrame()` requires
  three consecutive frames exactly `frameLength` apart. Do not relax this.
- **ID3 tags are not small.** With embedded artwork they run to 400 KB+, so any
  window into a file must start _after_ the tag, and any size-based bitrate
  estimate must subtract it. Ogg hides cover art in the comment header instead —
  `oggAudioStart()` skips it.
- **`buffer.sampleRate` is the AudioContext's rate, not the file's.** Everything
  is resampled to 44100 on decode. Only a real header tells you the source rate;
  otherwise leave it unknown rather than reporting a number you invented.
- **Quality thresholds are in MP3-equivalent terms.** Opus at 128 kbps sounds
  roughly like MP3 at 190, so `CODEC_EFFICIENCY` scales the measured bitrate
  before comparison. Badges show a verdict (_Good / Fair / Low_) and never a
  number, because raw bitrates invite exactly the wrong comparison.
- **Fade curves must stay linear.** `afade`/`acrossfade` in ffmpeg default to
  `tri`, which matches Web Audio's `linearRampToValueAtTime`. The two sides of a
  crossfade sum to 1 through the overlap; a test asserts this. Switching to an
  equal-power curve would need both sides changed together.
- **Whole-frame autocorrelation lags report half the tempo.** Two separate
  causes, and both bit. A beat period is never a whole number of analysis
  frames, so each beat straddles the frame boundary differently and alternate
  beats measure weaker — a period-two pattern the autocorrelation reports as
  half speed. The fix is the one-frame blur at the top of `flattenEnvelope()`.
  Searching fractional lags instead is _not_ a fix: interpolating the envelope
  flattens the very peaks being correlated, by an amount that depends on the
  fractional part, so the scan then prefers round lags for a different reason.
  Integer lags find the neighborhood; `refinePeriod()` finds the value.
- **A confidence that is a maximum needs a baseline that is also a maximum.**
  The grid score is the best over dozens of phases, and taking a best lifts the
  number on anything, structure or not — white noise scored 0.5 before
  `combBaseline()` existed. It scores unrelated periods the same way so the free
  lift cancels. Periods related to the answer by a simple ratio are excluded
  from it, or the evidence ends up in the denominator.
- **A sustained chord fits a beat grid beautifully.** Nothing starts, so the
  only flux is analysis leakage, which is faint and perfectly periodic. Contrast
  alone rates it highly; the `BEAT.minOnsets` term is what rejects it, by asking
  whether any notes start at all before believing the tempo.
- **BS.1770 publishes its coefficients at 48 kHz and nothing else.** Everything
  here is decoded to 44100, so `kWeighting()` derives them from the prototype
  values instead. Copying the published table straight in gives a filter tuned
  to the wrong frequencies. A test feeds it 48000 and checks it reproduces that
  table to twelve decimals, which is what says the derivation is honest.
- **Loudness gating is not a refinement.** Without the absolute gate, a cut that
  ends in a long fade measures far below what anyone hears and gets boosted for
  it; without the relative gate, a quiet passage does the same thing more
  subtly. Both are tested with the size of the mistake they prevent — around
  6 dB — asserted alongside, so neither can be dropped as an optimization.
- **Mono is measured 3 dB louder than the standard says.** Web Audio copies a
  mono buffer to both speakers, so measuring it as a single channel would leave
  every mono file reading 3 dB quiet and ending up that much too loud. This is a
  deliberate departure from BS.1770 and the reason `loudnessOf()` weights a lone
  channel by two. ffmpeg's meter differs from ours by exactly this much on mono,
  and by nothing on stereo — that agreement is a test.
- **Sample peaks understate the real ones.** Inter-sample peaks after encoding
  run above anything visible in the samples, which is what `LOUDNESS.ceiling`
  leaves room for. `encodeWav()` clamps, so overshoot is flat-topped distortion
  rather than wrap-around noise — audible, not catastrophic, and still to be
  prevented rather than survived.
- **Two silences are not a change of harmony.** Chroma vectors for silence are
  all zero, and a cosine distance between two zero vectors reads as maximally
  different — so every moment of a quiet passage scored as a phrase boundary.
  `chromaDistance()` returns 0 when either side has no energy; silence is the
  gap score's job, not the novelty score's.
- **Peak-picking an unsmoothed curve finds hundreds of boundaries.** Frame to
  frame wobble in the onset envelope produced 568 "phrase breaks" in a twelve
  second window, which is the same as finding none. `phrasePoints()` smooths
  before looking for peaks and then keeps only the best of each cluster — a
  boundary is an event, not a region.
- **A free-tempo test fixture must be genuinely irregular.** The first one
  spaced its phrases about 3.5 s apart, which the beat detector duly locked
  onto, so the fallback never ran and the test proved nothing. Fixtures for this
  path assert that `analyzeBeats` is below `BEAT.minConfidence` on the exact
  window under test, so they fail loudly rather than silently testing the wrong
  branch.
- **Sparse music still reads as having a beat more often than it should.**
  A dozen piano notes in a twelve second window let a metronome fit a few of
  them by chance, and the contrast measure in `analyzeBeats` rates that as
  confidently as a drum track. `BEAT.minCoverage` — what share of the grid's
  beats are actually played — damps it, and cut the affected windows of the test
  fixture from 33 of 55 to 12. It is not a cure. Finishing this needs real piano
  recordings to calibrate against, not more work against synthetic fixtures,
  which is why the tests assert that coverage _separates_ the two cases rather
  than that every sparse window is rejected. Until then some free-tempo music
  gets the beat strategy when it should get phrasing.
- **Round to the precision you display, then split the minutes off.** The other
  way round, any value reaching 60 once rounded shows as sixty seconds instead
  of carrying: a 59.98 second program reads `0:60.0` on the timer, and a 119.6
  second song lists as `1:60`. It is an easy one to miss by eye, because the
  level times that dominate the interface are all whole minutes.
- **A project's trims are unchecked until the audio turns up.** The file is not
  in the project, so nothing has compared `srcEnd` against a real duration until
  `addFiles` decodes one. Web Audio does not complain when a source is asked to
  play past its end — it plays silence — so a shorter copy of a song gave a clip
  duration that was a lie and an exported program of the wrong length, with
  nothing said. `clampClipsToFile()` runs on every decode and reports what it
  had to change.
- **Waiting on a frame in a background tab waits forever.** `withBusy()` yields
  two frames so the disabled state paints before the work blocks the thread. A
  hidden tab stops painting entirely, so `requestAnimationFrame` never fires and
  the button would sit on "Working…" with the work never run — which is exactly
  what happened the first time this was exercised in a background tab. The
  `setTimeout` alongside it is not belt-and-braces; it is the only thing that
  runs when the tab is not visible.
- **A drop is not a reorder just because something landed on a clip.** The
  timeline read `text/plain` off the drag and passed it to `moveClip`, checking
  only the destination index. A dragged text selection parses to NaN, every
  comparison against NaN is false, and `splice(NaN, 1)` coerces to
  `splice(0, 1)` — so a stray drop silently moved the _first_ song. Tightening
  the guard is not enough on its own: a dropped **file** leaves `text/plain`
  empty, and `Number('')` is 0, a perfectly valid index. The drag is identified
  by a private type (`CLIP_DRAG_TYPE`) that only these blocks publish, and
  `reordered()` validates both indices. Keep both halves.
- **A key repeat is one gesture, not thirty edits.** Held keys fire about thirty
  `keydown`s a second. A snapshot on each one fills the sixty-deep stack in two
  seconds and takes every earlier edit with it — an undo stack destroying the
  history it exists to hold. `pushUndo(tag)` coalesces a run of the same tag within
  `UNDO_COALESCE_MS`; untagged callers never coalesce and end any run. `undo()`
  must call `endUndoRun()`, or the next repeat folds into the gesture whose
  snapshot was just popped and becomes unundoable. Sliders solve the same
  problem with an `editing` flag, because a drag has an end event to hang it on.
- **The audition is a third playback path, and it drifts.** `AGENTS.md` says
  preview and export share `scheduleProgram`, and they do — but
  `playClipAudition()` builds its own graph, and for a long time that graph was
  `source → destination`, so **Play this song** ignored the clip's level and
  fades entirely. Setting a song to 40% and then auditioning it at 100% teaches
  the wrong thing about the edit. It now applies level and `fadeEnvelope`;
  the blend is deliberately left out, because that belongs to the join and there
  is no previous song here to blend with. Anything added to a clip that affects
  how it sounds has to be added in both places.
- **Grid and flex items need `min-width: 0`.** A long clip name once widened the
  whole column and pushed the buttons off-screen. Relatedly, the timeline sizes
  clips with `flex-grow`, not computed pixels — computing widths from the
  program length overflowed, because of the overlap point above.
- **`decodeAudioData` detaches its ArrayBuffer.** Copy any bytes you need for
  header inspection _before_ decoding.
- **Decoded audio is uncompressed** — roughly 90 MB per four minutes of stereo.
  This is why tablets get a warning and why files are decoded on demand.

## Things that must stay verifiable

**Program lengths** in the `LEVELS` table are set by the ISU and U.S. Figure
Skating and change between seasons. They are a convenience, not an authority.
Every dropdown option shows its time beside the level name so a wrong number is
visible rather than hidden, and saved projects store the actual target seconds
rather than only a level id — so reopening an old project never silently
retargets it. Keep both properties.

**Changing the MP3 encoder is one file.** `src/mp3.js` hands `audio.js` an
encoder during startup — `load(spec)` to get ready and answer whether it can
produce what the app promises, `encode(buffer, spec, onProgress)` to make the
file — and `audio.js` knows nothing else about it. A different library is a
rewrite of `src/mp3.js` and nothing more: not the page, not the script list, not
`audio.js`, which a check enforces by refusing to let a library name appear
there. The bitrate lives in `audio.js` because 320 kbps is a promise this app
makes to a competition, and an encoder's job is to satisfy it, not choose it.

Registration happens during `init()` rather than when the file loads, so the
order the page lists its scripts in stays something nobody has to think about.
An app with no encoder installed at all is a supported state: export offers WAV
and says why.

**The vendored MP3 encoder** (`src/vendor/mp3-encoder.js`) is generated and
committed. `npm run check:encoder` rebuilds it from the versions pinned in
`tools/build-mp3-encoder.js` and fails if the bytes differ, which is what makes
400 KB of somebody else's code reviewable: it is traceable to two npm versions
and a bundler, and to nothing else. `npm run test:net` asks npm whether those
versions are still the bytes that were published.

It is a classic script, not a module, and that is not a style choice. A page
opened from `file://` is an opaque origin and cannot load a local ES module at
all — the import is refused before the file is read — while an injected classic
script loads fine. Both are checked behavior, not assumed.

## Conventions

- Comments explain _why_, not _what_. Several above exist only because the
  obvious implementation was wrong.
- Errors say what happened and what would fix it, in the user's terms.
- Destructive actions confirm first, name what will be lost, and put the safe
  option under focus.
- New user-facing strings get the plain-language treatment; new pure functions
  get a test.
