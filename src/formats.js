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
 * Loaded after analysis.js, before everything that uses it.
 */
'use strict';

/* --------------------------------------------------------- source quality */

/* Competitions ask for clean audio, and a bad YouTube rip is the usual culprit.
 * Announcements vary and rarely quote a number, so treat these as sensible
 * defaults rather than a rule — check the specific competition's announcement.
 * Lossless sources (wav/flac) skip the bitrate test entirely. */
const QUALITY = {
  goodBitrate: 192, // kbps: comfortable for a rink PA
  minBitrate: 128, // kbps: below this, flag it loudly
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
  if (ext === 'webm') return 'opus'; // YouTube's WebM audio is Opus
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
  const size =
    (view.getUint8(6) << 21) |
    (view.getUint8(7) << 14) |
    (view.getUint8(8) << 7) |
    view.getUint8(9);
  return size + 10;
}

/** Decode one MPEG Layer III frame header, or null if these bytes aren't one. */
function parseFrameHeader(view, i) {
  if (i + 4 > view.byteLength) return null;
  if (view.getUint8(i) !== 0xff) return null;
  const b1 = view.getUint8(i + 1);
  if ((b1 & 0xe0) !== 0xe0) return null; // 11-bit frame sync

  const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (b1 >> 1) & 0x03; // 1 = Layer III
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
  const frameLength = Math.floor(((samplesPerFrame / 8) * bitrate * 1000) / sampleRate) + padding;
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
      if (
        !frame ||
        frame.versionBits !== first.versionBits ||
        frame.sampleRate !== first.sampleRate
      )
        break;
      confirmed++;
      pos += frame.frameLength;
      if (pos + 4 > view.byteLength) break; // ran out of file, not a failure
    }
    if (confirmed < 3) continue;

    const { bitrate, sampleRate, channels, samplesPerFrame, versionBits } = first;

    // Xing/Info sits after the side information block
    const sideInfo = versionBits === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
    let vbr = false;
    let average = bitrate;
    const tagAt = i + 4 + sideInfo;
    if (tagAt + 16 < view.byteLength) {
      const tag = String.fromCharCode(
        view.getUint8(tagAt),
        view.getUint8(tagAt + 1),
        view.getUint8(tagAt + 2),
        view.getUint8(tagAt + 3),
      );
      if (tag === 'Xing' || tag === 'Info') {
        vbr = tag === 'Xing';
        const flags = view.getUint32(tagAt + 4);
        let p = tagAt + 8;
        const frames = flags & 1 ? view.getUint32(p) : 0;
        if (flags & 1) p += 4;
        const streamBytes = flags & 2 ? view.getUint32(p) : 0;
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
  const magic = (at) =>
    view.getUint8(at) === 0x4f &&
    view.getUint8(at + 1) === 0x67 &&
    view.getUint8(at + 2) === 0x67 &&
    view.getUint8(at + 3) === 0x53; // "OggS"
  if (!magic(0)) return 0;

  let pos = 0;
  let packets = 0;
  while (pos + 27 < view.byteLength && magic(pos) && packets < 2) {
    const segments = view.getUint8(pos + 26);
    let payload = 0;
    for (let i = 0; i < segments; i++) {
      const len = view.getUint8(pos + 27 + i);
      payload += len;
      if (len < 255) packets++; // a segment under 255 ends a packet
    }
    pos += 27 + segments + payload;
  }
  return packets >= 2 ? pos : 0;
}

/* ------------------------------------------------------------------- tags */

/**
 * What a file says about itself, in the words a skater would use.
 *
 * Competition entry forms ask for the title and often the composer, and a file
 * called `track03.mp3` will not tell you either. Each container keeps this
 * somewhere different, so there is a reader per container and one name for each
 * idea across all three.
 *
 * Never throws and never insists: a file with no tags, half-written tags, or
 * tags in an encoding this does not know comes back with whatever could be read
 * and nothing else. A wrong guess about a title is cosmetic; refusing to open
 * somebody's music over one would not be.
 */

/* ID3v2.3 and 2.4 name frames with four characters, 2.2 with three. Only the
   fields worth showing someone are listed — a tag can hold dozens. */
const ID3_FRAMES = {
  TIT2: 'title',
  TPE1: 'artist',
  TALB: 'album',
  TCOM: 'composer',
  TPE3: 'conductor',
  TPUB: 'publisher',
  /* The two that answer "who would I ask about using this". An ISRC names one
     specific recording rather than the song, which is what a rights database or
     a licensing agency will want; the copyright line usually names the label
     that owns it. */
  TSRC: 'isrc',
  TCOP: 'copyright',
  TDRC: 'year', // 2.4
  TYER: 'year', // 2.3
  TT2: 'title', // and the 2.2 spellings of the same
  TP1: 'artist',
  TAL: 'album',
  TCM: 'composer',
  TP3: 'conductor',
  TPB: 'publisher',
  TRC: 'isrc',
  TCR: 'copyright',
  TYE: 'year',
};

/* Vorbis comments and MP4 atoms name the same ideas their own way. The MP4 keys
   begin with a copyright sign, which is part of the name rather than a typo. */
const VORBIS_FIELDS = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  COMPOSER: 'composer',
  CONDUCTOR: 'conductor',
  ORGANIZATION: 'publisher',
  LABEL: 'publisher',
  ISRC: 'isrc',
  COPYRIGHT: 'copyright',
  DATE: 'year',
};
const MP4_FIELDS = {
  '©nam': 'title',
  '©ART': 'artist',
  '©alb': 'album',
  '©wrt': 'composer',
  '©day': 'year',
  '©pub': 'publisher',
  '©cpy': 'copyright',
  cprt: 'copyright',
};

