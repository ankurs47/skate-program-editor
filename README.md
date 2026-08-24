<div align="center">

<img src="src/logo.svg" alt="" width="88" height="88">

<h1>Skate Program Editor</h1>

<p>
  <b>Cut figure skating program music in your browser.</b><br>
  Trim songs, put them in order, blend the joins, and watch the running total
  against the time limit for your event.
</p>

<p>
  <a href="https://github.com/ankurs47/skate-program-editor/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ankurs47/skate-program-editor/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/ankurs47/skate-program-editor/actions/workflows/mutation.yml"><img alt="Mutation testing" src="https://github.com/ankurs47/skate-program-editor/actions/workflows/mutation.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2f6df6"></a>
</p>

<p>
  <a href="https://ankurs47.github.io/skate-program-editor/">▶&nbsp;&nbsp;<b>Use it</b></a>
  &nbsp; · &nbsp;
  <a href="https://ankurs47.github.io/skate-program-editor/docs/help.html">📖&nbsp;&nbsp;<b>Guide</b></a>
  &nbsp; · &nbsp;
  <a href="docs/development.md">🔧&nbsp;&nbsp;<b>Development</b></a>
  &nbsp; · &nbsp;
  <a href="https://github.com/ankurs47/skate-program-editor/issues">🐛&nbsp;&nbsp;<b>Issues</b></a>
</p>

</div>

Nothing to install and nothing to sign up for. Your music never leaves your
computer — the files are read straight from disk by the browser and stay there.

> [!IMPORTANT]
> **Built with AI, for my own use.** The code here was written with heavy AI
> assistance. I needed to cut a program and did not want a digital audio
> workstation to do it; it is public in case it saves someone else the same
> afternoon.
>
> There is no team behind it, no support, and no undertaking to fix anything or
> to keep it working. **Use it at your own risk** — and before an entry deadline,
> play the exported file end to end rather than trusting that it came out right.

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

## License

MIT — see [LICENSE](LICENSE).
