#!/usr/bin/env node
/**
 * End-to-end gate: drive the built app through the journey a user actually takes,
 * against the real workerd runtime, and fail loudly at the first step that does
 * not work.
 *
 *   npm run e2e
 *
 * Steps: load → resupply → energy → weather → save → reload → the trip is still
 * there. Each step asserts on rendered text, not on internal state, so a broken
 * handler, a missing translation or a silent fetch failure all fail the gate.
 *
 * The Turrutebasen WFS is stubbed: huts from `test/fixtures/huts-wfs.xml`, and a
 * synthetic but topologically connected trail grid for routing. A live source
 * must not decide whether the journey passes. Failure paths are covered by
 * `npm run failure-paths`, and the parsers by unit tests.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './runtime.mjs';
import { stubDem } from './dem-stub.mjs';

const PORT = 4193;

function fail(message, detail) {
  console.error(`e2e: FAIL — ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  fail('Playwright is not installed');
}

// --- runtime -----------------------------------------------------------------
let runtime;
try {
  runtime = await startRuntime({ port: PORT, label: 'e2e' });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const ORIGIN = runtime.origin;
const stop = runtime.stop;

// --- browser -----------------------------------------------------------------
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
if (proxy) args.push(`--proxy-server=${proxy}`);
const browser = await chromium.launch({ args });

const pageErrors = [];
const steps = [];

async function step(name, run) {
  try {
    const detail = await run(page);
    steps.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    steps.push({ name, ok: false });
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    await browser.close().catch(() => {});
    stop();
    fail(`step "${name}" failed`, pageErrors.join('\n'));
  }
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => pageErrors.push(`[pageerror] ${error.message}`));
// Elevation comes from a synthetic DEM: hoydedata.no is a live service, and a
// live service must not be able to decide this gate (it has answered 503 for
// hours, which silently empties the profile and the energy panel).
await stubDem(page);

// Deterministic WFS: one hut on the imported route, plus a connected trail grid
// that covers the map. Grid lines are sampled at every crossing, so they share
// vertices and the router can actually traverse them.
const hutsFixture = readFileSync(new URL('../../test/fixtures/huts-wfs.xml', import.meta.url), 'utf8');
/** The route the journey imports: real Turrutebasen geometry (CC BY 4.0), also a
 *  test fixture now that the app ships no sample (D26). */
const FIXTURE_ROUTE = fileURLToPath(new URL('../../test/fixtures/memurubu-glitterheim-jot21.gpx', import.meta.url));
const HITS = `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="400" numberReturned="0"></wfs:FeatureCollection>`;

function trailGridXml() {
  const step = 0.003;
  const lines = [];
  for (let lon = 8.2; lon <= 9.1 + 1e-9; lon += step) {
    const points = [];
    for (let lat = 61.35; lat <= 61.65 + 1e-9; lat += step) points.push(lon, lat);
    lines.push(points);
  }
  for (let lat = 61.35; lat <= 61.65 + 1e-9; lat += step) {
    const points = [];
    for (let lon = 8.2; lon <= 9.1 + 1e-9; lon += step) points.push(lon, lat);
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

const TRAILS = trailGridXml();

await page.route('**/wfs.geonorge.no/**', (route) => {
  const url = route.request().url();
  if (url.includes('resultType=hits')) {
    return route.fulfill({ status: 200, contentType: 'application/gml+xml', body: HITS });
  }
  if (url.includes('RuteInfoPunkt')) {
    return route.fulfill({ status: 200, contentType: 'application/gml+xml', body: hutsFixture });
  }
  return route.fulfill({ status: 200, contentType: 'application/gml+xml', body: TRAILS });
});

const panelText = async (selector) => (await page.locator(selector).innerText()).replace(/\s+/g, ' ').trim();

await step('import a route', async () => {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  // No bundled sample route any more (D26): the journey starts the way a user
  // does — import a file, through the same input the menu uses.
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.setInputFiles('#file-input', FIXTURE_ROUTE);
  await page.waitForFunction(
    () => document.querySelector('.route-name')?.textContent?.includes('Memurubu'),
    undefined,
    { timeout: 20_000 },
  );
  const stats = await page.locator('.stat-value').allInnerTexts();
  if (!stats.some((value) => /\d/.test(value))) throw new Error('no stat rendered a number');
  return `${stats.filter((v) => /\d/.test(v)).length} stats with values`;
});

await step('resupply panel lists points along the route', async () => {
  await page.click('#btn-supply');
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('#supply-panel');
      return panel && !panel.hasAttribute('hidden') && /til neste brukbare punkt|neste brukbare/i.test(panel.textContent ?? '');
    },
    // The bundled shops render as soon as the index is parsed; the live hut query
    // has its own 30 s ceiling, and the panel waits for both. Under a blocked or
    // slow Turrutebasen the shops arrive when that ceiling fires, so the step
    // must outlast it.
    undefined,
    { timeout: 45_000 },
  );
  const text = await panelText('#supply-panel');
  const rows = (text.match(/til neste brukbare punkt/g) ?? []).length;
  if (rows > 0) return `${rows} row(s) with a gap-to-next`;
  // A route with a single point still shows the point; accept that but say so.
  if (/Forsyning/i.test(text)) return 'panel ready (no gap rows on this route)';
  throw new Error('resupply panel did not render rows');
});

await step('energy panel reports a range', async () => {
  await page.getByRole('tab', { name: /Energi/i }).click();
  await page.waitForFunction(
    () => /kcal\/dag/.test(document.querySelector('#supply-panel')?.textContent ?? ''),
    undefined,
    { timeout: 20_000 },
  );
  const text = await panelText('#supply-panel');
  if (!/\d[\d\s,.–-]+\d\s*kcal\/dag/.test(text)) throw new Error('no kcal range rendered');
  return text.match(/\d[\d\s,.–-]+\d\s*kcal\/dag/)?.[0] ?? 'range present';
});

