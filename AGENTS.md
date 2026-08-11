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
test/run.js  101 checks, no dependencies
tools/       music-get.sh and .cmd — optional YouTube downloader, not the app
```

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
worse than doing nothing. `alignSelectedJoin()` is the only caller: it takes the
snapshot for undo *after* deciding to act, so a declined suggestion doesn't leave
a no-op on the undo stack.

**The join button has two strategies, and beats is only the first.** Much
skating music — solo piano especially — has no steady pulse, and `analyseBeats`
correctly refuses to name one. `suggestJoinForBuffers()` then falls back to
`suggestPhraseJoin()`, which cuts at phrase boundaries found from lulls in the
onset envelope and changes of harmony in a chroma curve. Both strategies return
the same shape of answer, distinguished by `reason`, so callers do not care
which ran — but the message to the user does say which, because it tells her
the music has no beat and that the advice for it is different. Only when both
decline does nothing happen.

**Loudness is measured on the kept part of a clip, never the whole file.** They
trimmed twenty seconds out of a four-minute song; the rest is not in the
programme and must not influence its level. `measureClip()` takes the trim
bounds for that reason, and because the answer goes stale the moment anything is
re-trimmed, it is recomputed on demand rather than cached against the file — a
gating pass over thirty seconds is about 25 ms, which is cheaper than being
wrong. `solveGains()` then turns those measurements into one gain per clip.

**`gain` is a plain multiplier on the clip, applied by its own node.** It sits
before the fade and blend nodes in `scheduleProgram()` rather than being folded
into either, so the fade still runs 0 to 1 and the two sides of a crossfade
still sum to 1 whatever the levels are. Preview and export therefore get it for
free. The slider works in decibels, because that is what tracks how loud a
change *sounds*, but stores and shows the multiplier — `LEVEL_SLIDER` and the
`min`/`max` on the HTML input have to agree, and a test says so.

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
- **BS.1770 publishes its coefficients at 48 kHz and nothing else.** Everything
  here is decoded to 44100, so `kWeighting()` derives them from the prototype
  values instead. Copying the published table straight in gives a filter tuned
  to the wrong frequencies. A test feeds it 48000 and checks it reproduces that
  table to twelve decimals, which is what says the derivation is honest.
- **Loudness gating is not a refinement.** Without the absolute gate, a cut that
  ends in a long fade measures far below what anyone hears and gets boosted for
  it; without the relative gate, a quiet passage does the same thing more
  subtly. Both are tested with the size of the mistake they prevent — around
  6 dB — asserted alongside, so neither can be dropped as an optimisation.
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
  path assert that `analyseBeats` is below `BEAT.minConfidence` on the exact
  window under test, so they fail loudly rather than silently testing the wrong
  branch.
- **Sparse music still reads as having a beat more often than it should.**
  A dozen piano notes in a twelve second window let a metronome fit a few of
  them by chance, and the contrast measure in `analyseBeats` rates that as
  confidently as a drum track. `BEAT.minCoverage` — what share of the grid's
  beats are actually played — damps it, and cut the affected windows of the test
  fixture from 33 of 55 to 12. It is not a cure. Finishing this needs real piano
  recordings to calibrate against, not more work against synthetic fixtures,
  which is why the tests assert that coverage *separates* the two cases rather
  than that every sparse window is rejected. Until then some free-tempo music
  gets the beat strategy when it should get phrasing.
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
