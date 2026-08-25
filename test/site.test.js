/**
 * What gets published, as opposed to what the app is built from.
 *
 * The guide, the logo, the README's badges, and the handful of tags and files
 * that decide how a link to this looks in a search result or a group chat.
 *
 * These go wrong in ways nothing else notices: a sitemap with its namespace
 * mistyped, a description nobody sees the end of, a link that opens a tab and
 * hands it a way back to this page. Every one of those shipped at least once.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { check, eq, ok, html, css, ROOT, unclosedTags } = require('./harness.js');

const helpHtml = fs.readFileSync(path.join(ROOT, 'docs/help.html'), 'utf8');

const docsCss = fs.readFileSync(path.join(ROOT, 'docs/docs.css'), 'utf8');

/** The `--name: value` pairs a stylesheet defines, in order, as one string. */
function tokensOf(source) {
  return [...source.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => `${m[1]}: ${m[2].trim()}`);
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
  eq(
    anchors.filter((a) => !ids.has(a)),
    [],
    'links to sections that do not exist: ',
  );

  /* Every heading that can be linked to should be — a section missing from the
     contents is a section nobody finds. h3s are subsections and are exempt. */
  const body = helpHtml.replace(/<nav class="toc"[\s\S]*?<\/nav>/, '');
  const headings = [...body.matchAll(/<h2 id="([\w-]+)"/g)].map((m) => m[1]);
  const listed = new Set(anchors);
  eq(
    headings.filter((h) => !listed.has(h)),
    [],
    'sections missing from the contents: ',
  );
});

check('the app links to the guide without breaking the help buttons', () => {
  /* bindHelp() binds every .help-btn to openHelp(dataset.help), so a link
     wearing that class would be bound too and would open an empty dialog
     instead of navigating. It has to be a different class, and it is worth
     asserting because the styles make the two look identical on purpose. */
  const link = html.match(/<a class="([\w-]+)" href="(docs\/[\w.-]+)"/);
  ok(link, 'index.html no longer links to the guide');
  ok(
    !link[1].split(/\s+/).includes('help-btn'),
    'the guide link carries help-btn, so bindHelp will hijack its click',
  );
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
      ok(
        fs.existsSync(path.resolve(from, target)),
        `${file} links to ${target}, which does not exist`,
      );
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

  for (const [file, prefix] of [
    ['index.html', 'src/'],
    ['docs/help.html', '../src/'],
  ]) {
    const page = fs.readFileSync(path.join(ROOT, file), 'utf8');
    ok(page.includes(`<link rel="icon" href="${prefix}logo.svg"`), `${file} has no favicon`);
    ok(page.includes(`src="${prefix}logo.svg"`), `${file} does not show the logo`);
  }
  ok(
    fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('src="src/logo.svg"'),
    'the README no longer shows the logo',
  );
});

check('the README shows the state of the build', () => {
  /* The point of the badge is that it is fetched live. One written down as a
     static image, or pointing at a workflow file that has been renamed, would
     read as a passing build for as long as nobody checked. */
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const badges = [...readme.matchAll(/actions\/workflows\/([\w.-]+)\/badge\.svg/g)].map(
    (m) => m[1],
  );
  ok(badges.length > 0, 'the README shows no build status');
  for (const workflow of badges) {
    ok(
      fs.existsSync(path.join(ROOT, '.github/workflows', workflow)),
      `the README badges ${workflow}, which no longer exists`,
    );
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
    ok(
      /href="https:\/\/github\.com\/[\w-]+\/skate-program-editor"/.test(page),
      `${file} does not link to the source`,
    );
  }
});

