#!/usr/bin/env node
/**
 * Verify that the build is deployable to Cloudflare Workers Static Assets.
 *
 * Why not just run `wrangler deploy --dry-run` in place: wrangler creates a
 * `.wrangler/tmp/bundle-*` directory and then reads it back, and this sandbox's
 * overlay filesystem loses that directory between the two calls
 * (ENOENT lstat .wrangler/tmp/bundle-XXXX). The configuration is fine; the mount
 * is not. So the dry run is executed against an identical copy in a real temp
 * directory, which also proves the deploy needs nothing from the working tree
 * beyond `dist/` and `wrangler.jsonc`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const CONFIG = join(ROOT, 'wrangler.jsonc');
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');

function fail(message) {
  console.error('verify-deploy: FAIL');
  console.error('  - ' + message);
  process.exit(1);
}

if (!existsSync(DIST)) fail('dist/ is missing — run `npm run build` first');
if (!existsSync(CONFIG)) fail('wrangler.jsonc is missing');
if (!existsSync(WRANGLER)) fail('wrangler is not installed (npm install)');

const config = readFileSync(CONFIG, 'utf8');
if (/"main"\s*:/.test(config)) {
  fail('wrangler.jsonc declares a Worker `main`; this project is static-only');
}
if (!/"directory"\s*:\s*"\.\/dist"/.test(config)) fail('assets.directory is not ./dist');

// The monthly-refresh Worker has its own config, which the static dry run above
// never reads: a regression there (a binding, an inline secret, a cron that stopped
// matching the docs) would ship unverified. Validate the shape here; the Worker
// itself is exercised by no gate, which is recorded in docs/ARCHITECTURE.md.
const WORKER_CONFIG = join(ROOT, 'worker/wrangler.jsonc');
const WORKER_MAIN = join(ROOT, 'worker/cron.ts');
if (!existsSync(WORKER_CONFIG)) fail('worker/wrangler.jsonc is missing');
if (!existsSync(WORKER_MAIN)) fail('worker/cron.ts is missing');

/** Wrangler configs are JSONC; strip line and block comments before parsing. */
function parseJsonc(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
}

let worker;
try {
  worker = parseJsonc(readFileSync(WORKER_CONFIG, 'utf8'));
} catch (error) {
  fail(`worker/wrangler.jsonc does not parse: ${error.message}`);
}

if (worker.main !== 'cron.ts') fail('worker/wrangler.jsonc must have main: cron.ts');
if (worker.name !== 'truhiker-refresh') fail(`worker name is ${String(worker.name)}, expected truhiker-refresh`);
if (worker.assets || worker.site) fail('the cron worker must not serve assets');
if (worker.vars && Object.keys(worker.vars).length > 0) {
  fail('the cron worker must carry no inline vars; both values are secrets');
}
if (worker.routes || worker.route) fail('the cron worker must not claim a route');
const crons = worker.triggers?.crons;
if (!Array.isArray(crons) || crons.length !== 2) {
  fail(`expected two crons (monthly, then the retry), got ${JSON.stringify(crons)}`);
}
const workerCode = readFileSync(WORKER_MAIN, 'utf8');
for (const secret of ['DEPLOY_HOOK_URL', 'TRIGGER_KEY']) {
  if (!workerCode.includes(secret)) fail(`worker/cron.ts does not read ${secret}`);
}

const work = mkdtempSync(join(tmpdir(), 'truhiker-deploy-'));
try {
  cpSync(DIST, join(work, 'dist'), { recursive: true });
  cpSync(CONFIG, join(work, 'wrangler.jsonc'));

  const result = spawnSync(WRANGLER, ['deploy', '--dry-run'], {
    cwd: work,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    console.error(output.split('\n').slice(-20).join('\n'));
    fail(`wrangler exited with status ${String(result.status)}`);
  }

  const assets = /Read (\d+) files from the assets directory/.exec(output);
  if (!assets) fail('wrangler did not report reading the assets directory');
  if (!/--dry-run: exiting now/.test(output)) fail('wrangler did not reach the dry-run exit');
  if (/No bindings found/.test(output) === false) {
    // KV, R2 or D1 bindings would invalidate the static-only claim.
    fail('wrangler reported bindings; this project must deploy with none');
  }

  console.log(
    `verify-deploy: OK — ${assets[1]} assets, no Worker script, no bindings, ` +
      `static-only deploy validated`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
