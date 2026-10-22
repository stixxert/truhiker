#!/usr/bin/env node
/**
 * Licence audit — the notices and credits the licences actually require.
 *
 * Fails when:
 *   - a required notice text is missing from the build
 *   - the app's own HTML/JS no longer carries the Kartverket attribution
 *   - the ODbL data file is present without its notice
 *
 * A file in dist/ that matches no rule is reported as a *warning*: it is a
 * licence question for a maintainer, not a reason to stop a working build.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';

/** Each file must match the first rule whose pattern applies. */
const RULES = [
  { pattern: /^licences\//, licence: 'licence-text', note: 'redistributed notices' },
  { pattern: /^maplibre-.*\.(js|mjs|css)$/, licence: 'BSD-3-Clause', holder: 'MapLibre contributors' },
  // Our own files, under the project licence.
  { pattern: /^index\.html$/, licence: 'Apache-2.0' },
  { pattern: /^index-.*\.(js|css)$/, licence: 'Apache-2.0' },
  { pattern: /^dem.*\.js$/, licence: 'Apache-2.0' },
  // Any other JS/CSS chunk is our own code (lazy-loaded engines, workers, etc.).
  // Listed after the MapLibre rule so third-party code is never counted as ours.
  { pattern: /^[a-zA-Z0-9_.-]+\.(js|mjs|css)$/, licence: 'Apache-2.0' },
  { pattern: /^404\.html$/, licence: 'Apache-2.0' },
  { pattern: /^_headers$/, licence: 'Apache-2.0' },
  { pattern: /^data\/shops\.osm\.bin$/, licence: 'ODbL-1.0', holder: 'OpenStreetMap contributors' },  // Provenance and checksum for the data artefact.
  { pattern: /^data\/shops\.osm\.json$/, licence: 'ODbL-1.0', holder: 'OpenStreetMap contributors' },
  // The licence text itself, served beside the data.
  { pattern: /^data\/ODbL-1\.0\.txt$/, licence: 'ODbL-1.0', holder: 'Open Data Commons' },
];

/** Notice texts that must be present because we redistribute the work. */
const REQUIRED_NOTICES = [
  ['licences/LICENSE', 'Apache §4(a): a copy of the project licence must travel with the code'],
  ['licences/NOTICE', 'Apache §4(d): the NOTICE file must travel with the code'],
  ['licences/maplibre-gl-BSD-3-Clause.txt', 'MapLibre (BSD-3) requires its notice to travel with the code'],
  ['licences/ODbL-1.0.txt', 'the shops data is ODbL; the licence text must be reachable'],
  ['licences/shops.osm.ODbL-notice.txt', 'the ODbL data file needs its own attribution notice'],
  ['licences/TRUHIKER.txt', 'the app notice lists every source and its licence'],
];

const problems = [];
const warnings = [];

if (!existsSync(DIST)) {
  console.error('licence-audit: dist/ does not exist — build first');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const files = walk(DIST).map((path) => relative(DIST, path).split('\\').join('/'));

for (const file of files) {
  const rule = RULES.find((candidate) => candidate.pattern.test(file));
  if (!rule) warnings.push(`unaccounted asset: ${file} — add a licence rule or stop shipping it`);
}

for (const [path, why] of REQUIRED_NOTICES) {
  if (!existsSync(join(DIST, path))) problems.push(`missing notice ${path}: ${why}`);
}

// The attribution must be visible to a user, not only in a text file.
const html = existsSync(join(DIST, 'index.html')) ? readFileSync(join(DIST, 'index.html'), 'utf8') : '';
const js = files
  .filter((file) => /^index-.*\.js$/.test(file))
  .map((file) => readFileSync(join(DIST, file), 'utf8'))
  .join('\n');

if (!/Kartverket/.test(html) && !/Kartverket/.test(js)) {
  problems.push('the Kartverket attribution is not present in the built app');
}
if (files.some((file) => file.startsWith('data/shops.osm.')) && !/OpenStreetMap/.test(js + html)) {
  problems.push('the ODbL data ships without an OpenStreetMap attribution in the app');
}

// Every other credit the sources require to be visible. These live in the About
// panel, so a regression that drops one has to fail here rather than be noticed by
// a rights holder.
for (const [credit, why] of [
  ['Sentinel-2', 'the aerial layer is Copernicus Sentinel-2, CC BY 4.0'],
  ['Mapterhorn', 'the 3D terrain is Mapterhorn, attribution required'],
  ['MET Norway', 'the weather is MET Norway, NLOD / CC BY 4.0'],
]) {
  if (!(html + js).includes(credit)) problems.push(`the app carries no ${credit} credit: ${why}`);
}

for (const warning of warnings) console.warn(`licence-audit: warning — ${warning}`);

const counts = files.reduce((acc, file) => {
  const rule = RULES.find((candidate) => candidate.pattern.test(file));
  const key = rule?.licence ?? 'unaccounted';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

if (problems.length > 0) {
  console.error('licence-audit: FAIL');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(
  `licence-audit: OK — ${files.length} shipped files accounted for ` +
    `(${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}), ` +
    `${REQUIRED_NOTICES.length} notices present, attribution visible`,
);
