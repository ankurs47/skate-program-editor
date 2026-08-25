/**
 * Container and codec parsing, and the quality verdict — the formats.js file.
 *
 * The traps here are the reason this is worth testing on its own: a lone MPEG
 * sync word means nothing, ID3 tags with artwork run to hundreds of kilobytes,
 * and Ogg hides its cover art somewhere else again.
 */
'use strict';

const { app, check, eq, ok } = require('./harness.js');

check('qualityDetail: the tooltip says the numbers the badge refuses to', () => {
  // The badge is a word on purpose; this is where the figures live.
  const detail = app.qualityDetail({
    kind: 'good',
    bitrate: 256,
    sampleRate: 44100,
    channels: 2,
    lossless: false,
    codec: 'mp3',
    estimated: false,
    vbr: false,
    notes: [],
  });
  for (const part of ['256 kbps', 'mp3', '44.1 kHz', 'stereo']) {
    ok(detail.includes(part), `"${detail}" is missing ${part}`);
  }

  const lossless = app.qualityDetail({
    kind: 'good',
    bitrate: null,
    sampleRate: null,
    channels: 1,
    lossless: true,
    codec: 'wav',
    estimated: false,
    vbr: false,
    notes: [],
  });
  ok(lossless.startsWith('Lossless source'), `"${lossless}" should lead with that`);
  ok(lossless.includes('mono'), 'channel count is always worth saying');
  ok(!/kbps/.test(lossless), 'a lossless file has no bitrate worth quoting');

  const guessed = app.qualityDetail({
    kind: 'caution',
    bitrate: 130,
    sampleRate: null,
    channels: 2,
    lossless: false,
    codec: 'opus',
    estimated: true,
    vbr: false,
    notes: [],
  });
  ok(guessed.includes('estimated'), 'a measured-by-file-size figure must say so');
});

check('quality: judged per codec, not on the raw number', () => {
  /* This calls the app's own judgment rather than restating the thresholds
     here. A test carrying its own copy of them asserts against itself, and
     passes whatever `qualityKind` actually does — leaving the thresholds not
     under test at all. */
  const verdict = (bitrate, codec) => app.qualityKind({ bitrate, codec });
  eq(verdict(128, 'opus'), 'good', '128k opus is genuinely fine: ');
  eq(verdict(128, 'mp3'), 'caution', 'the same number in mp3 is not: ');
  eq(verdict(107, 'mp3'), 'poor');
  eq(verdict(205, 'mp3'), 'good');
  eq(verdict(64, 'opus'), 'poor');
  eq(verdict(128, 'wma'), 'caution', 'a codec not in the table gets no free credit: ');
});

check('quality: a file we could not measure says so rather than passing', () => {
  eq(app.qualityKind({ bitrate: null, codec: 'm4a' }), 'unknown');
  eq(
    app.qualityKind({ bitrate: null, lossless: true }),
    'good',
    'wav and flac need no bitrate to be trusted: ',
  );
  eq(
    app.qualityKind({ bitrate: 64, lossless: true }),
    'good',
    'a lossless file is not judged on a bitrate at all: ',
  );
});

check('quality: a low sample rate pulls the verdict down on its own', () => {
  // A 320k rip of a 22 kHz source is a bad file the bitrate alone calls good.
  eq(app.qualityKind({ bitrate: 320, sampleRate: 22050, codec: 'mp3' }), 'poor');
  eq(
    app.qualityKind({ bitrate: 320, sampleRate: 32000, codec: 'mp3' }),
    'caution',
    'below CD rate but not hopeless: ',
  );
  eq(app.qualityKind({ bitrate: 320, sampleRate: 44100, codec: 'mp3' }), 'good');
  eq(
    app.qualityKind({ bitrate: 96, sampleRate: 44100, codec: 'mp3' }),
    'poor',
    'a good sample rate cannot rescue a bad bitrate: ',
  );
});

check('quality: badges are short words, never bitrates', () => {
  for (const kind of ['good', 'caution', 'poor', 'unknown']) {
    const label = app.qualityLabel({ kind });
    ok(label.length <= 8, `"${label}" is too long for the badge`);
    ok(!/\d/.test(label), `"${label}" leaks a number into the badge`);
  }
});

check('codecOf: WebM from YouTube is Opus', () => {
  eq(app.codecOf('song.webm'), 'opus');
  eq(app.codecOf('song.opus'), 'opus');
  eq(app.codecOf('song.MP3'), 'mp3', 'extension match is case insensitive: ');
});

