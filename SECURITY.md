# Security

## Reporting

Use GitHub's private reporting: **[Report a
vulnerability](https://github.com/ankurs47/skate-program-editor/security/advisories/new)**,
or the Security tab of this repository. That keeps the details out of public
view until there is something to say about them.

Please do not open a public issue for anything exploitable. For everything else
— a broken link, a wrong spelling, a bug that is merely a bug — a normal issue
is right.

This is a personal project with no team behind it. There is no response-time
undertaking. I will look, and I will say what I find.

## What is actually exposed

Worth being precise, because most of the usual web attack surface is not here.

The app is a static page. There is no server, no backend, no database, no
accounts, no sessions, no cookies, and no analytics. Nothing you open is
uploaded anywhere. Files are read from disk by the browser and stay in the tab;
closing it discards them. So server-side injection, authentication bypass,
session theft and access-control bugs have nothing to act on.

What remains:

- **The MP3 encoder is third-party code that ships with the app.** The app makes
  no runtime fetch of any kind, so there is no CDN to compromise and nothing to
  substitute in transit — but `src/vendor/mp3-encoder.js` is 400 KB of generated
  bundle nobody reads in review, which is its own exposure. What stands in for
  reading it: `npm run check:encoder` rebuilds it from the versions pinned in
  `tools/build-mp3-encoder.js` and fails if a byte differs, and CI runs that on
  every push. A change to those pins, or to that file without a matching change
  to them, is worth scrutinizing in review. `npm test -- --net` additionally asks
  npm whether those versions are still the bytes that were published.
- **Project files are untrusted input.** A `.json` project is plain text people
  do edit by hand, and can arrive from anyone. It is parsed defensively rather
  than trusted — absent fields, wrong types and absurd numbers are all expected
  and clamped rather than thrown at. Bugs in that parsing are in scope.
- **Song titles and program names reach the page.** They come from file names
  and from project files, so they are attacker-influenced. They are written with
  `textContent`, never `innerHTML`. The only `innerHTML` writes are clearing a
  container and copying markup already in the page. Anything that would put
  attacker text into `innerHTML` is in scope.
- **File handles are stored in IndexedDB** on Chrome and Edge, so a saved
  project can offer your songs back after a reload. They are origin-scoped
  handles, not copies of your music, and they carry the same permission prompts.
- **Hosted on GitHub Pages** at `ankurs47.github.io`, which shares an origin
  with every other project on that subdomain. Data in `localStorage` and
  IndexedDB is not isolated from them. Nothing sensitive is kept there — a
  program name, a theme choice, and file handles — but it is worth knowing.

**Known gap:** the page sets no Content-Security-Policy. It would be a real
improvement and it is not there yet.

## Out of scope

- That the app has no accounts, no encryption at rest and no server-side
  validation. It has no server; these are design, not oversights.
- Anything requiring an attacker to already control your computer or your
  browser profile.
- The quality or legality of the music you put into it.

## What this cannot promise

Read the note in the README and mean it. This was built with heavy AI
assistance, for one person's use, and is public in case it helps. It has tests —
unit, browser and mutation — and they run on every change, which is evidence but
not a guarantee. **Before an entry deadline, play the exported file end to end.**
