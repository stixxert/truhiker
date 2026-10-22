#!/usr/bin/env node
/**
 * deploy-rehearsal.mjs — build a deployment the way the deploy container does, here.
 *
 * Why this exists. A Workers Builds job starts from a **clone**: no `data/`, no
 * `node_modules`, and a build command that lives in the Cloudflare dashboard rather
 * than in this repository (the platform ignores `[build]` in `wrangler.jsonc`). That
 * is a deploy path nothing on a developer's machine exercises, and it once shipped
 * a red build: `npm run build` on a bare clone stopped at preflight because the
 * resupply artefact is build output and is never committed (D24). The lesson is not
 * "run the right command" — it is that the deploy path has to be run and asserted
 * somewhere before it matters, and this repository has no CI (AGENTS.md), so it is
 * asserted here, inside the gate.
 *
 * What is rehearsed, in a temp directory holding exactly the files a clone would
 * contain (`git ls-files` plus untracked-but-not-ignored, with `node_modules`
 * symlinked):
 *
 *   1. a bare clone with no data and nothing to produce it → preflight refuses, and
 *      says what to do about the *data* (the incident's symptom, made legible);
 *   2. the same clone in a Workers build container (`WORKERS_CI=1`) → preflight lets
 *      it through, because the build step is what produces the data (D23);
 *   3. the producer's own guards: `refresh-shops.sh` parses, and refuses a truncated
 *      extract instead of indexing "no places in Norway";
 *   4. a published copy (`$TRUHIKER_DATA_URL`, served from this checkout's `data/`
 *      over loopback) → a complete `npm run build` in the fresh tree produces a
 *      `dist/` that carries the artefact, its provenance and the ODbL text;
 *   5. the container's data step with a stand-in producer → the artefact a container
 *      writes is accepted (and reported as drift from the pin, not rejected).
 *
 * Not rehearsed: the real 1.4 GB Geofabrik download and its two passes, which cannot
 * be hermetic. Its wiring is what step 5 pins down; its guards are step 3.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fail(message) {
  console.error('deploy-rehearsal: FAIL');
  console.error('  - ' + message);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 300_000,
    ...options,
    env: { ...process.env, ...options.env },
  });
}

/**
 * The same, without blocking the event loop.
 *
 * Necessary for the one step that fetches from a server in this process: a
 * synchronous child would freeze the loop and the fetch would wait for a reply the
 * parent can no longer send, which is a deadlock that looks exactly like a slow
 * build until the timeout kills it.
 */
function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

/** The files a clone of this working tree would contain. */
function cloneFileList() {
  const listed = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT });
  if (listed.status !== 0) fail(`git ls-files failed: ${listed.stderr ?? ''}`);
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  if (files.length < 50) fail(`git ls-files returned ${files.length} files; that is not this repository`);
  return files;
}

