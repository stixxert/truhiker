#!/usr/bin/env node
/**
 * Visual gate: build the app behind a production-like static server, load it in
 * headless Chromium at desktop and mobile widths, and *assert* that it works.
 *
 *   npm run visual-check
 *
 * Unlike a screenshot script this exits non-zero:
 *   - `dist/` must exist (run `npm run build` first),
 *   - the server must apply the headers from `public/_headers` (CSP included),
 *   - the document must have a title, the app must mount, the map must have a
 *     size, and at least one stat must render a value (not "—"),
 *   - there must be zero page errors, zero CSP violations and zero console
 *     errors other than network failures for the live tile/elevation hosts.
 *
 * The header rules are parsed from `public/_headers` rather than copied here, so
 * the gate and the deploy cannot drift. Screenshots are written only after a
 * viewport passes, to `/tmp/webshot`.
 *
 * Requires Playwright (`npm i -D playwright && npx playwright install chromium`).
 * It honours HTTPS_PROXY from the environment so it can run inside a network
 * sandbox that only exposes a proxy; the static server itself listens on
 * 127.0.0.1:4191, which Chromium reaches directly.
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { startRuntime } from './runtime.mjs';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const INDEX_HTML = join(DIST, 'index.html');
const HEADERS_FILE = join(ROOT, 'public', '_headers');
/**
 * A real route to render (Memurubu–Glitterheim, CC BY 4.0 Turrutebasen). It lives
 * under test/fixtures because the app no longer bundles a demo (D26).
 */
const ROUTE_FIXTURE = fileURLToPath(
  new URL('../../test/fixtures/memurubu-glitterheim-jot21.gpx', import.meta.url),
);

const OUT_DIR = '/tmp/webshot';
const PORT = 4191;
const HOST = '127.0.0.1';
let ORIGIN = `http://${HOST}:${PORT}`;

/**
 * `--runtime` serves the build through `wrangler dev` (workerd) instead of the
 * hand-rolled static server, so the gate exercises the real runtime and the
 * headers Cloudflare actually applies. The static server stays as the fallback
 * for environments without wrangler.
 */
const RUNTIME = process.argv.includes('--runtime');
const RUNTIME_PORT = 4192;

/** Live sources that may be slow or unreachable; they must not fail the gate. */
const ALLOWED_HOSTS = [
  'cache.kartverket.no',
  'wms.geonorge.no',
  'tiles.mapterhorn.com',
  'hoydedata.no',
];

/** Headers the root rule in `public/_headers` must define and serve. */
const REQUIRED_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'x-frame-options',
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const READY_TIMEOUT_MS = 30_000;
const SETTLE_MS = 2_500;
const NAV_TIMEOUT_MS = 60_000;

const CONTENT_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.gpx': 'application/gpx+xml; charset=utf-8',
    '.bin': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
  }),
);

class GateFailure extends Error {
  constructor(viewport, failures, observed) {
    super('visual check failed');
    this.viewport = viewport;
    this.failures = failures;
    this.observed = observed;
  }
}

