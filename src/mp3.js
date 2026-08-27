/* Which MP3 encoder this app uses, and the only file that knows.
 *
 * Browsers can decode MP3 but none of them can create one — WebCodecs exposes
 * an AudioEncoder everywhere, and `mp3` is not among the codecs any of them
 * will encode — so the editor carries its own.
 *
 * `audio.js` owns exporting and knows nothing about which encoder is here. It
 * calls `installMp3Encoder` with a `register` function, and what is registered
 * is two calls: get ready, and encode a buffer. Swapping libraries is rewriting
 * this file. Nothing else changes — not `audio.js`, not the page, not the
 * script list, because the name of the file and the shape it registers are the
 * contract rather than the library behind them.
 *
 * What is behind it today is mediabunny's MP3 encoder: LAME compiled to
 * WebAssembly, encoding in a worker it starts for itself, so the page stays
 * live through an export. That last part is why it is the one here — export is
 * the operation nobody can afford to have look broken, and a page that stops
 * answering looks broken.
 *
 * The bundle lives in this repository so the editor works with no network at
 * all once the page is open, and so nobody outside the repository can change
 * what export does. `tools/build-mp3-encoder.js` builds it and can prove the
 * committed bytes are what its sources produce.
 */
'use strict';

/* The bundle, and the global it defines. Both belong to this file: another
   encoder would have its own, or none. */
const MP3_ENCODER_FILE = 'src/vendor/mp3-encoder.js';
const MP3_ENCODER_GLOBAL = 'MediabunnyMp3';

/**
 * Hand `audio.js` the encoder to use.
 *
 * Called during startup rather than when this file loads, so the order the
 * page lists its scripts in stays something nobody has to think about.
 */
function installMp3Encoder(register) {
  register({
    name: 'mediabunny',
    load: loadMediabunny,
    encode: encodeWithMediabunny,
  });
}

/** The library, once it is there. */
let mediabunny = null;

/**
 * Fetch the bundle and say whether it can produce what `spec` asks for.
 *
 * Loaded on the way past rather than with the page: it is 400 KB that most
 * sessions never reach for, and nothing about starting up needs it. A failure
 * here is not an error — it is an app that offers WAV and says why.
 */
function loadMediabunny(spec) {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = MP3_ENCODER_FILE;
    script.async = true;
    script.onload = async () => {
      try {
        const lib = window[MP3_ENCODER_GLOBAL];
        /* Never override a browser that has grown its own MP3 encoder. None
           has yet; the day one does, its encoder is the better one to use. */
        if (!(await lib.canEncodeAudio('mp3'))) lib.registerMp3Encoder();
        const usable = await lib.canEncodeAudio('mp3', {
          numberOfChannels: spec.numberOfChannels,
          sampleRate: spec.sampleRate,
          bitrate: spec.bitrate,
        });
        mediabunny = usable ? lib : null;
        resolve(usable);
      } catch (_) {
        /* There, but not something this app can encode with. Same outcome as
           never arriving, and the same thing to say about it. */
        resolve(false);
      }
    };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

/**
 * Encode a rendered program, reporting progress from 0 to 1 as it goes.
 *
 * The work happens in a worker this library starts for itself, so there is no
 * loop here to yield from and nothing to keep the page responsive by hand.
 * Progress comes from the packets as they are produced.
 */
async function encodeWithMediabunny(buffer, spec, onProgress) {
  const { Output, Mp3OutputFormat, BufferTarget, AudioBufferSource } = mediabunny;

  const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
  const total = buffer.duration;
  const source = new AudioBufferSource({
    codec: 'mp3',
    /* `quality` is what this library would rather be given, but a named
       quality is a promise about how it sounds and this is a promise about the
       file: the bitrate the app asked for, whatever the encoder would have
       chosen. */
    bitrate: spec.bitrate,
    onEncodedPacket: (packet) => {
      if (total > 0) onProgress(Math.max(0, Math.min(1, packet.timestamp / total)));
    },
  });
  output.addAudioTrack(source);

  await output.start();
  await source.add(buffer);
  source.close();
  await output.finalize();

  return new Blob([output.target.buffer], { type: 'audio/mpeg' });
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MP3_ENCODER_FILE,
    MP3_ENCODER_GLOBAL,
    installMp3Encoder,
    loadMediabunny,
    encodeWithMediabunny,
  };
}