function freshCheckout(files, label) {
  const root = mkdtempSync(join(tmpdir(), `truhiker-${label}-`));
  for (const file of files) {
    const to = join(root, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(ROOT, file), to);
  }
  // Dependencies are not part of the rehearsal: the container installs them, and
  // copying 110 packages would dominate the gate. The symlink keeps resolution
  // honest without pretending an empty `node_modules` is a fresh install.
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

const files = cloneFileList();
const work = freshCheckout(files, 'deploy-rehearsal');
const container = freshCheckout(files, 'deploy-rehearsal-container');
let server;

try {
  // 1. A bare clone: refuse, and name the data as the reason — not `npm ci`, which
  //    would install what is already installed and fix nothing.
  const bare = run(process.execPath, ['tools/preflight.mjs'], { cwd: work });
  if (bare.status === 0) fail('preflight passed on a bare clone with no data: a deploy would ship an empty index');
  if (!/data\/ is missing/.test(bare.stderr ?? '')) fail('preflight did not name the missing data directory');
  if (!/creates `data\/`/.test(bare.stderr ?? '')) fail('preflight advised `npm ci` for a data problem');
  if (/Run `npm ci`/.test(bare.stderr ?? '')) fail('preflight still tells a data-only failure to run `npm ci`');

  // 2. The same clone in the container that is expected to build it.
  const inContainer = run(process.execPath, ['tools/preflight.mjs'], {
    cwd: work,
    env: { WORKERS_CI: '1' },
  });
  if (inContainer.status !== 0) {
    fail(`preflight refused a Workers build container: ${(inContainer.stderr ?? '').trim()}`);
  }

  // 3. The producer's guards, without the 1.4 GB download: it must parse, and it
  //    must refuse a truncated extract rather than index it.
  const syntax = run('bash', ['-n', 'tools/refresh-shops.sh'], { cwd: work });
  if (syntax.status !== 0) fail(`tools/refresh-shops.sh does not parse: ${syntax.stderr ?? ''}`);
  const tiny = join(work, 'tiny.osm.pbf');
  writeFileSync(tiny, 'not an extract');
  const tinySize = readFileSync(tiny).byteLength;
  const guarded = run('bash', ['tools/refresh-shops.sh'], { cwd: work, env: { PBF: tiny } });
  if (guarded.status === 0) fail(`refresh-shops.sh accepted a ${tinySize}-byte "extract"`);
  if (!new RegExp(`refusing a ${tinySize}-byte extract`).test(guarded.stderr ?? '')) {
    fail(`refresh-shops.sh failed for the wrong reason: ${(guarded.stderr ?? '').trim().slice(0, 200)}`);
  }

  // 4. The published-copy path, end to end: a full build of the fresh tree with the
  //    pinned artefact served over loopback. This is the rehearsal proper — tsc,
  //    vite, and `copy-data` against a `data/` the build itself fetched.
  const dataDir = join(ROOT, 'data');
  const served = ['shops.osm.bin', 'shops.osm.json', 'ODbL-1.0.txt'];
  for (const name of served) {
    if (!existsSync(join(dataDir, name))) fail(`data/${name} is missing — run \`npm run build\` first`);
  }
  server = createServer((request, response) => {
    const name = (request.url ?? '/').replace(/^\/+/, '');
    if (!served.includes(name)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200).end(readFileSync(join(dataDir, name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const built = await runAsync('npm', ['run', 'build'], {
    cwd: work,
    env: { TRUHIKER_DATA_URL: url },
  });
  if (built.status !== 0) {
    console.error(`${built.stdout ?? ''}${built.stderr ?? ''}`.split('\n').slice(-25).join('\n'));
    fail(`npm run build exited with ${built.status} in a fresh checkout with a published copy`);
  }
  for (const name of served) {
    const path = join(work, 'dist', 'data', name);
    if (!existsSync(path)) fail(`dist/data/${name} is missing from the rehearsal build`);
  }
  const pin = JSON.parse(readFileSync(join(ROOT, 'tools/data-manifest.json'), 'utf8')).artefacts[0];
  const shipped = readFileSync(join(work, 'dist', 'data', pin.file));
  if (sha256(shipped) !== pin.sha256) {
    fail(`the rehearsal build shipped ${sha256(shipped).slice(0, 12)}…, the pin is ${pin.sha256.slice(0, 12)}…`);
  }

  // 5. A container with no data and no published copy produces it itself. The real
  //    producer downloads 1.4 GB, so a stand-in writes the pair; what is asserted is
  //    the wiring — `ensure-data` runs `tools/refresh-shops.sh`, then accepts and
  //    reports the artefact it produced instead of rejecting it as off-pin.
  writeFileSync(
    join(container, 'tools/refresh-shops.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `node -e '`,
      `const fs=require("fs"),c=require("crypto");`,
      `const bin=Buffer.from("NPLSHP01 rehearsal artefact from the stand-in producer\\n");`,
      `const sha=c.createHash("sha256").update(bin).digest("hex");`,
      `fs.mkdirSync("data",{recursive:true});`,
      `fs.writeFileSync("data/shops.osm.bin",bin);`,
      `fs.writeFileSync("data/shops.osm.json",JSON.stringify(`,
      `{source:{extractDate:"2026-10-22"},counts:{total:8571},`,
      `sizes:{withNames:{raw:bin.byteLength}},checksum:{sha256:sha}},null,2));`,
      `'`,
      '',
    ].join('\n'),
  );
  mkdirSync(join(container, 'data'), { recursive: true });
  copyFileSync(join(dataDir, 'ODbL-1.0.txt'), join(container, 'data/ODbL-1.0.txt'));
  const produced = run(process.execPath, ['tools/ensure-data.mjs'], {
    cwd: container,
    env: { WORKERS_CI: '1' },
  });
  const producedOut = `${produced.stdout ?? ''}${produced.stderr ?? ''}`;
  if (produced.status !== 0) {
    console.error(producedOut.split('\n').slice(-20).join('\n'));
    fail('the container data step rejected what its own producer wrote');
  }
  if (!/building from the Geofabrik extract/.test(producedOut)) {
    fail('the container data step did not fall back to the producer');
  }
  if (!/different extract than the pin/.test(producedOut)) {
    fail('the container data step did not report the produced artefact as drift from the pin');
  }

  console.log(
    'deploy-rehearsal: OK — bare clone refuses with the data reason, Workers container builds, ' +
      'producer guards hold, published-copy build ships pinned data',
  );
} finally {
  if (server) server.close();
  rmSync(work, { recursive: true, force: true });
  rmSync(container, { recursive: true, force: true });
}
