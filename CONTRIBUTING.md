# Contributing

Thanks for looking. Read this first, because two things here are unusual.

**There is no team.** This is a personal project, built with heavy AI assistance
for my own skating, and made public in case it saves someone else an afternoon.
Issues and pull requests are welcome, and they may sit for a while. Nothing here
is a commitment to review, merge or maintain anything.

**Your first commit will be rejected unless you install the hooks.** They are not
optional and CI runs the same ones, so a commit that skips them fails there
instead. See below.

## Setting up

```sh
git clone https://github.com/ankurs47/skate-program-editor.git
cd skate-program-editor
pip install pre-commit    # or pipx, brew, your package manager
npm install               # installs eslint and turns the hooks on
```

`npm install` runs `tools/install-hooks.js`, which enables the hooks. Without
`pre-commit` on the machine it tells you and carries on — a missing tool should
not fail an install — and then nothing checks your commits until CI does.

To run the app, open `index.html`. That is the whole build.

## The three constraints

Any change has to keep all three. They are the reason the project looks the way
it does, and a change that breaks one is not a small change.

1. **No runtime dependencies.** eslint is the only devDependency and the app
   never touches it. Nothing is fetched at runtime: the MP3 encoder is a
   generated bundle committed under `src/vendor/`, and rebuilding it is the one
   job that downloads anything — `npm run build:encoder`, which installs its
   pinned packages into a temporary directory and throws them away.
2. **No build step.** Plain script tags sharing one global scope. What is in the
   repository is what runs.
3. **It opens from disk.** `file://` has to work, which rules out fetch of local
   files and anything needing a server. Nothing here is an ES module either: an
   opaque origin cannot load a local one, which is why the vendored MP3 encoder
   is bundled to a classic script. Checked behavior, not assumed.

Two more that matter nearly as much:

- **Plain language in the interface.** "Make music file", not "Export". A word
  like _bitrate_, _codec_ or _render_ in text a skater sees is a defect;
  technical detail belongs in a tooltip.
- **American spelling** everywhere, enforced by codespell.

## Running the checks

```sh
npm test              # 261 unit checks, no browser, about a second
npm run test:dom      # 67 checks driving real Chrome over CDP
npm run lint          # eslint
pre-commit run --all-files    # everything CI runs
npm run test:mutate   # breaks the code on purpose to see if the tests notice
```

`npm run test:mutate` is the slow one and needs a clean tree — it builds a
throwaway git worktree so a run cannot collide with what you are editing. Run it
if you have touched anything the unit tests cover.

## Writing a test

A test that cannot fail is worse than no test, because it reports success
forever. Before you are done with one, break the code it covers on purpose and
watch it fail. Two ways this goes wrong here in particular:

- **A check that reads the source and asserts against what it read.** It agrees
  with the file whatever the file says.
- **A check that asserts something is _absent_.** Point it at one file and it
  passes on the strength of not having looked. Read `SCRIPTS` instead.

New unit tests go in the file matching the code they cover; anything needing a
DOM goes in `test/dom/`.

## Sending a change

Branch from `main`, keep the commit message about why rather than what, and open
a pull request. `main` is protected: CI has to pass.

If you are changing behavior, say in the pull request how you checked it — the
template asks. If you are changing the interface, a screenshot helps more than a
paragraph.

## Program lengths

The event lengths in `src/program.js` come from ISU and US Figure Skating
documents, and they change. If one is wrong, please open an issue using the
**Program length** template and include a link to the source that says otherwise
— that is the part that takes the longest to find, and the tool cannot verify it
for you.

## Where things are

- **[`docs/development.md`](docs/development.md)** — the long version: layout,
  the three layers of testing, CI, the house rules.
- **[`AGENTS.md`](AGENTS.md)** — the same ground written for an AI assistant,
  and denser for it.
- **[`docs/help.html`](docs/help.html)** — the user guide, which is also the
  best description of what the app is supposed to do.
