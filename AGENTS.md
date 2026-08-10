# Working on this repo

Notes for anyone — human or AI agent — making changes here. The bullets under
"Traps" are all real bugs that shipped or nearly shipped; they are the reason
this file exists.

## What this is

A browser tool for cutting figure skating program music. Three static files, no
build step, no runtime dependencies, no server. It is used by skaters and their
parents, not by audio engineers — the language in the interface is deliberately
plain, and jargon is treated as a bug.

```
index.html   structure, help topic content, dialogs
app.js       everything: decode, waveforms, editing, playback, render, export
style.css    theming via CSS custom properties, light and dark
test/run.js  46 checks, no dependencies
```

## Commands

```bash
npm install      # installs eslint and enables the pre-commit hook
npm test         # unit + wiring + asset checks
npm run lint
npm run check    # what CI runs
npm run test:net # also re-verifies the pinned CDN hash
```

`main` is protected: pull request required, CI must pass, applies to admins too.
The pre-commit hook runs lint and tests; `--no-verify` skips it.

## Ground rules

- **No build step and no runtime dependencies.** Anyone must be able to clone
  and open `index.html`. The single exception is the MP3 encoder, loaded from a
  CDN with an integrity hash.
- **Audio never leaves the machine.** Files are read with the File API and
  decoded in memory. Nothing is uploaded, and nothing should become uploadable.
- **No personal information in shipped files.** There is a test asserting this.
  Placeholders use generic examples like "my 2026 junior long program".
- **Plain language in the interface.** "Make music file", not "Export". A word
  like *bitrate*, *codec* or *render* appearing in visible text is a defect.
  Technical detail belongs in tooltips.
- `app.js` is a plain browser script, so its functions are global by design.
  `no-implicit-globals` is deliberately disabled — satisfying it would mean
  wrapping two thousand lines in an IIFE for no benefit.

## How the pieces fit

**The edit is data.** `state.clips` is an ordered list of
`{file, srcStart, srcEnd, fadeIn, fadeOut, crossfade}`. Everything else —
timeline, waveforms, playback, export — is derived from it. `layout()` is the
single place that turns clips into timeline positions; nothing should compute
positions independently.

**`crossfade` is an overlap with the *previous* clip**, so blending makes the
programme *shorter*. Clip durations therefore sum to more than the total length.
This trips people up constantly.

**Preview and export share one code path.** `scheduleProgram()` builds the Web
Audio graph for both live playback and the `OfflineAudioContext` render, so what
you hear is what you get. Do not add an export-only path.

**Two views, different jobs.** The clip strip is a *list* — click to select,
drag to reorder, widths only roughly proportional. The scrubber below it is real
programme time, where overlapping blocks are blends. Seeking uses the scrubber.

**Testability.** `app.js` calls `init()` under a browser and exports its pure
functions under Node. Keep new pure logic out of DOM handlers so it stays
testable, and add it to the export list at the bottom.

**Beat detection answers with a confidence, and callers must honour it.**
`analyseBeats()` finds a tempo and a beat grid in a window of samples;
`suggestJoin()` uses two of those to nudge a pair of cut points onto the beat.
Both are pure, and beat times are relative to the window they were measured in,
never to the song. The grid is *always* found — on applause, on a held chord, on
silence — so `confidence` below `BEAT.minConfidence` means leave the edit alone.
Snapping a rubato piece to an invented grid is the worst outcome available here,
worse than doing nothing.

## Traps

- **A single MPEG sync word means nothing.** Compressed audio is full of `0xFF`
  bytes followed by high bits, so scanning Opus data will find a "frame" almost
  immediately and report a confident, wrong bitrate. `readMpegFrame()` requires
  three consecutive frames exactly `frameLength` apart. Do not relax this.
- **ID3 tags are not small.** With embedded artwork they run to 400 KB+, so any
  window into a file must start *after* the tag, and any size-based bitrate
  estimate must subtract it. Ogg hides cover art in the comment header instead —
  `oggAudioStart()` skips it.
- **`buffer.sampleRate` is the AudioContext's rate, not the file's.** Everything
  is resampled to 44100 on decode. Only a real header tells you the source rate;
  otherwise leave it unknown rather than reporting a number you invented.
- **Quality thresholds are in MP3-equivalent terms.** Opus at 128 kbps sounds
  roughly like MP3 at 190, so `CODEC_EFFICIENCY` scales the measured bitrate
  before comparison. Badges show a verdict (*Good / Fair / Low*) and never a
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
  Searching fractional lags instead is *not* a fix: interpolating the envelope
  flattens the very peaks being correlated, by an amount that depends on the
  fractional part, so the scan then prefers round lags for a different reason.
  Integer lags find the neighbourhood; `refinePeriod()` finds the value.
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
- **Grid and flex items need `min-width: 0`.** A long clip name once widened the
  whole column and pushed the buttons off-screen. Relatedly, the timeline sizes
  clips with `flex-grow`, not computed pixels — computing widths from the
  programme length overflowed, because of the overlap point above.
- **`decodeAudioData` detaches its ArrayBuffer.** Copy any bytes you need for
  header inspection *before* decoding.
- **Decoded audio is uncompressed** — roughly 90 MB per four minutes of stereo.
  This is why tablets get a warning and why files are decoded on demand.

## Things that must stay verifiable

**Programme lengths** in the `LEVELS` table are set by the ISU and U.S. Figure
Skating and change between seasons. They are a convenience, not an authority.
Every dropdown option shows its time beside the level name so a wrong number is
visible rather than hidden, and saved projects store the actual target seconds
rather than only a level id — so reopening an old project never silently
retargets it. Keep both properties.

**The pinned CDN hash** (`LAME_SRI`) is checked against jsDelivr by
`npm run test:net`. If it fails, find out why the bytes changed before updating
it.

## Conventions

- Comments explain *why*, not *what*. Several above exist only because the
  obvious implementation was wrong.
- Errors say what happened and what would fix it, in the user's terms.
- Destructive actions confirm first, name what will be lost, and put the safe
  option under focus.
- New user-facing strings get the plain-language treatment; new pure functions
  get a test.