function fail(message) {
  console.error(`visual-check: FAIL — ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// public/_headers parsing and matching
// ---------------------------------------------------------------------------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegex(pattern) {
  const source = pattern
    .split('*')
    .map(escapeRegex)
    .join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * Parse the Cloudflare/Netlify `_headers` format: a path pattern at column 0,
 * followed by indented `Name: value` lines. Comments and blank lines are
 * ignored.
 */
function parseHeaderRules(text) {
  const rules = [];
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      if (!pattern.startsWith('/')) {
        throw new Error(`_headers: path rule does not start with "/": ${pattern}`);
      }
      current = { pattern, regex: patternToRegex(pattern), headers: new Map() };
      rules.push(current);
      continue;
    }

    if (current === null) {
      throw new Error(`_headers: header line before any path rule: ${line.trim()}`);
    }
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`_headers: malformed header line: ${line.trim()}`);

    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    current.headers.set(name.toLowerCase(), { name, value });
  }

  if (rules.length === 0) throw new Error('_headers: no path rules found');
  return rules;
}

/** Exact rules are most specific; otherwise more literal characters wins. */
function specificity(rule) {
  if (!rule.pattern.includes('*')) {
    return Number.MAX_SAFE_INTEGER - 1_000 + rule.pattern.length;
  }
  return rule.pattern.replace(/\*/g, '').length;
}

/**
 * Resolve every rule that matches `pathname` and merge them least-specific
 * first, so the most specific rule wins for duplicate header names.
 */
function resolveHeaders(rules, pathname) {
  const matches = [];
  rules.forEach((rule, index) => {
    if (rule.regex.test(pathname)) {
      matches.push({ rule, index, score: specificity(rule) });
    }
  });
  matches.sort((a, b) => a.score - b.score || a.index - b.index);

  const merged = new Map();
  for (const { rule } of matches) {
    for (const [key, header] of rule.headers) merged.set(key, header);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

function resolveDistFile(pathname) {
  // The root path is what a browser requests; production serves index.html.
  const relative = pathname === '/' ? '/index.html' : pathname;
  const file = resolve(DIST, `.${relative}`);
  if (file !== DIST && !file.startsWith(DIST + sep)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

function createStaticServer(rules) {
  return createServer((request, response) => {
    let pathname;
    try {
      const url = new URL(request.url ?? '/', ORIGIN);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad request');
      return;
    }

    const file = resolveDistFile(pathname);
    if (file === null) {
      const headers = resolveHeaders(rules, pathname);
      const responseHeaders = { 'Content-Type': 'text/plain; charset=utf-8' };
      for (const header of headers.values()) responseHeaders[header.name] = header.value;
      response.writeHead(404, responseHeaders);
      response.end('Not found');
      return;
    }

    const headers = resolveHeaders(rules, pathname);
    const responseHeaders = {
      'Content-Type': CONTENT_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': String(statSync(file).size),
    };
    for (const header of headers.values()) responseHeaders[header.name] = header.value;

    response.writeHead(200, responseHeaders);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  });
}

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });
}

async function closeServer(server) {
  await new Promise((resolvePromise) => {
    server.closeAllConnections?.();
    server.close(() => resolvePromise());
  });
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

function hostsIn(text) {
  const hosts = [];
  const urls = text.match(/https?:\/\/[^\s'"()<>]+/g) ?? [];
  for (const url of urls) {
    try {
      hosts.push(new URL(url.replace(/[.,;:]+$/, '')).hostname);
    } catch {
      // Not a URL after all; ignore.
    }
  }
  return hosts;
}

function mentionsCsp(entry) {
  return /content security policy|err_blocked_by_csp|\bcsp\b/i.test(
    `${entry.text ?? ''} ${entry.url ?? ''} ${entry.errorText ?? ''}`,
  );
}

/**
 * A console error is tolerated only when it can be attributed to one of the
 * live tile/elevation hosts AND looks like a network/load failure. A CSP
 * violation is never tolerated, even for those hosts.
 */
function isAllowedTileNetworkError(entry) {
  if (mentionsCsp(entry)) return false;
  const haystack = `${entry.text} ${entry.url}`;
  const hosts = [...hostsIn(haystack), ...(entry.url ? hostsIn(entry.url) : [])];
  if (!hosts.some(isAllowedHost)) return false;
  return /failed to load|err_|ajaxerror|failed to fetch|networkerror|timed out|timeout|status of \d{3}/i.test(
    haystack,
  );
}

/** Any rejected request to an allowed host is a slow/unreachable live source. */
function isAllowedFailedRequest(entry) {
  if (mentionsCsp(entry)) return false;
  try {
    return isAllowedHost(new URL(entry.url).hostname);
  } catch {
    return false;
  }
}

function readStateInPage() {
  const map = document.getElementById('map');
  const rect = map?.getBoundingClientRect();
  const statIds = ['stat-distance', 'stat-ascent', 'stat-descent', 'stat-time', 'stat-elevation'];
  const stats = statIds.map((id) => document.getElementById(id)?.textContent?.trim() ?? null);
  const rendered = stats.filter((value) => value !== null && !/^[—–-]$/.test(value));
  return {
    title: document.title.trim(),
    root: document.querySelector('.app') !== null,
    map: rect ? { width: rect.width, height: rect.height } : null,
    canvasMounted: map?.querySelector('canvas.maplibregl-canvas') !== null,
    stats,
    renderedStats: rendered,
    routeName: document.getElementById('route-name')?.textContent?.trim() ?? null,
    source: document.getElementById('source-label')?.textContent?.trim() ?? null,
    banners: [...document.querySelectorAll('.banner-text')].map((element) => element.textContent ?? ''),
  };
}

function stateIsReady(state) {
  return (
    state.title !== '' &&
    state.root &&
    state.canvasMounted &&
    state.map !== null &&
    state.map.width > 0 &&
    state.map.height > 0 &&
    state.renderedStats.length > 0
  );
}

async function readState(page) {
  return page.evaluate(readStateInPage);
}

async function waitForReady(page) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let state = await readState(page);
  while (!stateIsReady(state) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    state = await readState(page);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function verifyViewport({ viewport, documentResponse, state, observed, expectedHeaders }) {
  const failures = [];
  const add = (assertion, detail, entries = []) => failures.push({ assertion, detail, entries });

  // 1. The server really applied the headers from public/_headers.
  if (documentResponse === null) {
    add('document response', 'navigation returned no response');
  } else {
    if (!documentResponse.ok()) {
      add('document response', `HTTP ${documentResponse.status()} ${documentResponse.statusText()}`);
    }
    const served = documentResponse.headers();
    for (const name of REQUIRED_HEADERS) {
      const expected = expectedHeaders.get(name);
      if (expected === undefined) {
        add(`header ${name}`, 'public/_headers defines no value for /');
      } else if (served[name] === undefined) {
        add(`header ${name}`, 'missing on the document response — the server did not apply public/_headers');
      } else if (served[name] !== expected.value) {
        add(`header ${name}`, `response has ${JSON.stringify(served[name])}, public/_headers says ${JSON.stringify(expected.value)}`);
      }
    }
  }

  // 2. The document and app are actually there.
  if (state.title === '') {
    add('document.title', 'document.title is empty');
  }
  if (!state.root || !state.canvasMounted) {
    add(
      'app mounted',
      `root=${state.root}, map canvas=${state.canvasMounted} (expected .app and canvas.maplibregl-canvas inside #map)`,
    );
  }

  // 3. The map has real dimensions.
  if (state.map === null || state.map.width <= 0 || state.map.height <= 0) {
    add('map size', `#map is ${state.map ? `${state.map.width}x${state.map.height}` : 'missing'}`);
  }

  // 4. At least one stat has a value rather than the placeholder em dash.
  if (state.renderedStats.length === 0) {
    add('stat values', `no stat rendered a value; stats were ${JSON.stringify(state.stats)}`);
  }

  // 5. No uncaught page exceptions.
  if (observed.pageErrors.length > 0) {
    add('zero page errors', `${observed.pageErrors.length} page error(s)`, observed.pageErrors);
  }

  // 6. No CSP violations, by security event or console message.
  const csp = [
    ...observed.cspEvents.map(
      (event) =>
        `[securitypolicyviolation] blocked ${event.blockedURI || '(inline)'} — ${event.effectiveDirective || event.violatedDirective}${event.sourceFile ? ` at ${event.sourceFile}:${event.lineNumber}` : ''}`,
    ),
    ...observed.cspConsole.map((entry) => `[console.${entry.type}] ${entry.text}${entry.url ? ` (${entry.url})` : ''}`),
  ];
  if (csp.length > 0) {
    add('zero CSP violations', `${csp.length} CSP violation(s)`, csp);
  }

  // 7. No console errors other than live tile/elevation network failures.
  const badConsole = observed.consoleErrors.filter((entry) => !isAllowedTileNetworkError(entry));
  if (badConsole.length > 0) {
    add(
      'zero console errors',
      `${badConsole.length} unexpected console error(s)`,
      badConsole.map((entry) => `[console.error] ${entry.text}${entry.url ? ` (${entry.url})` : ''}`),
    );
  }

  // 8. No failed requests other than the live tile/elevation hosts.
  const badRequests = observed.failedRequests.filter((entry) => !isAllowedFailedRequest(entry));
  if (badRequests.length > 0) {
    add(
      'zero unexpected failed requests',
      `${badRequests.length} failed request(s) outside the allowed live hosts`,
      badRequests.map((entry) => `${entry.url} :: ${entry.errorText}`),
    );
  }

  return failures;
}

