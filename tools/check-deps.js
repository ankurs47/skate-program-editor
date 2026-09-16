#!/usr/bin/env node
/**
 * Ask whether the versions in package-lock.json are still the ones we would
 * get if we resolved today, and whether any of them carry an advisory.
 *
 *   node tools/check-deps.js          # report; exit 1 if anything is out of date
 *   node tools/check-deps.js --json   # the same findings as data, for a human debugging this
 *
 * The lockfile pins exact versions on purpose — that is what makes `npm ci`
 * reproducible — so it only moves when someone moves it, and a patch released
 * the day after a lockfile was written can sit unused for a year. That is the
 * gap this watches. It is dull for weeks and then it is a high-severity
 * advisory in a transitive dependency nobody chose, which is how js-yaml
 * 4.3.1 stayed in ours (GHSA-2883-xcg3-v3hh).
 *
 * How it answers, and why not the obvious way: `npm audit fix --dry-run` said
 * there was nothing to do while that advisory was open, and `npm update
 * --dry-run` listed two of the three packages it would go on to change and
 * omitted the one that mattered. Neither dry run can be believed. So this does
 * the resolve for real — in a copy of package.json and package-lock.json in a
 * temporary directory, with --package-lock-only so nothing is downloaded and
 * --ignore-scripts so this repo's prepare hook does not fail the install out
 * from under it — and then compares the two lockfiles. What it reports is what
 * `npm update` would actually write, because it is what `npm update` just did.
 *
 * The vendored encoder is watched too, and it is not an npm dependency in any
 * sense npm can see: `src/vendor/mp3-encoder.js` is a committed bundle, built
 * from versions written down in tools/build-mp3-encoder.js. `npm test --net`
 * already asks whether those exact versions are still the bytes npm published,
 * which is a supply-chain question. This asks the other one — whether newer
 * ones exist — because nothing else would ever say so.
 *
 * What this does NOT do: change anything here. A job that quietly rewrote the
 * lockfile would be landing dependency changes on main with nobody reading
 * them, and the whole value of pinning is that a person saw the move.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** npm exits non-zero for ordinary findings — `outdated` whenever anything is
    outdated, `audit` whenever anything is vulnerable — so the status tells us
    nothing and the output is what matters. Only unparsable output is a real
    failure, and that is the caller's to decide. */
function npm(args, cwd) {
  try {
    return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw new Error(`npm ${args.join(' ')}: ${(err.stderr || err.message).trim().split('\n')[0]}`);
  }
}

function lockedVersions(lockfile) {
  const { packages } = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  const versions = new Map();
  for (const [where, meta] of Object.entries(packages)) {
    /* "" is this package itself, and a nested node_modules/a/node_modules/b is
       a second copy of b at a different version. Both are keyed by their last
       path segment, which is the name anyone would report it under. */
    if (!where) continue;
    versions.set(where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length), {
      version: meta.version,
      dev: Boolean(meta.dev),
    });
  }
  return versions;
}

/** What `npm update` would write, obtained by letting it write one. */
function resolveAfresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skate-deps-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
    }
    npm(['update', '--package-lock-only', '--ignore-scripts'], dir);
    return {
      versions: lockedVersions(path.join(dir, 'package-lock.json')),
      audit: audited(dir),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Open advisories in a tree, keyed by package name. */
function audited(cwd) {
  const report = JSON.parse(npm(['audit', '--json'], cwd));
  const found = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
    /* An advisory reaches us either directly or through whatever depends on
       the vulnerable package; `via` holds strings for the latter. Only the
       direct entries carry the title and the URL worth printing. */
    const details = (vuln.via || []).filter((v) => typeof v === 'object');
    found.set(name, {
      severity: vuln.severity,
      range: vuln.range,
      fixable: Boolean(vuln.fixAvailable),
      titles: details.map((d) => d.title),
      urls: details.map((d) => d.url),
    });
  }
  return found;
}

