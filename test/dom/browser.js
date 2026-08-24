/**
 * A very small headless Chrome driver, over the DevTools Protocol.
 *
 * No dependencies. Node 22 has a global WebSocket and Chrome speaks CDP over
 * one, so the whole of what these tests need — load a page, run an expression
 * in it, collect what the console said — is a few dozen lines. The alternative
 * was selenium-webdriver plus a chromedriver binary pinned to the installed
 * Chrome's major version, or Playwright and its own 150 MB browser, to do the
 * same three things.
 *
 * Everything here returns a promise and nothing polls on a timer it invented:
 * the tests assert on page state, never on how long something took.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const CHROMES = [
  process.env.CHROME,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
].filter(Boolean);

/* Anything the page actually asks for. Served as octet-stream, an SVG is a
   download rather than an image — which is how the logo went unrendered in
   every browser check until a screenshot showed a broken-image box. */
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

/**
 * Serve the repo over http rather than opening it as a file.
 *
 * `file://` would work — the app is built to — but it is not how anyone runs
 * it, and it changes enough about origins and module loading to be worth not
 * testing a different thing than ships.
 */
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, name);
      // Nothing outside the repo, however the request is spelled.
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        // Chrome caches aggressively enough that a stale index.html cost an
        // afternoon once. Nothing here should ever be served from cache.
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/** Wait for Chrome's debugging port to answer, or give up with a real message. */
async function waitForPort(port, chrome) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      return JSON.parse(await get(`http://127.0.0.1:${port}/json/version`));
    } catch (err) {
      if (chrome.exitCode !== null) {
        throw new Error(`Chrome exited with code ${chrome.exitCode} before listening`);
      }
      if (Date.now() > deadline) throw new Error(`Chrome never opened port ${port}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** The page target Chrome opened for us, once it exists. */
async function findPage(port) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const targets = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    if (Date.now() > deadline) throw new Error('Chrome opened no page to attach to');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** One CDP connection: send a command, get its result. */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Run an expression in the page and bring back its value.
   *
   * Top-level await works, and a thrown error surfaces here rather than being
   * swallowed into an undefined result — a test that silently asserts on
   * `undefined` is worse than one that fails.
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const e = result.exceptionDetails;
      throw new Error(e.exception?.description || e.text || 'page threw');
    }
    return result.result.value;
  }

  /** Everything the page logged or threw since it loaded. */
  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown'
        || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
      .map((e) => e.method === 'Runtime.exceptionThrown'
        ? (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
        : e.params.args.map((a) => a.value ?? a.description).join(' '));
  }
}

/**
 * Start Chrome, serve the repo, and open the editor in it.
 *
 * `--autoplay-policy` is the one that matters: without it a headless page
 * cannot start an AudioContext without a user gesture, and every check that
 * touches playback would fail for a reason that has nothing to do with the
 * code. Nothing here produces sound — the assertions are on the audio graph.
 */
async function open({ url = '/index.html' } = {}) {
  const server = await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'skate-dom-'));
  const port = 9222 + Math.floor(Math.random() * 700);

  let chrome = null;
  let launched = null;
  for (const candidate of CHROMES) {
    chrome = spawn(candidate, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-extensions', '--disable-background-networking',
      '--autoplay-policy=no-user-gesture-required',
      /* Headless defaults to 800x600, which is below the 860px breakpoint — so
         without this every check ran against the one-column phone layout and
         the two-column one the app actually ships in was never exercised. */
      '--window-size=1280,900',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ], { stdio: 'ignore' });
    launched = await new Promise((resolve) => {
      chrome.once('error', () => resolve(false));
      chrome.once('spawn', () => resolve(true));
    });
    if (launched) break;
  }
  if (!launched) {
    await server.stop();
    throw new Error(`no Chrome found — tried ${CHROMES.join(', ')}. Set CHROME=/path/to/chrome`);
  }

  await waitForPort(port, chrome);
  // Attach to the about:blank Chrome already opened rather than asking for a
  // new target: /json/new wants a PUT in current Chrome and answers a GET with
  // a warning in place of JSON, which is a confusing way to find that out.
  const target = await findPage(port);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  const page = new Session(socket);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  // Navigate, then wait for the app to have actually run rather than for a
  // load event that fires before init() has finished.
  await page.send('Page.navigate', { url: server.origin + url });
  const deadline = Date.now() + 20000;
  for (;;) {
    const ready = await page.evaluate(
      'return document.readyState === "complete" && typeof layout === "function";'
    ).catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) throw new Error('the editor never finished starting');
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    page,
    origin: server.origin,
    async close() {
      try { socket.close(); } catch (_) { /* already gone */ }

      /* Chrome does not exit alone — it leaves a zygote and a renderer or two
         that keep writing to the profile after the parent is gone. Waiting for
         the parent is not enough, so it gets a moment and then SIGKILL. */
      const ended = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill();
      const died = await Promise.race([
        ended.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 3000)),
      ]);
      if (!died) {
        try { chrome.kill('SIGKILL'); } catch (_) { /* already gone */ }
        await Promise.race([ended, new Promise((r) => setTimeout(r, 2000))]);
      }

      try { await server.stop(); } catch (_) { /* already closed */ }

      /* A temporary directory left behind is untidy; a failed run because of
         one is a lie about the code. This is best effort, and the operating
         system clears tmp anyway. */
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (_) { /* Chrome is still holding something; not our problem */ }
    },
  };
}

module.exports = { open };