check('MPEG parser: rejects data that merely looks like a frame', () => {
  // Random bytes contain 0xFF sync patterns constantly; without requiring
  // consecutive frames this returned a confident, wrong bitrate.
  const noise = Buffer.alloc(200000);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff;
  eq(app.readMpegFrame(noise.buffer.slice(0), 0), null);
});

check('parseFrameHeader: decodes a real MPEG-1 Layer III header', () => {
  // FF FB 90 00 — MPEG1, Layer III, 128 kbps, 44100, joint stereo, no padding.
  const view = new DataView(new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer);
  const frame = app.parseFrameHeader(view, 0);
  ok(frame, 'a valid header was rejected');
  eq(frame.bitrate, 128);
  eq(frame.sampleRate, 44100);
  eq(frame.channels, 2);
  eq(frame.samplesPerFrame, 1152);
  // 144 * 128000 / 44100 = 417.9, floored, plus no padding
  eq(frame.frameLength, 417, 'frame length is what the chain walk steps by: ');
});

check('parseFrameHeader: refuses the reserved and impossible encodings', () => {
  const header = (b1, b2, b3 = 0x00) =>
    app.parseFrameHeader(new DataView(new Uint8Array([0xff, b1, b2, b3]).buffer), 0);
  eq(header(0xfb, 0x00), null, 'bitrate index 0 is "free", not a rate: ');
  eq(header(0xfb, 0xf0), null, 'bitrate index 15 is reserved: ');
  eq(header(0xfb, 0x9c), null, 'sample rate index 3 is reserved: ');
  eq(header(0xff, 0x90), null, 'layer bits 3 is Layer I, not III: ');
  eq(header(0xeb, 0x90), null, 'version bits 1 is reserved: ');
  eq(
    app.parseFrameHeader(new DataView(new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer), 0),
    null,
    'no sync word at all: ',
  );
  eq(
    app.parseFrameHeader(new DataView(new Uint8Array([0xff, 0xfb]).buffer), 0),
    null,
    'a header cut short by the end of the window: ',
  );
});

check('fingerprint: the same audio matches, different audio does not', () => {
  const bytes = (values) => new Uint8Array(values).buffer;
  const a = bytes([1, 2, 3, 4, 5, 6, 7, 8]);
  const b = bytes([1, 2, 3, 4, 5, 6, 7, 8]);
  const c = bytes([1, 2, 3, 4, 5, 6, 7, 9]);

  eq(app.fingerprint(a), app.fingerprint(b), 'identical bytes must agree: ');
  ok(app.fingerprint(a) !== app.fingerprint(c), 'one byte apart must not');
  ok(app.fingerprint(bytes([])) !== app.fingerprint(a), 'and nor must nothing at all');

  // It ends up in a project file, so it has to be short and plainly text.
  const printed = app.fingerprint(a);
  ok(/^[0-9a-z]+$/.test(printed), `"${printed}" should be plain and short`);
  ok(printed.length <= 8, `"${printed}" is longer than a file record wants`);
});

check('fingerprint: order matters, so a reshuffle is not the same song', () => {
  // A sum or an xor would call these equal, which would defeat the point.
  const bytes = (values) => new Uint8Array(values).buffer;
  ok(
    app.fingerprint(bytes([1, 2, 3])) !== app.fingerprint(bytes([3, 2, 1])),
    'a hash that ignores order cannot tell two files apart',
  );
});

check('id3Size: reads the syncsafe length, tolerates untagged files', () => {
  const tagged = Buffer.alloc(20);
  tagged.write('ID3');
  [tagged[6], tagged[7], tagged[8], tagged[9]] = [0, 0, 2, 1];
  eq(app.id3Size(tagged.buffer.slice(0)), ((2 << 7) | 1) + 10);
  eq(app.id3Size(Buffer.alloc(20).buffer.slice(0)), 0, 'no tag: ');
  eq(app.id3Size(Buffer.alloc(4).buffer.slice(0)), 0, 'too short to have one: ');
});

/**
 * The exact bytes of a Buffer, as an ArrayBuffer.
 *
 * Not `buf.buffer.slice(0)`: anything under 4 KB from `Buffer.concat` or
 * `allocUnsafe` comes out of Node's shared pool, so `.buffer` is the whole
 * arena and the data starts at `byteOffset`, not at 0. `Buffer.alloc` happens
 * to be unpooled, which is why that shortcut works elsewhere in this file and
 * silently did not here.
 */
