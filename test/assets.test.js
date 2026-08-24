/**
 * Wiring and assets — the files themselves rather than the logic in them.
 *
 * Every id the scripts reach for exists in the HTML, every help button has
 * content, the files parse, the themes agree, and nothing personal or
 * machine-specific ever ships.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { app, check, eq, ok, html, css, ROOT, SCRIPTS, SHIPPED } = require('./harness.js');

/* --------------------------------------------------------------- 2. wiring */

check('every element the code reaches for exists in the HTML', () => {
  // All three files, not just app.js: the day one of the others grows a $()
  // is the day this should start covering it — and the day the check above
  // about them staying free of the browser should fail.
  const source = SCRIPTS.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const wanted = new Set([...source.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  const present = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !present.has(id));
  eq(missing, [], 'ids used in the scripts but absent from index.html: ');
});

check('every help button has a matching topic', () => {
  const buttons = [...html.matchAll(/class="help-btn" data-help="(\w+)"/g)].map((m) => m[1]);
  const topics = [...html.matchAll(/data-help="(\w+)" data-title="([^"]+)"/g)];
  const names = new Set(topics.map((m) => m[1]));
  ok(buttons.length > 0, 'no help buttons found');
  eq(buttons.filter((b) => !names.has(b)), [], 'buttons with no content: ');
  eq([...names].filter((n) => !buttons.includes(n)), [], 'content with no button: ');
  for (const [, , title] of topics) ok(title.trim(), 'a topic has an empty title');
});

check('outcomes are announced, and every dialog says it is one', () => {
  /* All three modals are plain divs over a backdrop rather than <dialog>, so
     the role, the name and the modality have to be stated by hand — and the
     toast carries every outcome the app reports, from "Evened out 3 songs" to
     the whole join result. */
  const toast = html.match(/<div id="toast"[^>]*>/);
  ok(toast, 'the toast is missing');
  ok(/role="status"/.test(toast[0]) && /aria-live=/.test(toast[0]),
    'toasts carry every outcome message and have to be announced');

  const cards = [...html.matchAll(/<div class="modal-card[^"]*"([^>]*)>/g)].map((m) => m[1]);
  ok(cards.length >= 3, `expected three dialogs, found ${cards.length}`);
  for (const attrs of cards) {
    ok(/role="dialog"/.test(attrs), `a dialog has no role:${attrs}`);
    ok(/aria-modal="true"/.test(attrs), `a dialog is not marked modal:${attrs}`);
    const named = attrs.match(/aria-labeledby="([\w-]+)"/);
    ok(named, `a dialog has no name:${attrs}`);
    ok(html.includes(`id="${named[1]}"`), `aria-labeledby points at a missing id: ${named[1]}`);
  }
});

check('the page and the file picker both cover what the tools produce', () => {
  ok(/<meta name="color-scheme" content="[^"]*dark[^"]*">/.test(html),
    'without this, native selects and scrollbars stay light in dark mode');
  const picker = html.match(/<input id="fileInput"[\s\S]*?>/);
  ok(picker, 'the file picker is missing');
  for (const ext of ['.webm', '.opus']) {
    ok(picker[0].includes(ext),
      `the picker can filter out ${ext}, which is what music-get.sh downloads`);
  }
});

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

/* --------------------------------------------------------------- 3. assets */

check('every script file parses', () => {
  for (const file of SCRIPTS) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)]);
  }
});

check('the analysis and format files stay free of the browser', () => {
  /* The split is only worth anything while it holds. These two are the parts
     that can be tested without a DOM, and one `document.` or one reach into
     `state` would quietly take that away — the drift would not break anything
     until someone tried to test the thing that had drifted. */
  for (const file of ['src/analysis.js', 'src/formats.js']) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const code = body.split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const [what, pattern] of [
      ['the DOM', /\bdocument\./],
      ['the window', /\bwindow\./],
      ['program state', /\bstate\.(clips|selected|name|level|target)/],
      ['the music library', /\blibrary\.(get|set|has|delete)\b/],
      ['an element lookup', /\$\('/],
    ]) {
      ok(!pattern.test(code), `${file} reaches for ${what}, which it must not`);
    }
  }
});

check('the page loads the scripts, in an order that works', () => {
  // app.js calls into both by name at load time, so they have to come first.
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  eq(order, SCRIPTS, 'the page must load exactly these, in this order: ');
});

/** Walks tags and returns the names left open, so both pages can be checked. */
function unclosedTags(source) {
  const voids = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'track']);
  const stack = [];
  for (const m of source.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, , selfClose] = m;
    const name = tag.toLowerCase();
    if (voids.has(name) || selfClose || name === '!doctype') continue;
    if (closing) {
      ok(stack.length, `stray </${name}>`);
      const open = stack.pop();
      eq(open, name, `</${name}> closes <${open}>: `);
    } else {
      stack.push(name);
    }
  }
  return stack;
}

check('HTML tags are balanced', () => {
  eq(unclosedTags(html), [], 'unclosed tags in index.html: ');
});