/** The order to show these in, and what to call each one on screen. */
const TAG_LABELS = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['composer', 'Composer'],
  ['conductor', 'Conductor'],
  ['album', 'Album'],
  ['publisher', 'Label'],
  ['year', 'Year'],
  ['copyright', 'Copyright'],
  ['isrc', 'ISRC'],
];

/** Text out of a byte range, in whichever encoding the tag claims. */
function tagText(bytes, from, to, encoding) {
  const labels = ['latin1', 'utf-16', 'utf-16be', 'utf-8'];
  const length = Math.max(0, Math.min(to, bytes.byteLength) - from);
  if (from < 0 || length <= 0) return '';
  try {
    const text = new TextDecoder(labels[encoding] || 'utf-8').decode(
      new Uint8Array(bytes, from, length),
    );
    // A NUL ends the text; padding, or a second value, may follow it.
    return text.split('\u0000')[0].trim();
  } catch (_) {
    return '';
  }
}

/** The fields of an ID3v2 tag at the start of the file. */
function readId3Tags(bytes) {
  const total = id3Size(bytes);
  if (!total) return {};
  const view = new DataView(bytes);
  const major = view.getUint8(3);
  const short = major <= 2; // 2.2 has three-character names and no flag bytes
  const headerLength = short ? 6 : 10;
  const found = {};

  let at = 10;
  const end = Math.min(total, bytes.byteLength);
  while (at + headerLength <= end) {
    let name = '';
    for (let i = 0; i < (short ? 3 : 4); i++) name += String.fromCharCode(view.getUint8(at + i));
    if (!/^[A-Z0-9]+$/.test(name)) break; // padding, or the end of the frames

    let size;
    if (short) {
      size = (view.getUint8(at + 3) << 16) | (view.getUint8(at + 4) << 8) | view.getUint8(at + 5);
    } else if (major >= 4) {
      // 2.4 writes frame sizes seven bits at a time, as the tag header does
      size =
        (view.getUint8(at + 4) << 21) |
        (view.getUint8(at + 5) << 14) |
        (view.getUint8(at + 6) << 7) |
        view.getUint8(at + 7);
    } else {
      size = view.getUint32(at + 4);
    }
    if (size <= 0 || at + headerLength + size > end) break;

    const field = ID3_FRAMES[name];
    if (field && !found[field]) {
      const body = at + headerLength;
      const text = tagText(bytes, body + 1, body + size, view.getUint8(body));
      if (text) found[field] = text;
    }
    at += headerLength + size;
  }
  return found;
}

/** The fields of a Vorbis comment header, which Ogg Vorbis and Opus both use. */
function readVorbisTags(bytes) {
  const view = new DataView(bytes);
  const marker = (at, text) => {
    if (at + text.length > view.byteLength) return false;
    for (let i = 0; i < text.length; i++) {
      if (view.getUint8(at + i) !== text.charCodeAt(i)) return false;
    }
    return true;
  };

  /* The comment header is the second packet, which may begin part way into a
     page. Found by its own marker rather than by reassembling packets. */
  let at = -1;
  const search = Math.min(view.byteLength, 65536);
  for (let i = 0; i < search; i++) {
    if (marker(i, 'OpusTags')) {
      at = i + 8;
      break;
    }
    if (marker(i, 'vorbis')) {
      at = i + 7;
      break;
    }
  }
  if (at < 0) return {};

  const found = {};
  if (at + 8 > view.byteLength) return found;
  at += 4 + view.getUint32(at, true); // the vendor string, which is not a field
  if (at + 4 > view.byteLength) return found;
  let count = view.getUint32(at, true);
  at += 4;
  // A comment header can run past the end of what is here. Whatever is readable
  // is read, and the rest is simply not known.
  while (count-- > 0 && at + 4 <= view.byteLength) {
    const length = view.getUint32(at, true);
    at += 4;
    if (length <= 0 || at + length > view.byteLength) break;
    const comment = tagText(bytes, at, at + length, 3);
    const split = comment.indexOf('=');
    if (split > 0) {
      const field = VORBIS_FIELDS[comment.slice(0, split).toUpperCase()];
      const value = comment.slice(split + 1).trim();
      if (field && value && !found[field]) found[field] = value;
    }
    at += length;
  }
  return found;
}