function printLines(lines, indent = '    ') {
  if (lines.length === 0) {
    console.error(`${indent}(none)`);
    return;
  }
  for (const line of lines) {
    for (const part of String(line).split('\n')) console.error(`${indent}${part}`);
  }
}

function printFailure(failure) {
  const { viewport, failures, observed } = failure;
  console.error(`visual-check: FAIL — ${viewport.name} ${viewport.width}x${viewport.height}`);
  for (const item of failures) {
    console.error(`  ✗ ${item.assertion}: ${item.detail}`);
    if (item.entries.length > 0) printLines(item.entries, '      ');
  }

  if (failure.state) {
    console.error(`  state: ${JSON.stringify(failure.state)}`);
  }

  console.error('  collected page errors:');
  printLines(observed.pageErrors);
  console.error('  collected console errors:');
  printLines(
    observed.consoleErrors.map((entry) =>
      `[console.error] ${entry.text}${entry.url ? ` (${entry.url})` : ''}`,
    ),
  );
  console.error('  collected CSP console messages:');
  printLines(
    observed.cspConsole.map((entry) =>
      `[console.${entry.type}] ${entry.text}${entry.url ? ` (${entry.url})` : ''}`,
    ),
  );

  const unexpectedRequests = observed.failedRequests.filter((entry) => !isAllowedFailedRequest(entry));
  const toleratedRequests = observed.failedRequests.length - unexpectedRequests.length;
  console.error('  collected unexpected request failures:');
  printLines(unexpectedRequests.map((entry) => `${entry.url} :: ${entry.errorText}`));
  if (toleratedRequests > 0) {
    console.error(`  (${toleratedRequests} live-source network failure(s) tolerated)`);
  }
}

