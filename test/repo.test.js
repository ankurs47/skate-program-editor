/**
 * Rules that hold across the whole repository rather than in any one file.
 *
 * What must never ship — personal information, a path off this machine — and
 * what has to be written the same way everywhere, comments included. Also that
 * the sources the program lengths come from are still being watched.
 *
 * These have no home in a file about the app or about the site, because the
 * point of them is that they apply to everything.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, check, eq, ok, ROOT, SHIPPED } = require('./harness.js');

/* The words this guards against are a family name and a skater's, and writing
   them here would publish, in a public repo, exactly what the check exists to
   keep out of it. So they are stored as salted hashes and the shipped files are
   tokenised and hashed to match.

   Reading them from git config instead was the other option and is worse: on CI
   the name is either unset or the runner's, so the check would quietly pass
   while testing nothing, which is the one failure mode a guard must not have.

   To add a word:
     node -e 'const c=require("crypto");console.log(c.createHash("sha256")
       .update("skate-private:"+process.argv[1].toLowerCase())
       .digest("hex").slice(0,16))' WORD
*/
const PRIVATE_WORD_HASHES = new Set(['db52ee1e907cd591', 'e87a22bb66604a0a', 'ca561af9108202c2']);

function privateWordHash(word) {
  return crypto
    .createHash('sha256')
    .update(`skate-private:${word.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

check('no personal information in anything shipped', () => {
  /* Whole tokens, so a name is caught however it is punctuated around it. This
     is narrower than the substring match it replaces — a hash cannot be searched
     for inside a longer word — so a trailing "s" is stripped as well, which
     covers the plural and possessive forms that narrowing would otherwise miss.
     Anything more would mean hashing every substring of every file. */
  for (const file of SHIPPED) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const token of body.split(/[^A-Za-z0-9]+/)) {
      if (!token) continue;
      const forms = [token];
      if (/s$/i.test(token) && token.length > 1) forms.push(token.slice(0, -1));
      for (const form of forms) {
        ok(
          !PRIVATE_WORD_HASHES.has(privateWordHash(form)),
          `${file} contains personal information`,
        );
      }
    }
  }
});

check('the personal information guard still catches what it is for', () => {
  /* A guard that has quietly stopped matching anything is worse than no guard,
     and nothing else here would notice. Proving it works by hashing one of the
     real words would put that word back in the file in plain text, which is the
     whole thing being avoided — so the canary is a neutral word with a known
     hash. If the hashing ever changes, this fails and the stored hashes are
     known to have stopped corresponding to the words they were made from. */
  eq(
    privateWordHash('sentinel'),
    '392571f57b389320',
    'the hashing changed, so the stored hashes no longer mean anything: ',
  );
  eq(PRIVATE_WORD_HASHES.size, 3, 'the guard list was emptied: ');
  ok(
    !PRIVATE_WORD_HASHES.has(privateWordHash('crossfade')),
    'an ordinary word in the codebase must not be flagged',
  );
});

check('no absolute local paths leaked into the app', () => {
  for (const file of SHIPPED) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    ok(!/\/home\/|file:\/\/\//.test(body), `${file} references a local path`);
  }
});

/* Spelling is codespell's job now, with its en-GB_to_en-US dictionary — see
   .pre-commit-config.yaml. What was here was a hand-written list of 28 British
   stems and a regex, and it was worse in both directions.

   It missed ten spellings across the repo that the dictionary found the moment
   it was switched on. And it matched substrings rather than words, so it flagged
   the British form buried inside aria-labelledby; a blanket fix on the strength
   of that produced aria-labeledby in four dialogs, which is not an attribute at
   all, and every one of them silently lost its accessible name. codespell
   matches whole words and never flags that attribute.

   What is left here is the half codespell cannot do: it reads files, not
   git, so it has no opinion about whether the spelling check ran at all.
   This asserts the hook is still configured to check. */
check('the spelling check is still switched on', () => {
  const config = fs.readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf8');
  ok(/id:\s*codespell/.test(config), 'codespell is no longer a hook');
  /* The argument, not merely the string. Written as /en-GB_to_en-US/ over the
     whole file this passed while the dictionary was switched off, because the
     comment above the hook names it — which is the same shape of mistake as a
     check that reads an attribute out of the file and then looks for it. */
  const args = config.match(/^\s*-\s*--builtin=(\S+)$/m);
  ok(args, 'codespell has no --builtin argument');
  ok(
    args[1].split(',').includes('en-GB_to_en-US'),
    `codespell runs with --builtin=${args[1]}, which will not keep the spelling American`,
  );
  /* The ignore list is where exceptions go, and each one needs a reason
     written beside it — an unexplained entry is how a real fault gets
     silenced. */
  const ignore = fs.readFileSync(path.join(ROOT, '.codespell-ignore'), 'utf8');
  for (const line of ignore.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    ok(
      /#/.test(ignore.slice(0, ignore.indexOf(line))),
      `${line.trim()} is ignored with no comment saying why`,
    );
  }
});

check('every rule source is one the checker knows how to read', () => {
  /* tools/sources.json says where the program lengths come from; the extractor
     that reads each source lives in tools/check-sources.js. An entry with no
     extractor is silently unwatched, which is the failure this guards: the
     monthly job would go on passing while nothing was being looked at. */
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/sources.json'), 'utf8'));
  const checker = fs.readFileSync(path.join(ROOT, 'tools/check-sources.js'), 'utf8');
  ok(baseline.sources.length >= 2, 'both governing bodies should be watched');

  for (const source of baseline.sources) {
    ok(checker.includes(`'${source.id}':`), `no extractor for ${source.id}`);
    ok(/^https:\/\//.test(source.url), `${source.id} is not fetched over https`);
    ok(source.what && source.what.length > 10, `${source.id} does not say what it watches`);
    ok(
      Array.isArray(source.seen) && source.seen.length,
      `${source.id} has no baseline — run: npm run check:sources -- --update`,
    );
  }
  ok(/^\d{4}-\d{2}-\d{2}$/.test(baseline.checked), 'no date for when a person last looked');
  ok(baseline.checked > '2020-01-01', 'the baseline date looks unset');
});

check('the check counts in the documentation are the real ones', () => {
  /* Four documents quote how many checks there are, and the number goes out of
     date the moment anyone adds one — it had drifted in three places at once
     before this existed. The counts are derivable, so nobody should be keeping
     them by hand.

     The unit total is the number of `check(` calls across the test files, which
     is what the runner ends up reporting because none of them are conditional.
     A number is read as a claim when it sits within a few words of "check", and
     is capped at four digits so a sample rate in a nearby sentence is not
     mistaken for one. */
  const files = fs
    .readdirSync(path.join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => fs.readFileSync(path.join(ROOT, 'test', name), 'utf8'));
  const unit = files.reduce((total, body) => total + (body.match(/^check\(/gm) || []).length, 0);
  const dom = (
    fs.readFileSync(path.join(ROOT, 'test/dom/run.js'), 'utf8').match(/await check\(/g) || []
  ).length;

  ok(unit > 100 && dom > 10, `the counting itself broke: ${unit} unit, ${dom} browser`);

  const docs = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/development.md'];
  let claims = 0;
  for (const file of docs) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of body.matchAll(/\b(\d{1,4})\b(?=[^.\n]{0,40}\bchecks?\b)/g)) {
      claims++;
      const line = body.slice(0, match.index).split('\n').length;
      ok(
        Number(match[1]) === unit || Number(match[1]) === dom,
        `${file}:${line} says ${match[1]} checks; there are ${unit} unit and ${dom} browser`,
      );
    }
  }
  /* Without this the check passes by finding nothing to look at — the way a
     test goes quiet rather than red. */
  ok(
    claims >= 4,
    `only ${claims} check counts found in the docs; the pattern has stopped matching`,
  );
});

check('every mutation still patches the code it names', () => {
  /* A mutation whose "find" no longer matches asserts nothing at all, and the
     only thing that notices is a mutation run — minutes long, and easy to skip.
     Formatters are what usually breaks them: Prettier reflows a ternary or
     rewrites a quote and the anchor written against the old shape stops
     matching, silently. This is the same failure as #26, moved to where it
     costs a second instead of an afternoon.

     Exactly once, not merely present: an anchor matching two places patches
     whichever comes first, which is not necessarily the one it was written for.
     `test/mutate.js` refuses to run those, so they would be dead weight. */
  const mutations = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/mutations.json'), 'utf8'));
  ok(mutations.length > 20, `only ${mutations.length} mutations; the file looks truncated`);

  const sources = new Map();
  for (const mutation of mutations) {
    if (!sources.has(mutation.file)) {
      sources.set(mutation.file, fs.readFileSync(path.join(ROOT, mutation.file), 'utf8'));
    }
    const hits = sources.get(mutation.file).split(mutation.find).length - 1;
    eq(
      hits,
      1,
      `"${mutation.name}" matches ${hits} places in ${mutation.file} — update its "find": `,
    );
    ok(
      mutation.find !== mutation.replace,
      `"${mutation.name}" replaces the code with itself, so it breaks nothing`,
    );
    ok(
      mutation.name && mutation.guards && mutation.expect,
      `"${mutation.name}" does not say what it guards or which check should catch it`,
    );
  }
});

/* ------------------------------------------- rebuilding a project from a file */

/** A RIFF chunk, for building a file to read back. */
function riffChunk(id, body) {
  const out = Buffer.alloc(8 + body.length + (body.length % 2));
  out.write(id, 0);
  out.writeUInt32LE(body.length, 4);
  body.copy(out, 8);
  return out;
}

check('project-from-music: reads a program back out of a WAV', () => {
  const tool = require(path.join(ROOT, 'tools', 'project-from-music.js'));
  const doc = { format: 'skate-program', version: 1, name: 'my long', clips: [] };

  const body = Buffer.concat([
    Buffer.from(riffChunk('data', Buffer.from([1, 0, 2, 0]))),
    Buffer.from(app.projectChunk(doc)),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0);
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WAVE', 8);

  const found = tool.readProgram(new Uint8Array(Buffer.concat([head, body])));
  eq(found.doc, doc);
  eq(found.from, 'a RIFF chunk', 'it should say where it found it: ');
});

check('project-from-music: a file carrying nothing is not an error', () => {
  const tool = require(path.join(ROOT, 'tools', 'project-from-music.js'));
  /* The common case by a distance: describing the program is off by default,
     so most exports carry none of this and the tool has to say so plainly
     rather than failing in a way that reads like the file is broken. */
  eq(tool.readProgram(new Uint8Array([1, 2, 3, 4])).doc, null);
});

check('project-from-music: what it says about a program is what the program says', () => {
  const tool = require(path.join(ROOT, 'tools', 'project-from-music.js'));
  const said = tool.describe({
    format: 'skate-program',
    version: 1,
    name: 'my 2027 junior long',
    event: { level: 'usfs-jr', targetSeconds: 210, toleranceSeconds: 10 },
    songs: [{ name: 'a.mp3' }, { name: 'b.mp3' }],
    clips: [{ id: 'x', song: 'a.mp3', start: 0, end: 10 }],
  });
  ok(/my 2027 junior long/.test(said), said);
  ok(/usfs-jr/.test(said), said);
  ok(/a\.mp3, b\.mp3/.test(said), 'it should name the songs to go looking for: ' + said);
});
