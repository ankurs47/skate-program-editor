/* What a program is, with no reference to the page it is shown on.
 *
 * Clip geometry, the event length tables, fade and crossfade envelopes, the
 * arithmetic behind a join, and reading a project file back. Everything here
 * is a function of its arguments, which is why almost all of the unit tests
 * point at this file.
 *
 * Like analysis.js and formats.js it touches no DOM, and a test holds it to
 * that: the rules of a program do not change because a button moved.
 */
'use strict';

const SR = 44100;
const MIN_CROSSFADE = 0.01;
const MIN_CLIP = 0.1; // the shortest a clip may be trimmed to, in seconds
/* One list, two shapes: the file picker wants extensions with dots, and the
   drop handler wants something to test a name against. */
const AUDIO_EXTENSION_LIST = [
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.ogg',
  '.opus',
  '.aac',
  '.webm',
  '.aif',
  '.aiff',
];
const AUDIO_EXTENSIONS = new RegExp(
  `(${AUDIO_EXTENSION_LIST.map((e) => `\\${e}`).join('|')})$`,
  'i',
);
const MAX_GAIN = 16; // a shade over the +24 dB the level slider reaches

/* ---------------------------------------------------------------------------
 * PROGRAM LENGTHS — CHECK THESE AGAINST THE CURRENT RULEBOOK
 *
 * Competition lengths are set by the ISU and U.S. Figure Skating and they do
 * change between seasons. This table is a convenience, not an authority. The
 * dropdown always shows the time beside the level name so a wrong number is
 * visible rather than hidden behind a label.
 *
 * To correct one, edit `seconds` here — nothing else refers to these values.
 * Times are m:ss; `tol` is the allowed variance in seconds either way.
 * ------------------------------------------------------------------------- */
const LEVELS = [
  {
    group: 'ISU — Singles',
    items: [
      { id: 'isu-sr-sp', label: 'Senior Short Program', seconds: 160, tol: 10 },
      { id: 'isu-sr-fs', label: 'Senior Free Skate', seconds: 240, tol: 10 },
      { id: 'isu-jr-sp', label: 'Junior Short Program', seconds: 160, tol: 10 },
      { id: 'isu-jr-fs', label: 'Junior Free Skate', seconds: 210, tol: 10 },
      { id: 'isu-adv-nov-sp', label: 'Advanced Novice Short Program', seconds: 140, tol: 10 },
      { id: 'isu-adv-nov-fs', label: 'Advanced Novice Free Skate', seconds: 180, tol: 10 },
      { id: 'isu-int-nov-fs', label: 'Intermediate Novice Free Skate', seconds: 180, tol: 10 },
      { id: 'isu-bas-nov-fs', label: 'Basic Novice Free Skate', seconds: 150, tol: 10 },
    ],
  },
  {
    group: 'ISU — Pairs',
    items: [
      { id: 'isu-pr-sr-sp', label: 'Senior Pairs Short Program', seconds: 160, tol: 10 },
      { id: 'isu-pr-sr-fs', label: 'Senior Pairs Free Skate', seconds: 240, tol: 10 },
      { id: 'isu-pr-jr-sp', label: 'Junior Pairs Short Program', seconds: 160, tol: 10 },
      { id: 'isu-pr-jr-fs', label: 'Junior Pairs Free Skate', seconds: 210, tol: 10 },
    ],
  },
  {
    group: 'ISU — Ice Dance',
    items: [
      { id: 'isu-id-sr-rd', label: 'Senior Rhythm Dance', seconds: 170, tol: 10 },
      { id: 'isu-id-sr-fd', label: 'Senior Free Dance', seconds: 240, tol: 10 },
      { id: 'isu-id-jr-rd', label: 'Junior Rhythm Dance', seconds: 170, tol: 10 },
      { id: 'isu-id-jr-fd', label: 'Junior Free Dance', seconds: 210, tol: 10 },
    ],
  },
  {
    group: 'U.S. Figure Skating — Free Skate',
    items: [
      { id: 'usfs-prelim', label: 'Preliminary', seconds: 90, tol: 10 },
      { id: 'usfs-pre-juv', label: 'Pre-Juvenile', seconds: 105, tol: 10 },
      { id: 'usfs-juv', label: 'Juvenile', seconds: 135, tol: 10 },
      { id: 'usfs-int', label: 'Intermediate', seconds: 160, tol: 10 },
      { id: 'usfs-nov', label: 'Novice', seconds: 180, tol: 10 },
      { id: 'usfs-jr', label: 'Junior', seconds: 210, tol: 10 },
      { id: 'usfs-sr', label: 'Senior', seconds: 240, tol: 10 },
    ],
  },
  {
    group: 'U.S. Figure Skating — Short Program',
    items: [
      { id: 'usfs-nov-sp', label: 'Novice Short Program', seconds: 160, tol: 10 },
      { id: 'usfs-jr-sp', label: 'Junior Short Program', seconds: 160, tol: 10 },
      { id: 'usfs-sr-sp', label: 'Senior Short Program', seconds: 160, tol: 10 },
    ],
  },
];

