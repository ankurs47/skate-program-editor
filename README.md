# Skate Program Editor

A small browser tool for cutting figure skating program music. Trim songs, put
them in order, blend the joins, and watch the running total against the time
limit for your event.

**[Use it here →](https://ankurs47.github.io/skate-program-editor/)** ·
**[Full guide →](https://ankurs47.github.io/skate-program-editor/docs/help.html)**

Nothing to install and nothing to sign up for. Your music never leaves your
computer — the files are read straight from disk by the browser and stay there.

## Why

Program music is a handful of cuts joined together and timed to the second, but
the usual options are a full digital audio workstation, which is far more than
the job needs, or paying someone else to do it.

This does the one job: cut, order, blend, check the length, save the file. Every
choice in it follows from that — plain language instead of studio vocabulary, a
timer sized for the thing you actually have to hit, and no feature that a
sequence of cuts does not need.

## What it does

- **Trim** each song by dragging the ends of its waveform, or with `I` and `O`
- **Reorder** by dragging the blocks
- **Blend** one song into the next, or fade in and out
- **Line up this join** — one button nudges a cut by up to a couple of seconds
  to somewhere the music can take it. With a steady beat it puts both songs on
  it, which is what stops a blend sounding like a stumble; where there is no
  beat, as in piano and much orchestral music, it finds the end of a phrase
  instead — and it tells you which it did
- **Even out the volume** — one button sets every song so they sound about
  equally loud without letting any of them distort, and a per-song slider
  adjusts it by hand afterwards
- **Watch the clock** — a big timer that turns green inside the allowed window
  for your event, and tells you exactly how far off you are when you're not
- **Flag weak audio** before you commit to it, with a plain Good / Fair / Low
  verdict rather than a bitrate you have to interpret
- **Hear a join** before you commit to it — one button plays the few seconds
  either side of a cut
- **Save your work** as a small readable file recording the edit, so you can
  come back and adjust it rather than starting over
- **Export** to MP3 or WAV, with a warning first if the program would come out
  too loud to store cleanly

Everything runs in the browser tab: decoding, playback, mixing and encoding.
There is no server and no upload step.

The [full guide](https://ankurs47.github.io/skate-program-editor/docs/help.html)
covers all of it in detail — [where to
cut](https://ankurs47.github.io/skate-program-editor/docs/help.html#joins),
[saving and
reloading](https://ankurs47.github.io/skate-program-editor/docs/help.html#saving),
[keyboard
shortcuts](https://ankurs47.github.io/skate-program-editor/docs/help.html#keys),
[getting music off
YouTube](https://ankurs47.github.io/skate-program-editor/docs/help.html#youtube)
and [what to do when something goes
wrong](https://ankurs47.github.io/skate-program-editor/docs/help.html#troubleshooting).

## What it needs

Any current Chrome, Edge, Firefox or Safari **on a computer**. The page tells
you if something it needs is missing rather than failing quietly.

It works on a tablet but warns you first: trimming by touch is fiddly, and
decoded audio is uncompressed — roughly 90 MB of memory per four minutes of
stereo — so a few long songs can exhaust what a mobile browser allows.

No account, no network beyond loading the page, and no server. On Chrome and
Edge the editor can also offer your songs back after a reload, so loading a
saved project is one click instead of finding each file by hand; Firefox and
Safari have no such facility and there you add the files again, as always.

## Program lengths — check them yourself

The event list covers ISU singles, pairs and ice dance, and U.S. Figure Skating
free skate and short program levels. **These times are a convenience, not an
authority.** Required lengths are set by the governing bodies and do change
between seasons. Check your level against the current rulebook, or with your
coach, before an entry deadline.

This project is not affiliated with, endorsed by, or connected to the ISU or
U.S. Figure Skating.

## Running it yourself

Clone the repo and open `index.html`. That's the whole build process — no build
step, no runtime dependencies.

To host it, copy `index.html` and the `src/` and `docs/` folders anywhere that
serves static files. Because users' music never reaches the host, there is no
storage, no per-user cost, and no third-party audio on your infrastructure.

## Development

```bash
npm install          # installs eslint, and enables the pre-commit hook
npm run check        # lint + 161 unit checks
npm run test:dom     # browser checks and render budgets — needs Chrome
npm run test:mutate  # break the code on purpose, check a test notices
```

**[Development notes →](docs/development.md)** — the layout, the three layers of
testing, CI, and the ground rules a change has to keep.
[`AGENTS.md`](AGENTS.md) has the architecture walkthrough and a list of the
traps that produced real bugs.

## Licence

MIT — see [LICENSE](LICENSE).
