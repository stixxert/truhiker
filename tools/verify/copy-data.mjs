#!/usr/bin/env node
/**
 * Copy the bundled data files into dist/ so they are served as static assets.
 *
 * Why a copy step rather than putting them in public/: the files are generated
 * by tools/build-shops.mjs from an OSM extract and are versioned by their own
 * build date, not by a hand-edited source file. Keeping them under data/ makes
 * the provenance and the licence file obvious, and this step makes them part of
 * the deployment.
 *
 * Deliberately copies MEASUREMENTS.md too: it is 12 KB and it lets a curious
 * user see exactly how the file was produced. It is not linked from the app.
 */
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'data';
const DEST = join('dist', 'data');

// Files that must never be served: build inputs and large intermediates.
const SKIP = new Set();

if (!existsSync('dist')) {
  console.error('copy-data: dist/ does not exist — run the build first');
  process.exit(1);
}

if (!existsSync(SRC)) {
  console.log('copy-data: no data/ directory, nothing to copy');
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const name of readdirSync(SRC)) {
  if (SKIP.has(name)) continue;
  const from = join(SRC, name);
  if (!statSync(from).isFile()) continue;
  copyFileSync(from, join(DEST, name));
  copied += 1;
  console.log(`copy-data: ${from} -> ${join(DEST, name)}`);
}

// The licence file is not optional: the POI file is an ODbL Derivative Database.
const required = ['shops.osm.bin', 'shops.osm.json', 'ODbL-1.0.txt'];
const missing = required.filter((f) => !existsSync(join(DEST, f)));
if (missing.length > 0) {
  console.error(
    `copy-data: missing required file(s) in dist/data: ${missing.join(', ')}\n` +
      'Run `node tools/build-shops.mjs` to regenerate them. Shipping the POI data\n' +
      'without its licence file would breach the ODbL attribution requirement.',
  );
  process.exit(1);
}

console.log(`copy-data: ${copied} file(s) in ${DEST}`);