await step('weather panel opens and states its horizon', async () => {
  await page.keyboard.press('Escape');
  await page.click('#btn-weather');
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('#weather-panel');
      return panel && !panel.hasAttribute('hidden') && /varsel|startdato/i.test(panel.textContent ?? '');
    },
    undefined,
    { timeout: 20_000 },
  );
  const text = await panelText('#weather-panel');
  if (!/10|horisont|startdato/i.test(text)) throw new Error('weather panel said nothing useful');
  return text.slice(0, 80);
});

await step('save the trip', async () => {
  await page.keyboard.press('Escape');
  await page.click('#btn-save');
  await page.waitForFunction(
    () => /lagret|lagrar|saving|saved/i.test(document.querySelector('#save-status, .save-status')?.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  );
  return (await panelText('#save-status, .save-status')).slice(0, 40);
});

await step('reload and find the trip', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.click('#btn-trips');
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('#trips-dialog');
      return dialog?.hasAttribute('open') && !/Ingen turer/i.test(dialog.textContent ?? '');
    },
    undefined,
    { timeout: 15_000 },
  );
  const text = await panelText('#trips-dialog');
  // Open it, so the journey continues on a loaded trip. With the bundled demo
  // this step used to be redundant — the reload brought a route back by itself
  // (D26); now the saved trip is the only way in, and opening it is the point.
  await page.click('#trips-dialog .trip-row:first-of-type button[data-action="open"]');
  await page.waitForFunction(
    () => (document.querySelector('.route-name')?.textContent ?? '').trim().length > 0,
    undefined,
    { timeout: 20_000 },
  );
  return text.split('\n')[0].slice(0, 60);
});

await step('route between two points along the trails', async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.click('[data-mode="edit"]');
  await page.waitForTimeout(400);
  const distanceBefore = await page.locator('#stat-distance').innerText();
  await page.click('#btn-route');
  await page.waitForTimeout(300);
  const canvas = await page.locator('.maplibregl-canvas').boundingBox();
  if (!canvas) throw new Error('the map canvas has no box');
  await page.mouse.click(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.5);
  await page.waitForTimeout(400);
  await page.mouse.click(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.5);
  await page.waitForFunction(() => /Rute lagt inn:/.test(document.querySelector('#toast')?.textContent ?? ''), undefined, {
    timeout: 30_000,
  });
  const toast = (await page.locator('#toast').innerText()).replace(/\s+/g, ' ');
  // The distance is recomputed and painted a frame later than the toast.
  await page.waitForFunction(
    (previous) => document.querySelector('#stat-distance')?.textContent !== previous,
    distanceBefore,
    { timeout: 10_000 },
  );
  const routed = Number.parseFloat(/Rute lagt inn: ([\d.,]+) km/.exec(toast)?.[1]?.replace(',', '.') ?? 'NaN');
  const stat = Number.parseFloat((await page.locator('#stat-distance').innerText()).replace(',', '.'));
  if (!Number.isFinite(routed) || !Number.isFinite(stat)) {
    throw new Error(`could not read the routed distance (toast "${toast}", stat "${stat}")`);
  }
  // The stat is recomputed from the committed leg, the toast from the routed
  // polyline: they must describe the same geometry, within display rounding.
  if (Math.abs(routed - stat) > 0.05) {
    throw new Error(`committed distance ${stat} km does not match the routed ${routed} km`);
  }

  // A routed leg is an ordinary undoable edit, not a rewrite.
  await page.click('#btn-undo');
  await page.waitForFunction(
    (previous) => document.querySelector('#stat-distance')?.textContent === previous,
    distanceBefore,
    { timeout: 10_000 },
  );
  await page.click('#btn-redo');
  await page.waitForFunction(
    (previous) => document.querySelector('#stat-distance')?.textContent === previous,
    `${stat} km`,
    { timeout: 10_000 },
  ).catch(async () => {
    // Formatting may already round differently; assert numerically instead.
    const redo = Number.parseFloat((await page.locator('#stat-distance').innerText()).replace(',', '.'));
    if (Math.abs(redo - routed) > 0.05) throw new Error(`redo did not restore the routed distance (${redo} km)`);
  });

  // Routing inside a leg must not relabel where the route came from.
  const tag = (await page.locator('#route-tag').innerText()).replace(/\s+/g, ' ').trim();
  if (!/file|fil/i.test(tag)) throw new Error(`route tag changed after routing: "${tag}"`);

  return `${routed.toFixed(2)} km committed, matches the distance stat, undo/redo verified`;
});

await step('drawing still adds a point', async () => {
  await page.click('[data-mode="draw"]');
  await page.waitForTimeout(500);
  const before = await page.locator('#editor-count').innerText();
  const canvas = await page.locator('.maplibregl-canvas').boundingBox();
  await page.mouse.click(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.62);
  await page.waitForFunction(
    (previous) => document.querySelector('#editor-count')?.textContent !== previous,
    before,
    { timeout: 10_000 },
  );
  return `${before} → ${await page.locator('#editor-count').innerText()}`;
});

if (pageErrors.length > 0) {
  await browser.close().catch(() => {});
  stop();
  fail('page errors occurred', pageErrors.join('\n'));
}

await browser.close();
stop();
const passed = steps.filter((s) => s.ok).length;
console.log(`e2e: OK — ${passed}/${steps.length} steps, 0 page errors`);
process.exit(0);
