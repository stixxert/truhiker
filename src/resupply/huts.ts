/**
 * Huts, live from Turrutebasen (`app:RuteInfoPunkt`).
 *
 * Huts are **not** in the bundled OSM index (the extractor excludes
 * `tourism=alpine_hut|wilderness_hut`); they come from the same Geonorge WFS
 * that serves the foot routes. The traps are the same ones documented in
 * `src/snap/wfs.ts` and `docs/04`, so the guards are reused rather than retyped:
 *
 *  1. `outputFormat` is **mandatory** — omitting it returns an OWS exception.
 *  2. The bbox CRS spelling controls the axis order: `EPSG:4326` means
 *     **lon,lat**. The spelling `urn:ogc:def:crs:EPSG::4326` would silently flip
 *     it and return zero features with HTTP 200 and no error.
 *  3. `cql_filter` is ignored, so the bbox is the only server-side filter; the
 *     radius test happens client-side against the route polyline.
 *  4. Geometry comes back as GML in `urn:ogc:def:crs:EPSG::4258` — **lat,lon**,
 *     the opposite of the request order.
 *
 * ## What a hut is *not*
 *
 * A hut carries `app:opphav` (name), `app:vedlikeholdsansvarlig` (maintainer)
 * and `app:tilrettelegging` (a facility code). The code's codelist was never
 * decoded (see `docs/DECISIONS.md` D1), so the
 * betjent/selvbetjent/ubetjent classification is **not machine-readable from
 * this response**. `tilrettelegging` is therefore kept as an opaque string and
 * never interpreted. A hut has no confirmed food, no opening hours and no
 * guarantee it is even a hut rather than a trail junction — the planner treats
 * it as "not a food source" unless the caller explicitly says otherwise.
 */

import { DOMParser } from '@xmldom/xmldom';

import type { LonLat } from '../core/geo';
import {
  TURRUTE_OUTPUT_FORMAT,
  WFS_ENDPOINT,
  assertLonLatBBox,
  parsePosList,
  type LonLatBBox,
} from '../snap/wfs';
import { M_PER_DEG_LAT, RouteCorridor, lonPadDeg } from './corridor';
import type { ResupplyCandidate } from './index';

/** Re-exported so a caller can size a view query without reaching into `src/snap`. */
export type { LonLatBBox };

/** The WFS feature type for route information points (huts, junctions, …). */
export const HUT_TYPE_NAME = 'app:RuteInfoPunkt';
/** Default corridor radius for hut queries, metres. */
export const DEFAULT_HUT_RADIUS_M = 5000;
const DEFAULT_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

