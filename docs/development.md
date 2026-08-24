# Development

Everything needed to change this project with confidence. It is written for a
person; [`AGENTS.md`](../AGENTS.md) at the repository root is the same territory
compressed for an agent, and carries the architecture walkthrough and the list of
traps that produced real bugs. Read that too before changing anything in `src/`.

- [The shape of it](#the-shape-of-it)
- [Setup](#setup)
- [Commands](#commands)
- [Layout](#layout)
- [The three layers of testing](#the-three-layers-of-testing)
  - [Unit checks](#unit-checks)
  - [Browser checks](#browser-checks)
  - [Mutation testing](#mutation-testing)
- [Continuous integration](#continuous-integration)
- [Ground rules](#ground-rules)
- [Adding a test](#adding-a-test)
- [Making a change](#making-a-change)

## The shape of it

**No build step. No runtime dependencies.** Anyone can clone the repository and
open `index.html` from disk, and it works. The single devDependency is eslint,
and it is only for checking changes — nothing it does is needed to run the app.

That constraint is the reason for most of what follows. There is no bundler, so
the three scripts share one global scope and load in a fixed order. There is no
test framework, so the harness is forty lines. There is no headless-browser
library, so the DOM tests drive Chrome over the DevTools Protocol using the
`WebSocket` that Node 22 already has.

The one outbound request the page makes is for the MP3 encoder, from a CDN,
pinned with a Subresource Integrity hash. If it cannot be reached the editor
still works and export falls back to WAV.

## Setup

```bash
git clone https://github.com/ankurs47/skate-program-editor
cd skate-program-editor
npm install
```

`npm install` also points git at `.githooks`, so **lint and tests run before
every commit**. `git commit --no-verify` skips it in an emergency.

Node 22 or later, for the global `WebSocket` the browser tests need. Chrome or
Chromium on `PATH` for `npm run test:dom`; without one, that suite is the only
thing that will not run.

## Commands

```bash
npm test             # 161 unit, wiring and asset checks — fast, no browser
npm run lint
npm run check        # lint + test, which is what the pre-commit hook runs
npm run test:net     # also re-verifies the pinned CDN hash over the network
npm run test:dom     # browser checks and render budgets — needs Chrome
npm run test:mutate  # break the code on purpose, check a test notices (~4 min)
                     # runs in a throwaway worktree; needs a clean tree
```

`npm test` deliberately excludes the browser suite so it stays fast and works on
a machine with no Chrome. CI runs both.

`--report <path>` on either runner writes the outcome as JSON, which is how CI
gets the numbers it posts on a pull request rather than any written down by hand.

## Layout

```
index.html            the whole interface; stays at the root, because
                      GitHub Pages serves from / and "open index.html"
                      has to keep working from disk
src/
  analysis.js         pure DSP — beats, phrases, loudness. No DOM.
  formats.js          container and codec parsing, quality verdicts,
                      file fingerprints. No DOM.
  app.js              state, DOM, playback, export, and all the wiring
  style.css
docs/
  help.html           the user-facing guide, linked from the app
  development.md      this file
  docs.css
test/
  harness.js          check/eq/near/ok, and where the shipped files are
  run.js              runs the four unit files
  *.test.js           one per source file, plus assets.test.js for wiring
  dom/                headless-Chrome checks over CDP
  mutate.js           the mutation runner
  mutations.json      the mutations themselves
  summary.js          renders the CI pull-request comment
tools/                the YouTube download wrappers
```

`analysis.js` and `formats.js` are the halves that can be tested without a DOM,
and a test asserts they stay that way: one `document.`, one `window.`, one reach
into `state` and the split has quietly stopped being worth anything.

`app.js` is a plain browser script, so its functions are global by design.
`no-implicit-globals` is disabled deliberately — satisfying it would mean
wrapping two thousand lines in an IIFE for no benefit. Under Node it requires
the other two and re-exports them, so a test file asking for `app` gets
everything.

## The three layers of testing

Each layer exists because the one below it cannot see a particular class of
mistake.

### Unit checks

`npm test` — 161 checks across four files, no browser, under a second.

They cover the parts that are easy to get quietly wrong: timeline maths with
overlapping blends, fade and crossfade envelopes summing correctly, filename
sanitising across platforms, per-codec quality thresholds, the MPEG frame parser
refusing to match non-MPEG data, beat detection reading the right tempo off a
known one while declining to claim a beat in material that has none, and loudness
measurement agreeing with an independent meter.

`assets.test.js` covers the wiring rather than the logic: that a saved project
survives a round trip through the file format, that every element id the code
reaches for exists in the HTML, that every help button has content, that both
color themes define the same variables, and that no personal information or
local path ever ships.

The harness catches, so one failure does not hide the rest. A run reports
everything that is wrong at once, which is what makes it worth running after a
refactor rather than before.

### Browser checks

`npm run test:dom` — 29 checks in real headless Chrome, driven over the DevTools
Protocol. No dependency: Node 22 has a global `WebSocket`, and Chrome speaks CDP
over one.

This layer covers the half of the editor the unit tests cannot reach — dialogs
and focus trapping, the audio graph's actual topology, key handling, and the
flows that only exist as a sequence of clicks.

It also holds **render budgets**: assertions that dragging a slider resolves no
styles, creates no elements and coalesces its waveform drawing to one batch a
frame. Those are *counts*, and counts are assertable. Wall-clock timings are
collected and reported but never asserted, because they are not comparable
between a laptop and a CI runner — a number that moves for reasons unrelated to
the change is not evidence.

### Mutation testing

`npm run test:mutate` — around four minutes.

The runner takes each entry in `test/mutations.json`, applies that one edit to
the source, runs the suite it names, and requires the suite to **fail**. A
mutation the tests do not notice is reported as `SURVIVED`, and it means a test
that cannot fail — which is worse than no test, because it reads like coverage.

This found two real ones. The audition check asserted that gain nodes were
*created*, which stayed true when the audition bypassed them; it now walks the
actual graph. And a check on the busy state could not fail because headless
Chrome always paints; it now stubs `requestAnimationFrame` to never fire.

Each mutation carries a `guards` line saying what property it defends and an
`expect` string naming the failure it should produce. If the mutation applies but
the *expected* failure does not appear, it is reported `STALE` — the code moved
and the mutation is now testing something else. Stale counts as a failure.

**It runs in a throwaway git worktree**, built from HEAD by
`tools/mutate-worktree.sh`. The runner edits source files in place, and doing
that in the tree you are working in ruins both sides: your edit lands in the
middle of a run, so the results describe a file nobody wrote, and then the
runner's restore writes its own copy back over what you changed. That happened
twice before the script existed.

The worktree means you can keep editing while it runs. It also means
**uncommitted work is not tested** — the script refuses to start on a dirty tree
rather than quietly testing something else. `npm run test:mutate:here` is the
old in-place behavior if you want it.

The runner restores from in-memory copies of the files, never from git. This is
not a stylistic preference: an earlier version used `git checkout --` and
destroyed uncommitted work.

## Continuous integration

`main` is protected — pull request required, CI must pass, and it applies to
admins too.

**`ci.yml`** runs on every pull request: lint, then the unit suite with `--net`,
then the browser suite, each writing a JSON report. It then posts a single
comment on the pull request with the counts and timings, updating that same
comment on each push rather than adding another. It runs under `always()`, so a
failing suite still gets its summary posted. Fork pull requests skip the comment,
because their token cannot write one.

**`mutation.yml`** runs on every push to `main`, weekly, and on demand. If any
mutation survives it opens — or comments on — an issue labeled `mutation`.

## Ground rules

These are the ones that will get a change rejected, and they are the same list
`AGENTS.md` gives:

- **No build step and no runtime dependencies.** The CDN-hosted MP3 encoder,
  integrity-pinned, is the single exception.
- **Audio never leaves the machine.** Files are read with the File API and
  decoded in memory. Nothing is uploaded, and nothing should become uploadable.
- **No personal information in shipped files.** There is a test asserting it,
  and it works from salted hashes so the words it guards against are not in the
  repository in plain text. Placeholders use generic examples like
  `my 2026 junior long program`.
- **Plain language in the interface.** "Make music file", not "Export". A word
  like *bitrate*, *codec* or *render* appearing in visible text is a defect;
  technical detail belongs in a tooltip.
- **Feature-detect, never sniff the protocol.** An earlier version of the
  documentation asserted the File System Access API was unavailable from
  `file://`. Chrome treats `file://` as a secure context, so it is available, and
  the claim was simply wrong.

## Adding a test

Put it in the file matching the source file it covers — `analysis.test.js`,
`formats.test.js`, `app.test.js` — or in `assets.test.js` if it is about wiring
or the shipped files rather than logic.

```js
check('what should be true, in a sentence', () => {
  eq(actual, expected, 'context: ');
});
```

`check` catches, `eq` compares as JSON, `near` takes a tolerance, `ok` asserts a
condition with a message. There is nothing else, and there does not need to be.

Then add a mutation to `test/mutations.json` that breaks the thing the test
guards, and confirm the test catches it:

```bash
npm run test:mutate
```

A test that ships without one is a test nobody has proved can fail.

## Making a change

1. Branch. `main` will not take a direct push.
2. Make the change, and add tests at whichever layers can see it.
3. `npm run check`, and `npm run test:dom` if anything touched the DOM.
4. **Commit** — then `npm run test:mutate` if the change touched logic. It
   builds its worktree from HEAD, so it has nothing to test until you do.
5. Open a pull request. CI will post the counts as a comment.

The two things worth knowing before you start are in `AGENTS.md`: the
[architecture walkthrough](../AGENTS.md#how-the-pieces-fit), and the
[traps](../AGENTS.md#traps) — a list of shipped bugs and what each one taught,
which is the fastest way to avoid writing the next one.