check('CSS braces balance', () => {
  const opens = (css.match(/{/g) || []).length;
  const closes = (css.match(/}/g) || []).length;
  eq(opens, closes, 'unbalanced braces: ');
});

check('every CSS custom property used is defined', () => {
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  eq([...used].filter((v) => !defined.has(v)), [], 'used but never defined: ');
});

check('both color themes define the same variables', () => {
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  const light = css.slice(0, css.indexOf('prefers-color-scheme: dark'));
  const names = (block) => new Set([...block.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  const l = names(light);
  const d = names(dark);
  const onlyDark = [...d].filter((v) => !l.has(v));
  eq(onlyDark, [], 'defined only in dark mode: ');
});

/* The two music-get wrappers are the same tool written twice, once for a shell
   and once for cmd. Nothing forces them to agree, and a fix applied to one and
   forgotten on the other is the obvious way for that to rot, so the flags that
   define the behavior are asserted in both. */
check('the music-get wrappers agree on what they do', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'tools/music-get.sh'), 'utf8');
  const cmd = fs.readFileSync(path.join(ROOT, 'tools/music-get.cmd'), 'utf8');
  const flags = [
    '--format bestaudio',   // the native stream, never re-encoded
    '--no-overwrites',
    '--no-playlist',
    '--yes-playlist',
    '--playlist-items 1',   // one song means one song, even off a stray feed
    '--print-to-file',      // how "did anything actually arrive" is answered
  ];
  for (const flag of flags) {
    ok(sh.includes(flag), `music-get.sh no longer passes ${flag}`);
    ok(cmd.includes(flag), `music-get.cmd no longer passes ${flag}`);
  }
  // Comments only, stripped out: both scripts say the word ffmpeg while
  // explaining that they don't need it, which is the opposite of the problem.
  const code = (sh + cmd)
    .split('\n')
    .filter((line) => !/^\s*(#|rem\b)/i.test(line))
    .join('\n');
  ok(!/--extract-audio|--audio-format|\bffmpeg\b/i.test(code),
    'a wrapper converts the audio; it is meant to take the stream as it is');
  ok(!/\/home\/|file:\/\/\//.test(code), 'a wrapper references a local path');
  if (process.platform !== 'win32') {
    ok(fs.statSync(path.join(ROOT, 'tools/music-get.sh')).mode & 0o111,
      'music-get.sh is not executable');
  }
});

if (process.argv.includes('--net')) {
  check('the pinned MP3 encoder hash still matches the CDN', () => {
    const body = execFileSync('curl', ['-sSL', '--max-time', '30', app.LAME_URL],
      { maxBuffer: 1 << 24 });
    const got = `sha384-${crypto.createHash('sha384').update(body).digest('base64')}`;
    eq(got, app.LAME_SRI,
      'the CDN now serves different bytes; update LAME_SRI after checking why: ');
  });
}


/* ------------------------------------------------------- 4. documentation */

const helpHtml = fs.readFileSync(path.join(ROOT, 'docs/help.html'), 'utf8');
const docsCss = fs.readFileSync(path.join(ROOT, 'docs/docs.css'), 'utf8');

/** The `--name: value` pairs a stylesheet defines, in order, as one string. */
function tokensOf(source) {
  return [...source.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
    .map((m) => `${m[1]}: ${m[2].trim()}`);
}

check('the two stylesheets agree on the colors', () => {
  /* docs.css copies the token block rather than loading src/style.css, which
     would drag in a layout built for a control surface — it styles `header`,
     `main`, `section` and `h2` for one, and a page of prose is not one. The
     copy is the same arrangement the two music-get wrappers are in, and it is
     held the same way: here. Drift shows up as the guide slowly not looking
     like the app any more, which nothing else would notice. */
  eq(tokensOf(docsCss), tokensOf(css), 'docs/docs.css has drifted from src/style.css: ');
});

check('the documentation page is well formed and its contents work', () => {
  eq(unclosedTags(helpHtml), [], 'unclosed tags in docs/help.html: ');

  const ids = new Set([...helpHtml.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const anchors = [...helpHtml.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
  ok(anchors.length > 10, 'the contents list has lost its links');
  eq(anchors.filter((a) => !ids.has(a)), [], 'links to sections that do not exist: ');

  /* Every heading that can be linked to should be — a section missing from the
     contents is a section nobody finds. h3s are subsections and are exempt. */
  const body = helpHtml.replace(/<nav class="toc"[\s\S]*?<\/nav>/, '');
  const headings = [...body.matchAll(/<h2 id="([\w-]+)"/g)].map((m) => m[1]);
  const listed = new Set(anchors);
  eq(headings.filter((h) => !listed.has(h)), [], 'sections missing from the contents: ');
});

check('the app links to the guide without breaking the help buttons', () => {
  /* bindHelp() binds every .help-btn to openHelp(dataset.help), so a link
     wearing that class would be bound too and would open an empty dialog
     instead of navigating. It has to be a different class, and it is worth
     asserting because the styles make the two look identical on purpose. */
  const link = html.match(/<a class="([\w-]+)" href="(docs\/[\w.-]+)"/);
  ok(link, 'index.html no longer links to the guide');
  ok(!link[1].split(/\s+/).includes('help-btn'),
    'the guide link carries help-btn, so bindHelp will hijack its click');
  ok(fs.existsSync(path.join(ROOT, link[2])), `index.html links to a missing ${link[2]}`);
});

check('every link between the docs and the README points at something', () => {
  /* Relative links only. The absolute ones go to the published site, and a test
     that reached the network to check them would fail for reasons that have
     nothing to do with the change being tested. */
  for (const file of ['README.md', 'docs/development.md', 'docs/help.html']) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const from = path.dirname(path.join(ROOT, file));
    const links = [...body.matchAll(/(?:\]\(|href=")([^)"#][^)"]*?)(?:#[^)"]*)?(?:\)|")/g)];
    for (const [, target] of links) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      ok(fs.existsSync(path.resolve(from, target)),
        `${file} links to ${target}, which does not exist`);
    }
  }
});

check('the logo is used as a favicon and a mark on every page that has one', () => {
  /* One file does three jobs — favicon, topbar mark, README header — so it
     carries fixed colors rather than theme tokens: two of those three never
     load a stylesheet. A palette token creeping in would look right in the app
     and render as an unstyled black shape everywhere else. */
  const logo = fs.readFileSync(path.join(ROOT, 'src/logo.svg'), 'utf8');
  ok(!/var\(--/.test(logo), 'the logo uses a CSS variable, which a favicon cannot resolve');
  ok(/<title/.test(logo), 'the logo has no <title> for screen readers');

  for (const [file, prefix] of [['index.html', 'src/'], ['docs/help.html', '../src/']]) {
    const page = fs.readFileSync(path.join(ROOT, file), 'utf8');
    ok(page.includes(`<link rel="icon" href="${prefix}logo.svg"`), `${file} has no favicon`);
    ok(page.includes(`src="${prefix}logo.svg"`), `${file} does not show the logo`);
  }
  ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('src="src/logo.svg"'),
    'the README no longer shows the logo');
});

check('the README shows the state of the build', () => {
  /* The point of the badge is that it is fetched live. One written down as a
     static image, or pointing at a workflow file that has been renamed, would
     read as a passing build for as long as nobody checked. */
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const badges = [...readme.matchAll(/actions\/workflows\/([\w.-]+)\/badge\.svg/g)].map((m) => m[1]);
  ok(badges.length > 0, 'the README shows no build status');
  for (const workflow of badges) {
    ok(fs.existsSync(path.join(ROOT, '.github/workflows', workflow)),
      `the README badges ${workflow}, which no longer exists`);
  }
  ok(badges.includes('ci.yml'), 'the README does not show whether CI passes');
});

check('every link that opens a new tab is safe, and the source is reachable', () => {
  /* `target="_blank"` without `rel="noopener"` hands the opened page a
     `window.opener` handle back to this one. Nothing here is worth stealing,
     but the pages are served from the same origin as anything else on
     github.io, and the fix costs one attribute. */
  for (const file of ['index.html', 'docs/help.html']) {
    const page = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [tag] of page.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)) {
      ok(/rel="[^"]*\bnoopener\b/.test(tag), `${file}: target=_blank without rel=noopener: ${tag}`);
    }
    ok(/href="https:\/\/github\.com\/[\w-]+\/skate-program-editor"/.test(page),
      `${file} does not link to the source`);
  }
});

check('the theme bootstrap in the page agrees with the logic in app.js', () => {
  /* The key and the two explicit mode names are written twice: once in the
     inline script in <head>, which has to run before the stylesheet to stop an
     explicit choice flashing the other theme first, and once in app.js, which
     owns everything else about it. Spelled differently, the page would come up
     in one theme and the button would claim the other, and nothing else here
     would notice. */
  const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  const boot = html.match(/<script>([\s\S]*?)<\/script>/);
  ok(boot, 'index.html has no inline theme bootstrap');

  const key = app.match(/const THEME_KEY = '([\w.]+)'/);
  ok(key, 'app.js no longer defines THEME_KEY');
  ok(boot[1].includes(`'${key[1]}'`), `the bootstrap does not read ${key[1]}`);

  for (const mode of ['light', 'dark']) {
    ok(boot[1].includes(`'${mode}'`), `the bootstrap does not handle ${mode}`);
    ok(app.includes(`'${mode}'`), `app.js does not handle ${mode}`);
  }
  ok(/data-theme/.test(boot[1]) && /data-theme/.test(app),
    'the two halves disagree about the attribute name');
  ok(/\[data-theme="dark"\]/.test(css) && /\[data-theme="light"\]/.test(css),
    'the stylesheet does not act on data-theme in both directions');
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
    .filter((f) => !['LICENSE', 'package-lock.json', 'test/assets.test.js'].includes(f));
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