check('the site tells crawlers where to look, and points only at real pages', () => {
  /* A sitemap listing a page that is not served, or carrying the wrong
     namespace, is worse than none: it looks handled and is quietly ignored.
     The namespace is sitemaps.org, plural — I typed the singular first. */
  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');

  ok(
    /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(sitemap),
    'the sitemap namespace is not the one crawlers look for',
  );

  const declared = robots.match(/^Sitemap:\s*(\S+)$/m);
  ok(declared, 'robots.txt does not point at the sitemap');

  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(urls.length >= 2, 'the sitemap lists fewer pages than the site has');

  /* Every listed page must exist in the repo, since that is what gets served.
     The site root is index.html; anything else is a path under it. */
  const base = declared[1].replace(/sitemap\.xml$/, '');
  for (const url of urls) {
    ok(url.startsWith(base), `${url} is not on the site robots.txt names`);
    const rel = url.slice(base.length) || 'index.html';
    const file = rel.endsWith('/') ? `${rel}index.html` : rel;
    ok(fs.existsSync(path.join(ROOT, file)), `the sitemap lists ${rel}, which is not in the repo`);
  }

  // The pages that are served should also be the ones listed.
  ok(
    urls.some((u) => u === base),
    'the sitemap does not list the app itself',
  );
  ok(
    urls.some((u) => u.endsWith('docs/help.html')),
    'the sitemap does not list the guide',
  );
});

check('both pages carry what a link preview and a search result need', () => {
  /* Lengths, not just presence. A validator caught every one of these on the
     first attempt: a 225-character description that Google and every phone cut
     off mid-sentence, a 20-character title wasting the space a search result
     gives you, and a 2:1 image on platforms that crop to 1.91:1.

     Search and social want different lengths — about 155 characters before
     Google truncates, about 125 before a phone does — so the two descriptions
     deliberately differ rather than one string serving both badly. */
  const card = 'docs/social-card.png';
  const image = fs.readFileSync(path.join(ROOT, card));
  eq(image.slice(1, 4).toString(), 'PNG', `${card} is not a PNG: `);
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  /* Exactly 1200x630, not merely the right shape. Two attempts were wrong in
     different ways — 1280x640 is 2:1 and gets its sides cropped, and rendering
     at 2x for sharpness gave 2400x1260, which validators flag and platforms
     resize themselves. It is a thumbnail; the canonical size beats a clever
     one, and `npm run screenshot` is what regenerates it. */
  eq([width, height], [1200, 630], `${card} should be exactly 1200x630: `);

  const pages = [
    ['index.html', html],
    ['docs/help.html', fs.readFileSync(path.join(ROOT, 'docs/help.html'), 'utf8')],
  ];

  for (const [file, page] of pages) {
    const content = (tag) => {
      const m = page.match(new RegExp(`(?:name|property)="${tag}"[^>]*content="([^"]*)"`));
      return m ? m[1] : null;
    };

    const title = (page.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    ok(
      title.length >= 40 && title.length <= 65,
      `${file}: title is ${title.length} characters; aim for 40-65`,
    );

    const serp = content('description');
    ok(
      serp && serp.length >= 70 && serp.length <= 160,
      `${file}: description is ${serp ? serp.length : 0} characters; Google cuts around 160`,
    );

    for (const tag of ['og:description', 'twitter:description']) {
      const value = content(tag);
      ok(
        value && value.length >= 60 && value.length <= 125,
        `${file}: ${tag} is ${value ? value.length : 0} characters; a phone cuts around 125`,
      );
    }

    for (const tag of [
      'og:title',
      'og:image',
      'og:url',
      'twitter:card',
      'twitter:image',
      'og:image:alt',
      'author',
    ]) {
      ok(content(tag), `${file} has no ${tag}`);
    }
    eq(content('og:image:width'), String(width), `${file}: og:image:width should match the file: `);
    eq(
      content('og:image:height'),
      String(height),
      `${file}: og:image:height should match the file: `,
    );

    ok(/<link rel="canonical" href="https:\/\/[^"]+">/.test(page), `${file} has no canonical URL`);
    for (const [, url] of page.matchAll(
      /(?:og:image|og:url|twitter:image)"[^>]*content="([^"]+)"/g,
    )) {
      ok(/^https:\/\//.test(url), `${file}: ${url} must be absolute to be resolved`);
    }
  }

  /* Structured data on the app itself, which is what carries an author and a
     date. It must parse — a broken blob is ignored in silence. */
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  ok(ld, 'index.html has no structured data');
  const data = JSON.parse(ld[1]);
  eq(data['@type'], 'WebApplication', 'structured data type: ');
  ok(data.author && data.author.name, 'structured data names no author');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(data.datePublished || ''), 'no publication date');
  ok(data.url && data.name, 'structured data is missing the name or url');
});
