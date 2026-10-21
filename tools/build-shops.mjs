#!/usr/bin/env node
/**
 * build-shops.mjs — build the resupply POI index from a Geofabrik Norway OSM PBF.
 *
 * Self-contained: includes a small streaming OpenStreetMap PBF reader (no npm
 * dependencies). Two passes over the file:
 *   pass 1 — collect tagged nodes (direct coordinates) and tagged ways (node refs)
 *   pass 2 — resolve the node refs of tagged ways into coordinates (way centre)
 *
 * Outputs (default dir `data/`):
 *   shops.osm.bin         compact binary, see tools/README.md for the byte layout
 *   shops.osm.json        provenance: counts, source, attribution, sizes, sha256
 *
 * Optional: --dump <path> writes every extracted POI as JSONL for inspection.
 *
 * Usage:
 *   node --max-old-space-size=1400 tools/build-shops.mjs \
 *     --pbf /tmp/norway-latest.osm.pbf --out data \
 *     [--source-date 2026-10-18] [--dump /tmp/shops-dump.jsonl]
 *
 * Licence note: the emitted binary is a Derivative Database of OpenStreetMap
 * data and is offered under ODbL 1.0. © OpenStreetMap contributors.
 */

import fs, { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOURCE_URL = 'https://download.geofabrik.de/europe/norway-latest.osm.pbf';
const ATTRIBUTION = '© OpenStreetMap contributors';
const LICENCE = 'ODbL-1.0';

/** Primary type codes stored in the binary (one byte). */
const TYPES = [
  { code: 0, key: 'supermarket', tag: ['shop', 'supermarket'], label: 'Supermarket' },
  { code: 1, key: 'convenience', tag: ['shop', 'convenience'], label: 'Convenience store' },
  { code: 2, key: 'general', tag: ['shop', 'general'], label: 'General store' },
  { code: 3, key: 'grocery', tag: ['shop', 'grocery'], label: 'Grocery' },
  { code: 4, key: 'fuel', tag: ['amenity', 'fuel'], label: 'Fuel station' },
  { code: 5, key: 'post_office', tag: ['amenity', 'post_office'], label: 'Post office' },
  { code: 6, key: 'parcel_locker', tag: ['amenity', 'parcel_locker'], label: 'Parcel locker' },
];

/**
 * Order in which a single object is assigned its primary type when it carries
 * more than one matching tag. A supermarket that also sells fuel stays a
 * supermarket; a petrol station with a convenience kiosk becomes `fuel`,
 * because the fuel is the resupply-relevant function.
 */
const PRIMARY_PRIORITY = ['supermarket', 'general', 'grocery', 'fuel', 'convenience', 'post_office', 'parcel_locker'];

const EXCLUDED_TAGS = [
  ['tourism', 'alpine_hut'],
  ['tourism', 'wilderness_hut'],
  ['amenity', 'shelter'],
];

/** Tags whose values we keep while scanning. */
const INTERESTING_KEYS = new Set([
  'shop', 'amenity', 'tourism',
  'name', 'brand', 'opening_hours', 'phone',
  'automated', 'vending',
]);

const TAG_FILTER = {
  any_of: [
    { 'shop': ['supermarket', 'convenience', 'general', 'grocery'] },
    { 'amenity': ['fuel', 'post_office', 'parcel_locker'] },
  ],
  exclude: [
    { 'tourism': ['alpine_hut', 'wilderness_hut'] },
    { 'amenity': ['shelter'] },
  ],
};

/** Taginfo reference counts (objects) with the date they were read. */
const TAGINFO = {
  date: '2026-10-18',
  source: 'https://taginfo.openstreetmap.org/ (Norway region)',
  counts: {
    supermarket: 4042,
    convenience: 577,
    general: 289,
    grocery: 24,
    fuel: 2379,
    post_office: 1257,
    parcel_locker: 250,
  },
};

/** Rural shops used as spot checks; matched case-insensitively on name. */
const SPOT_CHECKS = [
  'Joker Dalsbygda',
  'Coop Prix Hattfjelldal',
  'Coop Marked Randsverk',
  'Extra Kautokeino',
  'Coop Prix Mehamn',
  'Rustugsetra',
];

// ---------------------------------------------------------------------------
// Protobuf / PBF primitives
// ---------------------------------------------------------------------------

/** Read a packed repeated varint field at `pos`. Returns [values, newPos]. */
function readPackedVarints(buf, pos) {
  const len = readVarint(buf, pos);
  const end = len.pos + len.value;
  const out = [];
  let p = len.pos;
  while (p < end) {
    const v = readVarint(buf, p);
    out.push(v.value);
    p = v.pos;
  }
  return [out, end];
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error('varint overflow');
  }
  return { value: result, pos };
}

function zigzagOf(n) {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

/** Parse BlobHeader fields we need: 1=type, 3=datasize. */
function parseBlobHeader(buf) {
  let type = '';
  let datasize = 0;
  let pos = 0;
  while (pos < buf.length) {
    const k = readVarint(buf, pos);
    pos = k.pos;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      if (field === 1) type = buf.toString('utf8', pos, pos + len.value);
      pos += len.value;
    } else if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      if (field === 3) datasize = v.value;
    } else {
      throw new Error(`unexpected wire type ${wire} in BlobHeader`);
    }
  }
  return { type, datasize };
}

