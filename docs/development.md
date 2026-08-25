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
the scripts share one global scope and are listed by hand in the page. There is no
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

`npm install` turns on a pre-commit hook, so **checks run before every commit**.
`git commit --no-verify` skips it in an emergency.

The hooks are in `.pre-commit-config.yaml`: whitespace and end-of-file fixes,
YAML and JSON parsing, yamllint, markdownlint, shellcheck over the shell scripts,
codespell, Prettier, stylelint, then eslint and the unit suite.

`npm install` runs `tools/install-hooks.js`, which turns them on. Without
`pre-commit` on the machine it says so and stops — a missing tool should not fail
someone's install — and nothing checks your commits until CI does.

This is the only hook path. A plain git hook for anyone without the framework
would be a second thing to understand and much the weaker of the two: no
shellcheck, no spelling, no formatting, none of the file hygiene.

CI runs the same hooks, so a contributor without the framework still cannot land
trailing whitespace, a shell bug or a typo.

codespell runs with `--builtin=clear,rare,en-GB_to_en-US`. That last dictionary
is what keeps the spelling American. It matches whole words, which matters:
`aria-labelledby` is an ARIA attribute whose spelling is fixed by the spec, and
a matcher working on substrings flags the British form inside it and invites a
"fix" that renames the attribute and takes four dialogs' accessible names away.

Exceptions go in `.codespell-ignore`, each with a comment saying why. A check in
`repo.test.js` asserts the dictionary is still switched on, reading the argument
rather than the file — written the lazy way it passed while the dictionary was
off, because the comment above the hook happens to name it.

Where a hook answers a question, the test suite does not ask it again. Prettier's
HTML parser rejects unbalanced tags, stylelint rejects an unclosed CSS block, and
a syntax error in any script takes the whole suite down at require time, since
the harness requires `app.js` and `app.js` requires the rest.

The suite covers what nothing else does — a `var(--name)` with no matching
definition passes stylelint happily, and only `assets.test.js` notices.

`.yamllint` and `.markdownlint.json` draw the same line: **Prettier decides
layout, the linters decide whether the document is sound.** Every rule switched
off in them is one Prettier already has an opinion about, because two tools
rewriting the same file in opposite directions on each commit is a loop rather
than a quality bar — yamllint's default wants two spaces before an inline
comment and Prettier collapses to one, which is exactly that.

Line length is off in both, for a reason worth stating: nothing can enforce it.
Prettier does not reach inside a `run: |` block, a `${{ }}` expression cannot be
broken across lines at all, and `proseWrap: preserve` means prose is left as
written. Every finding would be a line no tool will ever fix.

`MD033` is allowed by element rather than switched off — GitHub markdown cannot
center a logo or lay out a badge row without inline HTML, so the tags the README
uses are listed and a `<script>` appearing there would still be a finding.

Two shellcheck findings are suppressed in place with the reason written down
rather than fixed, because both are deliberate: `music-get.sh` splits `$limit`
into two words on purpose and is `/bin/sh` with no arrays to do it otherwise,
and `mutate-worktree.sh` indents a multi-line value, which parameter expansion
cannot do.

Node 22 or later, for the global `WebSocket` the browser tests need. Chrome or
Chromium on `PATH` for `npm run test:dom`; without one, that suite is the only
thing that will not run.

## Commands

```bash
npm test             # 167 unit, wiring and asset checks — fast, no browser
npm run lint
npm run check        # lint + test, which is what the pre-commit hook runs
npm run test:net     # also re-verifies the pinned CDN hash over the network
npm run test:dom     # browser checks and render budgets — needs Chrome
npm run screenshot   # regenerate the README picture from a real, driven app
npm run check:sources # have the ISU or USFS published anything since we looked?
npm run test:mutate  # break the code on purpose, check a test notices (~4 min)
                     # runs in a throwaway worktree; needs a clean tree
```

`npm test` deliberately excludes the browser suite so it stays fast and works on
a machine with no Chrome. CI runs both.

`--report <path>` on either runner writes the outcome as JSON, which is how CI
gets the numbers it posts on a pull request rather than any written down by hand.

## Layout

```text
index.html            the whole interface; stays at the root, because
                      GitHub Pages serves from / and "open index.html"
                      has to keep working from disk
src/
  analysis.js         pure DSP — beats, phrases, loudness. No DOM.
  formats.js          container and codec parsing, quality verdicts,
                      file fingerprints. No DOM.
  program.js          what a program is — clips, levels, envelopes,
                      joins, project files. No DOM.
  canvas.js           theme colors and the canvas helpers
  audio.js            playback, offline render, WAV and MP3 encoding
  library.js          decoding files, the song list, remembered handles
  timeline.js         the clip strip, the ruler, the playhead
  editor.js           one clip up close, and what acts on a selection
  dialogs.js          modals, and keeping the keyboard inside them
  app.js              state, undo, theme, saving, and all the wiring
  style.css
docs/
  help.html           the user-facing guide, linked from the app
  screenshot.png      the README picture — regenerate, never hand-crop
  social-card.png     what a link to the site unfurls as
  development.md      this file
  docs.css
test/
  harness.js          check/eq/near/ok, and where the shipped files are
  run.js              loads the test files and reports the totals
  analysis.test.js    beats, phrases, loudness
  formats.test.js     container and codec parsing, the quality verdict
  app.test.js         layout, envelopes, undo, the project file
  assets.test.js      wiring, and the app's own files
  site.test.js        the guide, the logo, and how a link to this looks
  repo.test.js        what must never ship, and how everything is spelled
  dom/                headless-Chrome checks over CDP
  mutate.js           the mutation runner
  mutations.json      the mutations themselves
  summary.js          renders the CI pull-request comment
tools/                the YouTube download wrappers
```

