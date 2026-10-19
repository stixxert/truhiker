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
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const PORT = 4193;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function fail(message, detail) {
  console.error(`e2e: FAIL — ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) fail('dist/index.html is missing — run `npm run build` first');
if (!existsSync(WRANGLER)) fail('wrangler is not installed — run `npm install`');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  fail('Playwright is not installed');
}

// --- runtime -----------------------------------------------------------------
const directory = mkdtempSync(join(tmpdir(), 'truhiker-e2e-'));
cpSync(DIST, join(directory, 'dist'), { recursive: true });
for (const file of ['wrangler.jsonc', 'package.json']) cpSync(join(ROOT, file), join(directory, file));

const server = spawn(WRANGLER, ['dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
  cwd: directory,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout?.on('data', (c) => { serverOutput += c.toString(); });
server.stderr?.on('data', (c) => { serverOutput += c.toString(); });

function stop() {
  server.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
}

const started = Date.now();
for (;;) {
  if (server.exitCode !== null) {
    rmSync(directory, { recursive: true, force: true });
    fail(`wrangler dev exited with ${server.exitCode}`, serverOutput.slice(-1500));
  }
  try {
    const response = await fetch(`${ORIGIN}/`, { redirect: 'manual' });
    if (response.ok) break;
  } catch {
    /* not listening yet */
  }
  if (Date.now() - started > 40_000) {
    stop();
    fail('wrangler dev did not answer within 40 s', serverOutput.slice(-1500));
  }
  await new Promise((done) => setTimeout(done, 250));
}

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

const panelText = async (selector) => (await page.locator(selector).innerText()).replace(/\s+/g, ' ').trim();

await step('load the demo route', async () => {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('.route-name')?.textContent?.includes('Memurubu'),
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
    { timeout: 30_000 },
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
    { timeout: 15_000 },
  );
  const text = await panelText('#trips-dialog');
  return text.split('\n')[0].slice(0, 60);
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
