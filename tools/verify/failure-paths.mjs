#!/usr/bin/env node
/**
 * Failure-path gate (D7). Blocks every live source — Kartverket's basemap and
 * DEM, Geonorge's WMS fallback, Mapterhorn and MET — and checks that the app
 * degrades *specifically* and stays alive:
 *
 *   - elevation: "Høydedata utilgjengelig", and no derived number rendered as 0;
 *   - basemap: the WMS fallback is announced, or the tiles are reported missing;
 *   - terrain: 3D is reported unavailable, not silently flat;
 *   - weather: the panel says the forecast is unavailable;
 *   - zero page errors and zero unhandled promise rejections.
 *
 *   npm run failure-paths
 *
 * Served through `wrangler dev` (workerd, production CSP): a failure path that
 * only works under a stand-in server is not a failure path that ships.
 */
import { startRuntime } from './runtime.mjs';

const PORT = 4196;
const BLOCKED = [
  'cache.kartverket.no',
  'wms.geonorge.no',
  'wfs.geonorge.no',
  'hoydedata.no',
  'tiles.mapterhorn.com',
  'api.met.no',
];

function fail(message, detail) {
  console.error(`failure-paths: FAIL — ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/**
 * Vertical trail strips, 444 m apart, each internally connected and separate
 * from its neighbours (the merge tolerance is 5 m). Any click is within the
 * 250 m snap radius of one strip, and two clicks 100+ px apart land on
 * different strips — so the router must answer "no path", never bridge them.
 */
function splitGridXml() {
  const lines = [];
  for (let lon = 8.1; lon <= 8.95 + 1e-9; lon += 0.008) {
    const points = [];
    for (let lat = 61.35; lat <= 61.65 + 1e-9; lat += 0.003) points.push(lon, lat);
    lines.push(points);
  }
  const members = lines
    .map((points, index) => {
      const posList = [];
      for (let i = 0; i < points.length; i += 2) posList.push(points[i + 1], points[i]);
      return `<wfs:member><app:Fotrute gml:id="fotrute.${index}"><app:senterlinje><gml:LineString gml:id="f${index}" srsName="urn:ogc:def:crs:EPSG::4258"><gml:posList>${posList.join(' ')}</gml:posList></gml:LineString></app:senterlinje><app:fotruteInfo><app:FotruteInfo><app:rutenavn>Test</app:rutenavn><app:rutenummer>t${index}</app:rutenummer></app:FotruteInfo></app:fotruteInfo></app:Fotrute></wfs:member>`;
    })
    .join('');
  return `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:app="http://skjema.geonorge.no/SOSI/produktspesifikasjon/TurOgFriluftsruter/20171210" xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="${lines.length}" numberReturned="${lines.length}">${members}</wfs:FeatureCollection>`;
}

const SPLIT_GRID = splitGridXml();

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  fail('Playwright is not installed');
}

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
if (proxy) args.push(`--proxy-server=${proxy}`);

const problems = [];
let runtime;
let browser;

try {
  runtime = await startRuntime({ port: PORT, label: 'failure' });
  browser = await chromium.launch({ args });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // `pageerror` covers uncaught exceptions, not rejected promises; collect both.
  await page.addInitScript(() => {
    window.__unhandledRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__unhandledRejections.push(String(event.reason));
    });
  });

  await page.route('**/*', (route) => {
    let hostname = '';
    try {
      hostname = new URL(route.request().url()).hostname;
    } catch {
      return route.continue();
    }
    if (BLOCKED.includes(hostname)) return route.abort('failed');
    return route.continue();
  });

  await page.goto(`${runtime.origin}/`, { waitUntil: 'domcontentloaded' });

  /** Wait for a banner/panel string, returning the whole body text for the log. */
  const body = async () =>
    (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const expectText = async (pattern, what, timeout = 20_000) => {
    const found = await page
      .waitForFunction((source) => new RegExp(source, 'i').test(document.body.innerText), pattern.source, {
        timeout,
      })
      .then(() => true)
      .catch(() => false);
    if (!found) problems.push(`${what} was not shown (no /${pattern.source}/i on the page)`);
    return found;
  };

  // 1. Elevation (DEM) — the route's derived numbers must be disabled, not zeroed.
  await expectText(/Høydedata utilgjengelig/i, 'the DEM-degraded state');
  const stats = await page.locator('.stat-value').allInnerTexts();
  if (stats.some((value) => /^\s*0\s*(m|km)?\s*$/.test(value))) {
    problems.push(`a derived statistic rendered a zero instead of being disabled: ${stats.join(' | ')}`);
  }

  // 2. Basemap — Kartverket's cache fails, then the Geonorge WMS fallback fails.
  const basemapShown =
    (await expectText(/Kartflisene fra Kartverkets hurtigbuffer svarte ikke/i, 'the basemap fallback banner')) ||
    (await expectText(/Kartflisene er utilgjengelige/i, 'the basemap-failed banner'));
  if (!basemapShown) {
    const text = await body();
    problems.push(`basemap degradation not stated; page said: ${text.slice(0, 300)}`);
  }

  // 3. Terrain — Mapterhorn's TileJSON is unreachable; the app must say so.
  await expectText(/3D-terreng er utilgjengelig|Terrengdata fra Mapterhorn kunne ikke hentes/i, 'the terrain-degraded state');

  // 4. Weather — give the trip a start date and a daily distance so the app
  //    actually attempts a forecast; otherwise it legitimately asks for one.
  const today = new Date().toISOString().slice(0, 10);
  await page.click('#btn-settings').catch(() => problems.push('the settings dialog could not be opened'));
  await page.waitForSelector('#settings-dialog[open]', { timeout: 5000 }).catch(() => {});
  await page.fill('#settings-start-date', today).catch(() => {});
  await page.fill('#settings-daily-km', '20').catch(() => {});
  await page.click('#settings-submit').catch(() => {});
  await page.waitForTimeout(800);

  await page.click('#btn-weather').catch(() => problems.push('the weather panel could not be opened'));
  // Scope this to the panel: "utilgjengelig" elsewhere on the page (a banner for
  // another source) must not make a silent weather failure look handled.
  const weatherShown = await page
    .waitForFunction(
      () => {
        const panel = document.querySelector('#weather-panel');
        if (!panel || panel.hasAttribute('hidden')) return false;
        return /Værvarselet er ikke tilgjengelig/i.test(panel.textContent ?? '');
      },
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!weatherShown) {
    const weather = (await page.locator('#weather-panel').innerText().catch(() => '')).replace(/\s+/g, ' ');
    problems.push(`weather failed silently; panel said: ${weather.slice(0, 300) || '(empty)'}`);
  }

  // 5. Routing with the trail service blocked must fail visibly, not silently.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.click('[data-mode="edit"]');
  await page.waitForTimeout(400);
  await page.click('#btn-route');
  await page.waitForTimeout(300);
  const canvas = await page.locator('.maplibregl-canvas').boundingBox();
  if (!canvas) problems.push('the map canvas has no box for routing');
  else {
    await page.mouse.click(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.5);
    await page.waitForTimeout(300);
    await page.mouse.click(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.5);
    const routed = await page
      .waitForFunction(
        () => /Stinettet er utilgjengelig|utilgjengelig/i.test(document.querySelector('#toast')?.textContent ?? ''),
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!routed) {
      problems.push(`blocked trail service did not produce a routing error (toast: ${await page.locator('#toast').innerText()})`);
    }
    await page.keyboard.press('Escape');
  }

  // 6. A box larger than the routing limit is refused before any request.
  await page.mouse.move((canvas?.x ?? 0) + (canvas?.width ?? 1440) / 2, (canvas?.y ?? 0) + (canvas?.height ?? 900) / 2);
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(250);
  }
  await page.click('#btn-route');
  await page.waitForTimeout(300);
  if (canvas) {
    await page.mouse.click(canvas.x + canvas.width * 0.25, canvas.y + canvas.height * 0.55);
    await page.waitForTimeout(300);
    await page.mouse.click(canvas.x + canvas.width * 0.75, canvas.y + canvas.height * 0.55);
    const tooLarge = await page
      .waitForFunction(
        () => /Området er for stort|too large/i.test(document.querySelector('#toast')?.textContent ?? ''),
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!tooLarge) {
      problems.push(`an oversized route box was not refused (toast: ${await page.locator('#toast').innerText()})`);
    }
  }

  // 7. A disconnected network gives "no path", not a straight line.
  const disconnected = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const other = await disconnected.newPage();
  const otherErrors = [];
  other.on('pageerror', (error) => otherErrors.push(error.message));
  await other.addInitScript(() => {
    window.__unhandledRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__unhandledRejections.push(String(event.reason));
    });
  });
  await other.route('**/wfs.geonorge.no/**', (route) => {
    const url = route.request().url();
    if (url.includes('resultType=hits')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/gml+xml',
        body: '<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="200" numberReturned="0"></wfs:FeatureCollection>',
      });
    }
    if (url.includes('RuteInfoPunkt')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/gml+xml',
        body: '<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="0" numberReturned="0"></wfs:FeatureCollection>',
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/gml+xml', body: SPLIT_GRID });
  });
  await other.goto(`${runtime.origin}/`, { waitUntil: 'domcontentloaded' });
  await other.waitForFunction(
    () => [...document.querySelectorAll('.stat-value')].some((el) => /\d/.test(el.textContent ?? '')),
    undefined,
    { timeout: 30_000 },
  );
  await other.waitForTimeout(1000);
  await other.click('[data-mode="edit"]');
  await other.waitForTimeout(400);
  await other.click('#btn-route');
  await other.waitForTimeout(300);
  const otherCanvas = await other.locator('.maplibregl-canvas').boundingBox();
  if (otherCanvas) {
    await other.mouse.click(otherCanvas.x + otherCanvas.width * 0.45, otherCanvas.y + otherCanvas.height * 0.5);
    await other.waitForTimeout(300);
    await other.mouse.click(otherCanvas.x + otherCanvas.width * 0.55, otherCanvas.y + otherCanvas.height * 0.5);
    const noPath = await other
      .waitForFunction(
        () => /henger ikke sammen|does not connect/i.test(document.querySelector('#toast')?.textContent ?? ''),
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!noPath) {
      problems.push(`a disconnected network did not say "no path" (toast: ${await other.locator('#toast').innerText()})`);
    }
  }
  const otherUnhandled = await other.evaluate(() => window.__unhandledRejections ?? []);
  if (otherErrors.length > 0) problems.push(`disconnected-routing page errors: ${otherErrors.join(' | ')}`);
  if (otherUnhandled.length > 0) problems.push(`disconnected-routing unhandled rejections: ${otherUnhandled.join(' | ')}`);
  await disconnected.close();

  // 8. Nothing may escape as an uncaught error or an unhandled rejection.
  const unhandled = await page.evaluate(() => window.__unhandledRejections ?? []);
  if (pageErrors.length > 0) problems.push(`page errors: ${pageErrors.join(' | ')}`);
  if (unhandled.length > 0) problems.push(`unhandled rejections: ${unhandled.join(' | ')}`);
} finally {
  await browser?.close().catch(() => {});
  runtime?.stop();
}

if (problems.length > 0) fail(`${problems.length} problem(s)`, problems.map((problem) => `  - ${problem}`).join('\n'));
console.log('failure-paths: OK — DEM, basemap, terrain, weather and routing degrade visibly, no page errors or unhandled rejections');
process.exit(0);
