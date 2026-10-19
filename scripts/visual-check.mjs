/**
 * Visual smoke test: load the app in headless Chromium, capture screenshots at
 * desktop and mobile widths, and dump the observable state plus console errors.
 *
 *   node scripts/visual-check.mjs [url] [outDir]
 *
 * Requires Playwright (`npm i -D playwright && npx playwright install chromium`).
 * It honours HTTPS_PROXY from the environment so it can run inside a network
 * sandbox that only exposes a proxy.
 */

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5199/';
const outDir = process.argv[3] ?? '/tmp/npl-shots';
mkdirSync(outDir, { recursive: true });

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
if (proxy) args.push(`--proxy-server=${proxy}`);

const browser = await chromium.launch({ args });

async function capture(name, viewport, extra) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      logs.push(`[console.${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
  page.on('requestfailed', (request) =>
    logs.push(`[requestfailed] ${request.url()} :: ${request.failure()?.errorText}`),
  );

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((error) => {
    logs.push(`[goto] ${error.message}`);
  });
  await page.waitForTimeout(12_000);
  if (extra) await extra(page);
  await page.screenshot({ path: `${outDir}/${name}.png` });

  const state = await page.evaluate(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    route: document.getElementById('route-name')?.textContent,
    tag: document.getElementById('route-tag')?.textContent,
    stats: ['stat-distance', 'stat-ascent', 'stat-descent', 'stat-time', 'stat-elevation'].map(
      (id) => document.getElementById(id)?.textContent,
    ),
    source: document.getElementById('source-label')?.textContent,
    profileStatus: document.getElementById('profile-status')?.textContent,
    overlayHidden: document.getElementById('profile-overlay')?.hidden,
    banners: [...document.querySelectorAll('.banner-text')].map((element) => element.textContent),
    terrainDisabled: document.getElementById('btn-terrain')?.disabled,
    attribution: [...document.querySelectorAll('.map-attrib > *')]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => element.textContent.trim()),
    demoBadge: (() => {
      const summary = document.getElementById('demo-summary');
      return summary && !summary.closest('details')?.hidden
        ? { text: summary.textContent.trim(), title: summary.title }
        : null;
    })(),
    canvas: (() => {
      const canvas = document.getElementById('profile-canvas');
      return canvas ? `${canvas.width}x${canvas.height}` : null;
    })(),
  }));

  console.log(`\n=== ${name} ${viewport.width}x${viewport.height} ===`);
  console.log(JSON.stringify(state, null, 2));
  if (logs.length > 0) {
    console.log('--- console/network ---');
    console.log(logs.join('\n'));
  } else {
    console.log('--- no console errors ---');
  }
  await page.close();
}

await capture('desktop', { width: 1440, height: 900 });
await capture('mobile', { width: 390, height: 844 });
await capture('english', { width: 1440, height: 900 }, async (page) => {
  await page.click('[data-lang="en"]');
  await page.waitForTimeout(800);
});

await browser.close();