/** Decompress a PBF Blob. Supports raw and zlib (what Geofabrik uses). */
function decompressBlob(buf) {
  let pos = 0;
  let raw = null;
  let zlibData = null;
  let rawSize = 0;
  while (pos < buf.length) {
    const k = readVarint(buf, pos);
    pos = k.pos;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      if (field === 1) raw = buf.subarray(pos, pos + len.value);
      else if (field === 3) zlibData = buf.subarray(pos, pos + len.value);
      pos += len.value;
    } else if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      if (field === 2) rawSize = v.value;
    } else {
      throw new Error(`unexpected wire type ${wire} in Blob`);
    }
  }
  if (raw) return raw;
  if (zlibData) return zlib.inflateSync(zlibData, { maxOutputLength: rawSize || 32 * 1024 * 1024 });
  throw new Error('unsupported PBF blob compression (only raw/zlib supported)');
}

/** Iterate the blobs of a .osm.pbf file synchronously. */
function* pbfBlobs(fd) {
  const lenBuf = Buffer.alloc(4);
  let headerBuf = Buffer.alloc(64 * 1024);
  let blobBuf = Buffer.alloc(1024 * 1024);
  for (;;) {
    const n = fs.readSync(fd, lenBuf, 0, 4, null);
    if (n === 0) return;
    if (n !== 4) throw new Error('truncated PBF (partial blob length)');
    const headerLen = lenBuf.readUInt32BE(0);
    if (headerLen <= 0 || headerLen > 64 * 1024) throw new Error(`bad blob header length ${headerLen}`);
    if (headerBuf.length < headerLen) headerBuf = Buffer.alloc(headerLen);
    if (fs.readSync(fd, headerBuf, 0, headerLen, null) !== headerLen) throw new Error('truncated blob header');
    const header = parseBlobHeader(headerBuf.subarray(0, headerLen));
    if (blobBuf.length < header.datasize) blobBuf = Buffer.alloc(header.datasize);
    if (fs.readSync(fd, blobBuf, 0, header.datasize, null) !== header.datasize) throw new Error('truncated blob');
    yield { type: header.type, data: decompressBlob(blobBuf.subarray(0, header.datasize)) };
  }
}

/**
 * Parse one PrimitiveBlock and dispatch nodes/ways.
 * callbacks: onNode(id, latNano, lonNano, tags|null), onWay(id, refs, tags|null)
 */
function parsePrimitiveBlock(buf, onNode, onWay) {
  const groupSlices = [];
  const stStrings = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;

  let pos = 0;
  while (pos < buf.length) {
    const k = readVarint(buf, pos);
    pos = k.pos;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      if (field === 17) granularity = v.value;
      else if (field === 19) latOffset = v.value;
      else if (field === 20) lonOffset = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      const start = len.pos;
      const end = start + len.value;
      pos = end;
      if (field === 1) {
        // StringTable
        let p = start;
        while (p < end) {
          const kk = readVarint(buf, p);
          p = kk.pos;
          const f = Math.floor(kk.value / 8);
          if (kk.value % 8 === 2) {
            const ll = readVarint(buf, p);
            p = ll.pos;
            if (f === 1) stStrings.push(buf.toString('utf8', p, p + ll.value));
            p += ll.value;
          } else if (kk.value % 8 === 0) {
            p = readVarint(buf, p).pos;
          } else {
            p += kk.value % 8 === 1 ? 8 : 4;
          }
        }
      } else if (field === 2) {
        groupSlices.push(buf.subarray(start, end));
      }
    } else {
      pos += wire === 1 ? 8 : 4;
    }
  }

  // Indices of interesting key strings, so dense-node scanning can skip fast.
  const interestingKeyIdx = new Uint8Array(stStrings.length);
  for (let i = 0; i < stStrings.length; i++) {
    if (INTERESTING_KEYS.has(stStrings[i])) interestingKeyIdx[i] = 1;
  }

  const toLat = (v) => latOffset + granularity * v;
  const toLon = (v) => lonOffset + granularity * v;

  for (const group of groupSlices) {
    let p = 0;
    while (p < group.length) {
      const k = readVarint(group, p);
      p = k.pos;
      const field = Math.floor(k.value / 8);
      const wire = k.value % 8;
      if (wire !== 2) {
        if (wire === 0) p = readVarint(group, p).pos;
        else p += wire === 1 ? 8 : 4;
        continue;
      }
      const len = readVarint(group, p);
      const start = len.pos;
      const end = start + len.value;
      p = end;
      if (field === 1) parseNode(group.subarray(start, end), onNode, toLat, toLon, stStrings, interestingKeyIdx);
      else if (field === 2) parseDenseNodes(group.subarray(start, end), onNode, toLat, toLon, stStrings, interestingKeyIdx);
      else if (field === 3) parseWay(group.subarray(start, end), onWay, stStrings, interestingKeyIdx);
      // Relations (4) and changesets (5) are ignored.
    }
  }
}

