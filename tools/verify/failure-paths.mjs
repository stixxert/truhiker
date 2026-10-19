#!/usr/bin/env node
/**
 * Failure-path gate (D7). Blocks every live source and checks that the app says
 * something specific and stays alive: no page errors, the elevation-derived
 * numbers are disabled rather than zeroed, and the weather panel states that the
 * forecast is unavailable.
 *
 *   npm run failure-paths
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ORIGIN = 'http://127.0.0.1:4196';
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

if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('dist/index.html is missing — run `npm run build` first');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  fail('Playwright is not installed');
}

const server = spawn(process.execPath, ['-e', `
  const {createServer}=require('node:http');const{createReadStream,existsSync,statSync}=require('node:fs');
  const{join,extname}=require('node:path');const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.gpx':'application/gpx+xml','.bin':'application/octet-stream','.txt':'text/plain'};
  createServer((q,s)=>{const u=new URL(q.url,'http://x').pathname;let f=join('${ROOT}/dist',u==='/'?'index.html':u);if(!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404);return s.end('x');}s.writeHead(200,{'content-type':T[extname(f)]??'application/octet-stream'});createReadStream(f).pipe(s);}).listen(4196,'127.0.0.1');
`], { stdio: 'ignore' });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 150));
}

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
if (proxy) args.push(`--proxy-server=${proxy}`);
const browser = await chromium.launch({ args });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/*', (route) => {
  const host = new URL(route.request().url()).hostname;
  if (BLOCKED.includes(host)) return route.abort('failed');
  return route.continue();
});

const problems = [];
await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
if (!/Høydedata utilgjengelig/i.test(body)) {
  problems.push('the elevation-degraded state was not shown (expected "Høydedata utilgjengelig")');
}
const stats = await page.locator('.stat-value').allInnerTexts();
if (stats.some((value) => /^\s*0\s*(m|km)?\s*$/.test(value))) {
  problems.push(`a derived statistic rendered a zero instead of being disabled: ${stats.join(' | ')}`);
}

// Give the trip a start date and a daily distance so the app actually attempts a
// forecast; otherwise the panel legitimately asks for a start date instead.
const today = new Date().toISOString().slice(0, 10);
await page.click('#btn-settings').catch(() => problems.push('the settings dialog could not be opened'));
await page.waitForSelector('#settings-dialog[open]', { timeout: 5000 }).catch(() => {});
await page.fill('#settings-start-date', today).catch(() => {});
await page.fill('#settings-daily-km', '20').catch(() => {});
await page.click('#settings-submit').catch(() => {});
await page.waitForTimeout(800);

await page.click('#btn-weather').catch(() => problems.push('the weather panel could not be opened'));
await page.waitForTimeout(4000);
const weather = (await page.locator('#weather-panel').innerText().catch(() => '')).replace(/\s+/g, ' ');
if (!/ikke tilgjengelig|utilgjengelig|kunne ikke/i.test(weather)) {
  problems.push('the weather panel did not state that the forecast is unavailable');
}

if (pageErrors.length > 0) problems.push(`page errors: ${pageErrors.join(' | ')}`);

await browser.close();
server.kill('SIGKILL');

if (problems.length > 0) fail(`${problems.length} problem(s)`, problems.map((p) => '  - ' + p).join('\n'));
console.log('failure-paths: OK — degraded states shown, no page errors');
process.exit(0);