/** The fields of an MP4 metadata list, which m4a and aac files carry. */
function readMp4Tags(bytes) {
  const view = new DataView(bytes);
  const boxName = (at) => {
    let text = '';
    for (let i = 4; i < 8; i++) text += String.fromCharCode(view.getUint8(at + i));
    return text;
  };
  const found = {};

  /* Only the path down to the metadata list is walked. `meta` is the odd one:
     four bytes of version and flags sit between it and its children. */
  const walk = (from, to, depth) => {
    let at = from;
    while (at + 8 <= to && depth < 6) {
      let size = view.getUint32(at);
      let body = at + 8;
      if (size === 1) {
        if (at + 16 > to) return;
        size = view.getUint32(at + 12); // a 64-bit size, of which this is the half that fits
        body = at + 16;
      }
      if (size < 8 || at + size > to) return;
      const box = boxName(at);
      if (box === 'moov' || box === 'udta' || box === 'ilst') {
        walk(body, at + size, depth + 1);
      } else if (box === 'meta') {
        walk(body + 4, at + size, depth + 1);
      } else if (MP4_FIELDS[box] && !found[MP4_FIELDS[box]]) {
        // the value sits in a `data` box, after its type and its locale
        if (body + 16 <= at + size && boxName(body) === 'data') {
          const text = tagText(bytes, body + 16, at + size, 3);
          if (text) found[MP4_FIELDS[box]] = text;
        }
      }
      at += size;
    }
  };
  walk(0, view.byteLength, 0);
  return found;
}

/**
 * Whatever the file says about itself, from whichever container it is in.
 *
 * Every reader is tried rather than choosing one from the extension: files are
 * routinely named wrongly, and an MP3 with an ID3 tag inside a `.m4a` should
 * still give up its title. The first reader that finds anything wins.
 */
function readTags(bytes) {
  for (const read of [readId3Tags, readMp4Tags, readVorbisTags]) {
    try {
      const found = read(bytes);
      if (Object.keys(found).length) return found;
    } catch (_) {
      /* a malformed tag is not a reason to refuse the music */
    }
  }
  return {};
}

/**
 * A short identity for a file's audio, so a project can tell whether the song
 * it has been handed is the one it was built from.
 *
 * Files are matched by name, which is all a browser offers — it will not tell a
 * page where a file lives, and a handle to one cannot be written into a project
 * file. So a project cannot record a location. What it can record is what the
 * audio looked like, and that is enough to say "this is a different song with
 * the same name" rather than silently rebuilding the program around it.
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
 * Separate from `analyzeSource`, which needs a decoded buffer and a File to say
 * anything at all. The judgment itself is the part that is easy to get wrong
 * and easy to check, so it stands on its own and takes plain numbers. Its test
 * calls it rather than keeping its own copy of these thresholds, which would be
 * asserting against itself and would pass whatever this actually did.
 *
 * `bitrate` is the real figure; the comparison is against its MP3-equivalent,
 * because 128k Opus and 128k MP3 are not the same thing. A null measurement
 * means unknown, never zero.
 */
