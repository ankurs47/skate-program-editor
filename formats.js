/* Skate Program Editor — what a source file is, and whether it is good enough.
 *
 * Container and codec parsing: ID3 tags, MPEG frame headers, Ogg page walking,
 * and the verdict that turns a bitrate and a sample rate into Good, Fair, Low
 * or Unknown. Pure — it is handed bytes and a decoded buffer and returns a
 * description.
 *
 * The traps here are the reason it is worth its own file: a lone MPEG sync word
 * means nothing, ID3 tags with artwork run to hundreds of kilobytes, and Ogg
 * hides its cover art somewhere else again. All three are written up in
 * AGENTS.md.
 *
 * Loaded after analysis.js and before app.js.
 */
'use strict';

/* --------------------------------------------------------- source quality */

/* Competitions ask for clean audio, and a bad YouTube rip is the usual culprit.
 * Announcements vary and rarely quote a number, so treat these as sensible
 * defaults rather than a rule — check the specific competition's announcement.
 * Lossless sources (wav/flac) skip the bitrate test entirely. */
const QUALITY = {
  goodBitrate: 192,      // kbps: comfortable for a rink PA
  minBitrate: 128,       // kbps: below this, flag it loudly
  goodSampleRate: 44100, // Hz: CD rate
  minSampleRate: 32000,
};

/* Thresholds above are in MP3 terms. Newer codecs sound better at the same
 * bitrate, so compare an equivalent figure rather than the raw number —
 * otherwise a perfectly good 128 kbps Opus download gets flagged. Displayed
 * bitrates are always the real ones. */
const CODEC_EFFICIENCY = { mp3: 1, aac: 1.3, m4a: 1.3, opus: 1.5, ogg: 1.2, vorbis: 1.2 };

function codecOf(name) {
  const match = String(name).match(/\.([a-z0-9]+)$/i);
  const ext = match ? match[1].toLowerCase() : '';
  if (ext === 'webm') return 'opus';   // YouTube's WebM audio is Opus
  return ext;
}

const MPEG_BITRATES = {
  // [versionKey][bitrateIndex] in kbps, Layer III only
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Length of an ID3v2 tag at the start of the file, or 0. Takes an ArrayBuffer. */
function id3Size(bytes) {
  if (bytes.byteLength < 10) return 0;
  const view = new DataView(bytes, 0, 10);
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return 0;
  // syncsafe integer: 7 bits per byte
  const size = (view.getUint8(6) << 21) | (view.getUint8(7) << 14)
             | (view.getUint8(8) << 7) | view.getUint8(9);
  return size + 10;
}

/** Decode one MPEG Layer III frame header, or null if these bytes aren't one. */
function parseFrameHeader(view, i) {
  if (i + 4 > view.byteLength) return null;
  if (view.getUint8(i) !== 0xff) return null;
  const b1 = view.getUint8(i + 1);
  if ((b1 & 0xe0) !== 0xe0) return null;              // 11-bit frame sync

  const versionBits = (b1 >> 3) & 0x03;               // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (b1 >> 1) & 0x03;                 // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;

  const b2 = view.getUint8(i + 2);
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const bitrate = MPEG_BITRATES[versionBits === 3 ? 1 : 2][bitrateIndex];
  const sampleRate = MPEG_RATES[versionBits][rateIndex];
  const padding = (b2 >> 1) & 0x01;
  const channels = ((view.getUint8(i + 3) >> 6) & 0x03) === 3 ? 1 : 2;
  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8) * bitrate * 1000 / sampleRate) + padding;
  if (frameLength < 8) return null;

  return { versionBits, bitrate, sampleRate, channels, samplesPerFrame, frameLength };
}

/**
 * Find the first real MPEG audio frame. Returns null for non-MPEG data.
 *
 * A bare sync-word search is not enough: compressed audio of any kind is full
 * of 0xFF bytes followed by high bits, so scanning Opus or AAC data will find a
 * false "frame" almost immediately and report a nonsense bitrate. Requiring
 * several consecutive frames to sit exactly frameLength apart, agreeing on
 * version and sample rate, is what makes the match trustworthy.
 *
 * Also picks up a Xing/Info header, which is how VBR files declare their real
 * average — the frame header alone reports only the first frame's rate.
 */
