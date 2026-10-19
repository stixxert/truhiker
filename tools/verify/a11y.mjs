#!/usr/bin/env node
/**
 * Accessibility gate: axe-core against the built app at both breakpoints, plus a
 * keyboard-only journey. Fails on any critical or serious violation, or if the
 * keyboard path does not work.
 *
 *   npm run a11y
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ORIGIN = 'http://127.0.0.1:4195';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

function fail(message, detail) {
  console.error(`a11y: FAIL — ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('dist/index.html is missing — run `npm run build` first');

let chromium;
let AxeBuilder;
try {
  ({ chromium } = await import('playwright'));
  ({ default: AxeBuilder } = await import('@axe-core/playwright'));
} catch {
  fail('Playwright or @axe-core/playwright is not installed');
}

const server = spawn(process.execPath, ['-e', `
  const {createServer}=require('node:http');const{createReadStream,existsSync,statSync}=require('node:fs');
  const{join,extname}=require('node:path');const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.gpx':'application/gpx+xml','.bin':'application/octet-stream','.txt':'text/plain'};
  createServer((q,s)=>{const u=new URL(q.url,'http://x').pathname;let f=join('${ROOT}/dist',u==='/'?'index.html':u);if(!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404);return s.end('x');}s.writeHead(200,{'content-type':T[extname(f)]??'application/octet-stream'});createReadStream(f).pipe(s);}).listen(4195,'127.0.0.1');
`], { stdio: 'ignore' });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 150));
}

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
if (proxy) args.push(`--proxy-server=${proxy}`);
const browser = await chromium.launch({ args });

const results = [];
const problems = [];

for (const viewport of VIEWPORTS) {
  // AxeBuilder requires a context, not a bare browser.newPage().
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page
    .waitForFunction(
      () => {
        const chart = document.querySelector('#profile-chart');
        const stat = [...document.querySelectorAll('.stat-value')].some((el) => /\d/.test(el.textContent ?? ''));
        return !!chart && chart.getAttribute('aria-valuenow') !== null && stat;
      },
      { timeout: 25_000 },
    )
    .catch(() => {});

  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = scan.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  results.push({ viewport: viewport.name, violations: scan.violations.length, blocking: blocking.length });
  for (const violation of blocking) {
    const nodes = violation.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ');
    problems.push(`${viewport.name}: ${violation.impact} ${violation.id} — ${violation.help} [${nodes}]`);
  }
  await context.close();
}

// Keyboard-only journey, mobile first (where the menu is a disclosure).
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // The menu must be reachable and operable without a pointer.
  const toggle = page.locator('#topbar-more');
  await toggle.focus();
  if ((await page.evaluate(() => document.activeElement?.id)) !== 'topbar-more') {
    problems.push('keyboard: the mobile menu toggle cannot take focus');
  }
  await page.keyboard.press('Space');
  const menuOpen = await page.evaluate(() => document.querySelector('.topbar-more-body')?.getBoundingClientRect().height > 0);
  if (!menuOpen) problems.push('keyboard: Space on the menu toggle does not reveal the menu');

  await page.locator('#btn-supply').focus();
  await page.keyboard.press('Enter');
  const panelOpen = await page.waitForFunction(
    () => { const p = document.querySelector('#supply-panel'); return p && !p.hasAttribute('hidden'); },
    { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  if (!panelOpen) problems.push('keyboard: Enter on Forsyning does not open the panel');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => document.querySelector('#supply-panel')?.hasAttribute('hidden') ?? false);
  if (!closed) problems.push('keyboard: Escape does not close the panel');

  await context.close();
}

// The elevation profile is the one custom widget. It is expanded by default on
// desktop, so exercise it there rather than behind the phone's collapsed panel.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#profile-chart')?.getAttribute('aria-valuenow') !== null,
    { timeout: 25_000 },
  ).catch(() => {});
  const slider = page.locator('#profile-chart');
  await slider.focus().catch(() => {});
  const before = await slider.getAttribute('aria-valuenow').catch(() => null);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const after = await slider.getAttribute('aria-valuenow').catch(() => null);
  if (!before || before === after) problems.push('keyboard: the profile slider does not respond to ArrowRight');
  await context.close();
}

await browser.close();
server.kill('SIGKILL');

for (const row of results) console.log(`a11y: ${row.viewport}: ${row.violations} violation(s), ${row.blocking} critical/serious`);
if (problems.length > 0) fail(`${problems.length} problem(s)`, problems.map((p) => '  - ' + p).join('\n'));
console.log('a11y: OK — no critical or serious violations, keyboard journey passes');
process.exit(0);
