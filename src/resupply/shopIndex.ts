/**
 * The bundled resupply index — `data/shops.osm.bin`, read without dependencies.
 *
 * The byte layout is specified in `tools/README.md` and produced by
 * `tools/build-shops.mjs`; it is **not** re-derived here. Summary:
 *
 * ```
 * header   'NPLSHP01' (8) | count uint32 (4)
 * records  count × { latDelta zigzag-varint, lonDelta zigzag-varint,
 *                    type u8, flags u8, brandIdx varint, nameIdx varint }
 * strings  stringCount uint32 | stringCount × { byteLength varint, UTF-8 bytes }
 * ```
 *
 * Coordinates are int32 **microdegrees**, delta-encoded against the previous
 * record and sorted by latitude then longitude. The string table is
 * deduplicated and sorted; `brandIdx`/`nameIdx` are 1-based (`0` = absent).
 *
 * Honesty about what the file does *not* contain:
 *
 * - `opening_hours` exists only as a **presence bit** (`0x01`). The text is not
 *   stored, so `ResupplyCandidate.openingHours` is never set from this file —
 *   `hoursRecorded` says only "OSM had an hours tag". A point with no hours is
 *   labelled unverified, never assumed open.
 * - There is no build timestamp in the binary. `builtAt` is therefore a module
 *   constant naming the committed extract (`data/MEASUREMENTS.md`), overridable
 *   through `parseShopIndex(buffer, { builtAt })`.
 * - The `0x04` "unmanned fuel" bit is a heuristic from the extractor, not a fact.
 */

import { haversine, type LonLat } from '../core/geo';
import { M_PER_DEG_LAT, RouteCorridor, lonPadDeg } from './corridor';
import type { ResupplyCandidate, ShopIndex } from './index';

/** 8 ASCII bytes at offset 0. The trailing `01` is the format version. */
export const SHOP_INDEX_MAGIC = 'NPLSHP01';
/** Where the bundled file is served from. */
export const SHOP_INDEX_PATH = '/data/shops.osm.bin';
/**
 * Build date of the committed extract (`data/MEASUREMENTS.md`,
 * `data/shops.osm.json`). The binary itself carries no date, so a *different*
 * file must be labelled by its caller through `parseShopIndex(buffer, { builtAt })`.
 */
export const COMMITTED_INDEX_BUILT_AT = '2026-10-19T13:41:49.167Z';

/** Binary type byte → candidate kind. `post_office` and `parcel_locker` split. */
const KIND_BY_TYPE = [
  'supermarket',
  'convenience',
  'general',
  'grocery',
  'fuel',
  'post',
  'parcel',
] as const;

const FLAG = {
  OPENING_HOURS: 0x01,
  PHONE: 0x02,
  FUEL_UNMANNED: 0x04,
  NAME_EQUALS_BRAND: 0x08,
  NAME_IS_BRAND_SUFFIX: 0x10,
  /**
   * `0x20` — this post office sits within 50 m of a supermarket. Parsed into the
   * file but not used yet: `ResupplyPoint` has no same-site field, so the
   * planner shows the two records as two stops rather than merging the site.
   */
  SAME_SITE_SUPERMARKET: 0x20,
} as const;

export type ShopIndexErrorReason =
  | 'bad-magic'
  | 'bad-version'
  | 'truncated'
  | 'bad-record'
  | 'trailing-bytes';

/**
 * A malformed index file. Typed so callers can tell "this is not our file" from
 * "the network failed", and so a version bump is detectable rather than silent.
 */
export class ShopIndexFormatError extends Error {
  readonly reason: ShopIndexErrorReason;

  constructor(reason: ShopIndexErrorReason, message: string) {
    super(message);
    this.name = 'ShopIndexFormatError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

class Cursor {
  private readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.pos === this.bytes.length;
  }

  byte(): number {
    if (this.pos >= this.bytes.length) {
      throw new ShopIndexFormatError('truncated', `index ends at byte ${this.pos}: expected a byte`);
    }
    return this.bytes[this.pos++];
  }

  uint32(): number {
    if (this.pos + 4 > this.bytes.length) {
      throw new ShopIndexFormatError(
        'truncated',
        `index ends at byte ${this.pos}: expected a uint32`,
      );
    }
    const b = this.bytes;
    const value =
      (b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16) | (b[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return value;
  }

  /** Unsigned LEB128. */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) {
        throw new ShopIndexFormatError('bad-record', 'varint overflow in index record');
      }
    }
    if (!Number.isSafeInteger(result)) {
      throw new ShopIndexFormatError('bad-record', `varint out of safe range: ${result}`);
    }
    return result;
  }

