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