function collectTags(keys, vals, stStrings, interestingKeyIdx) {
  const tags = {};
  let any = false;
  for (let i = 0; i < keys.length; i++) {
    const ki = keys[i];
    if (!interestingKeyIdx[ki]) continue;
    const key = stStrings[ki];
    const value = stStrings[vals[i]];
    if (value === undefined) continue;
    tags[key] = value;
    any = true;
  }
  return any ? tags : null;
}

function parseNode(buf, onNode, toLat, toLon, stStrings, interestingKeyIdx) {
  let id = 0n;
  let lat = 0;
  let lon = 0;
  let keys = [];
  let vals = [];
  let pos = 0;
  while (pos < buf.length) {
    const k = readVarint(buf, pos);
    pos = k.pos;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      if (field === 1) id = BigInt(v.value);
      else if (field === 8) lat = zigzagOf(v.value);
      else if (field === 9) lon = zigzagOf(v.value);
    } else if (wire === 2) {
      const fieldPos = pos;
      const len = readVarint(buf, pos);
      const start = len.pos;
      const end = start + len.value;
      pos = end;
      if (field === 2) [keys] = readPackedVarints(buf, fieldPos);
      else if (field === 3) [vals] = readPackedVarints(buf, fieldPos);
    } else {
      pos += wire === 1 ? 8 : 4;
    }
  }
  const tags = collectTags(keys, vals, stStrings, interestingKeyIdx);
  onNode(id, toLat(lat), toLon(lon), tags);
}

function parseDenseNodes(buf, onNode, toLat, toLon, stStrings, interestingKeyIdx) {
  let ids = [];
  let lats = [];
  let lons = [];
  let keysVals = [];
  let pos = 0;
  while (pos < buf.length) {
    const k = readVarint(buf, pos);
    pos = k.pos;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 2) {
      const fieldPos = pos;
      const len = readVarint(buf, pos);
      const start = len.pos;
      const end = start + len.value;
      pos = end;
      if (field === 1) [ids] = readPackedVarints(buf, fieldPos);
      else if (field === 8) [lats] = readPackedVarints(buf, fieldPos);
      else if (field === 9) [lons] = readPackedVarints(buf, fieldPos);
      else if (field === 10) [keysVals] = readPackedVarints(buf, fieldPos);
    } else if (wire === 0) {
      pos = readVarint(buf, pos).pos;
    } else {
      pos += wire === 1 ? 8 : 4;
    }
  }

  let id = 0;
  let lat = 0;
  let lon = 0;
  let kv = 0;
  for (let i = 0; i < ids.length; i++) {
    id += zigzagOf(ids[i]);
    lat += zigzagOf(lats[i]);
    lon += zigzagOf(lons[i]);
    let tags = null;
    if (keysVals.length) {
      const keys = [];
      const vals = [];
      let hasInteresting = false;
      while (kv < keysVals.length) {
        const ki = keysVals[kv++];
        if (ki === 0) break;
        const vi = keysVals[kv++];
        keys.push(ki);
        vals.push(vi);
        if (interestingKeyIdx[ki]) hasInteresting = true;
      }
      if (hasInteresting) tags = collectTags(keys, vals, stStrings, interestingKeyIdx);
    }
    onNode(BigInt(id), toLat(lat), toLon(lon), tags);
  }
}

function parseWay(buf, onWay, stStrings, interestingKeyIdx) {
  let id = 0n;
  let keys = [];
  let vals = [];
  let refs = [];
  let pos = 0;
  while (pos < buf.length) {
    const k = readVarint(buf, pos);
    pos = k.pos;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      if (field === 1) id = BigInt(v.value);
    } else if (wire === 2) {
      const fieldPos = pos;
      const len = readVarint(buf, pos);
      const start = len.pos;
      const end = start + len.value;
      pos = end;
      if (field === 2) [keys] = readPackedVarints(buf, fieldPos);
      else if (field === 3) [vals] = readPackedVarints(buf, fieldPos);
      else if (field === 8) [refs] = readPackedVarints(buf, fieldPos);
    } else {
      pos += wire === 1 ? 8 : 4;
    }
  }
  const tags = collectTags(keys, vals, stStrings, interestingKeyIdx);
  if (!tags) return;
  // Way refs are delta-encoded sint64.
  let nodeId = 0;
  const absolute = new Array(refs.length);
  for (let i = 0; i < refs.length; i++) {
    nodeId += zigzagOf(refs[i]);
    absolute[i] = nodeId;
  }
  onWay(id, absolute, tags);
}