function bytesOf(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** One Ogg page with the given segment lacing values. */
function oggPage(lacing) {
  const payload = lacing.reduce((n, v) => n + v, 0);
  const page = Buffer.alloc(27 + lacing.length + payload, 0x41);
  page.write('OggS', 0);
  page[26] = lacing.length;
  for (let i = 0; i < lacing.length; i++) page[27 + i] = lacing[i];
  return page;
}

check('oggAudioStart: skips the two headers to where the audio really begins', () => {
  /* This is what stops a yt-dlp download reading ~40% too high: Ogg Opus keeps
     its cover art in the OpusTags comment header, and measuring the bitrate
     from file size without skipping it counts the artwork as audio. */
  const head = oggPage([19]); // OpusHead: 27 + 1 + 19 = 47
  const tags = oggPage([100]); // OpusTags: 27 + 1 + 100 = 128
  const audio = Buffer.alloc(4096, 0x5a);
  const file = Buffer.concat([head, tags, audio]);
  eq(app.oggAudioStart(bytesOf(file)), 47 + 128, 'audio starts after both headers: ');
});

check('oggAudioStart: a comment header big enough for cover art spans segments', () => {
  // A packet longer than 255 bytes is split into 255-byte segments, and only
  // the final short one ends it. Artwork makes this the normal case, not an
  // edge one — 255 + 255 + 100 is a 610-byte tags packet.
  const head = oggPage([19]);
  const tags = oggPage([255, 255, 100]); // 27 + 3 + 610 = 640
  const file = Buffer.concat([head, tags, Buffer.alloc(2048, 0x5a)]);
  eq(
    app.oggAudioStart(bytesOf(file)),
    47 + 640,
    'the multi-segment comment header was not fully skipped: ',
  );
});

check('oggAudioStart: says nothing rather than guessing on other containers', () => {
  eq(app.oggAudioStart(bytesOf(Buffer.alloc(4096, 0x41))), 0, 'not an Ogg stream: ');
  eq(app.oggAudioStart(bytesOf(Buffer.alloc(10))), 0, 'too short to hold a page: ');
  eq(
    app.oggAudioStart(bytesOf(oggPage([19]))),
    0,
    'one header alone is not enough to locate the audio: ',
  );
});

/* ------------------------------------------------------------------- tags */

/* Real tag layouts, built here rather than shipped as sample files: a few dozen
   bytes each, and every field is visible in the test instead of hidden inside a
   binary nobody can read in a diff. */
const bytes = (...parts) =>
  Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
/** Seven bits a byte, which is how ID3 writes a length that must not look like audio. */
const synchsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const asBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function id3File(major, frames) {
  const body = Buffer.concat(
    frames.map(([name, text]) => {
      const payload = bytes(Buffer.from([3]), Buffer.from(text, 'utf8'), Buffer.from([0]));
      if (major === 2) {
        const size = Buffer.alloc(3);
        size.writeUIntBE(payload.length, 0, 3);
        return bytes(Buffer.from(name.slice(0, 3), 'latin1'), size, payload);
      }
      const size = major >= 4 ? synchsafe(payload.length) : be32(payload.length);
      return bytes(Buffer.from(name, 'latin1'), size, Buffer.from([0, 0]), payload);
    }),
  );
  return asBuffer(bytes('ID3', Buffer.from([major, 0, 0]), synchsafe(body.length), body));
}

function mp4File(fields) {
  const box = (name, ...inner) => {
    const body = Buffer.concat(inner.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
    return bytes(be32(body.length + 8), Buffer.from(name, 'latin1'), body);
  };
  const item = (name, text) => box(name, box('data', be32(1), be32(0), Buffer.from(text, 'utf8')));
  const list = box('ilst', ...fields.map(([name, value]) => item(name, value)));
  // `meta` keeps four bytes of version and flags between itself and its children
  const meta = bytes(be32(list.length + 12), Buffer.from('meta', 'latin1'), be32(0), list);
  return asBuffer(bytes(box('ftyp', 'M4A '), box('moov', box('udta', meta))));
}

function opusFile(comments) {
  const vendor = Buffer.from('test', 'utf8');
  const parts = comments.map((c) => {
    const b = Buffer.from(c, 'utf8');
    return bytes(le32(b.length), b);
  });
  return asBuffer(
    bytes(
      'OggS',
      Buffer.alloc(23),
      'OpusTags',
      le32(vendor.length),
      vendor,
      le32(parts.length),
      Buffer.concat(parts),
    ),
  );
}

check('tags: an ID3 tag gives up what the file is called and who wrote it', () => {
  /* Entry forms ask for the title and often the composer, and `track03.mp3`
     answers neither. All three ID3 generations are still out there — 2.2 names
     frames with three characters, and 2.4 writes their lengths seven bits at a
     time — so a file from any of them has to be readable. */
  const v23 = app.readTags(
    id3File(3, [
      ['TIT2', 'Adagio in G minor'],
      ['TPE1', 'Some Orchestra'],
      ['TCOM', 'Tomaso Albinoni'],
      ['TPUB', 'A Label'],
      ['TSRC', 'GBAYE0601498'],
      ['TCOP', '1958 A Label Ltd'],
      ['TYER', '1958'],
    ]),
  );
  eq(v23.title, 'Adagio in G minor');
  eq(v23.composer, 'Tomaso Albinoni');
  eq(v23.publisher, 'A Label');
  eq(v23.year, '1958');
  /* The two that answer "who would I ask about using this". An ISRC names one
     specific recording rather than the song, which is what a rights database
     wants; the copyright line usually names whoever owns it. */
  eq(v23.isrc, 'GBAYE0601498');
  eq(v23.copyright, '1958 A Label Ltd');

  const v24 = app.readTags(
    id3File(4, [
      ['TIT2', 'Bolero'],
      ['TCOM', 'Ravel'],
      ['TDRC', '1928'],
    ]),
  );
  eq([v24.title, v24.composer, v24.year], ['Bolero', 'Ravel', '1928'], 'ID3v2.4: ');

  const v22 = app.readTags(
    id3File(2, [
      ['TT2', 'Carmen'],
      ['TCM', 'Bizet'],
    ]),
  );
  eq([v22.title, v22.composer], ['Carmen', 'Bizet'], 'ID3v2.2: ');
});

check('tags: m4a and opus keep the same facts somewhere else entirely', () => {
  /* The two formats a download is most likely to arrive in. Every reader is
     tried rather than choosing one by extension, because files are routinely
     named wrongly. */
  const m4a = app.readTags(
    mp4File([
      ['\u00a9nam', 'Swan Lake'],
      ['\u00a9wrt', 'Tchaikovsky'],
      ['\u00a9ART', 'An Orchestra'],
    ]),
  );
  eq([m4a.title, m4a.composer, m4a.artist], ['Swan Lake', 'Tchaikovsky', 'An Orchestra'], 'm4a: ');

  const opus = app.readTags(
    opusFile(['TITLE=Nocturne', 'COMPOSER=Chopin', 'ORGANIZATION=A Label', 'ISRC=GBAYE0601498']),
  );
  eq([opus.title, opus.composer, opus.publisher], ['Nocturne', 'Chopin', 'A Label'], 'opus: ');
  eq(opus.isrc, 'GBAYE0601498', 'an ISRC in a Vorbis comment: ');
});

check('tags: a file with nothing to say is not a file that fails', () => {
  /* Most of what a skater has is untagged, and a tag can be truncated, padded,
     or written by something that got the length wrong. None of that is a reason
     to refuse somebody's music. */
  const hostile = [
    ['no tags at all', asBuffer(Buffer.alloc(2048))],
    ['an empty file', asBuffer(Buffer.alloc(0))],
    [
      'an ID3 header and nothing else',
      asBuffer(bytes('ID3', Buffer.from([3, 0, 0]), synchsafe(4096))),
    ],
    [
      'a frame claiming more than is there',
      asBuffer(
        bytes(
          'ID3',
          Buffer.from([3, 0, 0]),
          synchsafe(100),
          'TIT2',
          be32(9999),
          Buffer.from([0, 0, 3]),
          'x',
        ),
      ),
    ],
    ['an MP4 box bigger than the file', asBuffer(bytes(be32(99999), 'moov'))],
    [
      'a comment count past the end',
      asBuffer(bytes('OggS', Buffer.alloc(23), 'OpusTags', le32(0), le32(9999))),
    ],
  ];
  for (const [label, doc] of hostile) {
    let found = null;
    try {
      found = app.readTags(doc);
    } catch (e) {
      ok(false, `${label} threw: ${e.message}`);
      continue;
    }
    ok(found && typeof found === 'object', `${label} gave back nothing usable`);
  }

  // And a real tag still reads, so the above is not passing by reading nothing.
  eq(app.readTags(id3File(3, [['TIT2', 'Still works']])).title, 'Still works');
});
