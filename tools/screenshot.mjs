#!/usr/bin/env node
/**
 * Take the README screenshot from the *built* app, under the real CSP.
 *
 * The shot has to be reproducible: the same fixture, the same viewport, the same
 * panels, and the same language — the README is in English, so the picture of the
 * app must be in English too. Everything here is asserted rather than hoped for,
 * so a layout regression fails the command instead of shipping a stale picture.
 *
 *   node tools/screenshot.mjs                     # writes docs/screenshots/truhiker.jpg
 *   node tools/screenshot.mjs --lang no --out /tmp/no.jpg
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startRuntime } from './verify/runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const lang = arg('lang', 'en');
const out = resolve(root, arg('out', 'docs/screenshots/truhiker.jpg'));
const fixture = resolve(root, arg('fixture', 'test/fixtures/memurubu-glitterheim-jot21.gpx'));

/** Words the shot must show, per language, so a wrong locale cannot slip through. */
const EXPECTED = {
  en: ['Route', 'Resupply', 'Elevation profile', 'Distance', 'Ascent'],
  no: ['Rute', 'Forsyning', 'Høydeprofil', 'Distanse', 'Stigning'],
};

const runtime = await startRuntime({ port: 4377, label: 'screenshot' });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: lang === 'en' ? 'en-GB' : 'nb-NO',
  });
  const failures = [];
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));

  // `?lang=` is the app's documented override; storage is empty in a fresh context.
  await page.goto(`${runtime.origin}/?lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.setInputFiles('#file-input', fixture);

  // The route is on the map once its name and the profile's figures are filled in.
  await page.waitForFunction(
    () => (document.querySelector('.route-name')?.textContent ?? '').trim().length > 0,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => /[0-9]/.test(document.getElementById('profile-readout')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

  // Supply panel: the shot's reason to exist is that the planner shows what the
  // next stretch has — and does not have.
  await page.click('#btn-supply');
  // Wait for the panel's content, not a spinner: the resupply list and the totals.
  await page.waitForFunction(
    () => (document.getElementById('supply-section-resupply')?.textContent ?? '').trim().length > 600,
    undefined,
    { timeout: 60_000 },
  );

  // Profile open (it is the default) and the chart drawn.
  const expanded = await page.getAttribute('#profile-toggle', 'aria-expanded');
  if (expanded !== 'true') await page.click('#profile-toggle');
  await page.waitForSelector('#profile-chart canvas, #profile-chart svg', { timeout: 20_000 });

  // Tiles: the basemap is live, so wait for the labels to settle rather than for a
  // fixed delay — an empty background would make the shot worthless.
  await page.waitForFunction(
    () => {
      const scale = document.querySelector('.maplibregl-ctrl-scale')?.textContent ?? '';
      return /[0-9]/.test(scale);
    },
    undefined,
    { timeout: 30_000 },
  );
  // MapLibre paints into a canvas, so count the tiles and terrain requests that
  // actually landed instead of looking for DOM nodes that never exist.
  let tiles = 0;
  for (let attempt = 0; attempt < 60 && tiles < 12; attempt += 1) {
    await page.waitForTimeout(500);
    tiles = await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => /kartverket|mapterhorn/.test(entry.name)).length,
    );
  }
  if (tiles < 12) failures.push(`the basemap never arrived (${tiles} tile requests)`);
  // A beat for the last frame (labels, hillshade, the profile's hover line).
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => document.body.innerText);
  const missing = EXPECTED[lang].filter((word) => !text.includes(word));
  if (missing.length > 0) failures.push(`the page is not in ${lang}: missing ${missing.join(', ')}`);
  if (failures.length > 0) {
    console.error(`screenshot: FAIL\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 88 });
    await writeFile(out, jpeg);
    console.log(`screenshot: OK — ${out} (${lang}, 1440x900 @2x, ${Math.round(jpeg.length / 1024)} KB)`);
  }
} finally {
  await browser.close();
  runtime.stop();
}
