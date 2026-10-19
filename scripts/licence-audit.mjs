#!/usr/bin/env node
/**
 * Licence audit — every shipped byte must have a licence, and the notices we are
 * obliged to redistribute must actually be in the build.
 *
 * Fails when:
 *   - a file in dist/ matches no rule (someone shipped something unaccounted for)
 *   - a required notice text is missing
 *   - the app's own HTML/JS no longer carries the Kartverket attribution
 *   - the ODbL data file is present without its notice
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';

/** Each file must match the first rule whose pattern applies. */
const RULES = [
  { pattern: /^licences\//, licence: 'licence-text', note: 'redistributed notices' },
  { pattern: /^maplibre-.*\.(js|mjs|css)$/, licence: 'BSD-3-Clause', holder: 'MapLibre contributors' },
  { pattern: /^index\.html$/, licence: 'proprietary', holder: 'Sivert Asakskogen' },
  { pattern: /^index-.*\.(js|css)$/, licence: 'proprietary', holder: 'Sivert Asakskogen' },
  { pattern: /^dem.*\.js$/, licence: 'proprietary', holder: 'Sivert Asakskogen' },
  // Any other JS/CSS chunk is our own code (lazy-loaded engines, workers, etc.).
  // Listed after the MapLibre rule so third-party code is never counted as ours.
  { pattern: /^[a-zA-Z0-9_.-]+\.(js|mjs|css)$/, licence: 'proprietary', holder: 'Sivert Asakskogen' },
  { pattern: /^404\.html$/, licence: 'proprietary', holder: 'Sivert Asakskogen' },
  { pattern: /^_headers$/, licence: 'proprietary', holder: 'Sivert Asakskogen' },
  { pattern: /^demo\/.*\.gpx$/, licence: 'CC-BY-4.0', holder: 'Kartverket (Turrutebasen)' },
  { pattern: /^data\/shops\.osm\.bin$/, licence: 'ODbL-1.0', holder: 'OpenStreetMap contributors' },
  { pattern: /^data\/shops\.osm\.meta\.json$/, licence: 'ODbL-1.0', holder: 'OpenStreetMap contributors' },
  { pattern: /^data\/shops\.osm\.LICENSE$/, licence: 'ODbL-1.0', holder: 'OpenStreetMap contributors' },
];

/** Notice texts that must be present because we redistribute the work. */
const REQUIRED_NOTICES = [
  ['licences/maplibre-gl-BSD-3-Clause.txt', 'MapLibre (BSD-3) requires its notice to travel with the code'],
  ['licences/ODbL-1.0.txt', 'the shops data is ODbL; the licence text must be reachable'],
  ['licences/shops.osm.ODbL-notice.txt', 'the ODbL data file needs its own attribution notice'],
  ['licences/TRUHIKER.txt', 'the app notice lists every source and its licence'],
];

const problems = [];

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
  if (!rule) problems.push(`unaccounted asset: ${file} — add a licence rule or stop shipping it`);
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