/** One `app:RuteInfoPunkt` waypoint, as served. */
export interface HutPoint {
  /** `identifikasjon/lokalId` when present, else the GML id. */
  readonly id: string;
  /** `app:opphav` — usually the cabin name; may be empty. */
  readonly name: string;
  readonly point: LonLat;
  /** `app:vedlikeholdsansvarlig`, e.g. "DNT | DNT Oslo og omegn". */
  readonly maintainer: string;
  /**
   * `app:tilrettelegging` — an undecoded facility code (e.g. "42" at Fondsbu).
   * Kept verbatim; **never** interpreted as a staffing class.
   */
  readonly facilityCode: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Build the GetFeature URL. The bbox is asserted to be lon/lat ordered: with
 * `EPSG:4326` the WFS expects lon before lat, and the wrong order returns zero
 * features with HTTP 200 and no error at all.
 */
export function hutGetFeatureUrl(bbox: LonLatBBox): string {
  assertLonLatBBox(bbox);
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: HUT_TYPE_NAME,
    // Mandatory for this endpoint; the space and `;` are significant.
    outputFormat: TURRUTE_OUTPUT_FORMAT,
    // lon,lat (EPSG:4326 spelling) — not lat,lon.
    bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat},EPSG:4326`,
  });
  return `${WFS_ENDPOINT}?${params.toString()}`;
}

/** Bounding box of a polyline, padded by `radiusM` on every side. */
export function hutQueryBbox(route: readonly LonLat[], radiusM: number): LonLatBBox {
  if (route.length === 0) throw new Error('hutQueryBbox needs at least one route point');
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const point of route) {
    if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
      throw new RangeError(`route point is not finite: ${String(point)}`);
    }
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  }
  const padLat = radiusM / M_PER_DEG_LAT;
  const padLon = lonPadDeg(radiusM, Math.max(Math.abs(minLat), Math.abs(maxLat)));
  return {
    minLon: minLon - padLon,
    minLat: minLat - padLat,
    maxLon: maxLon + padLon,
    maxLat: maxLat + padLat,
  };
}

// ---------------------------------------------------------------------------
// GML parsing
// ---------------------------------------------------------------------------

interface XmlNode {
  localName?: string | null;
  nodeType?: number;
  textContent?: string | null;
  childNodes?: {
    length: number;
    item?(index: number): XmlNode | null;
    [index: number]: XmlNode;
  } | null;
  attributes?: {
    length: number;
    item?(index: number): { name?: string; value?: string } | null;
    [index: number]: { name?: string; value?: string };
  } | null;
}

function childrenOf(node: XmlNode): XmlNode[] {
  const list = node.childNodes;
  if (!list) return [];
  const out: XmlNode[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const child = typeof list.item === 'function' ? list.item(i) : list[i];
    if (child) out.push(child);
  }
  return out;
}

function descendantsOf(node: XmlNode, localName: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of childrenOf(node)) {
    if (child.localName === localName) out.push(child);
    out.push(...descendantsOf(child, localName));
  }
  return out;
}

function textOf(node: XmlNode | undefined): string {
  return (node?.textContent ?? '').trim();
}

/**
 * Text that belongs to this element only, not to a nested group. A container
 * like `<app:tilrettelegging><app:Tilrettelegging/></app:tilrettelegging>`
 * therefore yields "" instead of a concatenation of its children.
 */
function ownText(node: XmlNode): string {
  let text = '';
  for (const child of childrenOf(node)) {
    // Text nodes have nodeType 3 (xmldom).
    if (child.nodeType === 3) text += child.textContent ?? '';
  }
  return text.trim();
}

function firstOwnText(root: XmlNode, localName: string): string {
  for (const node of descendantsOf(root, localName)) {
    const text = ownText(node);
    if (text !== '') return text;
  }
  return '';
}

function attributeOf(node: XmlNode, name: string): string | null {
  const attrs = node.attributes;
  if (!attrs) return null;
  for (let i = 0; i < attrs.length; i += 1) {
    const attr = typeof attrs.item === 'function' ? attrs.item(i) : attrs[i];
    if (attr && (attr.name === name || attr.name?.endsWith(`:${name}`))) {
      return attr.value ?? null;
    }
  }
  return null;
}

/**
 * Parse a GetFeature response for `app:RuteInfoPunkt`.
 *
 * Namespace-prefix tolerant (matches on `localName`). Throws on an OWS
 * exception or a non-FeatureCollection document; an empty collection is `[]`,
 * which is a legitimate answer for a bbox with no huts.
 */
export function parseHutGml(xml: string): HutPoint[] {
  if (!xml || xml.trim() === '') throw new Error('RuteInfoPunkt WFS response is empty');

  let doc: XmlNode;
  try {
    const parser = new DOMParser({
      onError: (level: string, message: string) => {
        if (level === 'fatalError') throw new Error(`Invalid XML: ${message}`);
      },
    } as never);
    doc = parser.parseFromString(xml, 'text/xml') as unknown as XmlNode;
  } catch (error) {
    throw new Error(
      `RuteInfoPunkt response is not parseable XML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const root = childrenOf(doc).find((node) => typeof node.localName === 'string') ?? doc;
  if (root.localName === 'ExceptionReport' || descendantsOf(root, 'ExceptionReport').length > 0) {
    const messages = descendantsOf(root, 'ExceptionText').map(textOf).filter(Boolean);
    throw new Error(
      `RuteInfoPunkt WFS returned an OWS exception${messages.length ? `: ${messages.join(' / ')}` : ''}`,
    );
  }
  if (root.localName !== 'FeatureCollection') {
    throw new Error(
      `RuteInfoPunkt response root is <${root.localName ?? 'unknown'}>, expected <wfs:FeatureCollection>`,
    );
  }

  const huts: HutPoint[] = [];
  for (const member of childrenOf(root).filter((node) => node.localName === 'member')) {
    const feature = childrenOf(member).find((node) => localNameIsRuteInfoPunkt(node));
    if (!feature) continue;

    const identity = descendantsOf(feature, 'Identifikasjon')[0];
    const id =
      (identity ? descendantsOf(identity, 'lokalId').map(textOf).find(Boolean) : undefined) ??
      attributeOf(feature, 'id') ??
      '';

    const point = geometryOf(feature);
    if (!point) continue; // a waypoint without a position is unusable, not an error

    huts.push({
      id,
      name: firstOwnText(feature, 'opphav'),
      point,
      maintainer: firstOwnText(feature, 'vedlikeholdsansvarlig'),
      facilityCode: firstOwnText(feature, 'tilrettelegging'),
      updatedAt: firstOwnText(feature, 'oppdateringsdato'),
    });
  }
  return huts;
}

function localNameIsRuteInfoPunkt(node: XmlNode): boolean {
  return node.localName === 'RuteInfoPunkt';
}

