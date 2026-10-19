#!/usr/bin/env node
/**
 * Ship the licence texts we are obliged to ship.
 *
 * Redistributing MapLibre (BSD-3) in a build requires reproducing its copyright
 * notice and licence; the ODbL data file requires its own notice and a route to
 * the licence. These were previously absent from `dist/`, which is a real
 * compliance gap rather than a nicety.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const OUT = join(DIST, 'licences');

const COPIES = [
  ['node_modules/maplibre-gl/LICENSE.txt', 'maplibre-gl-BSD-3-Clause.txt'],
  ['LICENSES/ODbL-1.0.txt', 'ODbL-1.0.txt'],
  ['data/shops.osm.LICENSE', 'shops.osm.ODbL-notice.txt'],
];

if (!existsSync(DIST)) {
  console.error('copy-licences: dist/ does not exist — build first');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const missing = [];
let copied = 0;
for (const [from, to] of COPIES) {
  if (!existsSync(from)) {
    missing.push(from);
    continue;
  }
  copyFileSync(from, join(OUT, to));
  copied += 1;
}

if (missing.length > 0) {
  console.error(
    `copy-licences: missing source(s): ${missing.join(', ')}\n` +
      'Refusing to produce a build without the notices it must carry.',
  );
  process.exit(1);
}

// The app's own notice, plus a pointer to the full inventory in the repository.
writeFileSync(
  join(OUT, 'TRUHIKER.txt'),
  `TruHiker — GPX route analyser for Norwegian hiking
https://github.com/stixxert/truhiker

Application code: © Sivert Asakskogen. All rights reserved.

Bundled third-party material:
  maplibre-gl-BSD-3-Clause.txt   MapLibre GL JS, BSD-3-Clause
  ODbL-1.0.txt                   Open Database License, for data/shops.osm.bin
  shops.osm.ODbL-notice.txt      attribution and provenance for that data

Live data sources (not redistributed; fetched by your browser):
  Kartverket  — basemap, elevation (DTM), trail and hut geometry — CC BY 4.0
  Mapterhorn  — terrain tiles (derived from Kartverket) — see attribution.json
  MET Norway  — weather forecasts — NLOD / CC BY 4.0
  OpenStreetMap contributors — resupply points, under ODbL 1.0
`,
  'utf8',
);

const readme = readFileSync(join(OUT, 'TRUHIKER.txt'), 'utf8');
if (!readme.includes('Kartverket')) {
  console.error('copy-licences: the app notice lost its attribution block');
  process.exit(1);
}

console.log(`copy-licences: ${copied} notice(s) + app notice in ${OUT}`);
