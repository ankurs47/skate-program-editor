<!-- Delete anything that does not apply. A one-line fix does not need an essay. -->

## What this changes

<!-- And why. The why is the part that is hard to recover later. -->

## How you checked it

<!--
Which of these you ran, and anything you did by hand. If you changed behavior
the unit tests cover, say whether the mutation suite still passes.

  npm test              unit
  npm run test:dom      real Chrome
  npm run lint
  pre-commit run --all-files
  npm run test:mutate   needs a clean tree
-->

## Before merging

- [ ] `pre-commit run --all-files` passes
- [ ] New behavior has a test, and I watched it fail before it passed
- [ ] Still no runtime dependencies, no build step, and `index.html` opens from disk
- [ ] Nothing a skater reads uses studio vocabulary
- [ ] `AGENTS.md` and `docs/development.md` still describe what is here

<!--
If you touched the interface, a screenshot says more than a paragraph.
If you added a src/*.js file, it needs a script tag in index.html and an entry
in SCRIPTS in test/harness.js — a test will tell you if you forgot.
-->
