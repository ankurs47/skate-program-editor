# Skate Program Editor

A small browser tool for cutting figure skating program music. Trim songs, put
them in order, blend the joins, and watch the running total against the time
limit for your event.

**[Use it here →](https://ankurs47.github.io/skate-program-editor/)**

Nothing to install and nothing to sign up for. Your music never leaves your
computer — the files are read straight from disk by the browser and stay there.

## Why

Program music is a handful of cuts joined together and timed to the second, but
the usual options are a full digital audio workstation, which is far more than
the job needs, or paying someone else to do it. This does the one job: cut,
order, blend, check the length, save the file.

## What it does

- **Trim** each song by dragging the ends of its waveform, or with `I` and `O`
- **Reorder** by dragging the blocks
- **Blend** one song into the next, or fade in and out
- **Line up this join** — one button nudges a cut by up to a couple of seconds
  to somewhere the music can take it, and says what that did to the running
  total. With a steady beat it puts both songs on it, which is what stops a
  blend sounding like a stumble. Piano and much orchestral music have no beat to
  find, so there it looks for the end of a phrase instead — the breath between
  one line and the next — and tells you that is what it did
- **Even out the volume** — one button sets every song so they sound about
  equally loud, without letting any of them distort, and a per-song **Volume**
  slider adjusts it by hand afterwards
- **Watch the clock** — a big timer that turns green inside the allowed window
  for your event, and tells you exactly how far off you are when you're not
- **Flag weak audio** before you commit to it, with a plain Good / Fair / Low
  verdict rather than a bitrate you have to interpret
- **Save your work** as a small readable file that records the edit, so you can
  come back and adjust it rather than starting over
- **Hear a join** before you commit to it — one button plays the few seconds
  either side of a cut, so you can judge it without hunting for the spot
- **Export** to MP3 or WAV, with a warning first if the program would come out
  too loud to store cleanly

Everything runs in the browser tab: decoding, playback, mixing and encoding.
There is no server and no upload step.

## Program lengths — check them yourself

The event list covers ISU singles, pairs and ice dance, and U.S. Figure Skating
free skate and short program levels. **These times are a convenience, not an
authority.** Required lengths are set by the governing bodies and do change
between seasons.

Check your level against the current rulebook, or with your coach, before an
entry deadline. Every option shows its time next to the level name so a wrong
number is visible rather than hidden, and there is a *Custom length* option for
anything not listed.

This project is not affiliated with, endorsed by, or connected to the ISU or
U.S. Figure Skating.

## What it needs

Any current Chrome, Edge, Firefox or Safari on a computer. The page tells you if
something is missing rather than failing quietly.

It works on a tablet but warns you first: trimming by touch is fiddly, and
decoded audio is uncompressed — roughly 90 MB of memory per four minutes of
stereo — so a few long songs can exhaust what a mobile browser allows.

## Getting the music off YouTube

The editor works on files that are already on your computer, and often the song
you want is one you have only ever heard on YouTube. `tools/` has a small
helper for that — one script for Mac and Linux, one for Windows, doing the same
thing:

```bash
./tools/music-get.sh "https://www.youtube.com/watch?v=..."     # Mac, Linux
tools\music-get.cmd "https://www.youtube.com/watch?v=..."      # Windows
```

```
  -o DIR      where to put the files (default: here)
  --playlist  the link is part of a playlist and you want all of it,
              not just the one song
```

It saves the sound exactly as YouTube already stores it — usually a `.webm`
file, which Chrome and Firefox open without complaint. Nothing is converted, so
no quality is lost before you start cutting and there is no ffmpeg to install.
Give it several links at once and it works through them in turn.

The one thing to install is [yt-dlp][yt-dlp], which does the actual work
(`brew install yt-dlp`, `sudo apt install yt-dlp`, `winget install
yt-dlp.yt-dlp`). The script says so, with the command for your system, if it
isn't there. YouTube changes often enough that a download failing usually means
yt-dlp is due an update — `yt-dlp -U`.

Competition music is normally covered by the licence your rink or federation
holds, but that is between you and them; this tool just moves audio onto your
own disk.

[yt-dlp]: https://github.com/yt-dlp/yt-dlp

## Running it yourself

Clone the repo and open `index.html`. That's the whole build process.

To host it, copy `index.html`, `analysis.js`, `formats.js`, `app.js` and
`style.css` anywhere that serves
static files. Because users' music never reaches the host, there is no storage,
no per-user cost, and no third-party audio on your infrastructure.

The one outbound request the page makes is for [lamejs][lamejs], the MP3
encoder, from a CDN — browsers can play MP3 but none of them can create one. It
is loaded with a Subresource Integrity hash pinning the exact bytes, in the
background, and if it can't be reached the editor still works and export falls
back to WAV.

[lamejs]: https://github.com/zhuker/lamejs

## The project file

**Save project** writes a small JSON file recording the edit — which songs,
where each starts and ends, and every fade and blend. It does not contain the
music, which is why it stays a few kilobytes.

```json
{
  "name": "my 2026 junior long program",
  "level": "usfs-jr",
  "targetSeconds": 210,
  "toleranceSeconds": 10,
  "clips": [
    { "file": "chosen song.mp3", "srcStart": 4.76, "srcEnd": 77.08,
      "fadeIn": 1.5, "fadeOut": 0, "crossfade": 0, "gain": 1 }
  ]
}
```

Because the music isn't inside it, loading a project means adding the song files
again. They reconnect by filename, so as long as the names haven't changed every
cut comes back exactly. Keeping the project file in the same folder as the music
is the easy way to keep them together.

## Limits

- Songs play in sequence. No layering, no second track, no EQ. A program is a
  sequence of cuts, and the tool is shaped around that.
- Trimming never modifies your source files.
- Exporting at a higher quality cannot improve a song that was already poor. The
  editor says so before you export rather than after.

## Development

The app itself has no build step and no runtime dependencies — the tooling below
is only for checking changes.

```bash
npm install          # installs eslint, and enables the pre-commit hook
npm test             # 147 checks: maths, wiring, and asset integrity
npm run lint
npm run check        # lint + test
npm run test:net     # also re-verifies the pinned CDN hash
npm run test:dom     # browser checks — needs Chrome installed
```

`npm install` points git at `.githooks`, so **lint and tests run before every
commit**. Use `git commit --no-verify` to skip it in an emergency.

`main` is protected: changes go through a pull request, and CI has to pass
before it can merge.

`npm run test:dom` drives real headless Chrome over the DevTools Protocol —
no dependencies, since Node 22 has a global `WebSocket` and Chrome speaks CDP
over one. It covers the half of the editor the unit tests cannot reach: dialogs
and focus, the audio graph, key handling, and the flows that only exist as a
sequence of clicks. It is kept out of `npm test` so that stays fast and works
on a machine with no browser; CI runs both.

The test suite covers the parts that are easy to get quietly wrong — timeline
maths with overlapping blends, fade and crossfade envelopes summing correctly,
filename sanitising across platforms, per-codec quality thresholds, the MPEG
frame parser refusing to match non-MPEG data, beat detection reading the right
tempo off a known one while declining to claim a beat in material that has none,
and loudness measurement agreeing with an independent meter. It also checks that
a saved project survives a round trip through the file format, that
every element id the code reaches for exists in the HTML, that every help button
has content, and that no personal information or local path ever ships.

## Licence

MIT — see [LICENSE](LICENSE).