const CUSTOM_LEVEL = 'custom';

function allLevels() {
  return LEVELS.flatMap((g) => g.items);
}

function findLevel(id) {
  return allLevels().find((l) => l.id === id) || null;
}

/* Both of these round to the precision they display *before* splitting the
   minutes off, not after. Rounding afterwards means a value that comes to 60
   once rounded is shown as sixty seconds rather than carried: 59.98 read as
   "0:60.0" on the program timer, and a 119.6 second song listed as "1:60". */

/* ------------------------------------------------------------- formatting */

function fmt(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const tenths = Math.round(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function fmtShort(seconds) {
  const whole = isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const m = Math.floor(whole / 60);
  return `${m}:${String(whole - m * 60).padStart(2, '0')}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/* ------------------------------------------------------------------ layout */

function clipDuration(clip) {
  return Math.max(0, clip.srcEnd - clip.srcStart);
}

/**
 * A clip's level as a plain multiplier. Anything missing, negative or absurd
 * becomes 1 — a hand-edited project file must not be able to silence the
 * program or blow the speakers.
 */
function clipGain(clip) {
  const gain = clip ? clip.gain : undefined;
  // Checked as a number before anything else: `Number(null)` is 0, so coercing
  // first would read a null in a project file as "silent" rather than "absent".
  return typeof gain === 'number' && isFinite(gain) && gain >= 0 ? clamp(gain, 0, MAX_GAIN) : 1;
}

/** Overlap between clip i and the one before it, clamped to fit both. */
function crossfadeOf(clips, i) {
  if (i === 0) return 0;
  const x = Math.max(0, clips[i].crossfade || 0);
  return Math.min(x, clipDuration(clips[i]), clipDuration(clips[i - 1]));
}

/** Timeline start of every clip, plus the total program length. */
function layout(clips) {
  const parts = [];
  let t = 0;
  clips.forEach((clip, i) => {
    if (i) t += clipDuration(clips[i - 1]) - crossfadeOf(clips, i);
    parts.push({ start: t, dur: clipDuration(clip), xf: crossfadeOf(clips, i) });
  });
  const total = parts.length ? parts[parts.length - 1].start + parts[parts.length - 1].dur : 0;
  return { parts, total };
}

/* ------------------------------------------------------------- envelopes */

/**
 * Piecewise-linear breakpoints for something that rises, holds, and falls.
 *
 * Both envelopes a clip has are this shape, and they were written out twice.
 * Keeping one copy is what makes the property the whole crossfade rests on —
 * that the two sides sum to 1 through the overlap — a single thing to reason
 * about rather than two that have to be kept in step.
 *
 * A rise and a fall that would overlap meet in the middle instead, so the
 * breakpoints stay in order and the level never exceeds 1.
 */
function rampEnvelope(dur, rise, fall) {
  const up = clamp(rise, 0, dur);
  const down = clamp(fall, 0, dur);
  const points = [[0, up > 0 ? 0 : 1]];
  if (up > 0) points.push([up, 1]);
  if (down > 0) {
    points.push([Math.max(up, dur - down), 1], [dur, 0]);
  } else {
    points.push([dur, 1]);
  }
  return points;
}

/** Breakpoints for a clip's intrinsic fades. */
function fadeEnvelope(clip) {
  return rampEnvelope(clipDuration(clip), clip.fadeIn || 0, clip.fadeOut || 0);
}

/** Breakpoints for the crossfade with the previous and next clips. */
function crossfadeEnvelope(clips, i) {
  return rampEnvelope(
    clipDuration(clips[i]),
    crossfadeOf(clips, i),
    i + 1 < clips.length ? crossfadeOf(clips, i + 1) : 0,
  );
}

function valueAt(points, t) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return t1 === t0 ? v1 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
    }
  }
  return points[points.length - 1][1];
}

/* ----------------------------------------------------------------- peaks */

function computePeaks(buffer, buckets = 5000) {
  const n = buffer.length;
  const step = Math.max(1, Math.floor(n / buckets));
  const count = Math.ceil(n / step);
  const peaks = new Float32Array(count * 2);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < count; i++) {
    const s = i * step;
    const e = Math.min(n, s + step);
    let mn = 1,
      mx = -1;
    for (const data of channels) {
      for (let j = s; j < e; j++) {
        const v = data[j];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    peaks[i * 2] = mn;
    peaks[i * 2 + 1] = mx;
  }
  return peaks;
}

/* ---------------------------------------------- clips against their files */

/**
 * Bring clips back inside a file that has just been decoded.
 *
 * A project records trims but not the audio, so until the file actually arrives
 * nothing has checked those numbers against a real duration. If the file turns
 * out shorter than the project expects — a different copy of the song, a fresh
 * download, a hand-edited project — the clip is claiming time that does not
 * exist. Web Audio plays silence past the end rather than failing, so the strip
 * shows a duration that is a lie and the finished program comes out the wrong
 * length with nothing said about it.
 *
 * Mutates the clips it has to, and returns how many that was.
 */
function clampClipsToFile(clips, entry) {
  const duration = entry.duration;
  let changed = 0;
  for (const clip of clips) {
    if (clip.file !== entry.name) continue;
    const start = clamp(clip.srcStart, 0, Math.max(0, duration - MIN_CLIP));
    const end = clamp(clip.srcEnd, start + MIN_CLIP, duration);
    if (start === clip.srcStart && end === clip.srcEnd) continue;
    clip.srcStart = start;
    clip.srcEnd = end;
    changed++;
  }
  return changed;
}

/**
 * Bring each clip's own fades inside the clip, and say how many moved.
 *
 * `rampEnvelope` already clamps these on the way to the speakers, so the sound
 * was never wrong. Everything else disagreed with it: after trimming a twenty
 * second clip with an eight second fade down to three, the label read 8.0s, the
 * slider sat at 3 because its `max` had moved under it, the ears got 3, and the
 * project file recorded 8 — a fade nobody could see or hear, waiting for a
 * later trim to bring it back.
 *
 * The stored value is the one that gives way, rather than the display being
 * taught to lie more carefully. A fade you cannot hear is not a fade you have,
 * and expecting eight seconds to return after a trim means remembering a number
 * the app stopped showing you.
 *
 * Only `fadeIn` and `fadeOut`, which belong to the clip alone. A blend belongs
 * to a pair, and the clip on the other side of it can change length later —
 * `crossfadeOf` works that out on every read and nothing here should preempt
 * it.
 */
function clampFades(clips) {
  let changed = 0;
  for (const clip of clips) {
    const room = clipDuration(clip);
    let moved = false;
    for (const key of ['fadeIn', 'fadeOut']) {
      const stored = clip[key];
      /* A clip that never had a fade is left without one, rather than gaining a
         zero. Otherwise the first redraw after loading any project would report
         every clip as changed. */
      if (stored === undefined || stored === null) continue;
      /* `|| 0` before the clamp and not after: `clamp` is Math.min and Math.max
         and both hand NaN straight back, so a fade that is not a number would
         have been written back as one. Compared against what is stored rather
         than against that, so NaN — which is equal to nothing, itself included
         — is corrected instead of silently kept. */
      const now = clamp(Number(stored) || 0, 0, room);
      if (now === stored) continue;
      clip[key] = now;
      moved = true;
    }
    if (moved) changed++;
  }
  return changed;
}

/**
 * Where a trim key would put an edge, or why it will not.
 *
 * The clip editor draws the whole file with the kept region picked out, so a
 * marker outside that region is one click away — and clicking ahead to hear
 * what comes next is a normal thing to do. Pressing I there used to run the
 * marker through a clamp, which kept the clip valid by collapsing it: ten
 * seconds of trimming became a tenth of a second, silently, on one keystroke.
 *
 * The clamp was not wrong so much as unable to tell "a little past the end"
 * from "nowhere near this clip", and it turned both into the same answer. This
 * separates them: a marker outside the clip is not a trim point for it, and
 * saying so is better than obeying an instruction nobody meant.
 *
 * Running past the end of the *file* is different and stays a clamp. Asking for
 * more music than the file holds has an obvious best answer, which is all of it.
 */
function trimEdge(clip, edge, cursor, fileDuration = Infinity) {
  /* Not `Number(cursor)` and then `isFinite`: `Number(null)` is 0, which is a
     perfectly finite number and a real place in the song, so a missing marker
     would have trimmed to the very start. */
  const at = typeof cursor === 'number' && isFinite(cursor) ? cursor : null;
  if (at === null) return { refuse: 'There is no marker to trim to' };

  if (edge === 'start') {
    const latest = clip.srcEnd - MIN_CLIP;
    if (at > latest) {
      return { refuse: 'The marker is past the end of this song — move it inside the song first' };
    }
    return { at: clamp(at, 0, latest) };
  }

  const earliest = clip.srcStart + MIN_CLIP;
  if (at < earliest) {
    return {
      refuse: 'The marker is before the start of this song — move it inside the song first',
    };
  }
  return { at: clamp(at, earliest, fileDuration) };
}

/**
 * The clip list with one clip moved, or null if that is not a real move.
 *
 * Both indices are checked, not just the destination. `fromIndex` arrives from
 * a drag's data transfer, so it is whatever the browser was carrying, and every
 * comparison against NaN is false — a destination-only check let it straight
 * through, and `splice(NaN, 1)` coerces to `splice(0, 1)`.
 *
 * Pure: the list handed in, and the clips in it, come back untouched.
 */
function reordered(clips, fromIndex, toIndex) {
  const valid = (i) => Number.isInteger(i) && i >= 0 && i < clips.length;
  if (!valid(fromIndex) || !valid(toIndex) || fromIndex === toIndex) return null;
  const next = clips.slice();
  const [clip] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, clip);
  return next;
}

/* Enough music either side to hear the join in context. Four seconds is about
   two bars at a walking tempo — long enough to have settled into the first song
   before it hands over, short enough not to be a wait. */
const JOIN_PREVIEW = { lead: 4, tail: 4 };

/**
 * The stretch of program time to play when auditioning one join.
 *
 * The join is where clip `i` begins; the blend, if there is one, runs on from
 * there, so the tail is measured from the end of the overlap rather than from
 * the cut. Returns null when there is no join — the first clip has nothing
 * before it.
 */
function joinPreviewRange(clips, i, opts = {}) {
  if (!(i > 0) || i >= clips.length) return null;
  const lead = opts.lead ?? JOIN_PREVIEW.lead;
  const tail = opts.tail ?? JOIN_PREVIEW.tail;
  const { parts, total } = layout(clips);
  const at = parts[i].start;
  return {
    from: Math.max(0, at - lead),
    until: Math.min(total, at + parts[i].xf + tail),
  };
}

/** How far a join's two cuts may move without eating a clip whole. */
function joinRoom(clip, entry, side) {
  const keep = 0.5;
  return side === 'end'
    ? {
        min: Math.min(0, keep - clipDuration(clip)),
        max: Math.max(0, entry.duration - clip.srcEnd),
      }
    : { min: Math.min(0, -clip.srcStart), max: Math.max(0, clipDuration(clip) - keep) };
}

/* What a project file is called and which shape of it this app understands.
   The marker is checked before anything else is read, so a stray .json is
   recognized as not one of these rather than half-loaded as an empty program.
   The version is bumped only for a change an older reader would get wrong. */
const FORMAT = 'skate-program';
const FORMAT_VERSION = 1;

/* Written into every project file so an editor validates it and completes field
   names while it is being edited by hand. A test holds this to the schema's own
   $id, because a URL that has drifted is one that quietly 404s. */
/* What made the file, for the field a reader shows as "software". No version
   with it: the number would change on every release and say nothing a person
   reading it could act on, and it would make two exports of one program differ
   for a reason that is not about the program. */
const APP_NAME = 'Skate Program Editor';

const SCHEMA_URL = 'https://ankurs47.github.io/skate-program-editor/docs/program.skate.schema.json';

/* The keys this reader knows. Anything else in a file — written by a desktop
   shell, or by a version after this one — is carried through untouched rather
   than dropped, so saving in one app never silently erases what another
   recorded. `readProject` collects them and `project` puts them back.

   Every key `project` writes has to appear here. One that does not is read back
   as a carried key, and from the next save onwards the carried copy overwrites
   whatever the app computed — the field silently freezes at the first value it
   ever had. A check in app.test.js holds the two lists together. */
const KNOWN_KEYS = [
  '$schema',
  'format',
  'version',
  'name',
  'event',
  'songs',
  'clips',
  'export',
  'notes',
  'mediaDir',
];

/** The keys of `from` that `known` does not list. */
function unknownKeys(from, known) {
  const rest = {};
  for (const key of Object.keys(from || {})) {
    if (!known.includes(key)) rest[key] = from[key];
  }
  return rest;
}

/**
 * What to call a song, for a person reading rather than a file system.
 *
 * The song's own title when it has one — a desktop shell knows it from wherever
 * it fetched the music, and it is usually better than what the file ended up
 * being called. Otherwise the file name without its extension, which is all the
 * app can work out on its own.
 */
function songTitle(song, name) {
  const given = song && typeof song.title === 'string' ? song.title.trim() : '';
  return given || name.replace(/\.[^.]+$/, '');
}

/**
 * The file name a song record names, with any path taken off it.
 *
 * A project holds names, never locations, and a desktop app resolves each one
 * inside the folder holding the project — so a name carrying `../` would be a
 * way out of that folder. Reducing it to the last component here means the app
 * that resolves it is not the only thing standing in the way, and means a name
 * typed by hand as a path still finds the file it obviously meant.
 *
 * Empty, or nothing but dots, names no file at all.
 */
function songName(value) {
  const last = (typeof value === 'string' ? value : '').split(/[/\\]/).pop();
  return /^\.*$/.test(last) ? '' : last;
}

/**
 * A number of seconds from a file, which may hold anything at all.
 *
 * `1e999` parses as Infinity, and one of those in a trim spreads through the
 * arithmetic until the timer reads NaN and the program has no length. Absent,
 * negative and non-finite all mean zero: a hand-edited file should come up
 * looking wrong, not take the page down.
 */
function seconds(value) {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
}

/**
 * The id to give a clip, preferring the one the file supplied.
 *
 * `taken` accumulates across the whole document, so the first clip to claim a
 * name keeps it and a later duplicate is given a fresh one. A made-up id is
 * checked against the set too — the chance of a collision is tiny, and "tiny"
 * is not a thing to leave in the one place that decides whether removing a clip
 * removes the right clip.
 */
function claimId(wanted, taken) {
  let id = typeof wanted === 'string' && wanted ? wanted : uid();
  while (taken.has(id)) id = uid();
  taken.add(id);
  return id;
}

/**
 * A clip's level, read from the decibels the file carries.
 *
 * Absent or unreadable means "as recorded" — 0 dB, never silent. A number is
 * clamped to what the slider can reach before being converted, so a hand-typed
 * 9999 comes back as the loudest the interface offers rather than as infinity,
 * which `clipGain` will not accept and which would quietly become 1.
 *
 * The floor is 6% of the recording, not silence. `gainToDb` maps a gain of zero
 * onto that same floor, so the two cannot be told apart in a file — and the
 * slider cannot reach silence either. Reading the floor as silence would mean
 * dragging a clip all the way down, saving, and finding it gone on reopening.
 * A clip nobody wants to hear is one to delete, not to silence.
 */
function gainFromDb(db) {
  if (typeof db !== 'number' || !isFinite(db)) return 1;
  return clipGain({ gain: dbToGain(clamp(db, LEVEL_SLIDER.min, LEVEL_SLIDER.max)) });
}

/**
 * Read a saved project document into the state it describes.
 *
 * Pure — no DOM, nothing global touched — because this is the contract with
 * every project anyone saves, and `loadProject` could not be checked at all
 * while the parsing and the wiring were the same function.
 *
 * Anything absent or nonsense falls back to something usable rather than
 * throwing: a project file is a plain text document people do edit by hand, and
 * refusing one over a number that can be clamped would be no help to anybody.
 *
 * A version from the future is the exception, and the only thing here that is
 * refused. Falling back would mean reading a file whose fields have meanings
 * this app does not know — coming up with a program that looks plausible and is
 * wrong. `unsupported` says so and the caller leaves the current program alone.
 *
 * The file speaks the language the interface speaks: song, start, end, blend,
 * decibels. Clips are held in memory with the names the drawing and audio code
 * has always used, and this function is the only place the two meet.
 *
 * `retargeted` names the level whose length no longer matches the stored time,
 * for the caller to mention. It is not an error — the stored time is the one
 * that wins.
 */
function readProject(data) {
  const doc = data && typeof data === 'object' ? data : {};
  const taken = new Set();
  const version = Math.floor(Number(doc.version)) || 1;
  if (version > FORMAT_VERSION) {
    return { unsupported: { version, understands: FORMAT_VERSION } };
  }

  const event = doc.event && typeof doc.event === 'object' ? doc.event : {};
  // The stored time wins over the level's current table value, so reopening an
  // old program never silently retargets it because a rulebook number changed.
  const targetSeconds = event.targetSeconds || 135;
  let levelId = event.level || CUSTOM_LEVEL;
  const level = findLevel(levelId);
  const retargeted = level && level.seconds !== targetSeconds ? level : null;
  if (retargeted) levelId = CUSTOM_LEVEL;

  const songs = (Array.isArray(doc.songs) ? doc.songs : [])
    .filter((song) => song && typeof song === 'object' && songName(song.name))
    .map((song) => ({ ...song, name: songName(song.name) }));
  /* What each song is called, so a clip that says nothing about its own title
     is shown the song's rather than its file name. */
  const titles = new Map(songs.map((song) => [song.name, songTitle(song, song.name)]));

  return {
    unsupported: null,
    name: doc.name || 'my program',
    level: levelId,
    targetSeconds,
    toleranceSeconds: event.toleranceSeconds || 10,
    retargeted,
    /* What each song was, kept whole. Without a record of them nothing is
       claimed about the songs, which is a fine state for a hand-written file. */
    songs,
    exportSettings: doc.export && typeof doc.export === 'object' ? doc.export : null,
    /* Free text nothing reads, and the folder a desktop app keeps the audio in.
       Both are carried rather than acted on here: a browser has no folder, and
       nothing in the app writes a note yet. */
    notes: typeof doc.notes === 'string' ? doc.notes : '',
    mediaDir: typeof doc.mediaDir === 'string' ? doc.mediaDir : '',
    /* Top-level keys this reader does not know, handed back so `project` can
       put them where it found them. Per-song ones need no such list: the song
       records go into `state.expectedFiles` whole and are written back whole. */
    carried: unknownKeys(doc, KNOWN_KEYS),
    /* A clip that is not an object names nothing and cannot be drawn. Dropped
       rather than read, because reading one throws and this must not: it is
       what opens every file anybody has, including hand-edited ones. */
    clips: (Array.isArray(doc.clips) ? doc.clips : [])
      .filter((c) => c && typeof c === 'object' && songName(c.song))
      .map((c) => ({
        /* The file's own id, so anything that refers to a clip still refers to
         the same one after a save. Selecting and removing are by id and two
         clips sharing one would take each other out, so a repeated or unusable
         id is replaced rather than trusted. */
        id: claimId(c.id, taken),
        file: songName(c.song),
        /* The clip's own label when it has one, then the song's title, then
           the bare file name. A clip is a slice of a song and usually wants no
           name of its own; one that has been labeled keeps its label. */
        title:
          (typeof c.title === 'string' && c.title.trim()) ||
          titles.get(songName(c.song)) ||
          songName(c.song).replace(/\.[^.]+$/, ''),
        srcStart: seconds(c.start),
        srcEnd: seconds(c.end),
        fadeIn: seconds(c.fadeIn),
        fadeOut: seconds(c.fadeOut),
        crossfade: seconds(c.blend),
        gain: gainFromDb(c.gainDb),
      })),
  };
}

/* A hair above 1, so a program that merely touches full scale is not nagged
 * about. Anything genuinely past it is flat-topped by the encoders below. */
const PEAK_TOLERANCE = 1e-4;

/**
 * Does the finished program go past what a sound file can hold?
 *
 * `solveGains` guards the automatic path carefully, but the Volume slider
 * reaches +24 dB by hand and nothing downstream stops it. `encodeWav` clamps,
 * so the result is flat-topped distortion rather than wrap-around noise —
 * audible, and worth catching here rather than at the rink.
 */
function clipsOnExport(peak) {
  return peak > 1 + PEAK_TOLERANCE;
}

/** The picker's filter, built from the same list the drop handler tests against. */
function audioPickerTypes() {
  return [{ description: 'Music', accept: { 'audio/*': [...AUDIO_EXTENSION_LIST] } }];
}

/**
 * Is this the song the project was built from? One sentence if not, else null.
 *
 * Matching is by file name because that is all a browser gives us, and two
 * different songs can easily share one — "track01.mp3" from two albums, or a
 * re-download at a different quality. Rebuilding a program around the wrong
 * one silently is the failure worth catching: the trims would still apply, the
 * timer would still read correctly, and it would all be wrong.
 *
 * Pure, and forgiving: a project written before this existed records nothing to
 * compare against, and says nothing rather than crying wolf.
 */
function describeWrongFile(expected, entry) {
  if (!expected || !expected.fingerprint || !entry.fingerprint) return null;
  if (expected.fingerprint === entry.fingerprint) return null;

  const was = Number(expected.seconds);
  const now = entry.duration;
  const length =
    isFinite(was) && was > 0 && Math.abs(was - now) > 1
      ? ` — this one is ${fmtShort(now)}, the program was built from ${fmtShort(was)}`
      : '';
  return `“${entry.name}” is not the song this program was built from${length}`;
}

/* ------------------------------------------------ swapping a song for another */

/* Replacing a song under an edit that is already made is the one operation here
 * that can go wrong without looking wrong. Every trim, fade, blend and level
 * survives; the timer still reads correctly; the strip still draws. If the file
 * handed over is not the song the program was cut from, all of that is a
 * carefully made edit of the wrong music, and nothing on screen says so.
 *
 * So the swap is checked and the checks are shown, every one of them, passing
 * or not. A skater replacing a rough download with the copy they licensed is
 * doing something entirely reasonable and should not have to argue with the
 * app about it — the checks inform the decision rather than making it, which is
 * why the button stays live and only changes what it says.
 */

const REPLACE = {
  worthSaying: 1, // seconds of difference in length worth a line of its own
};

/**
 * Clips that would fall outside the new file, after any shift is applied.
 *
 * Pure and counted rather than clamped, because this runs before the swap to
 * describe it. `clampClipsToFile` does the clamping afterwards, and would
 * silently shorten these — which is fine once it has been said out loud and not
 * before.
 */
function clipsPastEnd(clips, file, duration, shift = 0) {
  return clips.filter((c) => c.file === file && c.srcEnd + shift > duration + 0.001).length;
}

/**
 * Everything worth saying about swapping `candidate` in for `current`.
 *
 * Pure: two analyses, whatever `sameRecording` returned, whatever
 * `compareQuality` returned, and the clips. No DOM, no state, so the wording
 * and the verdicts are under test rather than being whatever the dialog
 * happened to render.
 *
 * `worst` is what the button reads from. `shift` is what the clips would move
 * by, already decided — zero unless the music really does start elsewhere and
 * this really is the same recording, because moving every trim in a program on
 * the strength of a song that did not match would be two mistakes rather than
 * one.
 */
function checkReplacement({ current, candidate, match, quality, clips }) {
  const checks = [];
  const say = (id, level, head, says) => checks.push({ id, level, head, says });

  if (!match) {
    say(
      'song',
      'note',
      'Too short to check',
      'One of these is too short to compare, so whether they are the same recording is unknown',
    );
  } else if (match.same) {
    say('song', 'good', 'The same recording', 'The sound rises and falls in the same places');
  } else {
    say(
      'song',
      'warn',
      'This does not look like the same recording',
      'The sound rises and falls in different places. A different take, a remaster at a ' +
        'different speed, or simply another song — every trim you have made would land ' +
        'somewhere else in the music',
    );
  }

  const better = { better: 'good', same: 'note', worse: 'warn', unknown: 'note' };
  const heads = {
    better: 'Better quality',
    same: 'No better, no worse',
    worse: 'Lower quality',
    unknown: 'Quality unknown',
  };
  say('quality', better[quality.direction], heads[quality.direction], quality.says);

  /* Only meaningful when the two are the same recording: an offset found
     between two different songs is where they happened to line up best, which
     is not a fact about either of them. */
  const shift = match && match.same && Math.abs(match.shift) >= MATCH.shift ? match.shift : 0;
  if (shift) {
    const later = shift > 0;
    say(
      'timing',
      'note',
      `The music starts ${fmt(Math.abs(shift))} ${later ? 'later' : 'earlier'}`,
      `Every trim will be moved ${fmt(Math.abs(shift))} ${later ? 'later' : 'earlier'} to match, ` +
        'so your cuts stay on the same moments in the music',
    );
  } else if (match && match.same) {
    say(
      'timing',
      'good',
      'The music starts in the same place',
      'Your trims land where they do now',
    );
  }

  const grew = candidate.duration - current.duration;
  if (Math.abs(grew) >= REPLACE.worthSaying) {
    say(
      'length',
      'note',
      `${fmtShort(candidate.duration)} rather than ${fmtShort(current.duration)}`,
      grew > 0
        ? 'Longer than the song it replaces. Extra music at either end changes nothing about ' +
            'your program'
        : 'Shorter than the song it replaces',
    );
  }

  const past = clipsPastEnd(clips, current.name, candidate.duration, shift);
  if (past) {
    say(
      'fit',
      'warn',
      past === 1 ? 'One clip runs past the end' : `${past} clips run past the end`,
      past === 1
        ? 'It will be shortened to fit, which changes how long your program runs'
        : 'They will be shortened to fit, which changes how long your program runs',
    );
  }

  const worst = checks.some((c) => c.level === 'warn')
    ? 'warn'
    : checks.some((c) => c.level === 'note')
      ? 'note'
      : 'good';
  return { checks, worst, shift, shortened: past };
}

/* ------------------------------------------- what a program says about itself */

/* Every step of this app reads what a music file says about itself and makes
 * something of it — the library panel shows the tags, the licensing search is
 * built from them, and `tools/music-get.sh` goes out of its way to ask for them
 * because it "saves typing them onto an entry form later".
 *
 * The one file this app produces carried none of it. A finished cut arrived at
 * a rink with its file name as the only thing saying what it was, and a file
 * name is the first thing an upload form throws away.
 *
 * What goes in is only what is already on screen. Nothing here asks the skater
 * a new question, and nothing here is a new field.
 */

/** The event line: what this was cut to, and what it actually came out at. */
function describeEvent(program) {
  const level = findLevel(program.level);
  const name = level ? level.label : 'Custom';
  const target = program.targetSeconds
    ? ` — target ${fmt(program.targetSeconds)} ±${Math.round(program.toleranceSeconds || 0)}s`
    : '';
  return `${name}${target}, actual ${fmt(program.total)}`;
}

/**
 * One line per clip: where it falls in the finished cut, what it is, and which
 * part of the song it came from.
 *
 * The second half is the part worth having. "Libertango at 1:16" tells a person
 * which song; "from 2:10.0 to 3:04.2" tells them which fifty-four seconds of
 * it, which is what somebody rebuilding this program from scratch actually
 * needs and what nobody writes down.
 */
function describeCut(clips, at) {
  return clips.map((clip, i) => {
    const start = at.parts[i] ? at.parts[i].start : 0;
    const from = ` — from ${fmt(clip.srcStart)} to ${fmt(clip.srcEnd)}`;
    return `${fmt(start)}  ${clip.title || clip.file}${from}`;
  });
}

/**
 * Everything a program can say about itself, as the fields a file can hold.
 *
 * Pure, and takes plain values rather than reaching for `state`, so the wording
 * is under test rather than being whatever the exporter happened to build.
 *
 * `artists` comes from the source files where they were tagged and is left out
 * entirely where they were not — an empty artist field is worse than no artist
 * field, because a reader shows it as a blank rather than as absent.
 */
function programTags({ name, level, targetSeconds, toleranceSeconds, clips, artists = [] }) {
  const at = layout(clips);
  const heard = [...new Set(artists.filter((a) => a && a.trim()))];
  const comment = [
    describeEvent({ level, targetSeconds, toleranceSeconds, total: at.total }),
    ...describeCut(clips, at),
  ].join('\n');

  return {
    title: name || '',
    software: APP_NAME,
    comment,
    ...(heard.length ? { artist: heard.join(', ') } : {}),
  };
}

/**
 * What happened when the music was asked for again, in one sentence.
 *
 * Each outcome needs a different next step, and "could not open the files" tells
 * nobody which one they are in: a file that has been moved needs finding, a
 * refused prompt needs saying yes to, and a file that is simply elsewhere needs
 * Add files. Pure, so the wording is under test.
 */
function describeReconnect({ files, gone, refused }) {
  const names = (list) => list.map((n) => `“${n}”`).join(', ');
  if (!files.length && gone.length && !refused.length) {
    return gone.length === 1
      ? `${names(gone)} is not where it was — it may have been moved, renamed or deleted. ` +
          'Use Add files to find it'
      : `${gone.length} songs are not where they were — they may have been moved, ` +
          'renamed or deleted. Use Add files to find them';
  }
  if (!files.length && refused.length && !gone.length) {
    return (
      'Permission to read the music was not given, so nothing was opened. ' +
      'Try again and choose Allow, or use Add files'
    );
  }
  if (!files.length) {
    return 'Could not open the music again — use Add files to find it';
  }
  const opened = files.length === 1 ? 'Opened one song' : `Opened ${files.length} songs`;
  if (gone.length && refused.length) {
    return `${opened}. ${gone.length} could not be found and ${refused.length} were not allowed`;
  }
  if (gone.length) {
    return (
      `${opened}, but ${names(gone)} could not be found — use Add files for ` +
      (gone.length === 1 ? 'it' : 'those')
    );
  }
  return `${opened}, but permission was not given for ${refused.length} of them`;
}

/* --------------------------------------------------------- reading a time */

function parseClock(text) {
  const m = String(text)
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const seconds = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return seconds > 0 && seconds < 3600 ? seconds : null;
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FORMAT,
    FORMAT_VERSION,
    SCHEMA_URL,
    APP_NAME,
    claimId,
    KNOWN_KEYS,
    unknownKeys,
    songName,
    songTitle,
    seconds,
    gainFromDb,
    SR,
    MIN_CROSSFADE,
    MIN_CLIP,
    AUDIO_EXTENSION_LIST,
    AUDIO_EXTENSIONS,
    MAX_GAIN,
    LEVELS,
    CUSTOM_LEVEL,
    allLevels,
    findLevel,
    fmt,
    fmtShort,
    uid,
    clipDuration,
    clipGain,
    crossfadeOf,
    layout,
    rampEnvelope,
    fadeEnvelope,
    crossfadeEnvelope,
    valueAt,
    computePeaks,
    clampClipsToFile,
    clampFades,
    trimEdge,
    reordered,
    JOIN_PREVIEW,
    joinPreviewRange,
    joinRoom,
    readProject,
    PEAK_TOLERANCE,
    clipsOnExport,
    audioPickerTypes,
    describeWrongFile,
    describeEvent,
    describeCut,
    programTags,
    REPLACE,
    clipsPastEnd,
    checkReplacement,
    describeReconnect,
    parseClock,
  };
}
