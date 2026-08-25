/**
 * The app's own files, and whether they hang together.
 *
 * Every id the scripts reach for exists in the HTML, every help button has
 * content, the files parse, the two halves that must stay clear of the browser
 * still are, and the themes agree.
 *
 * Nothing here reaches the network or looks at anything published — site.test.js
 * covers what gets served, repo.test.js the rules that apply everywhere.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { check, eq, ok, html, css, ROOT, SCRIPTS } = require('./harness.js');

check('every element the code reaches for exists in the HTML', () => {
  // Every script, not just app.js: the day one of the others grows a $()
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
  eq(
    buttons.filter((b) => !names.has(b)),
    [],
    'buttons with no content: ',
  );
  eq(
    [...names].filter((n) => !buttons.includes(n)),
    [],
    'content with no button: ',
  );
  for (const [, , title] of topics) ok(title.trim(), 'a topic has an empty title');
});

check('outcomes are announced, and every dialog says it is one', () => {
  /* All the modals are plain divs over a backdrop rather than <dialog>, so the
     role, the name and the modality have to be stated by hand — and the toast
     carries every outcome the app reports.

     The attribute names are checked against the spec's spelling, not against
     whatever the file happens to say. An American-English pass once turned
     aria-labelledby into aria-labeledby in all four dialogs; that is not an
     attribute, so every one of them silently lost its accessible name, and the
     version of this check that looked for "whatever is in the file" passed
     throughout. */
  const toast = html.match(/<div id="toast"[^>]*>/);
  ok(toast, 'the toast is missing');
  ok(
    /role="status"/.test(toast[0]) && /aria-live=/.test(toast[0]),
    'toasts carry every outcome message and have to be announced',
  );

  ok(
    !/aria-labeledby/.test(html),
    'aria-labelledby is spelled with two Ls; one L is not an attribute',
  );

  const cards = [...html.matchAll(/<div\s[^>]*class="modal-card[^"]*"[^>]*>/g)].map((m) => m[0]);
  ok(cards.length >= 3, `expected three dialogs, found ${cards.length}`);
  for (const attrs of cards) {
    ok(/role="dialog"/.test(attrs), `a dialog has no role:${attrs}`);
    ok(/aria-modal="true"/.test(attrs), `a dialog is not marked modal:${attrs}`);
    const named = attrs.match(/aria-labelledby="([\w-]+)"/);
    ok(named, `a dialog has no name:${attrs}`);
    ok(html.includes(`id="${named[1]}"`), `aria-labelledby points at a missing id: ${named[1]}`);
  }
});

check('the page and the file picker both cover what the tools produce', () => {
  ok(
    /<meta name="color-scheme" content="[^"]*dark[^"]*"\s*\/?>/.test(html),
    'without this, native selects and scrollbars stay light in dark mode',
  );
  const picker = html.match(/<input\s[^>]*id="fileInput"[^>]*>/);
  ok(picker, 'the file picker is missing');
  for (const ext of ['.webm', '.opus']) {
    ok(
      picker[0].includes(ext),
      `the picker can filter out ${ext}, which is what music-get.sh downloads`,
    );
  }
});

check('the analysis, format and program files stay free of the browser', () => {
  /* The split is only worth anything while it holds. These three are the parts
     that can be tested without a DOM, and one `document.` or one reach into
     `state` would quietly take that away — the drift would not break anything
     until someone tried to test the thing that had drifted. */
  for (const file of ['src/analysis.js', 'src/formats.js', 'src/program.js']) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const code = body
      .split('\n')
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

check('the page loads every script, in the order the tests assume', () => {
  /* Nothing runs at load but init(), so the order is not what makes the app
     work — but the page and the harness have to agree on the list, or a file
     could be added to one and forgotten in the other. */
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  eq(order, SCRIPTS, 'the page must load exactly these, in this order: ');
});

check('every CSS custom property used is defined', () => {
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  eq(
    [...used].filter((v) => !defined.has(v)),
    [],
    'used but never defined: ',
  );
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
  ok(
    /data-theme/.test(boot[1]) && /data-theme/.test(app),
    'the two halves disagree about the attribute name',
  );
  ok(
    /\[data-theme="dark"\]/.test(css) && /\[data-theme="light"\]/.test(css),
    'the stylesheet does not act on data-theme in both directions',
  );
});

/* The two music-get wrappers are the same tool written twice, once for a shell
   and once for cmd. Nothing forces them to agree, and a fix applied to one and
   forgotten on the other is the obvious way for that to rot, so the flags that
   define the behavior are asserted in both. */
check('the music-get wrappers agree on what they do', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'tools/music-get.sh'), 'utf8');
  const cmd = fs.readFileSync(path.join(ROOT, 'tools/music-get.cmd'), 'utf8');
  const flags = [
    '--format bestaudio', // the native stream, never re-encoded
    '--embed-metadata', // the title and composer, which the editor reads back
    '--no-overwrites',
    '--no-playlist',
    '--yes-playlist',
    '--playlist-items 1', // one song means one song, even off a stray feed
    '--print-to-file', // how "did anything actually arrive" is answered
  ];
  for (const flag of flags) {
    ok(sh.includes(flag), `music-get.sh no longer passes ${flag}`);
    ok(cmd.includes(flag), `music-get.cmd no longer passes ${flag}`);
  }
  /* Comments stripped out: both scripts talk about ffmpeg while explaining what
     it is and is not for, which is the opposite of the problem.

     Writing tags does need ffmpeg, and that is fine — it copies the audio
     stream through untouched. Converting it is what must never happen, so the
     rule is about the flags that transcode, not about ffmpeg. */
  const code = (sh + cmd)
    .split('\n')
    .filter((line) => !/^\s*(#|rem\b)/i.test(line))
    .join('\n');
  ok(
    !/--extract-audio|--audio-format|--recode-video/i.test(code),
    'a wrapper converts the audio; it is meant to take the stream as it is',
  );
  ok(!/\/home\/|file:\/\/\//.test(code), 'a wrapper references a local path');
  if (process.platform !== 'win32') {
    ok(
      fs.statSync(path.join(ROOT, 'tools/music-get.sh')).mode & 0o111,
      'music-get.sh is not executable',
    );
  }
});