function readMpegFrame(bytes, start) {
  const view = new DataView(bytes);
  const limit = Math.min(view.byteLength - 4, start + 65536);

  for (let i = start; i < limit; i++) {
    if (view.getUint8(i) !== 0xff) continue;
    const first = parseFrameHeader(view, i);
    if (!first) continue;

    // Walk forward and confirm this is a real frame chain, not a coincidence.
    let pos = i;
    let confirmed = 0;
    for (let n = 0; n < 4; n++) {
      const frame = parseFrameHeader(view, pos);
      if (!frame
          || frame.versionBits !== first.versionBits
          || frame.sampleRate !== first.sampleRate) break;
      confirmed++;
      pos += frame.frameLength;
      if (pos + 4 > view.byteLength) break;   // ran out of file, not a failure
    }
    if (confirmed < 3) continue;

    const { bitrate, sampleRate, channels, samplesPerFrame, versionBits } = first;

    // Xing/Info sits after the side information block
    const sideInfo = versionBits === 3 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
    let vbr = false;
    let average = bitrate;
    const tagAt = i + 4 + sideInfo;
    if (tagAt + 16 < view.byteLength) {
      const tag = String.fromCharCode(
        view.getUint8(tagAt), view.getUint8(tagAt + 1),
        view.getUint8(tagAt + 2), view.getUint8(tagAt + 3));
      if (tag === 'Xing' || tag === 'Info') {
        vbr = tag === 'Xing';
        const flags = view.getUint32(tagAt + 4);
        let p = tagAt + 8;
        const frames = (flags & 1) ? view.getUint32(p) : 0;
        if (flags & 1) p += 4;
        const streamBytes = (flags & 2) ? view.getUint32(p) : 0;
        if (frames > 0 && streamBytes > 0) {
          const seconds = (frames * samplesPerFrame) / sampleRate;
          average = Math.round((streamBytes * 8) / seconds / 1000);
        }
      }
    }
    return { bitrate: average, sampleRate, channels, vbr, codec: 'mp3' };
  }
  return null;
}

/**
 * Byte offset where audio data begins in an Ogg stream, or 0 if not Ogg.
 *
 * Ogg Opus puts the cover art in the OpusTags comment header, which for a
 * yt-dlp download runs to several hundred KB. Measuring from file size without
 * skipping it overstates the bitrate by ~40%. The first two packets are
 * OpusHead and OpusTags; everything after them is audio.
 */
function oggAudioStart(bytes) {
  const view = new DataView(bytes);
  if (view.byteLength < 27) return 0;
  const magic = (at) => view.getUint8(at) === 0x4f && view.getUint8(at + 1) === 0x67
    && view.getUint8(at + 2) === 0x67 && view.getUint8(at + 3) === 0x53;   // "OggS"
  if (!magic(0)) return 0;

  let pos = 0;
  let packets = 0;
  while (pos + 27 < view.byteLength && magic(pos) && packets < 2) {
    const segments = view.getUint8(pos + 26);
    let payload = 0;
    for (let i = 0; i < segments; i++) {
      const len = view.getUint8(pos + 27 + i);
      payload += len;
      if (len < 255) packets++;    // a segment under 255 ends a packet
    }
    pos += 27 + segments + payload;
  }
  return packets >= 2 ? pos : 0;
}

/**
 * A short identity for a file's audio, so a project can tell whether the song
 * it has been handed is the one it was built from.
 *
 * Files are matched by name, which is all a browser offers — it will not tell a
 * page where a file lives, and a handle to one cannot be written into a project
 * file. So a project cannot record a location. What it can record is what the
 * audio looked like, and that is enough to say "this is a different song with
 * the same name" rather than silently rebuilding the programme around it.
 *
 * Taken from the bytes where the audio starts, not the head of the file, so
 * editing the title or artwork does not make a file look like a stranger. FNV-1a
 * rather than a real digest: `crypto.subtle` needs a secure context and this has
 * to work when index.html is opened straight off disk.
 */
