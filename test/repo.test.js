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
const { execFileSync } = require('child_process');
const { check, eq, ok, ROOT, SHIPPED } = require('./harness.js');

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
const PRIVATE_WORD_HASHES = new Set([
  'db52ee1e907cd591',
  'e87a22bb66604a0a',
  'ca561af9108202c2',
]);

function privateWordHash(word) {
  return crypto.createHash('sha256')
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
        ok(!PRIVATE_WORD_HASHES.has(privateWordHash(form)),
          `${file} contains personal information`);
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
  eq(privateWordHash('sentinel'), '392571f57b389320',
    'the hashing changed, so the stored hashes no longer mean anything: ');
  eq(PRIVATE_WORD_HASHES.size, 3, 'the guard list was emptied: ');
  ok(!PRIVATE_WORD_HASHES.has(privateWordHash('crossfade')),
    'an ordinary word in the codebase must not be flagged');
});

check('no absolute local paths leaked into the app', () => {
  for (const file of SHIPPED) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    ok(!/\/home\/|file:\/\/\//.test(body), `${file} references a local path`);
  }
});

/* American spellings throughout, including in comments — the interface says
   "program" for a skating program, and a file that says "programme" two lines
   above it reads as two people arguing. Only forms that actually differ are
   listed: "analysis" and the plural "analyses" are spelled the same either way,
   so the analyse pattern refuses to match the latter.

   This file is the one thing not scanned, because the list below would match
   itself on every entry. Nothing else is exempt. */
const BRITISH = [
  'colour', 'programme', 'behaviour', 'neighbour', 'honour', 'centre', 'licence',
  'grey', 'labelled', 'analyse(?!s\\b)', 'recognis', 'organis', 'realis',
  'summaris', 'normalis', 'optimis', 'initialis', 'utilis', 'minimis', 'maximis',
  'apologis', 'favourite', 'defence', 'catalogue', 'practis', 'whilst',
  'amongst', 'learnt',
];

check('everything is written in American English', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(js|html|css|md|json|yml|svg|sh|cmd)$/.test(f))
    // The license text is quoted verbatim and is not ours to restyle.
    .filter((f) => !['LICENSE', 'package-lock.json', 'test/repo.test.js'].includes(f));
  ok(files.length > 15, `only ${files.length} files were scanned`);

  const found = [];
  for (const file of files) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    body.split('\n').forEach((line, i) => {
      for (const word of BRITISH) {
        if (new RegExp(word, 'i').test(line)) found.push(`${file}:${i + 1} ${word}`);
      }
    });
  }
  eq(found, [], 'British spellings: ');
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
    ok(Array.isArray(source.seen) && source.seen.length,
      `${source.id} has no baseline — run: npm run check:sources -- --update`);
  }
  ok(/^\d{4}-\d{2}-\d{2}$/.test(baseline.checked), 'no date for when a person last looked');
  ok(baseline.checked > '2020-01-01', 'the baseline date looks unset');
});