function forEachBlob(file, callbacks) {
  const fd = fs.openSync(file, 'r');
  try {
    for (const blob of pbfBlobs(fd)) {
      if (blob.type !== 'OSMData') continue;
      parsePrimitiveBlock(blob.data, callbacks.onNode, callbacks.onWay);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Extraction rules
// ---------------------------------------------------------------------------

function matchesFilter(tags) {
  if (!tags) return false;
  for (const [k, v] of EXCLUDED_TAGS) if (tags[k] === v) return false;
  if (tags.shop && ['supermarket', 'convenience', 'general', 'grocery'].includes(tags.shop)) return true;
  if (tags.amenity && ['fuel', 'post_office', 'parcel_locker'].includes(tags.amenity)) return true;
  return false;
}

/** All type keys matched by a tag object (for overlap reporting). */
function matchedTypes(tags) {
  const out = [];
  if (tags.shop && ['supermarket', 'convenience', 'general', 'grocery'].includes(tags.shop)) out.push(tags.shop);
  if (tags.amenity === 'fuel') out.push('fuel');
  if (tags.amenity === 'post_office') out.push('post_office');
  if (tags.amenity === 'parcel_locker') out.push('parcel_locker');
  return out;
}

function primaryType(matched) {
  for (const key of PRIMARY_PRIORITY) if (matched.includes(key)) return key;
  return null;
}

/**
 * Unmanned fuel-station heuristic. Returns one of:
 *   'automated' — automated=yes
 *   'vending'   — vending=* other than no/none
 *   'no_shop'   — shop=no (no kiosk staff)
 *   'automat_name' — name/brand contains "automat"
 *   null        — no unmanned evidence
 * Tiers are mutually exclusive in this order.
 */
function unmannedEvidence(tags) {
  if (/^(yes|true|1)$/i.test(tags.automated ?? '')) return 'automated';
  if (tags.vending && !/^(no|none|false|0)$/i.test(tags.vending)) return 'vending';
  const label = `${tags.name ?? ''} ${tags.brand ?? ''}`;
  if (/automat|selvbetjent|unbemannet/i.test(label)) return 'automat_name';
  if (/^no$/i.test(tags.shop ?? '')) return 'no_shop';
  return null;
}

function clean(value) {
  if (typeof value !== 'string') return null;
  const v = value.replace(/\s+/g, ' ').trim();
  return v.length ? v : null;
}

function normalizeName(value) {
  return (value ?? '').toLowerCase().replace(/[^a-zæøå0-9]+/gi, ' ').trim();
}

/** Great-circle distance between two records (coordinates are microdegrees). */
function distanceMeters(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const lat1 = a.lat / 1e6;
  const lon1 = a.lon / 1e6;
  const lat2 = b.lat / 1e6;
  const lon2 = b.lon / 1e6;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Collapse same-type POIs within `radiusMeters` into one record (union-find, so
 * transitive chains collapse together). The survivor is chosen by:
 *   1. has a name
 *   2. more of brand + opening_hours + phone
 *   3. earlier in the lat/lon sort (deterministic tie-break)
 * Different types are never merged: a post office inside a supermarket is two
 * legitimate records. Two records with **different non-empty brands** are also
 * never merged (an Esso and an Uno-X across the road are two stations, not a
 * duplicate); an unbranded record can join either. The survivor keeps its own
 * coordinates and fields.
 */
function dedupeSameType(records, radiusMeters = 50) {
  const n = records.length;
  const parent = new Int32Array(n);
  const brandKey = (r) => (r.brand ? r.brand.toLowerCase().replace(/[^a-zæøå0-9]+/gi, ' ').trim() : null);
  const brandSets = new Array(n);
  for (let i = 0; i < n; i++) {
    parent[i] = i;
    brandSets[i] = new Set(brandKey(records[i]) ? [brandKey(records[i])] : []);
  }
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  let brandConflictPairs = 0;
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const merged = new Set(brandSets[ra]);
    for (const brand of brandSets[rb]) merged.add(brand);
    if (merged.size > 1) {
      brandConflictPairs++; // different chains: not the same shop
      return;
    }
    parent[rb] = ra;
    brandSets[ra] = merged;
    brandSets[rb] = null;
  };

  const maxDLatMicro = Math.ceil((radiusMeters / 111320) * 1e6) + 1;
  for (let i = 0; i < n; i++) {
    const a = records[i];
    for (let j = i + 1; j < n; j++) {
      const b = records[j];
      if (b.lat - a.lat > maxDLatMicro) break; // sorted by lat
      if (a.typeKey !== b.typeKey) continue;
      if (distanceMeters(a, b) <= radiusMeters) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const score = (r) => (r.displayName ? 64 : 0) + (r.brand ? 1 : 0) + (r.openingHours ? 1 : 0) + (r.phone ? 1 : 0);

  const collapsedPerType = Object.fromEntries(TYPES.map((t) => [t.key, 0]));
  const groupsPerType = Object.fromEntries(TYPES.map((t) => [t.key, 0]));
  const examples = [];
  const survivors = [];
  let collapsed = 0;

  for (const indices of groups.values()) {
    let best = indices[0];
    for (const i of indices) {
      const s = score(records[i]);
      const sb = score(records[best]);
      if (s > sb || (s === sb && i < best)) best = i;
    }
    survivors.push(records[best]);
    if (indices.length > 1) {
      const type = records[best].typeKey;
      collapsed += indices.length - 1;
      collapsedPerType[type] += indices.length - 1;
      groupsPerType[type] += 1;
      let maxDistanceM = 0;
      for (const i of indices) if (i !== best) maxDistanceM = Math.max(maxDistanceM, distanceMeters(records[best], records[i]));
      examples.push({
        type,
        survivor: records[best].displayName ?? records[best].brand ?? '(unnamed)',
        dropped: indices.filter((i) => i !== best).map((i) => records[i].displayName ?? records[i].brand ?? '(unnamed)'),
        lat: records[best].lat / 1e6,
        lon: records[best].lon / 1e6,
        maxDistanceM: Math.round(maxDistanceM * 10) / 10,
      });
    }
  }

  survivors.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
  // Most illustrative examples first: a named survivor that absorbed unnamed duplicates.
  examples.sort((a, b) => Number(b.dropped.some((d) => d === '(unnamed)')) - Number(a.dropped.some((d) => d === '(unnamed)')));

  return {
    survivors,
    collapsed,
    collapsedPerType,
    groupsPerType,
    examples: examples.slice(0, 10),
    radiusMeters,
    brandConflictPairs,
  };
}

/**
 * Mark post offices that share a site with a supermarket (within radiusMeters).
 * This is a hint for the resupply planner ("post in store"), not a merge.
 */
function markSameSite(records, radiusMeters = 50) {
  const maxDLatMicro = Math.ceil((radiusMeters / 111320) * 1e6) + 1;
  const supermarkets = records.filter((r) => r.typeKey === 'supermarket');
  let count = 0;
  for (const post of records) {
    if (post.typeKey !== 'post_office') continue;
    for (const sup of supermarkets) {
      if (Math.abs(sup.lat - post.lat) > maxDLatMicro) continue;
      if (distanceMeters(post, sup) <= radiusMeters) {
        post.sameSiteSupermarket = true;
        count++;
        break;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Binary encoder
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from('NPLSHP01', 'ascii');
const TYPE_CODE = Object.fromEntries(TYPES.map((t) => [t.key, t.code]));

const FLAG = {
  OPENING_HOURS: 0x01,
  PHONE: 0x02,
  FUEL_UNMANNED: 0x04,
  NAME_EQUALS_BRAND: 0x08,
  NAME_IS_BRAND_SUFFIX: 0x10,
  SAME_SITE_SUPERMARKET: 0x20,
};

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(buf) {
    this.chunks.push(buf);
    this.length += buf.length;
  }
  byte(v) {
    this.push(Buffer.from([v & 0xff]));
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.push(b);
  }
  varint(v) {
    if (v < 0) throw new Error('varint must be non-negative');
    const bytes = [];
    while (v >= 0x80) {
      bytes.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(v);
    this.push(Buffer.from(bytes));
  }
  zigzag(v) {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  concat() {
    return Buffer.concat(this.chunks, this.length);
  }
}

function buildStringTable(records, includeNames) {
  const strings = new Set();
  for (const r of records) {
    if (r.brand) strings.add(r.brand);
    if (includeNames && r.name) strings.add(r.name);
    if (includeNames && r.nameSuffix) strings.add(r.nameSuffix);
  }
  const sorted = [...strings].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const index = new Map(sorted.map((s, i) => [s, i + 1])); // 0 means "none"
  return { sorted, index };
}

function encode(records, { includeNames }) {
  const w = new Writer();
  w.push(MAGIC);
  w.u32(records.length);
  let prevLat = 0;
  let prevLon = 0;
  const table = buildStringTable(records, includeNames);
  for (const r of records) {
    w.zigzag(r.lat - prevLat);
    w.zigzag(r.lon - prevLon);
    prevLat = r.lat;
    prevLon = r.lon;
    w.byte(r.type);
    let flags = 0;
    if (r.openingHours) flags |= FLAG.OPENING_HOURS;
    if (r.phone) flags |= FLAG.PHONE;
    if (r.unmanned) flags |= FLAG.FUEL_UNMANNED;
    if (r.nameEqualsBrand) flags |= FLAG.NAME_EQUALS_BRAND;
    if (r.nameSuffix) flags |= FLAG.NAME_IS_BRAND_SUFFIX;
    if (r.sameSiteSupermarket) flags |= FLAG.SAME_SITE_SUPERMARKET;
    w.byte(flags);
    w.varint(r.brand ? table.index.get(r.brand) : 0);
    const storedName = includeNames ? (r.name ?? r.nameSuffix) : null;
    w.varint(storedName ? table.index.get(storedName) : 0);
  }
  w.u32(table.sorted.length);
  for (const s of table.sorted) {
    const bytes = Buffer.from(s, 'utf8');
    w.varint(bytes.length);
    w.push(bytes);
  }
  return w.concat();
}

/** Decoder used for the self-verification pass and by tools/inspect-shops.mjs. */
export function decode(buf) {
  if (buf.toString('ascii', 0, 8) !== 'NPLSHP01') throw new Error('bad magic');
  let pos = 8;
  const count = buf.readUInt32LE(pos);
  pos += 4;
  const records = [];
  let lat = 0;
  let lon = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = buf[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  };
  const readZigzag = () => {
    const n = readVarint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  };
  for (let i = 0; i < count; i++) {
    lat += readZigzag();
    lon += readZigzag();
    const type = buf[pos++];
    const flags = buf[pos++];
    const brandIdx = readVarint();
    const nameIdx = readVarint();
    records.push({ lat, lon, type, flags, brandIdx, nameIdx });
  }
  const stringCount = buf.readUInt32LE(pos);
  pos += 4;
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const len = readVarint();
    strings.push(buf.toString('utf8', pos, pos + len));
    pos += len;
  }
  if (pos !== buf.length) throw new Error(`trailing bytes: ${buf.length - pos}`);
  for (const r of records) {
    r.brand = r.brandIdx ? strings[r.brandIdx - 1] : null;
    const leaf = r.nameIdx ? strings[r.nameIdx - 1] : null;
    if (r.flags & 0x10 && r.brand) r.name = r.brand + leaf;
    else if (r.flags & 0x08) r.name = r.brand;
    else r.name = leaf;
  }
  return { count, records, strings };
}

// ---------------------------------------------------------------------------
// Sizes, statistics
// ---------------------------------------------------------------------------

function sizes(buf) {
  const gzip = zlib.gzipSync(buf, { level: 9 });
  const brotli = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
    },
  });
  return { raw: buf.length, gzip: gzip.length, brotli: brotli.length };
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(part, total) {
  return total ? ((part / total) * 100).toFixed(1) : '0.0';
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { pbf: null, out: 'data', sourceDate: null, dump: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pbf') args.pbf = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--source-date') args.sourceDate = argv[++i];
    else if (a === '--dump') args.dump = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/build-shops.mjs --pbf <file> [--out data] [--source-date YYYY-MM-DD] [--dump file.jsonl]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.pbf) throw new Error('--pbf is required');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const stat = fs.statSync(args.pbf);

  const taggedNodes = [];
  const taggedWays = [];
  const neededRefs = new Set();
  const tagCounts = Object.fromEntries(TYPES.map((t) => [t.key, 0]));
  let scannedNodes = 0;
  let scannedWays = 0;
  let overlappingObjects = 0;
  const rawTagObjects = [];

  // ---- Pass 1: tagged nodes and ways -------------------------------------
  forEachBlob(args.pbf, {
    onNode(id, latNano, lonNano, tags) {
      scannedNodes++;
      if (!matchesFilter(tags)) return;
      const matched = matchedTypes(tags);
      const type = primaryType(matched);
      if (!type) return;
      for (const k of matched) tagCounts[k]++;
      if (matched.length > 1) overlappingObjects++;
      taggedNodes.push({ id, latNano, lonNano, tags, type });
      rawTagObjects.push({ id: Number(id), kind: 'node', tags });
    },
    onWay(id, refs, tags) {
      scannedWays++;
      if (!matchesFilter(tags)) return;
      const matched = matchedTypes(tags);
      const type = primaryType(matched);
      if (!type) return;
      for (const k of matched) tagCounts[k]++;
      if (matched.length > 1) overlappingObjects++;
      for (const r of refs) neededRefs.add(r);
      taggedWays.push({ id, refs, tags, type });
      rawTagObjects.push({ id: Number(id), kind: 'way', refs: refs.length, tags });
    },
  });

  const pass1Ms = Date.now() - t0;

  // ---- Pass 2: resolve way node coordinates ------------------------------
  const nodeCoords = new Map(); // id (number) -> [latNano, lonNano]
  if (neededRefs.size) {
    const t1 = Date.now();
    forEachBlob(args.pbf, {
      onNode(id, latNano, lonNano) {
        if (!neededRefs.has(Number(id))) return;
        nodeCoords.set(Number(id), [latNano, lonNano]);
      },
      onWay() {},
    });
    var pass2Ms = Date.now() - t1;
  } else {
    var pass2Ms = 0;
  }

  // ---- Build records ------------------------------------------------------
  let records = [];
  let unresolvedRefs = 0;
  const micro = (nano) => Math.round(nano / 1000);
  const pushRecord = (lat, lon, tags, type, kind) => {
    const rawName = clean(tags.name);
    const brand = clean(tags.brand);
    const openingHours = clean(tags.opening_hours);
    const phone = clean(tags.phone);
    const unmanned = type === 'fuel' ? unmannedEvidence(tags) : null;

    // Store a name only when it is not already implied by the brand:
    //   identical to brand      -> omit, flag NAME_EQUALS_BRAND
    //   starts with the brand   -> store only the distinguishing suffix
    //   otherwise               -> store the name
    let name = rawName;
    let nameSuffix = null;
    let nameEqualsBrand = false;
    if (rawName && brand) {
      if (rawName.toLowerCase() === brand.toLowerCase()) {
        name = null;
        nameEqualsBrand = true;
      } else if (rawName.startsWith(brand)) {
        name = null;
        nameSuffix = rawName.slice(brand.length);
      }
    }

    records.push({
      lat: micro(lat),
      lon: micro(lon),
      type: TYPE_CODE[type],
      typeKey: type,
      kind,
      displayName: rawName,
      name,
      nameSuffix,
      brand,
      nameEqualsBrand,
      openingHours,
      phone,
      unmanned,
      tags,
    });
  };

  for (const n of taggedNodes) pushRecord(n.latNano, n.lonNano, n.tags, n.type, 'node');

  for (const w of taggedWays) {
    let sumLat = 0;
    let sumLon = 0;
    let count = 0;
    for (const ref of w.refs) {
      const c = nodeCoords.get(ref);
      if (!c) {
        unresolvedRefs++;
        continue;
      }
      sumLat += c[0];
      sumLon += c[1];
      count++;
    }
    if (!count) continue;
    pushRecord(sumLat / count, sumLon / count, w.tags, w.type, 'way');
  }

  // Sorted by lat, then lon (required by the binary format and by the dedupe scan).
  records.sort((a, b) => a.lat - b.lat || a.lon - b.lon);

  // ---- Collapse near-duplicates, then mark same-site hints -----------------
  const rawCount = records.length;
  const rawByType = Object.fromEntries(TYPES.map((t) => [t.key, 0]));
  const rawByKind = { node: 0, way: 0 };
  for (const r of records) {
    rawByType[r.typeKey]++;
    rawByKind[r.kind]++;
  }

  const dedupeResult = dedupeSameType(records, 50);
  records = dedupeResult.survivors;
  const sameSitePostOffices = markSameSite(records, 50);

  // ---- Encode -------------------------------------------------------------
  const fullBuf = encode(records, { includeNames: true });
  const noNamesBuf = encode(records, { includeNames: false });
  const fullSizes = sizes(fullBuf);
  const noNamesSizes = sizes(noNamesBuf);

  // ---- Self-verification --------------------------------------------------
  const decoded = decode(fullBuf);
  if (decoded.count !== records.length) throw new Error('verification: count mismatch');
  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    const b = decoded.records[i];
    if (a.lat !== b.lat || a.lon !== b.lon || a.type !== b.type) {
      throw new Error(`verification: record ${i} mismatch`);
    }
    const expectedName = a.nameEqualsBrand ? a.brand : (a.displayName ?? null);
    if ((b.name ?? null) !== expectedName) {
      throw new Error(`verification: name mismatch at record ${i}: ${JSON.stringify(b.name)} != ${JSON.stringify(expectedName)}`);
    }
  }

  // ---- Outputs ------------------------------------------------------------
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const binPath = path.join(outDir, 'shops.osm.bin');
  fs.writeFileSync(binPath, fullBuf);

  if (args.dump) {
    fs.writeFileSync(
      args.dump,
      rawTagObjects.map((o) => JSON.stringify(o)).join('\n') + '\n',
    );
  }

  // Counts per primary type and per tag.
  const byType = Object.fromEntries(TYPES.map((t) => [t.key, 0]));
  for (const r of records) byType[r.typeKey]++;

  const withHours = records.filter((r) => r.openingHours).length;
  const withPhone = records.filter((r) => r.phone).length;
  const withName = records.filter((r) => r.displayName).length;
  const withBrand = records.filter((r) => r.brand).length;
  const namesEqualBrand = records.filter((r) => r.nameEqualsBrand).length;
  const namesAsSuffix = records.filter((r) => r.nameSuffix).length;
  const storedNames = decoded.strings.length;

  const fuel = records.filter((r) => r.typeKey === 'fuel');
  const unmannedBy = { automated: 0, vending: 0, automat_name: 0, no_shop: 0 };
  for (const r of fuel) if (r.unmanned) unmannedBy[r.unmanned]++;
  const unmannedAny = fuel.filter((r) => r.unmanned).length;
  const unmannedWithHours = fuel.filter((r) => r.unmanned && r.openingHours).length;
  const automatedWithHours = fuel.filter((r) => r.unmanned === 'automated' && r.openingHours).length;
  const automatedWithShop = fuel.filter((r) => r.unmanned === 'automated' && r.tags.shop && r.tags.shop !== 'no').length;

  const hoursByType = Object.fromEntries(
    TYPES.map((t) => {
      const rows = records.filter((r) => r.typeKey === t.key);
      return [t.key, { total: rows.length, withHours: rows.filter((r) => r.openingHours).length }];
    }),
  );

  // Name-length statistics on stored names (UTF-8 bytes and code points).
  const nameRows = records
    .filter((r) => r.displayName && !r.nameEqualsBrand)
    .map((r) => ({
      name: r.displayName,
      bytes: Buffer.byteLength(r.displayName, 'utf8'),
      chars: [...r.displayName].length,
      lat: r.lat,
      lon: r.lon,
      typeKey: r.typeKey,
    }));
  const nameBytes = nameRows.map((r) => r.bytes);
  const nameChars = nameRows.map((r) => r.chars);
  const top20 = [...nameRows].sort((a, b) => b.chars - a.chars || b.bytes - a.bytes).slice(0, 20);

  const byKind = { node: records.filter((r) => r.kind === 'node').length, way: records.filter((r) => r.kind === 'way').length };
  const geometryByType = Object.fromEntries(
    TYPES.map((t) => {
      const rows = records.filter((r) => r.typeKey === t.key);
      return [t.key, { node: rows.filter((r) => r.kind === 'node').length, way: rows.filter((r) => r.kind === 'way').length }];
    }),
  );

  // Spot checks: substring match on name, case-insensitive.
  const spotChecks = SPOT_CHECKS.map((needle) => {
    const norm = normalizeName(needle);
    const hits = records
      .filter((r) => r.displayName && normalizeName(r.displayName).includes(norm))
      .map((r) => ({
        name: r.displayName,
        brand: r.brand,
        type: r.typeKey,
        lat: r.lat / 1e6,
        lon: r.lon / 1e6,
        kind: r.kind,
      }));
    return { needle, hits };
  });

  // Taginfo comparison.
  const taginfo = Object.entries(TAGINFO.counts).map(([key, expected]) => {
    const got = tagCounts[key];
    return { key, taginfo: expected, extracted: got, diff: got - expected, ratio: expected ? got / expected : null };
  });

  const sha256 = crypto.createHash('sha256').update(fullBuf).digest('hex');
  const builtAt = new Date().toISOString();

  const meta = {
    format: 'npl-shops-osm-bin',
    formatVersion: 1,
    buildDate: builtAt,
    source: {
      url: SOURCE_URL,
      extractDate: args.sourceDate,
      pbfBytes: stat.size,
    },
    attribution: ATTRIBUTION,
    licence: LICENCE,
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    tagFilter: TAG_FILTER,
    primaryTypePriority: PRIMARY_PRIORITY,
    excluded: EXCLUDED_TAGS.map(([k, v]) => `${k}=${v}`),
    counts: {
      total: records.length,
      beforeDedupe: rawCount,
      perType: byType,
      perTypeBeforeDedupe: rawByType,
      objectsPerTag: tagCounts,
      overlappingObjects,
      byGeometry: byKind,
      byGeometryBeforeDedupe: rawByKind,
      byGeometryPerType: geometryByType,
      unresolvedWayNodeRefs: unresolvedRefs,
    },
    dedupe: {
      radiusMeters: 50,
      sameTypeOnly: true,
      brandGuard: true,
      rule: 'same primary type within 50 m and not two different brands -> one record (transitive); survivor: named > more of brand/opening_hours/phone > first in sort; survivor coordinates and fields kept',
      brandConflictPairsSkipped: dedupeResult.brandConflictPairs,
      collapsedTotal: dedupeResult.collapsed,
      collapsedPerType: dedupeResult.collapsedPerType,
      groupsPerType: dedupeResult.groupsPerType,
      examples: dedupeResult.examples,
    },
    sameSite: {
      rule: 'post_office within 50 m of a supermarket (hint, not a merge)',
      postOfficesWithSupermarket: sameSitePostOffices,
    },
    fields: {
      withName,
      withBrand,
      withOpeningHours: withHours,
      withPhone,
      namesOmittedBecauseEqualToBrand: namesEqualBrand,
      namesStoredAsBrandSuffix: namesAsSuffix,
      stringTableEntries: storedNames,
    },
    openingHours: {
      total: withHours,
      ratio: records.length ? withHours / records.length : 0,
      perType: hoursByType,
    },
    fuelUnmanned: {
      heuristic: 'automated=yes -> automated; vending=* (not no) -> vending; name/brand matches /automat|selvbetjent|unbemannet/ -> automat_name; shop=no -> no_shop',
      totalFuel: fuel.length,
      unmanned: unmannedAny,
      byEvidence: unmannedBy,
      flaggedWithOpeningHours: unmannedWithHours,
      automatedWithOpeningHours: automatedWithHours,
      automatedWithShopTag: automatedWithShop,
      caveat: 'Heuristic estimate, not a fact. automated=yes is also used for car washes/payment terminals; vending=* can sit inside a staffed shop; shop=no often means only that no shop is mapped. The UI must present it as "self-service possible — check the station".',
    },
    sizes: {
      withNames: fullSizes,
      withoutNames: noNamesSizes,
      nameCost: {
        raw: fullSizes.raw - noNamesSizes.raw,
        gzip: fullSizes.gzip - noNamesSizes.gzip,
        brotli: fullSizes.brotli - noNamesSizes.brotli,
      },
      gzip: 'zlib gzip level 9',
      brotli: 'brotli quality 11, lgwin 22',
    },
    checksum: { sha256 },
    stats: {
      scannedNodes,
      scannedWays,
      taggedNodes: taggedNodes.length,
      taggedWays: taggedWays.length,
      pass1Ms,
      pass2Ms,
    },
  };
  const provenance = { ...meta, file: 'shops.osm.bin', servedAt: '/data/shops.osm.bin', builtBy: 'tools/build-shops.mjs' };
  fs.writeFileSync(path.join(outDir, 'shops.osm.json'), JSON.stringify(provenance, null, 2) + '\n');



  console.log(`wrote ${binPath} (${fmt(fullSizes.raw)} B raw, ${fmt(fullSizes.brotli)} B brotli)`);
  console.log(`POIs: ${fmt(records.length)}`, byType);
  console.log(`opening_hours: ${fmt(withHours)}/${fmt(records.length)} (${pct(withHours, records.length)}%)`);
  console.log(`unmanned fuel: ${fmt(unmannedAny)}/${fmt(fuel.length)}`);
}

// A guard that compares a percent-encoded, symlink-resolved URL with a raw path
// silently no-ops for a checkout whose path has a space or is reached through a
// symlink — and a producer that no-ops exits 0 having built nothing (D24).
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