/**
 * First coordinate of the feature geometry.
 *
 * The response CRS is `urn:ogc:def:crs:EPSG::4258`, i.e. **lat,lon** — the
 * opposite of the request bbox order. `parsePosList` applies the axis order from
 * `srsName` and throws on a value that could only come from swapped axes, so a
 * silent flip cannot produce a plausible-looking wrong hut.
 */
function geometryOf(feature: XmlNode): LonLat | undefined {
  const pointNode = descendantsOf(feature, 'Point')[0];
  if (pointNode) {
    const pos = textOf(descendantsOf(pointNode, 'pos')[0]);
    if (pos !== '') {
      const srsName = attributeOf(pointNode, 'srsName') ?? '';
      const coords = parsePosList(pos, srsName);
      return coords[0];
    }
  }
  const line = descendantsOf(feature, 'LineString')[0];
  if (line) {
    const posList = textOf(descendantsOf(line, 'posList')[0]);
    if (posList !== '') {
      const srsName = attributeOf(line, 'srsName') ?? '';
      return parsePosList(posList, srsName)[0];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface FetchHutsOptions {
  /** Corridor radius around the route polyline, metres. Default 5,000. */
  readonly radiusM?: number;
  readonly fetchImpl?: typeof fetch;
  /** Total attempts (1 = no retry). Default 3. */
  readonly attempts?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Ceiling for the whole query, across every tile and retry. Default 15 s:
   * the panel must show the bundled shops even when Turrutebasen hangs, rather
   * than hiding them behind a spinner (D7).
   */
  readonly deadlineMs?: number;
}

/** `AbortSignal.any` is not universal; fall back to a controller. */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHutXml(url: string, options: FetchHutsOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: unknown;
  let definitive = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const signal = combineSignals(options.signal, timeoutMs);
      const response = await fetchImpl(url, {
        headers: { accept: 'application/gml+xml' },
        signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim();
        const error = new Error(
          `RuteInfoPunkt request failed: HTTP ${response.status} ${response.statusText}` +
            (snippet ? ` — ${snippet}` : ''),
        );
        // A definitive 4xx must not be retried. The flag is needed because this
        // throw is inside the try: without it the catch below would swallow a
        // 403/404 and hammer Geonorge three times with backoff.
        if (response.status < 500 && response.status !== 429) {
          definitive = true;
          throw error;
        }
        lastError = error;
      } else {
        return await response.text();
      }
    } catch (error) {
      if (definitive) throw error;
      lastError = error;
      if (options.signal?.aborted) throw error;
    }
    if (attempt < attempts) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  throw new Error(
    `RuteInfoPunkt request failed after ${attempts} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}

/** Largest bbox requested in one call. Turrutebasen has no radius filter. */
const HUT_TILE_DEG = 4;
/** Hard ceiling on requests per `fetchHutsAlong` call. */
const MAX_HUT_REQUESTS = 24;
const HUT_REQUEST_CONCURRENCY = 2;

/**
 * Split the padded route extent into bboxes.
 *
 * There is no server-side radius query (`cql_filter` is ignored and would return
 * the whole national layer), so a country-length route would ask for every hut in
 * Norway in one response. Tiles keep each request bounded and the total capped;
 * the tile size grows when needed so coverage is never silently dropped.
 */
function hutQueryTiles(route: readonly LonLat[], radiusM: number): LonLatBBox[] {
  const bbox = hutQueryBbox(route, radiusM);
  const latSpan = bbox.maxLat - bbox.minLat;
  const lonSpan = bbox.maxLon - bbox.minLon;
  const perAxis = Math.max(1, Math.floor(Math.sqrt(MAX_HUT_REQUESTS)));
  const size = Math.max(HUT_TILE_DEG, Math.max(latSpan, lonSpan) / perAxis);
  const tiles: LonLatBBox[] = [];
  for (let lat = bbox.minLat; lat < bbox.maxLat; lat += size) {
    for (let lon = bbox.minLon; lon < bbox.maxLon; lon += size) {
      tiles.push({
        minLon: lon,
        minLat: lat,
        maxLon: Math.min(lon + size, bbox.maxLon),
        maxLat: Math.min(lat + size, bbox.maxLat),
      });
    }
  }
  return tiles.length > 0 ? tiles : [bbox];
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

function dedupeHuts(huts: readonly HutPoint[]): HutPoint[] {
  const seen = new Set<string>();
  const out: HutPoint[] = [];
  for (const hut of huts) {
    const key = JSON.stringify(hut);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hut);
  }
  return out;
}

/**
 * Huts within `radiusM` of the route, as resupply candidates.
 *
 * There is **no** server-side radius query (`cql_filter` is ignored), so one
 * bbox request is issued for the padded route extent and each hut is projected
 * onto the polyline client-side; anything beyond the radius is dropped.
 *
 * Every returned hut is `evidence: 'curated'` (it is Kartverket's curated
 * Turrutebasen data, not OSM) with **no opening hours** — and, deliberately, no
 * claim about food. `planResupplyForTrip()` treats huts as "not a food source"
 * unless the caller opts in with `hutsSellFood`.
 */
export async function fetchHutsAlong(
  route: readonly LonLat[],
  opts: FetchHutsOptions = {},
): Promise<ResupplyCandidate[]> {
  if (route.length === 0) throw new Error('fetchHutsAlong needs at least one route point');
  const radiusM = opts.radiusM ?? DEFAULT_HUT_RADIUS_M;
  if (!(radiusM > 0) || Number.isNaN(radiusM)) {
    throw new RangeError(`invalid hut radius: ${radiusM}`);
  }

  const tiles = hutQueryTiles(route, radiusM);
  // One deadline for all tiles: a hanging WFS must not hold the panel hostage.
  // When it fires, `fetchHutXml` throws and the caller reports a partial result.
  const signal = combineSignals(opts.signal, opts.deadlineMs ?? 15_000);
  const responses = await mapLimited(tiles, HUT_REQUEST_CONCURRENCY, (bbox) =>
    fetchHutXml(hutGetFeatureUrl(bbox), { ...opts, signal }),
  );
  const huts = dedupeHuts(responses.flatMap((xml) => parseHutGml(xml)));

  const corridor = new RouteCorridor(route);
  const out: ResupplyCandidate[] = [];
  const seen = new Set<string>();
  for (const hut of huts) {
    const hit = corridor.projectWithin(hut.point, radiusM);
    if (!hit) continue;
    const key = hut.id !== '' ? hut.id : `${hut.point.lat.toFixed(6)},${hut.point.lon.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'hut',
      name: hut.name !== '' ? hut.name : '(unnamed hut)',
      point: hut.point,
      alongRouteM: hit.alongM,
      detourM: hit.detourM,
      evidence: 'curated',
      // No opening hours: Turrutebasen carries none, and an unknown hut is not
      // "always open". The value is omitted rather than guessed.
    });
  }
  return out.sort((a, b) => a.alongRouteM - b.alongRouteM);
}

/**
 * Huts **inside a view box**, as resupply candidates.
 *
 * This is what the map asks for, and it is not `fetchHutsAlong`. A route wants
 * the corridor test; a view is a box, and projecting a box's huts onto that
 * box's **diagonal** drops everything more than a radius off it — measured at
 * z12 over Gjendesheim, the WFS returned 3 waypoints in view and the corridor
 * kept 2. Here the box itself is the filter, so what Turrutebasen returned
 * inside the view is what the map draws.
 *
 * `alongRouteM` and `detourM` are `0`: there is no route in play, which is the
 * same convention the bundled index uses for `within()`.
 */
export async function fetchHutsInBounds(
  bounds: LonLatBBox,
  opts: Omit<FetchHutsOptions, 'radiusM'> = {},
): Promise<ResupplyCandidate[]> {
  assertLonLatBBox(bounds);
  // `hutQueryTiles` pads by a radius; here the caller's box is the box fetched.
  const tiles = hutQueryTiles(
    [
      { lon: bounds.minLon, lat: bounds.minLat },
      { lon: bounds.maxLon, lat: bounds.maxLat },
    ],
    0,
  );
  // One deadline for all tiles: a hanging WFS must not hold the map hostage.
  const signal = combineSignals(opts.signal, opts.deadlineMs ?? 15_000);
  const responses = await mapLimited(tiles, HUT_REQUEST_CONCURRENCY, (bbox) =>
    fetchHutXml(hutGetFeatureUrl(bbox), { ...opts, signal }),
  );
  const huts = dedupeHuts(responses.flatMap((xml) => parseHutGml(xml)));

  const out: ResupplyCandidate[] = [];
  const seen = new Set<string>();
  for (const hut of huts) {
    // The tile is the box (nothing is padded), so this re-filter is defensive:
    // it also keeps the promise local if the tiler ever pads again.
    if (hut.point.lat < bounds.minLat || hut.point.lat > bounds.maxLat) continue;
    if (hut.point.lon < bounds.minLon || hut.point.lon > bounds.maxLon) continue;
    const key = hut.id !== '' ? hut.id : `${hut.point.lat.toFixed(6)},${hut.point.lon.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'hut',
      name: hut.name !== '' ? hut.name : '(unnamed hut)',
      point: hut.point,
      alongRouteM: 0,
      detourM: 0,
      evidence: 'curated',
      // No opening hours: Turrutebasen carries none.
    });
  }
  return out;
}