function fingerprint(head) {
  const bytes = new Uint8Array(head);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The verdict for one source: good, caution, poor, or unknown.
 *
 * Separate from `analyseSource`, which needs a decoded buffer and a File to say
 * anything at all. The judgement itself is the part that is easy to get wrong
 * and easy to check, so it stands on its own and takes plain numbers — the test
 * for it used to reimplement these thresholds and assert against its own copy,
 * which would have passed whatever this actually did.
 *
 * `bitrate` is the real figure; the comparison is against its MP3-equivalent,
 * because 128k Opus and 128k MP3 are not the same thing. A null measurement
 * means unknown, never zero.
 */
function qualityKind({ bitrate = null, sampleRate = null, codec = '', lossless = false }) {
  // Nothing measurable and not a known lossless format — say so rather than
  // implying it's fine.
  let kind = (!lossless && bitrate === null) ? 'unknown' : 'good';
  if (!lossless && bitrate !== null) {
    // Judge on the MP3-equivalent figure; display the real one.
    const effective = bitrate * (CODEC_EFFICIENCY[codec] || 1);
    if (effective < QUALITY.minBitrate) kind = 'poor';
    else if (effective < QUALITY.goodBitrate) kind = 'caution';
  }
  if (sampleRate !== null && kind !== 'unknown') {
    if (sampleRate < QUALITY.minSampleRate) kind = 'poor';
    else if (sampleRate < QUALITY.goodSampleRate && kind === 'good') kind = 'caution';
  }
  return kind;
}

/**
 * Work out what we can about a source file. `head` is a copy of the bytes at
 * the first audio frame, taken before decoding because decodeAudioData detaches
 * the buffer. `tagEnd` is where the ID3v2 tag ended — with embedded artwork
 * that is routinely several hundred KB, so it cannot be assumed small.
 */
function analyseSource(head, tagEnd, file, buffer) {
  const lossless = /\.(wav|flac|aiff?)$/i.test(file.name);
  // Only attempt MPEG parsing on files that could plausibly be MPEG. The frame
  // validator would reject Opus anyway, but not paying for the scan is better.
  const maybeMpeg = /\.(mp3|mp2|mpga)$/i.test(file.name);
  let info = null;

  if (!lossless && maybeMpeg) {
    try { info = readMpegFrame(head, 0); } catch (_) { info = null; }
  }

  // buffer.sampleRate is the AudioContext's rate, not the file's — everything
  // is resampled to 44100 on decode. Only an actual header tells us the source
  // rate, so leave it unknown rather than reporting a number we made up.
  const sampleRate = info ? info.sampleRate : null;
  const channels = info ? info.channels : buffer.numberOfChannels;
  let bitrate = info ? info.bitrate : null;
  let estimated = false;

  if (!lossless && bitrate === null && buffer.duration > 0) {
    // Fallback for m4a/ogg/opus. `tagEnd` already skips embedded artwork, which
    // yt-dlp adds by default and which runs to hundreds of KB.
    const payload = Math.max(0, file.size - tagEnd);
    bitrate = Math.round((payload * 8) / buffer.duration / 1000);
    estimated = true;
  }

  const codec = info ? 'mp3' : codecOf(file.name);
  const kind = qualityKind({ bitrate, sampleRate, codec, lossless });

  // Short flags, used where there is room to show them. The badge never uses
  // these — it has to stay narrow enough to sit beside the Add button.
  const notes = [];
  if (channels === 1) notes.push('mono');
  if (sampleRate !== null && sampleRate < QUALITY.goodSampleRate) {
    notes.push(`${(sampleRate / 1000).toFixed(1)} kHz`);
  }

  return {
    bitrate, sampleRate, channels, lossless, kind, codec, notes,
    estimated, vbr: Boolean(info && info.vbr),
  };
}

/* A verdict rather than a number. 128k Opus and 128k MP3 sound nothing alike,
 * so showing bitrates invites exactly the wrong comparison — the codec factors
 * above already do that reasoning. The figures stay in the tooltip. */
const QUALITY_LABEL = { good: 'Good', caution: 'Fair', poor: 'Low', unknown: 'Unknown' };

/** Compact badge text — must stay narrow enough to sit beside the Add button. */
function qualityLabel(q) {
  return q ? (QUALITY_LABEL[q.kind] || 'Unknown') : '';
}

/** Everything worth saying, for the tooltip and the export warning. */
function qualityDetail(q) {
  const head = q.lossless ? 'Lossless source'
    : q.kind === 'unknown' ? 'Could not measure this file'
    : q.kind === 'good' ? 'Good quality'
    : q.kind === 'poor' ? 'Low quality — may sound rough on a rink system'
    : 'Below CD quality, but probably fine';
  const parts = [];
  if (q.bitrate && !q.lossless) parts.push(`${q.bitrate} kbps${q.estimated ? ' (estimated)' : ''}`);
  if (q.codec) parts.push(q.codec);
  if (q.sampleRate !== null) parts.push(`${(q.sampleRate / 1000).toFixed(1)} kHz`);
  parts.push(q.channels === 1 ? 'mono' : 'stereo');
  if (q.vbr) parts.push('VBR');
  return `${head} — ${parts.join(', ')}`;
}

/* Under Node — the test suite — hand the parsing over. In a browser these are
   already global and this block does nothing. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUALITY, CODEC_EFFICIENCY, codecOf,
    id3Size, oggAudioStart, readMpegFrame, parseFrameHeader,
    qualityKind, analyseSource, qualityLabel, qualityDetail, fingerprint,
  };
}
