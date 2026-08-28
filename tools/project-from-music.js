#!/usr/bin/env node
/**
 * Rebuild a project file from a music file this app made.
 *
 *   node tools/project-from-music.js "my long program.wav"
 *   node tools/project-from-music.js "my long program.mp3" -o program.skate.json
 *   node tools/project-from-music.js "my long program.wav" --show
 *
 * The editor can write what a program is into the file it exports. This reads
 * it back out. What comes out is the project document itself — the same thing
 * the app saves — so a folder that has lost its `program.skate.json` can be put
 * back together from the one file somebody kept.
 *
 * What it cannot do is bring the music back. The document names the songs it
 * was cut from and says which seconds of each it used, but the songs themselves
 * are not in here and nothing could put four minutes of a program and twenty
 * minutes of source material in the same file. Opening the result gives you
 * every edit and a list of what is missing, which is the same state a project
 * is in when its media folder has moved.
 *
 * Only files exported with "Describe the program inside the file" turned on
 * carry anything. It is off by default, and deliberately: what goes in includes
 * whatever was typed as the program's name, which is often a skater's.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* The app's own readers, rather than a second copy of them here. `app.js` puts
   every file's names into one scope, which is how the browser sees them too. */
const app = require(path.join(__dirname, '..', 'src', 'app.js'));

function usage(message) {
  if (message) console.error(`\n  ${message}`);
  console.error(`
  node tools/project-from-music.js <file> [-o <out>] [--show]

    <file>      a .wav or .mp3 exported by the editor
    -o <out>    where to write it; default is program.skate.json beside the file
    --show      print it instead of writing anything
`);
  process.exit(message ? 1 : 0);
}

/**
 * The project document a file carries, and how it was carried.
 *
 * Both containers are tried whatever the file is called. An extension is a
 * claim somebody made about a file and this has the bytes in front of it —
 * a WAV renamed to .mp3 should still give up its program.
 */
function readProgram(bytes) {
  const wav = app.readProjectChunk(bytes);
  if (wav) return { doc: wav, from: 'a RIFF chunk' };

  /* `readId3Tags` takes an ArrayBuffer and collects TXXX frames under their
     descriptions; the editor writes the document under one description. */
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const tags = app.readId3Tags(buffer);
  const text = tags.custom && tags.custom[app.MP3_PROGRAM_FRAME];
  if (!text) return { doc: null, from: null };
  try {
    return { doc: JSON.parse(text), from: 'an ID3 frame' };
  } catch (_) {
    return { doc: null, from: null, broken: true };
  }
}

/** What the document says, for somebody deciding whether it is the right one. */
function describe(doc) {
  const read = app.readProject(doc);
  const songs = read.songs.map((song) => song.name);
  const lines = [
    `  name     ${read.name || '(none)'}`,
    `  event    ${read.level || '(none)'}${read.targetSeconds ? ` — target ${app.fmt(read.targetSeconds)}` : ''}`,
    `  clips    ${read.clips.length}`,
    `  songs    ${songs.length ? songs.join(', ') : '(none named)'}`,
  ];
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) usage();

  const show = args.includes('--show');
  const at = args.indexOf('-o');
  const out = at >= 0 ? args[at + 1] : null;
  if (at >= 0 && !out) usage('-o needs somewhere to write to');

  /* `at` is -1 when there is no -o, and -1 + 1 is 0 — which is the first
     argument, and usually the file. Guarded rather than computed. */
  const skip = at >= 0 ? at + 1 : -1;
  const file = args.find((arg, i) => !arg.startsWith('-') && i !== skip);
  if (!file) usage('name a music file');
  if (!fs.existsSync(file)) usage(`there is no file at ${file}`);

  const { doc, from, broken } = readProgram(new Uint8Array(fs.readFileSync(file)));
  if (broken) usage(`${path.basename(file)} carries a program but it will not parse`);
  if (!doc) {
    usage(
      `${path.basename(file)} carries no program.\n` +
        '  Only files exported with "Describe the program inside the file" turned on do,\n' +
        '  and that is off unless somebody turned it on.',
    );
  }

  /* Read through the app's own reader before it is written anywhere. A document
     this refuses is one the editor would refuse too, and finding that out now
     beats finding it out when the file will not open. */
  const read = app.readProject(doc);
  if (read.unsupported) {
    usage(`that program was written by a newer version of the editor (format ${doc.version})`);
  }

  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (show) {
    process.stdout.write(text);
    return;
  }

  const target = out || path.join(path.dirname(file), 'program.skate.json');
  if (fs.existsSync(target)) usage(`${target} already exists — name somewhere else with -o`);
  fs.writeFileSync(target, text);

  console.log(`\n  Read a program out of ${from} in ${path.basename(file)}:\n`);
  console.log(describe(doc));
  console.log(`\n  Written to ${target}`);
  console.log(
    '\n  The music is not in there. Put the songs it names into the folder\n  beside it, and the editor will find them.\n',
  );
}

if (require.main === module) main(process.argv);

module.exports = { readProgram, describe };
