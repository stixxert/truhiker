/**
 * The headers production actually serves.
 *
 * `visual-check` asserts the security headers on `/` only, and `test/hosting.test.ts`
 * reads the *source text* of `public/_headers`. Neither can see the two rules that
 * bit this project:
 *
 *   1. a block with several pattern lines applies its headers only to the **last**
 *      one — so `/*.js`, `/*.mjs`, `/*.css` in one block served JS with
 *      `max-age=0, must-revalidate` while CSS kept `immutable`;
 *   2. the static-server fallback in `visual-check` *merges* matching rules and so
 *      reported the opposite of production for exactly that case.
 *
 * This gate requests one real path of each kind from workerd and asserts the
 * Cache-Control it gets back. It is the only check that can fail when the cache
 * policy regresses.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startRuntime } from './runtime.mjs';

const PORT = 4199;
const DIST = 'dist';

const problems = [];
const rows = [];

function pick(pattern) {
  const match = readdirSync(DIST).find((name) => pattern.test(name));
  if (!match) throw new Error(`no ${pattern} asset in ${DIST} — run \`npm run build\` first`);
  return match;
}

function expectCache(path, status, cachePattern, required) {
  return fetch(`${origin}${path}`).then((response) => {
    const cache = response.headers.get('cache-control') ?? '';
    const csp = response.headers.get('content-security-policy') ?? '';
    rows.push({ path, status: response.status, cache: cache || '(none)' });
    if (response.status !== status) problems.push(`${path}: HTTP ${response.status}, expected ${status}`);
    if (cachePattern && !cachePattern.test(cache)) {
      problems.push(`${path}: Cache-Control "${cache}" does not match ${cachePattern}`);
    }
    if (required && !csp.includes("default-src 'self'")) {
      problems.push(`${path}: the security headers are missing (no CSP)`);
    }
    return response;
  });
}

let origin = '';
let runtime = null;
try {
  runtime = await startRuntime({ port: PORT, label: 'served-headers' });
  origin = runtime.origin;

  const immutable = /max-age=31536000/;
  const revalidate = /max-age=0/;
  const hourly = /max-age=3600/;

  // Hashed build output must be immutable in production — this is the case that
  // was silently broken, so all three kinds are checked, not just CSS.
  await expectCache(`/${pick(/^index-.*\.js$/)}`, 200, immutable, true);
  await expectCache(`/${pick(/^maplibre-gl-worker-.*\.mjs$/)}`, 200, immutable, true);
  await expectCache(`/${pick(/^index-.*\.css$/)}`, 200, immutable, true);

  // Data changes with the extract, not with the deployment.
  await expectCache('/data/shops.osm.bin', 200, hourly, false);
  await expectCache('/data/ODbL-1.0.txt', 200, hourly, false);

  // The document itself must be revalidated, never immutable.
  await expectCache('/', 200, revalidate, true);

  // An unknown path is a 404, not the app shell pretending to be one.
  const missing = await fetch(`${origin}/this-path-does-not-exist`);
  rows.push({ path: '/this-path-does-not-exist', status: missing.status, cache: '-' });
  if (missing.status !== 404) problems.push(`unknown path: HTTP ${missing.status}, expected 404`);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
} finally {
  runtime?.stop();
}

for (const row of rows) console.log(`  ${String(row.status).padEnd(4)} ${row.path.padEnd(44)} ${row.cache}`);
if (problems.length > 0) {
  console.error(`\nserved-headers: FAIL — ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`\nserved-headers: OK — ${rows.length} path(s), cache policy as intended`);
