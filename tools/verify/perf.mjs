#!/usr/bin/env node
/**
 * Performance gate. Measures the built app under throttled Slow 4G and fails if
 * it gets slower than the product budget.
 *
 *   npm run perf
 *
 * Budgets: first contentful paint < 1500 ms, map interactive (a rendered canvas
 * and the empty state or a route name) < 8000 ms, JS transfer < 500 KB. The build
 * is served by the same static server the visual gate uses, so the numbers are
 * comparable between runs; the live kartverket/MET requests are throttled with
 * everything else.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ORIGIN = 'http://127.0.0.1:4194';
const BUDGET = { fcpMs: 1500, interactiveMs: 8000, transferKB: 500 };

function fail(message) {
  console.error(`perf: FAIL — ${message}`);
  process.exit(1);
}

if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('dist/index.html is missing — run `npm run build` first');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  fail('Playwright is not installed');
}

// Serve dist with a minimal static server (no headers needed for timing).
const server = spawn(process.execPath, ['-e', `
  const {createServer}=require('node:http');const{createReadStream,existsSync,statSync,readFileSync}=require('node:fs');
  const{join,extname}=require('node:path');const zlib=require('node:zlib');
  const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.gpx':'application/gpx+xml','.bin':'application/octet-stream','.txt':'text/plain'};
  const COMPRESSIBLE=new Set(['.html','.js','.mjs','.css','.json','.gpx','.txt']);
  createServer((q,s)=>{
    const u=new URL(q.url,'http://x').pathname;
    let f=join('${ROOT}/dist',u==='/'?'index.html':u);
    if(!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404);return s.end('x');}
    const type=T[extname(f)]??'application/octet-stream';
    const ext=extname(f);
    // Production is behind Cloudflare, which compresses text assets. Measuring an
    // uncompressed server would report a number no user ever sees.
    if(COMPRESSIBLE.has(ext)){
      const body=zlib.gzipSync(readFileSync(f),{level:9});
      s.writeHead(200,{'content-type':type,'content-encoding':'gzip','content-length':body.length});
      return s.end(body);
    }
    s.writeHead(200,{'content-type':type});createReadStream(f).pipe(s);
  }).listen(4194,'127.0.0.1');
`], { stdio: 'ignore' });

for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 150));
}

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
if (proxy) args.push(`--proxy-server=${proxy}`);
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
// Slow 4G: 200 kb/s down, 150 ms RTT.
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, downloadThroughput: 200_000, uploadThroughput: 60_000, latency: 150,
});

const started = Date.now();
await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
const metrics = await page.evaluate(() => {
  const navigation = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint');
  const scripts = performance.getEntriesByType('resource').filter((r) => /\.(js|mjs|css)$/.test(r.name));
  return {
    fcpMs: Math.round(paint.find((p) => p.name === 'first-contentful-paint')?.startTime ?? navigation?.domContentLoadedEventEnd ?? 0),
    domContentLoadedMs: Math.round(navigation?.domContentLoadedEventEnd ?? 0),
    transferKB: Math.round(scripts.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024),
  };
});
// "Interactive" means the map is usable, not that a route has been loaded: the app
// boots to an empty state (D26), and requiring a stat with a number made this probe
// wait for something that only appears after an import.
const interactive = await page
  .waitForFunction(
    () => {
      const canvas = document.querySelector('canvas.maplibregl-canvas');
      const emptyState = document.querySelector('#empty-state');
      const routeName = document.querySelector('.route-name')?.textContent?.trim() ?? '';
      const rendered = (emptyState !== null && !emptyState.hidden) || routeName.length > 0;
      return !!canvas && canvas.width > 0 && rendered;
    },
    { timeout: BUDGET.interactiveMs + 4000 },
  )
  .then(() => Date.now() - started)
  .catch(() => null);

await browser.close();
server.kill('SIGKILL');

const problems = [];
if (metrics.fcpMs > BUDGET.fcpMs) problems.push(`FCP ${metrics.fcpMs} ms > ${BUDGET.fcpMs} ms`);
if (interactive === null) problems.push(`map not interactive within ${BUDGET.interactiveMs} ms`);
else if (interactive > BUDGET.interactiveMs) problems.push(`interactive ${interactive} ms > ${BUDGET.interactiveMs} ms`);
if (metrics.transferKB > BUDGET.transferKB) problems.push(`JS transfer ${metrics.transferKB} KB > ${BUDGET.transferKB} KB`);

console.log(
  `perf: FCP ${metrics.fcpMs} ms · DCL ${metrics.domContentLoadedMs} ms · interactive ${interactive ?? '—'} ms · JS ${metrics.transferKB} KB (Slow 4G)`,
);
if (problems.length > 0) fail(problems.join('; '));
console.log('perf: OK');
process.exit(0);