function qualityKind({ bitrate = null, sampleRate = null, codec = '', lossless = false }) {
  // Nothing measurable and not a known lossless format — say so rather than
  // implying it's fine.
  let kind = !lossless && bitrate === null ? 'unknown' : 'good';
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
function analyzeSource(head, tagEnd, file, buffer) {
  const lossless = /\.(wav|flac|aiff?)$/i.test(file.name);
  // Only attempt MPEG parsing on files that could plausibly be MPEG. The frame
  // validator would reject Opus anyway, but not paying for the scan is better.
  const maybeMpeg = /\.(mp3|mp2|mpga)$/i.test(file.name);
  let info = null;

  if (!lossless && maybeMpeg) {
    try {
      info = readMpegFrame(head, 0);
    } catch (_) {
      info = null;
    }
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
    bitrate,
    sampleRate,
    channels,
    lossless,
    kind,
    codec,
    notes,
    estimated,
    vbr: Boolean(info && info.vbr),
  };
}

/* A verdict rather than a number. 128k Opus and 128k MP3 sound nothing alike,
 * so showing bitrates invites exactly the wrong comparison — the codec factors
 * above already do that reasoning. The figures stay in the tooltip. */
const QUALITY_LABEL = { good: 'Good', caution: 'Fair', poor: 'Low', unknown: 'Unknown' };

/** Compact badge text — must stay narrow enough to sit beside the Add button. */
function qualityLabel(q) {
  return q ? QUALITY_LABEL[q.kind] || 'Unknown' : '';
}

/** Everything worth saying, for the tooltip and the export warning. */
function qualityDetail(q) {
  const head = q.lossless
    ? 'Lossless source'
    : q.kind === 'unknown'
      ? 'Could not measure this file'
      : q.kind === 'good'
        ? 'Good quality'
        : q.kind === 'poor'
          ? 'Low quality — may sound rough on a rink system'
          : 'Below CD quality, but probably fine';
  const parts = [];
  if (q.bitrate && !q.lossless) parts.push(`${q.bitrate} kbps${q.estimated ? ' (estimated)' : ''}`);
  if (q.codec) parts.push(q.codec);
  if (q.sampleRate !== null) parts.push(`${(q.sampleRate / 1000).toFixed(1)} kHz`);
  parts.push(q.channels === 1 ? 'mono' : 'stereo');
  if (q.vbr) parts.push('VBR');
  return `${head} — ${parts.join(', ')}`;
}

/* How much better one source has to be before it is worth calling better. Two
   files that measure 190 and 192 kbps are the same file for every purpose a
   skater has, and saying otherwise would turn a real question — is this an
   upgrade? — into noise. */
const BETTER_BY = 1.1;

/**
 * Is `candidate` a better source than `current`? Pure, and takes the two
 * analyses `analyzeSource` produces.
 *
 * Answers in MP3-equivalent terms for the same reason the badge does: 128 kbps
 * Opus is not 128 kbps MP3, and a swap that reads as a downgrade on the raw
 * numbers can be an upgrade on the ear. Lossless outranks everything lossy
 * whatever the bitrates say, because there is nothing left to gain past it.
 *
 * `null` for either measurement means unknown, and unknown is its own answer —
 * never "the same" and never "worse".
 */
function compareQuality(current, candidate) {
  if (!current || !candidate) return { direction: 'unknown', says: 'Could not compare the two' };

  const rate = (q) =>
    q.lossless
      ? Infinity
      : q.bitrate === null
        ? null
        : q.bitrate * (CODEC_EFFICIENCY[q.codec] || 1);
  const was = rate(current);
  const now = rate(candidate);

  if (was === null || now === null) {
    return {
      direction: 'unknown',
      says:
        was === null
          ? 'The song already here could not be measured, so there is nothing to compare against'
          : 'This file could not be measured, so whether it is better is unknown',
    };
  }

  const sample = (q) => q.sampleRate;
  const rateNote =
    sample(candidate) !== null && sample(current) !== null && sample(candidate) < sample(current)
      ? ` — but sampled at ${(sample(candidate) / 1000).toFixed(1)} kHz rather than ${(sample(current) / 1000).toFixed(1)} kHz`
      : '';

  if (candidate.lossless && !current.lossless) {
    return { direction: 'better', says: 'Lossless, where the song already here is compressed' };
  }
  if (current.lossless && !candidate.lossless) {
    return { direction: 'worse', says: 'Compressed, where the song already here is lossless' };
  }
  if (now > was * BETTER_BY) {
    return {
      direction: 'better',
      says: `${describeRate(candidate)}, up from ${describeRate(current)}${rateNote}`,
    };
  }
  if (was > now * BETTER_BY) {
    return {
      direction: 'worse',
      says: `${describeRate(candidate)}, down from ${describeRate(current)}${rateNote}`,
    };
  }
  return {
    direction: 'same',
    says: `About the same quality as the song already here${rateNote || ' — both around ' + describeRate(current)}`,
  };
}

/** A source's bitrate as a person would say it, or what it is when there is none. */
function describeRate(q) {
  if (q.lossless) return 'lossless';
  if (q.bitrate === null) return 'an unknown bitrate';
  return `${q.bitrate} kbps ${q.codec || 'audio'}`;
}

/* Under Node — the test suite — hand the parsing over. In a browser these are
   already global and this block does nothing. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUALITY,
    CODEC_EFFICIENCY,
    codecOf,
    id3Size,
    oggAudioStart,
    readTags,
    readId3Tags,
    readVorbisTags,
    readMp4Tags,
    TAG_LABELS,
    readMpegFrame,
    parseFrameHeader,
    qualityKind,
    analyzeSource,
    qualityLabel,
    qualityDetail,
    fingerprint,
    BETTER_BY,
    compareQuality,
    describeRate,
  };
}
