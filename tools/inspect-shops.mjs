#!/usr/bin/env node
/**
 * inspect-shops.mjs — read data/shops.osm.bin, verify it, and query it.
 *
 * Usage:
 *   node tools/inspect-shops.mjs [data/shops.osm.bin] [query ...]
 *   node tools/inspect-shops.mjs --stats
 *   node tools/inspect-shops.mjs --near LAT,LON [--radius-km N]
 *
 * Queries are case-insensitive substrings matched against name and brand.
 * No dependencies: the binary format is documented in tools/README.md.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const TYPES = ['supermarket', 'convenience', 'general', 'grocery', 'fuel', 'post_office', 'parcel_locker'];
const FLAG = {
  OPENING_HOURS: 0x01,
  PHONE: 0x02,
  FUEL_UNMANNED: 0x04,
  NAME_EQUALS_BRAND: 0x08,
  NAME_IS_BRAND_SUFFIX: 0x10,
  SAME_SITE_SUPERMARKET: 0x20,
};

export function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 8) !== 'NPLSHP01') throw new Error('bad magic: not an npl-shops file');
  let pos = 8;
  const count = buf.readUInt32LE(pos);
  pos += 4;

  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = buf[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new Error('varint overflow');
    }
    return result;
  };
  const readZigzag = () => {
    const n = readVarint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  };

  const records = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < count; i++) {
    lat += readZigzag();
    lon += readZigzag();
    const type = buf[pos++];
    const flags = buf[pos++];
    const brandIdx = readVarint();
    const nameIdx = readVarint();
    if (type >= TYPES.length) throw new Error(`record ${i}: bad type ${type}`);
    records.push({ lat, lon, type, flags, brandIdx, nameIdx, index: i });
  }

  const stringCount = buf.readUInt32LE(pos);
  pos += 4;
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const len = readVarint();
    strings.push(buf.toString('utf8', pos, pos + len));
    pos += len;
  }
  if (pos !== buf.length) throw new Error(`trailing bytes (${buf.length - pos})`);

  for (const r of records) {
    r.typeName = TYPES[r.type];
    r.brand = r.brandIdx ? strings[r.brandIdx - 1] : null;
    const leaf = r.nameIdx ? strings[r.nameIdx - 1] : null;
    if (r.flags & FLAG.NAME_IS_BRAND_SUFFIX) r.name = (r.brand ?? '') + leaf;
    else if (r.flags & FLAG.NAME_EQUALS_BRAND) r.name = r.brand;
    else r.name = leaf;
    r.nameSuffix = r.flags & FLAG.NAME_IS_BRAND_SUFFIX ? leaf : null;
    r.sameSiteSupermarket = !!(r.flags & FLAG.SAME_SITE_SUPERMARKET);
    r.hasOpeningHours = !!(r.flags & FLAG.OPENING_HOURS);
    r.hasPhone = !!(r.flags & FLAG.PHONE);
    r.fuelUnmanned = !!(r.flags & FLAG.FUEL_UNMANNED);
    r.nameEqualsBrand = !!(r.flags & FLAG.NAME_EQUALS_BRAND);
  }

  // Integrity: sorted by lat then lon; string indices in range.
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1];
    const b = records[i];
    if (a.lat > b.lat || (a.lat === b.lat && a.lon > b.lon)) {
      throw new Error(`verification: records not sorted at index ${i}`);
    }
  }
  for (const r of records) {
    if (r.brandIdx > strings.length || r.nameIdx > strings.length) {
      throw new Error(`verification: string index out of range at record ${r.index}`);
    }
  }
  return { records, strings, bytes: buf.length };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function display(r) {
  const name = r.name ?? (r.brand ?? '(unnamed)');
  const bits = [];
  if (r.brand && r.name) bits.push(`brand=${r.brand}`);
  if (r.hasOpeningHours) bits.push('hours');
  if (r.hasPhone) bits.push('phone');
  if (r.fuelUnmanned) bits.push('unmanned');
  if (r.sameSiteSupermarket) bits.push('same-site-supermarket');
  return `${name}  [${r.typeName}]  ${(r.lat / 1e6).toFixed(5)}, ${(r.lon / 1e6).toFixed(5)}  ${bits.join(' ')}`;
}

function main() {
  const argv = process.argv.slice(2);
  let file = 'data/shops.osm.bin';
  if (argv.length && !argv[0].startsWith('--')) file = argv.shift();

  let mode = 'search';
  let near = null;
  let radiusKm = 25;
  const queries = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stats') mode = 'stats';
    else if (argv[i] === '--verify') mode = 'verify';
    else if (argv[i] === '--near') {
      mode = 'near';
      const [lat, lon] = argv[++i].split(',').map(Number);
      near = { lat, lon };
    } else if (argv[i] === '--radius-km') radiusKm = Number(argv[++i]);
    else queries.push(argv[i]);
  }

  const data = decode(file);

  if (mode === 'stats') {
    const byType = Object.fromEntries(TYPES.map((t) => [t, 0]));
    let hours = 0;
    let unmanned = 0;
    let sameSite = 0;
    for (const r of data.records) {
      byType[r.typeName]++;
      if (r.hasOpeningHours) hours++;
      if (r.fuelUnmanned) unmanned++;
      if (r.sameSiteSupermarket) sameSite++;
    }
    console.log(`file: ${file}`);
    console.log(`bytes: ${data.bytes}`);
    console.log(`POIs: ${data.records.length}`);
    console.log(`string table: ${data.strings.length}`);
    console.log('per type:', byType);
    console.log(`opening_hours: ${hours} (${((hours / data.records.length) * 100).toFixed(1)}%)`);
    console.log(`fuel unmanned flag: ${unmanned}`);
    console.log(`post office same-site-as-supermarket hints: ${sameSite}`);
    return;
  }

  if (mode === 'verify') {
    // The binary and its manifest must agree, and the points must be in Norway.
    // A stale or corrupted artefact is a licence and a data-quality problem, not
    // a cosmetic one: ODbL asks us to serve what we say we serve.
    const problems = [];
    const manifestPath = file.replace(/shops\.osm\.bin$/, 'shops.osm.json');
    if (!fs.existsSync(manifestPath)) {
      problems.push(`missing manifest ${manifestPath}`);
    } else {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (manifest.checksum?.sha256 !== sha) {
        problems.push(`checksum ${sha} does not match the manifest (${manifest.checksum?.sha256})`);
      }
      if (manifest.counts?.total !== data.records.length) {
        problems.push(`count ${data.records.length} does not match the manifest (${manifest.counts?.total})`);
      }
    }
    for (const r of data.records) {
      const lat = r.lat / 1e6;
      const lon = r.lon / 1e6;
      // The Norway extract includes Svalbard (Longyearbyen, 78.2 N).
      if (!(lat > 57 && lat < 82) || !(lon > 3 && lon < 33)) {
        problems.push(`point ${r.index} outside Norway: ${lat}, ${lon}`);
        break;
      }
    }
    if (problems.length > 0) {
      console.error('verify: FAIL');
      for (const problem of problems) console.error('  - ' + problem);
      process.exit(1);
    }
    console.log(`verify: OK — ${data.records.length} records, ${data.strings.length} strings, ${data.bytes} bytes, sorted, indices in range, checksum and manifest agree, all points in Norway`);
    return;
  }

  if (false) {
    console.log(`OK: ${data.records.length} records, ${data.strings.length} strings, ${data.bytes} bytes, sorted, indices in range`);
    return;
  }

  if (mode === 'near') {
    const rows = data.records
      .map((r) => ({ r, km: haversineKm(near.lat, near.lon, r.lat / 1e6, r.lon / 1e6) }))
      .filter((x) => x.km <= radiusKm)
      .sort((a, b) => a.km - b.km);
    console.log(`${rows.length} POIs within ${radiusKm} km of ${near.lat}, ${near.lon}`);
    for (const { r, km } of rows) console.log(`${km.toFixed(2).padStart(6)} km  ${display(r)}`);
    return;
  }

  if (!queries.length) {
    console.log('usage: node tools/inspect-shops.mjs [file] [--stats|--verify|--near LAT,LON [--radius-km N]] [query ...]');
    return;
  }

  let found = 0;
  for (const q of queries) {
    const needle = q.toLowerCase();
    const hits = data.records.filter(
      (r) => (r.name && r.name.toLowerCase().includes(needle)) || (r.brand && r.brand.toLowerCase().includes(needle)),
    );
    console.log(`\n${q}: ${hits.length} hit(s)`);
    for (const r of hits) console.log(`  ${display(r)}`);
    found += hits.length;
  }
  if (!found) console.log('\nNo matches. Try a shorter substring.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