/** Direct dependencies whose newest release is outside the range we declare —
    a package.json edit and a person's decision, not something a lockfile move
    can reach. Read from node_modules, so it needs an install to have happened;
    an empty answer where there should be one is reported rather than assumed. */
function majors() {
  const outdated = JSON.parse(npm(['outdated', '--json'], ROOT) || '{}');
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const ranges = { ...declared.dependencies, ...declared.devDependencies };
  return Object.entries(outdated)
    .filter(([name, o]) => ranges[name] && o.latest && o.latest !== o.wanted)
    .map(([name, o]) => ({ name, range: ranges[name], wanted: o.wanted, latest: o.latest }));
}

/** The versions the committed bundle in src/vendor was built from. They are
    not installed, not in the lockfile, and invisible to `npm outdated` — they
    live in tools/build-mp3-encoder.js, which is read here rather than copied so
    there is one place that says what the encoder is made of. */
function vendored() {
  const { PINS } = require(path.join(ROOT, 'tools/build-mp3-encoder.js'));
  return Object.entries(PINS)
    .map(([name, { version }]) => ({
      name,
      pinned: version,
      latest: npm(['view', name, 'version'], ROOT).trim(),
    }))
    .filter((p) => p.latest && p.latest !== p.pinned);
}

function findings() {
  const now = lockedVersions(path.join(ROOT, 'package-lock.json'));
  const after = resolveAfresh();

  const drift = [];
  for (const [name, meta] of now) {
    const next = after.versions.get(name);
    if (next && next.version !== meta.version) {
      drift.push({ name, from: meta.version, to: next.version, dev: meta.dev });
    }
  }
  drift.sort((a, b) => a.name.localeCompare(b.name));

  const advisories = [...audited(ROOT)]
    .map(([name, a]) => ({ name, ...a, clearedByUpdate: !after.audit.has(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { drift, advisories, majors: majors(), vendored: vendored() };
}

/* A digest of what was found rather than of the words below, so the weekly job
   can tell "the same news again" from "something new" without diffing prose.
   Versions are in it; the run date deliberately is not. */
function digest({ drift, advisories, majors: behind, vendored: pins }) {
  const parts = [
    ...drift.map((d) => `${d.name}@${d.from}>${d.to}`),
    ...advisories.map((a) => `${a.name}:${a.severity}`),
    ...behind.map((m) => `${m.name}^${m.latest}`),
    ...pins.map((p) => `vendored:${p.name}@${p.latest}`),
  ];
  return require('crypto')
    .createHash('sha256')
    .update(parts.sort().join('|'))
    .digest('hex')
    .slice(0, 12);
}

function report(found) {
  const { drift, advisories, majors: behind, vendored: pins } = found;
  /* The heading names the most serious thing found, because it is the only
     part of this that reaches anyone who does not open the issue. */
  const title = advisories.length
    ? `A dependency in the lockfile has a ${advisories[0].severity}-severity advisory`
    : drift.length
      ? 'The lockfile has drifted from what npm would resolve today'
      : pins.length
        ? `The vendored encoder was built from ${pins[0].name}@${pins[0].pinned}, and there is a newer one`
        : 'A new major is out for a dependency we declare';
  const lines = [`## ${title}\n`];

  if (advisories.length) {
    lines.push('### Advisories\n');
    for (const a of advisories) {
      lines.push(`- **${a.name}** ${a.range} — ${a.severity}`);
      for (const [i, title] of a.titles.entries()) lines.push(`  - ${title} (${a.urls[i]})`);
      lines.push(
        a.clearedByUpdate
          ? '  - cleared by `npm update`'
          : a.fixable
            ? '  - not cleared by `npm update`; `npm audit fix` wants a wider change than a lockfile move'
            : '  - **no fix published yet** — nothing to do here but decide whether to keep the dependency',
      );
    }
    lines.push('');
  }

  if (drift.length) {
    lines.push('### `npm update` would move these\n');
    for (const d of drift) {
      lines.push(`- ${d.name}: ${d.from} → ${d.to}${d.dev ? ' (dev)' : ''}`);
    }
    lines.push(
      '',
      'Every one of these is already inside a range `package.json` declares — no',
      'range has to change, the lockfile just has not been resolved since they',
      'were published. This list is what `npm update` wrote when this check ran',
      'it against a copy, not what its `--dry-run` claims it would write; the two',
      'do not agree, and the dry run is the one that is wrong.\n',
    );
  }

  if (behind.length) {
    lines.push('### Outside the ranges we declare\n');
    for (const m of behind) {
      lines.push(`- ${m.name}: on ${m.wanted}, latest is ${m.latest} (declared \`${m.range}\`)`);
    }
    lines.push(
      '',
      "This one is a person's call, not a lockfile move: it means editing the",
      'range in `package.json` and reading the release notes for what broke.',
      'Nothing here is urgent on its own — it is listed so a major cannot sit',
      'unnoticed for a year.\n',
    );
  }

  if (pins.length) {
    lines.push('### The vendored encoder is behind its sources\n');
    for (const p of pins) {
      lines.push(`- ${p.name}: built from ${p.pinned}, latest is ${p.latest}`);
    }
    lines.push(
      '',
      'These are not installed and `npm outdated` cannot see them. They are the',
      'versions `src/vendor/mp3-encoder.js` was bundled from, written down in',
      '`tools/build-mp3-encoder.js`. Taking a newer one means rebuilding that',
      'bundle and committing around 400 KB of generated code, so it is a change',
      'to read the release notes for rather than to take on sight — and for',
      'esbuild it is the bundler itself, which can rewrite the whole file for no',
      'reason anyone asked for.\n',
      'To take them: edit the versions and their `integrity` hashes in',
      '`tools/build-mp3-encoder.js`, then\n',
      '```',
      'node tools/build-mp3-encoder.js   # rebuild, a minute or two',
      'npm run check:encoder             # the committed bytes are what the pins build',
      'npm run test:net                  # the pins are what npm published',
      'npm run test:dom                  # the encoder still exports a playable file',
      '```\n',
      'and update the version table in `src/vendor/NOTICE.md` — a unit check',
      'compares it against the pins and will fail if you do not.\n',
    );
  }

  /* Nothing to run when the only finding is a major: `npm update` would print
     "up to date" and the next reader would reasonably conclude the check was
     wrong. Say what there is to do instead. */
  lines.push('### To act on this\n');
  if (drift.length || advisories.some((a) => a.clearedByUpdate)) {
    lines.push(
      '```',
      'npm update          # takes the lockfile moves above',
      'npm audit           # should then be quiet',
      'npm run check       # lint and the unit suite, on the new versions',
      '```',
      '',
      'Then commit `package-lock.json`. Nothing updates it automatically, on',
      'purpose — a pinned dependency is only worth pinning if a person saw it move.',
    );
  } else {
    lines.push(
      'There is no lockfile move to take here — `npm update` would say it is up',
      'to date and mean it. What is above needs a range changed in `package.json`',
      'by someone who has read what changed, or a decision that it can wait.',
    );
  }
  return lines.join('\n');
}

function main() {
  const found = findings();
  const total =
    found.drift.length + found.advisories.length + found.majors.length + found.vendored.length;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...found, digest: digest(found) }, null, 2));
    return total ? 1 : 0;
  }

  if (!total) {
    console.log(
      '\n  the lockfile is what npm would resolve today, nothing in it is flagged,' +
        '\n  and the vendored encoder is built from the newest of its sources\n',
    );
    return 0;
  }

  const body = `${report(found)}\n\n<!-- deps-digest: ${digest(found)} -->\n`;
  fs.writeFileSync(path.join(ROOT, 'deps-report.md'), body);
  console.log(`\n${body}`);
  return 1;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`\n  the dependency check could not run: ${err.message}\n`);
  process.exit(1);
}