`analysis.js`, `formats.js` and `program.js` are the parts that can be tested
without a DOM, and a test asserts they stay that way: one `document.`, one
`window.`, one reach into `state` and the split has quietly stopped being worth
anything. Almost every unit test points at one of the three.

The rest are plain browser scripts, so their functions are global by design.
`no-implicit-globals` is disabled deliberately — satisfying it would mean
wrapping every file in an IIFE for no benefit. Under Node, `app.js` requires all
of them and re-exports them, so a test file asking for `app` gets everything.
Nothing runs when a file is loaded, which is what makes that safe and what makes
the order of the script tags a matter of readability rather than correctness.

## The three layers of testing

Each layer exists because the one below it cannot see a particular class of
mistake.

### Unit checks

`npm test` — 167 checks across six files, no browser, under a second.

They cover the parts that are easy to get quietly wrong: timeline math with
overlapping blends, fade and crossfade envelopes summing correctly, filename
sanitizing across platforms, per-codec quality thresholds, the MPEG frame parser
refusing to match non-MPEG data, beat detection reading the right tempo off a
known one while declining to claim a beat in material that has none, and loudness
measurement agreeing with an independent meter.

Three more cover things that are not logic at all. `assets.test.js` is the
wiring: every element id the code reaches for exists in the HTML, every help
button has content, both color themes define the same variables, and every
custom property used is defined somewhere. `site.test.js`
is what gets served: the guide, the logo, the README badges, and the tags that
decide how a link to this looks in a search result. `repo.test.js` is the rules
that apply everywhere: no personal information, no path off this machine, and
American spellings including in comments.

They were one file until it had grown to twenty-seven checks across three
unrelated subjects, which is how a test file stops being somewhere anyone
thinks to look.

The harness catches, so one failure does not hide the rest. A run reports
everything that is wrong at once, which is what makes it worth running after a
refactor rather than before.

### Browser checks

`npm run test:dom` — 36 checks in real headless Chrome, driven over the DevTools
Protocol. No dependency: Node 22 has a global `WebSocket`, and Chrome speaks CDP
over one.

This layer covers the half of the editor the unit tests cannot reach — dialogs
and focus trapping, the audio graph's actual topology, key handling, and the
flows that only exist as a sequence of clicks.

It also holds **render budgets**: assertions that dragging a slider resolves no
styles, creates no elements and coalesces its waveform drawing to one batch a
frame. Those are _counts_, and counts are assertable. Wall-clock timings are
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
_created_, which stayed true when the audition bypassed them; it now walks the
actual graph. And a check on the busy state could not fail because headless
Chrome always paints; it now stubs `requestAnimationFrame` to never fire.

Each mutation carries a `guards` line saying what property it defends and an
`expect` string naming the failure it should produce. If the mutation applies but
the _expected_ failure does not appear, it is reported `STALE` — the code moved
and the mutation is now testing something else. Stale counts as a failure.

**It runs in a throwaway git worktree**, built from HEAD by
`tools/mutate-worktree.sh`. The runner edits source files in place, and doing
that in the tree you are working in ruins both sides: your edit lands in the
middle of a run, so the results describe a file nobody wrote, and then the
runner's restore writes its own copy back over what you changed. That happened
twice before the script existed.

The worktree means you can keep editing while it runs. It also means
**uncommitted work is not tested** — the script refuses to start on a dirty tree
rather than quietly testing something else. `npm run test:mutate:here` runs it
in place if you want that.

The runner restores from in-memory copies of the files, never from git. This is
not a stylistic preference: `git checkout --` takes uncommitted work with it.

The worktree cannot protect `tools/mutate-worktree.sh` itself. Bash reads a
script by byte offset as it runs, so editing one mid-run makes it resume in the
wrong place and fail with something unrecognizable. Let a run finish first.

## Continuous integration

`main` is protected — pull request required, CI must pass, and it applies to
admins too.

**`ci.yml`** runs on every pull request: lint, then the unit suite with `--net`,
then the browser suite, each writing a JSON report. It then posts a single
comment on the pull request with the counts and timings, updating that same
comment on each push rather than adding another. It runs under `always()`, so a
failing suite still gets its summary posted. Fork pull requests skip the comment,
because their token cannot write one.

**`sources.yml`** runs monthly. It asks whether the ISU or U.S. Figure Skating
have published anything since a person last checked the program lengths in
`LEVELS`, and opens an issue if so.

It deliberately does **not** claim to verify the times. Neither body publishes
durations anywhere machine-readable — they live in season-specific PDFs whose
addresses change — so a job reporting "program lengths verified" would be
guessing, and would quietly contradict the disclaimer the app and the README
both carry. What it watches instead is stable and meaningful when it moves: the
list of numbered ISU Communications, and the season the USFS rules hub names.
Whole-page hashes were the first attempt and were useless — both pages carry
per-request tokens, so every run would have fired.

When you have checked, update `tools/sources.json` with
`npm run check:sources -- --update` and commit it. Until that baseline moves the
job keeps asking, which is the point: merging an acknowledgment without looking
would reset the tripwire and lose the question.

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
  like _bitrate_, _codec_ or _render_ appearing in visible text is a defect;
  technical detail belongs in a tooltip.
- **Feature-detect, never sniff the protocol.** Chrome treats `file://` as a
  secure context, so the File System Access API is available from there. A rule
  written against the protocol rather than the feature gets this wrong.

## Adding a test

Put it in the file matching the source file it covers — `analysis.test.js`,
`formats.test.js`, `app.test.js`. If it is not about logic, ask what it is
about: the app's own wiring goes in `assets.test.js`, anything published in
`site.test.js`, and a rule that holds repository-wide in `repo.test.js`.

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
