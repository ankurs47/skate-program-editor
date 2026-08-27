#!/usr/bin/env node
/**
 * Build the vendored MP3 encoder, `src/vendor/mp3-encoder.js`.
 *
 *   node tools/build-mp3-encoder.js           # rebuild it
 *   node tools/build-mp3-encoder.js --check   # rebuild and compare, changing nothing
 *
 * Browsers play MP3 and none of them can create one, so the encoder has to come
 * from somewhere. It used to be fetched from a CDN; it is a file in this
 * repository instead, and that is a deliberate trade.
 *
 * Why a bundle rather than the published files: mediabunny ships ES modules,
 * and a page opened from disk cannot load a local one — `file://` is an opaque
 * origin, so the import is refused before it is read. A classic script has no
 * such problem. Bundling to one is what lets the encoder be a file here at all,
 * and it is why this script exists rather than a copy step.
 *
 * Why bundle it ourselves rather than take the one they publish: the encoder
 * cannot run without mediabunny's core, and the core is a whole media toolkit —
 * demuxers for containers this app never opens, muxers it never writes, codec
 * tables for video. Bundling only what `src/audio.js` calls takes 945 KB down to
 * around 400 KB. Everything dropped is code that could not have run.
 *
 * Nothing here is installed by `npm install`. The pinned packages and the
 * bundler are fetched into a temporary directory when this runs and thrown away
 * afterwards, so cloning the repository stays a small download and the app
 * still has no dependency it reaches for. That makes this the slow script it is
 * — a minute or two — which is why it is not part of `npm test`.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src/vendor/mp3-encoder.js');

/* The exact versions this file was built from. The bundler is pinned with them,
   because its output is what gets committed: a newer esbuild that minifies one
   expression differently would show up as a repository full of changes nobody
   made, and `--check` would call it drift. */
const PINS = {
  mediabunny: {
    version: '1.55.3',
    integrity:
      'sha512-kpBhMiJHGmerizzObAT1XLZDyImO4ZEKXaxjjfxGVkycQ0U5of/xlLepm1Izp3P+3jlaedFSRI5fJnv3Q5xV6A==',
  },
  '@mediabunny/mp3-encoder': {
    version: '1.55.3',
    integrity:
      'sha512-plPXIgyF9veZTxMWIwG+N8u/6WKvnm3xB5bVP6bWXqmsgPddaGXLtutizV1lUMp76sjHbg+NFG7W754/WhBskA==',
  },
  esbuild: {
    version: '0.28.1',
    integrity:
      'sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D4Vw==',
  },
};

/* The global the page ends up with, and the only names taken from the library.
   Anything added here has to be something `src/audio.js` actually calls — the
   list is what makes the bundle small. */
const GLOBAL = 'MediabunnyMp3';
const ENTRY = `
import {
  Output,
  Mp3OutputFormat,
  BufferTarget,
  AudioBufferSource,
  canEncodeAudio,
} from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

export { Output, Mp3OutputFormat, BufferTarget, AudioBufferSource, canEncodeAudio, registerMp3Encoder };
`;

function banner() {
  const line = (name) => `${name}@${PINS[name].version}`;
  return `/*
 * GENERATED FILE — do not edit, and do not reformat.
 *
 * The MP3 encoder, bundled for a page with no build step. Built from:
 *
 *     ${line('mediabunny')}
 *     ${line('@mediabunny/mp3-encoder')}
 *     bundled by ${line('esbuild')}
 *
 * Rebuild:  node tools/build-mp3-encoder.js
 * Verify:   node tools/build-mp3-encoder.js --check
 *
 * mediabunny and its MP3 encoder are MPL-2.0 and the encoder embeds LAME, which
 * is LGPL — neither is the MIT the rest of this repository carries. The terms
 * are in src/vendor/NOTICE.md, and the license headers below are theirs.
 */`;
}

/** Ask the registry what it has for a version, and refuse anything else. */
function verifyPublished(name) {
  const { version, integrity } = PINS[name];
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`;
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          let meta;
          try {
            meta = JSON.parse(body);
          } catch (_) {
            return reject(new Error(`${name}@${version}: the registry sent something unreadable`));
          }
          if (!meta.dist || meta.dist.integrity !== integrity) {
            return reject(
              new Error(
                `${name}@${version} no longer hashes to what is pinned here.\n` +
                  `  pinned:   ${integrity}\n` +
                  `  registry: ${(meta.dist || {}).integrity}\n` +
                  `Find out why the bytes changed before updating the pin.`,
              ),
            );
          }
          resolve();
        });
      })
      .on('error', reject);
  });
}

function build(into) {
  const pkg = {
    name: 'mp3-encoder-build',
    private: true,
    dependencies: Object.fromEntries(
      Object.entries(PINS).map(([name, { version }]) => [name, version]),
    ),
  };
  fs.writeFileSync(path.join(into, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(into, 'entry.js'), ENTRY);

  console.log('  installing the pinned packages…');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], {
    cwd: into,
    stdio: 'inherit',
  });

  console.log('  bundling…');
  const out = path.join(into, 'bundle.js');
  execFileSync(
    path.join(into, 'node_modules/.bin/esbuild'),
    [
      'entry.js',
      '--bundle',
      '--format=iife',
      `--global-name=${GLOBAL}`,
      '--minify',
      /* Their copyright headers stay in the file. Stripping the license off
         someone's code because a minifier offered to is not a saving. */
      '--legal-comments=eof',
      '--target=es2022',
      `--banner:js=${banner()}`,
      `--outfile=${out}`,
    ],
    { cwd: into, stdio: 'inherit' },
  );
  return fs.readFileSync(out);
}

async function main() {
  const checking = process.argv.includes('--check');

  console.log('Verifying the pinned packages are still what was published…');
  await Promise.all(Object.keys(PINS).map(verifyPublished));

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-encoder-'));
  let built;
  try {
    built = build(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  if (checking) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
    if (!have.equals(built)) {
      console.error(
        `\n${path.relative(ROOT, OUT)} is not what these pins build.\n` +
          `  committed: ${have.length} bytes\n` +
          `  rebuilt:   ${built.length} bytes\n` +
          'Run `node tools/build-mp3-encoder.js` and commit the result.',
      );
      process.exit(1);
    }
    console.log(`\n${path.relative(ROOT, OUT)} matches its sources — ${built.length} bytes.`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, built);
  console.log(`\nWrote ${path.relative(ROOT, OUT)} — ${built.length} bytes.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}

/* The tests read the pins from here rather than keeping a second copy: what is
   committed in src/vendor has to be traceable to a version somebody chose. */
module.exports = { PINS, GLOBAL, OUT, verifyPublished };