  /** Two's-complement zigzag varint. */
  zigzag(): number {
    const value = this.varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  utf8(length: number): string {
    if (this.pos + length > this.bytes.length) {
      throw new ShopIndexFormatError(
        'truncated',
        `string of ${length} bytes at ${this.pos} runs past the end of the index`,
      );
    }
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return new TextDecoder().decode(slice);
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One parsed record, kept in column form by `BundledShopIndex`. */
interface ParsedRecords {
  readonly kinds: Uint8Array;
  readonly flags: Uint8Array;
  /** Latitude in microdegrees (int32). */
  readonly lats: Int32Array;
  /** Longitude in microdegrees (int32). */
  readonly lons: Int32Array;
  /** Display name after the brand/suffix reconstruction rules. */
  readonly names: string[];
}

function decodeName(
  flags: number,
  brand: string | undefined,
  stored: string | undefined,
): string {
  if ((flags & FLAG.NAME_IS_BRAND_SUFFIX) !== 0) return (brand ?? '') + (stored ?? '');
  if ((flags & FLAG.NAME_EQUALS_BRAND) !== 0) return brand ?? stored ?? '(unnamed)';
  return stored ?? brand ?? '(unnamed)';
}

function readRecords(bytes: Uint8Array, count: number): ParsedRecords {
  const cursor = new Cursor(bytes);
  cursor.pos = 12; // magic + count
  const kinds = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const lats = new Int32Array(count);
  const lons = new Int32Array(count);
  /** 0 = absent, otherwise 1-based index into the string table. */
  const brandIdx = new Int32Array(count);
  const nameIdx = new Int32Array(count);

  let lat = 0;
  let lon = 0;
  for (let i = 0; i < count; i += 1) {
    lat += cursor.zigzag();
    lon += cursor.zigzag();
    const type = cursor.byte();
    const flag = cursor.byte();
    const brand = cursor.varint();
    const name = cursor.varint();
    if (type >= KIND_BY_TYPE.length) {
      throw new ShopIndexFormatError('bad-record', `record ${i}: unknown type byte ${type}`);
    }
    if (Math.abs(lat) > 90_000_000 || Math.abs(lon) > 180_000_000) {
      throw new ShopIndexFormatError(
        'bad-record',
        `record ${i}: coordinates outside WGS84 (lat ${lat}, lon ${lon} microdegrees)`,
      );
    }
    kinds[i] = type;
    flags[i] = flag;
    lats[i] = lat;
    lons[i] = lon;
    // The file stores these as 64-bit varints but we keep them in Int32Array;
    // a value that would truncate must be rejected rather than alias the wrong
    // string in the table.
    if (brand > 0x7fffffff || name > 0x7fffffff) {
      throw new ShopIndexFormatError('bad-record', `string index out of range at record ${i}`);
    }
    brandIdx[i] = brand;
    nameIdx[i] = name;
  }

  const stringCount = cursor.uint32();
  const strings = new Array<string>(stringCount);
  for (let i = 0; i < stringCount; i += 1) {
    strings[i] = cursor.utf8(cursor.varint());
  }
  if (!cursor.done) {
    throw new ShopIndexFormatError(
      'trailing-bytes',
      `index has ${bytes.length - cursor.pos} trailing byte(s) after the string table`,
    );
  }

  const lookup = (index: number, what: string, record: number): string | undefined => {
    if (index === 0) return undefined;
    const value = strings[index - 1];
    if (value === undefined) {
      throw new ShopIndexFormatError(
        'bad-record',
        `record ${record}: ${what} index ${index} is outside the ${stringCount}-entry string table`,
      );
    }
    return value;
  };

  const names = new Array<string>(count);
  for (let i = 0; i < count; i += 1) {
    names[i] = decodeName(flags[i], lookup(brandIdx[i], 'brand', i), lookup(nameIdx[i], 'name', i));
  }

  return { kinds, flags, lats, lons, names };
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

class BundledShopIndex implements ShopIndex {
  readonly count: number;
  readonly builtAt: string;
  /** Byte length of the parsed file, for provenance/logging. */
  readonly byteLength: number;

  private readonly records: ParsedRecords;
  private readonly types: Int32Array;

  constructor(records: ParsedRecords, builtAt: string, byteLength: number) {
    this.records = records;
    this.count = records.kinds.length;
    this.builtAt = builtAt;
    this.byteLength = byteLength;
    this.types = Int32Array.from(records.kinds);
  }

  alongRoute(points: readonly LonLat[], radiusM: number): ResupplyCandidate[] {
    if (points.length === 0) throw new Error('alongRoute needs at least one route point');
    if (!(radiusM >= 0) || Number.isNaN(radiusM)) {
      throw new RangeError(`invalid corridor radius: ${radiusM}`);
    }
    const corridor = new RouteCorridor(points);

    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let minLon = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
      minLon = Math.min(minLon, point.lon);
      maxLon = Math.max(maxLon, point.lon);
    }
    const padLat = radiusM / M_PER_DEG_LAT;
    const padLon = lonPadDeg(radiusM, Math.max(Math.abs(minLat), Math.abs(maxLat)));

    const out: ResupplyCandidate[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.count; i += 1) {
      const lat = this.records.lats[i] / 1e6;
      const lon = this.records.lons[i] / 1e6;
      if (lat < minLat - padLat || lat > maxLat + padLat) continue;
      if (lon < minLon - padLon || lon > maxLon + padLon) continue;
      const hit = corridor.projectWithin({ lon, lat }, radiusM);
      if (!hit) continue;
      const candidate = this.candidateAt(i, hit.alongM, hit.detourM);
      // A route that passes the same shop twice yields one candidate, at the
      // first passage: two rows for one building is noise, not a resupply point.
      const key = `${candidate.kind}|${candidate.name}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    return out.sort(compareAlongRoute);
  }

  /**
   * Every point inside a bounding box, for the map's "what is around me" layer.
   *
   * The index is a flat, in-memory array: this is a scan of 8 571 records, which
   * costs nothing next to a tile request. `limit` keeps a zoomed-out view from
   * pushing the whole national extract into a GeoJSON source.
   *
   * The cap is applied as a **stride over the matches**, never as a stop in the
   * scan. The records are stored in latitude order, so taking the first `limit`
   * hits kept only the southern edge of a wide view: a country-sized view drew
   * a band of badges along the south coast and left the rest of the map bare.
   * A stride keeps the coverage even across the box and the count bounded.
   */
  within(
    bounds: { west: number; south: number; east: number; north: number },
    limit = 2_000,
  ): ResupplyCandidate[] {
    // An empty answer reads as "no shops here", which is the one thing this
    // layer must never say by accident — so a nonsense cap is an error.
    if (!(limit >= 0)) throw new RangeError(`invalid view limit: ${limit}`);
    const matches: number[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const lat = this.records.lats[i] / 1e6;
      if (lat < bounds.south || lat > bounds.north) continue;
      const lon = this.records.lons[i] / 1e6;
      if (lon < bounds.west || lon > bounds.east) continue;
      matches.push(i);
    }
    const kept = Math.min(Math.floor(limit), matches.length);
    const stride = kept === 0 ? 1 : matches.length / kept;
    const out: ResupplyCandidate[] = [];
    // Half a stride of offset, so the samples sit in the middle of each band
    // rather than hugging the box's southern edge.
    for (let k = 0; k < kept; k += 1) {
      out.push(this.candidateAt(matches[Math.floor((k + 0.5) * stride)] as number, 0, 0));
    }
    return out;
  }

  near(point: LonLat, radiusM: number): ResupplyCandidate[] {
    if (!(radiusM >= 0) || Number.isNaN(radiusM)) {
      throw new RangeError(`invalid radius: ${radiusM}`);
    }
    const out: ResupplyCandidate[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const lat = this.records.lats[i] / 1e6;
      const lon = this.records.lons[i] / 1e6;
      // Cheap latitude reject before the trigonometry.
      if (Math.abs(lat - point.lat) * M_PER_DEG_LAT > radiusM + 1) continue;
      const detour = haversine({ lon, lat }, point);
      if (detour > radiusM) continue;
      // `near()` has no route, so along-route distance is the query point's 0.
      out.push(this.candidateAt(i, 0, detour));
    }
    return out.sort(compareDetourThenName);
  }

  private candidateAt(i: number, alongM: number, detourM: number): ResupplyCandidate {
    const kind = KIND_BY_TYPE[this.types[i]];
    const flags = this.records.flags[i];
    const candidate: ResupplyCandidate = {
      kind,
      name: this.records.names[i],
      point: { lon: this.records.lons[i] / 1e6, lat: this.records.lats[i] / 1e6 },
      alongRouteM: alongM,
      detourM,
      // Bundled OSM data, and nothing else: no chain store-locator join, no
      // curation. `chain-verified`/`curated` are for other sources.
      evidence: 'osm',
      // The value of `opening_hours` was not stored — only its presence.
      hoursRecorded: (flags & FLAG.OPENING_HOURS) !== 0,
      ...(kind === 'fuel' && (flags & FLAG.FUEL_UNMANNED) !== 0 ? { unmanned: true } : {}),
    };
    return candidate;
  }
}

function compareAlongRoute(a: ResupplyCandidate, b: ResupplyCandidate): number {
  if (a.alongRouteM !== b.alongRouteM) return a.alongRouteM - b.alongRouteM;
  if (a.detourM !== b.detourM) return a.detourM - b.detourM;
  return a.name.localeCompare(b.name);
}

function compareDetourThenName(a: ResupplyCandidate, b: ResupplyCandidate): number {
  if (a.detourM !== b.detourM) return a.detourM - b.detourM;
  return a.name.localeCompare(b.name);
}

/**
 * Parse a `shops.osm.bin` buffer. Pure: no network, no clock, no globals.
 *
 * `builtAt` is the date to *label* the data with. The binary stores none, so it
 * defaults to the committed extract's build date; pass the real date when the
 * file came from somewhere else.
 */
export function parseShopIndex(
  buffer: ArrayBuffer,
  options: { builtAt?: string } = {},
): ShopIndex {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 12) {
    throw new ShopIndexFormatError(
      'truncated',
      `shop index is ${bytes.byteLength} bytes; the header alone is 12`,
    );
  }
  let magic = '';
  for (let i = 0; i < 8; i += 1) magic += String.fromCharCode(bytes[i]);
  if (magic !== SHOP_INDEX_MAGIC) {
    if (/^NPLSHP\d\d$/.test(magic)) {
      throw new ShopIndexFormatError(
        'bad-version',
        `shop index version ${magic.slice(-2)} is not supported (expected ${SHOP_INDEX_MAGIC}); ` +
          'the record layout may have changed — rebuild with tools/build-shops.mjs',
      );
    }
    throw new ShopIndexFormatError(
      'bad-magic',
      `not a shop index: magic "${magic.replace(/[^\x20-\x7e]/g, '?')}" (expected ${SHOP_INDEX_MAGIC})`,
    );
  }

  const cursor = new Cursor(bytes);
  cursor.pos = 8;
  const count = cursor.uint32();
  if (count * 6 > bytes.byteLength) {
    throw new ShopIndexFormatError(
      'truncated',
      `header claims ${count} records, but the file is only ${bytes.byteLength} bytes`,
    );
  }

  const records = readRecords(bytes, count);
  return new BundledShopIndex(
    records,
    options.builtAt ?? COMMITTED_INDEX_BUILT_AT,
    bytes.byteLength,
  );
}

/**
 * Fetch and parse the bundled index. `fetchImpl` is injectable so tests never
 * touch the network; `fetch` is the only I/O in this module.
 *
 * Not preloaded from `index.html`: a `<link rel="preload">` makes Vite treat the
 * file as a source asset and emit a second, content-hashed copy next to the one
 * `tools/verify/copy-data.mjs` ships — 170 KB of duplicate for a request the app
 * already starts at boot (`App.prefetchShopIndex`).
 */
export async function loadShopIndex(fetchImpl: typeof fetch): Promise<ShopIndex> {
  const response = await fetchImpl(SHOP_INDEX_PATH, {
    headers: { accept: 'application/octet-stream' },
  });
  if (!response.ok) {
    throw new Error(
      `shop index fetch failed: HTTP ${response.status} ${response.statusText} from ${SHOP_INDEX_PATH}`,
    );
  }
  return parseShopIndex(await response.arrayBuffer());
}