// ---------------------------------------------------------------------------
// Playwright
// ---------------------------------------------------------------------------

async function checkViewport(browser, viewport, expectedHeaders) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });

  const observed = {
    pageErrors: [],
    consoleErrors: [],
    cspConsole: [],
    cspEvents: [],
    failedRequests: [],
  };

  try {
    // Runs before any page script, so violations during initial parsing are seen.
    await page.addInitScript(() => {
      window.__visualCheckCsp = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__visualCheckCsp.push({
          blockedURI: event.blockedURI,
          violatedDirective: event.violatedDirective,
          effectiveDirective: event.effectiveDirective,
          sourceFile: event.sourceFile,
          lineNumber: event.lineNumber,
          disposition: event.disposition,
        });
      });
    });

    page.on('console', (message) => {
      const text = message.text();
      const url = message.location()?.url ?? '';
      if (/content security policy/i.test(text)) {
        observed.cspConsole.push({ type: message.type(), text, url });
        return;
      }
      if (message.type() !== 'error') return;
      observed.consoleErrors.push({ text, url });
    });
    page.on('pageerror', (error) => {
      observed.pageErrors.push(error.stack || error.message || String(error));
    });
    page.on('requestfailed', (request) => {
      observed.failedRequests.push({
        url: request.url(),
        errorText: request.failure()?.errorText ?? 'unknown failure',
      });
    });

    let documentResponse = null;
    try {
      documentResponse = await page.goto(`${ORIGIN}/`, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
    } catch (error) {
      throw new GateFailure(
        viewport,
        [{ assertion: 'navigation', detail: error instanceof Error ? error.message : String(error), entries: [] }],
        observed,
      );
    }

    // The first screen is now the empty state (D26), and it is the screen most
    // visitors ever see — so it is asserted before a route is imported, which no
    // other gate does.
    // It appears once boot finishes (the app decides there is no route to open),
    // so wait for it rather than sampling one frame after DOMContentLoaded.
    await page
      .waitForFunction(
        () => {
          const empty = document.querySelector('#empty-state');
          return !!empty && !empty.hidden;
        },
        { timeout: 15_000 },
      )
      .catch(() => {});
    const firstScreen = await page.evaluate(() => {
      const empty = document.querySelector('#empty-state');
      const cta = document.querySelector('#btn-empty-new');
      const ctaBox = cta?.getBoundingClientRect();
      return {
        emptyShown: !!empty && !empty.hidden,
        cta: cta?.textContent?.trim() ?? null,
        ctaVisible: !!ctaBox && ctaBox.width > 0 && ctaBox.height > 0,
      };
    });
    if (!firstScreen.emptyShown || !firstScreen.ctaVisible || !firstScreen.cta) {
      throw new GateFailure(
        viewport,
        [
          {
            assertion: 'empty state',
            detail: `first screen: empty=${firstScreen.emptyShown} cta="${firstScreen.cta ?? ''}" visible=${firstScreen.ctaVisible}`,
            entries: [],
          },
        ],
        observed,
      );
    }

    // Then import a route: the stats panel is only meaningful with one, and this
    // exercises the import path a real visitor takes, under the real CSP.
    await page.setInputFiles('#file-input', ROUTE_FIXTURE);

    let state = await waitForReady(page);
    // Give late errors (tile aborts, async failures) a moment to surface.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, SETTLE_MS));
    state = await readState(page);
    observed.cspEvents = await page.evaluate(() => window.__visualCheckCsp ?? []);

    const failures = verifyViewport({
      viewport,
      documentResponse,
      state,
      observed,
      expectedHeaders,
    });
    if (failures.length > 0) {
      const failure = new GateFailure(viewport, failures, observed);
      failure.state = state;
      throw failure;
    }

    const screenshot = join(OUT_DIR, `${viewport.name}.png`);
    await page.screenshot({ path: screenshot });
    return {
      viewport,
      screenshot,
      state,
      allowedTileFailures: observed.failedRequests.filter(isAllowedFailedRequest).length,
    };
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    throw new GateFailure(
      viewport,
      [
        {
          assertion: 'visual check completed',
          detail: error instanceof Error ? error.stack || error.message : String(error),
        },
      ],
      observed,
    );
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Serve the build from a real temp directory under workerd (shared helper). */
async function startWorkerd() {
  try {
    const runtime = await startRuntime({ port: RUNTIME_PORT, label: 'visual' });
    ORIGIN = runtime.origin;
    return runtime;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  if (!existsSync(HEADERS_FILE)) {
    fail(`public/_headers is missing — cannot exercise the production CSP`);
  }
  if (!existsSync(INDEX_HTML)) {
    fail('dist/index.html is missing — run `npm run build` first');
  }

  let rules;
  try {
    rules = parseHeaderRules(readFileSync(HEADERS_FILE, 'utf8'));
  } catch (error) {
    fail(`could not parse public/_headers: ${error instanceof Error ? error.message : String(error)}`);
  }

  const expectedRootHeaders = resolveHeaders(rules, '/');
  const missing = REQUIRED_HEADERS.filter((name) => !expectedRootHeaders.has(name));
  if (missing.length > 0) {
    fail(`public/_headers defines no ${missing.join(', ')} for /`);
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    fail('Playwright is not installed — run `npm i -D playwright && npx playwright install chromium`');
  }

  mkdirSync(OUT_DIR, { recursive: true });

  let stopServer;
  if (RUNTIME) {
    const runtime = await startWorkerd();
    stopServer = runtime.stop;
    process.stdout.write(`visual-check: runtime ${runtime.origin} (wrangler dev)\n`);
  } else {
  const server = createStaticServer(rules);
  try {
    await listen(server);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    fail(
      code === 'EADDRINUSE'
        ? `port ${PORT} is already in use — stop the process using it (the gate starts its own server)`
        : `could not start the static server on ${HOST}:${PORT}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  stopServer = () => closeServer(server);
  }

  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
  if (proxy) args.push(`--proxy-server=${proxy}`);

  let browser;
  try {
    browser = await chromium.launch({ args });
  } catch (error) {
    await stopServer?.();
    fail(`could not launch Chromium: ${error instanceof Error ? error.message : String(error)}`);
  }

  const results = [];
  let failure = null;
  try {
    for (const viewport of VIEWPORTS) {
      try {
        results.push(await checkViewport(browser, viewport, expectedRootHeaders));
      } catch (error) {
        if (error instanceof GateFailure) {
          failure = error;
          break;
        }
        throw error;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await stopServer?.();
  }

  if (failure !== null) {
    printFailure(failure);
    console.error(
      `visual-check: ${results.length}/${VIEWPORTS.length} viewports passed` +
        (results.length > 0
          ? ` (${results.map((result) => `${result.viewport.name} ${result.viewport.width}x${result.viewport.height}`).join(', ')})`
          : ''),
    );
    process.exit(1);
  }

  const summary = results
    .map(
      (result) =>
        `${result.viewport.width}x${result.viewport.height} ${result.viewport.name}: ` +
        `title ✓, map ${Math.round(result.state.map.width)}x${Math.round(result.state.map.height)} ✓, ` +
        `stats ✓ (${result.state.renderedStats.length}), 0 page errors, 0 CSP violations, ` +
        `0 console errors` +
        (result.allowedTileFailures > 0
          ? ` (${result.allowedTileFailures} live-source network failure(s) tolerated)`
          : ''),
    )
    .join('; ');

  console.log(
    `visual-check: OK — ${summary}; screenshots: ${results.map((result) => result.screenshot).join(', ')}`,
  );
  process.exit(0);
}

await main();
