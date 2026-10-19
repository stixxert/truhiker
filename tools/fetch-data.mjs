#!/usr/bin/env node
/**
 * Fetch the resupply extract at build time, instead of keeping derived data in
 * the repository.
 *
 * The file is a Derivative Database of OpenStreetMap (ODbL 1.0). It is published
 * as a release asset and served by the deployed app; the repository holds only
 * the generator, the manifest and the licence notice.
 *
 * Usage:
 *   node tools/fetch-data.mjs            # fetch if missing or checksum-mismatched
 *   node tools/fetch-data.mjs --force    # always fetch
 *   TRUHIKER_DATA_URL=<url> node tools/fetch-data.mjs
 *
 * If the asset cannot be reached (for example the release asset has not been
 * uploaded yet), the script explains the two ways to produce it locally and exits
 * non-zero — it never leaves a half-written file behind.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA = join(ROOT, 'data');
const manifest = JSON.parse(readFileSync(join(DATA, 'MANIFEST.json'), 'utf8'));
const target = join(DATA, manifest.file);
const force = process.argv.includes('--force');
const url = process.env.TRUHIKER_DATA_URL ?? manifest.assetUrl;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function verify(buffer) {
  if (buffer.length !== manifest.bytes) {
    return `expected ${manifest.bytes} bytes, got ${buffer.length}`;
  }
  const digest = sha256(buffer);
  if (digest !== manifest.sha256) return `checksum mismatch (${digest.slice(0, 12)}…)`;
  return null;
}

if (!force && existsSync(target)) {
  const problem = verify(readFileSync(target));
  if (problem === null) {
    console.log(`fetch-data: ${manifest.file} present and verified (${manifest.bytes} bytes)`);
    process.exit(0);
  }
  console.log(`fetch-data: local copy is wrong (${problem}); refetching`);
}

function instructions() {
  return [
    '',
    'The resupply extract is not in the repository by design; it is a build artefact.',
    '',
    'Produce it in one of two ways:',
    '',
    '  1. Upload the asset once from a machine with release access:',
    '       gh release upload data-2026-10-18 data/shops.osm.bin data/shops.osm.meta.json data/shops.osm.LICENSE',
    '',
    '  2. Build it locally from the OSM extract (about 1.3 GB download):',
    '       node tools/build-shops.mjs',
    '',
    `Expected: ${manifest.bytes} bytes, sha256 ${manifest.sha256}`,
    `Manifest: data/MANIFEST.json`,
    '',
  ].join('\n');
}

let response;
try {
  response = await fetch(url, { redirect: 'follow' });
} catch (error) {
  console.error(`fetch-data: cannot reach ${url} (${error.message})`);
  console.error(instructions());
  process.exit(1);
}

if (!response.ok) {
  console.error(`fetch-data: ${url} returned HTTP ${response.status}`);
  console.error(instructions());
  process.exit(1);
}

const buffer = Buffer.from(await response.arrayBuffer());
const problem = verify(buffer);
if (problem !== null) {
  console.error(`fetch-data: downloaded file failed verification (${problem})`);
  console.error(instructions());
  process.exit(1);
}

mkdirSync(DATA, { recursive: true });
const temporary = `${target}.part`;
try {
  writeFileSync(temporary, buffer);
  renameSync(temporary, target);
} catch (error) {
  rmSync(temporary, { force: true });
  console.error(`fetch-data: could not write ${target} (${error.message})`);
  process.exit(1);
}

console.log(`fetch-data: ${manifest.file} fetched and verified (${buffer.length} bytes, ${manifest.points} points)`);
