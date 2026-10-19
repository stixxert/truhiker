/**
 * Turrutebasen WFS client (Geonorge, `app:Fotrute`).
 *
 * The service is a WFS 2.0 endpoint that works, but only if you respect a set
 * of undocumented traps. They are encoded in the code and in the tests:
 *
 *  1. `outputFormat` is **mandatory**, and the only value that works is
 *     `application/gml+xml; version=3.2` (the `+` URL-encoded as `%2B`).
 *     Omitting it returns an OWS exception, not data.
 *  2. The bbox CRS spelling controls the axis order. `EPSG:4326` means
 *     **lon,lat**; `urn:ogc:def:crs:EPSG::4326` flips it to **lat,lon**.
 *     The wrong spelling returns *zero features with HTTP 200 and no error*,
 *     so `assertLonLatBBox()` refuses a bbox that looks swapped.
 *  3. `cql_filter` is silently ignored (no error, no filtering). There is no
 *     server-side radius query: fetch a bbox and distance-test client-side.
 *  4. The geometry is GML `posList` in `urn:ogc:def:crs:EPSG::4258`
 *     (ETRS89, lat/lon order) — note that the *response* axis order differs
 *     from the *request* axis order.
 *
 * Requests are capped at 2 concurrent and retried on 429/5xx/timeouts. The
 * client never widens the bbox: a caller asking for 1 km gets 1 km.
 */

import { DOMParser } from '@xmldom/xmldom';

import type { LonLat } from '../core/geo';

export type { LonLat };

/** Geographic bounding box in WGS84 degrees, always lon/lat order. */
export interface LonLatBBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** Attributes carried by a Turrutebasen foot route. */
export interface TurruteAttributes {
  /** `identifikasjon/lokalId` (UUID). */
  lokalId: string;
  /** Route name; often the literal string "Ukjent". */
  rutenavn: string;
  /** Route number, e.g. "jot27". Case is inconsistent in the source data. */
  rutenummer: string;
  /** Maintainer, e.g. "DNT | Kristiansund og Nordmøre Turistforening". */
  vedlikeholdsansvarlig: string;
  /** Difficulty G/B/R (green/blue/red); often empty. */
  gradering: string;
  /** Waymarking JA/NEI. */
  merking: string;
  /** What the route follows (ST = sti, …); top-level in the WFS response. */
  ruteFolger: string;
  /** Surface type; often empty. */
  underlagstype: string;
  /** Season; often empty. */
  sesong: string;
  /** Top-level `oppdateringsdato`, ISO timestamp. */
  oppdateringsdato: string;
}

/** One polyline of one foot route, in lon/lat degrees. */
export interface TurruteLine {
  /** Stable id: `<lokalId>` for a single geometry, `<lokalId>#n` if split. */
  id: string;
  lokalId: string;
  attributes: TurruteAttributes;
  coords: LonLat[];
  /** CRS string from the GML geometry, kept for diagnostics. */
  srsName: string;
}

/** Result of one GetFeature request. */
export interface TurruteBoxResult {
  lines: TurruteLine[];
  /** `numberMatched` from the collection; may be `undefined` ("unknown"). */
  numberMatched?: number;
  /** `numberReturned` from the collection; the server currently always says 0. */
  numberReturned?: number;
  /** Number of features (members) parsed, independent of `lines.length`. */
  featureCount: number;
  /** The exact URL that produced this result (for logging / debugging). */
  url: string;
}

export interface FetchTurruteOptions {
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Total attempts (1 = no retry). Default 3. */
  attempts?: number;
  /** Base backoff in ms (doubles each attempt). Default 400. */
  retryBaseMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  /** Caller abort signal (supersede/cancel). */
  signal?: AbortSignal;
  /**
   * Upper bound on features requested. Omitted by default: the caller's bbox
   * is the only limit, and WFS servers may impose their own.
   */
  count?: number;
}

export const WFS_ENDPOINT = 'https://wfs.geonorge.no/skwms1/wfs.turogfriluftsruter';
export const TURRUTE_TYPE_NAME = 'app:Fotrute';

/**
 * Mandatory. The OWS endpoint only serves GML 3.2 for this layer. The semicolon
 * and the space are significant; `+` must survive URL encoding.
 */
export const TURRUTE_OUTPUT_FORMAT = 'application/gml+xml; version=3.2';

/**
 * Default cache partition. Bump when Geonorge publishes a new dataset version;
 * there is deliberately no wall-clock TTL, so a stale dataset is never served
 * under the new version key.
 */
export const DEFAULT_DATA_VERSION = 'turrute-2026-10';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// Request construction (the axis-order trap)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a bounding box and assert that it is lon/lat ordered.
 *
 * In Norway longitude is roughly 3–32 °E and latitude 57–72 °N, so a bbox
 * whose *first* axis sits in the latitude band while its *second* axis sits in
 * the longitude band is almost certainly a lat/lon bbox passed by mistake.
 * Such a request would return HTTP 200 with zero features, so throwing here is
 * the only way the caller finds out.
 */
export function assertLonLatBBox(bbox: LonLatBBox): void {
  for (const [name, value] of Object.entries(bbox)) {
    if (!isFiniteNumber(value)) {
      throw new RangeError(`Turrute bbox.${name} is not a finite number (${String(value)})`);
    }
  }
  if (!(bbox.maxLon > bbox.minLon) || !(bbox.maxLat > bbox.minLat)) {
    throw new RangeError(
      `Turrute bbox must have maxLon > minLon and maxLat > minLat, got ${JSON.stringify(bbox)}`,
    );
  }
  if (bbox.minLon < -180 || bbox.maxLon > 180 || bbox.minLat < -90 || bbox.maxLat > 90) {
    throw new RangeError(
      `Turrute bbox is outside lon ±180 / lat ±90: ${JSON.stringify(bbox)}`,
    );
  }

  // Swapped-axis heuristic for Norway: first axis in the latitude band and
  // second axis in the longitude band.
  const looksLikeLatitude = (v: number): boolean => v >= 55 && v <= 73;
  const looksLikeLongitude = (v: number): boolean => v >= 0 && v <= 35;
  if (
    looksLikeLatitude(bbox.minLon) &&
    looksLikeLatitude(bbox.maxLon) &&
    looksLikeLongitude(bbox.minLat) &&
    looksLikeLongitude(bbox.maxLat)
  ) {
    throw new RangeError(
      `Turrute bbox looks like lat,lon order (${JSON.stringify(bbox)}): ` +
        `with EPSG:4326 the WFS expects lon,lat. ` +
        `The wrong order returns zero features with HTTP 200 and no error.`,
    );
  }
}

/**
 * Build a GetFeature URL. `bbox` must be lon/lat ordered (asserted here).
 *
 * Note: `resultType=hits` is supported for cheap feature counting; the same
 * mandatory `outputFormat` applies.
 */
export function turruteGetFeatureUrl(
  bbox: LonLatBBox,
  options: { resultType?: 'results' | 'hits'; count?: number } = {},
): string {
  assertLonLatBBox(bbox);
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: TURRUTE_TYPE_NAME,
    outputFormat: TURRUTE_OUTPUT_FORMAT,
    // `EPSG:4326` + lon,lat is the one spelling that works. Do not use
    // `urn:ogc:def:crs:EPSG::4326` here: it silently swaps the axes.
    bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat},EPSG:4326`,
  });
  if (options.resultType && options.resultType !== 'results') {
    params.set('resultType', options.resultType);
  }
  if (options.count !== undefined) {
    if (!Number.isInteger(options.count) || options.count < 1) {
      throw new RangeError(`Turrute count must be a positive integer, got ${options.count}`);
    }
    params.set('count', String(options.count));
  }
  // Never send cql_filter: the server silently ignores it.
  return `${WFS_ENDPOINT}?${params.toString()}`;
}

export function turruteHitsUrl(bbox: LonLatBBox): string {
  return turruteGetFeatureUrl(bbox, { resultType: 'hits' });
}

// ---------------------------------------------------------------------------
// GML parsing
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of an xmldom node. Keeping our own shape avoids
 * fighting over the DOM `Element` types from lib.dom vs @xmldom/xmldom.
 */
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

function childNodesOf(node: XmlNode): XmlNode[] {
  const list = node.childNodes;
  if (!list) return [];
  const out: XmlNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const child = typeof list.item === 'function' ? list.item(i) : list[i];
    if (child) out.push(child);
  }
  return out;
}

function elementsOf(node: XmlNode, localName: string): XmlNode[] {
  return childNodesOf(node).filter((child) => child.localName === localName);
}

function descendantsOf(node: XmlNode, localName: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of childNodesOf(node)) {
    if (child.localName === localName) out.push(child);
    out.push(...descendantsOf(child, localName));
  }
  return out;
}

function attributeOf(node: XmlNode, name: string): string | null {
  const attrs = node.attributes;
  if (!attrs) return null;
  for (let i = 0; i < attrs.length; i++) {
    const attr = typeof attrs.item === 'function' ? attrs.item(i) : attrs[i];
    if (attr && (attr.name === name || attr.name?.endsWith(`:${name}`))) {
      return attr.value ?? null;
    }
  }
  return null;
}

function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  return (node.textContent ?? '').trim();
}

function firstText(root: XmlNode, localName: string): string {
  const [node] = descendantsOf(root, localName);
  return textOf(node);
}

function nonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value.trim() !== '') return value.trim();
  }
  return '';
}

/** XML axis order of a GML `srsName`. */
export type GmlAxisOrder = 'lat-lon' | 'lon-lat';

/**
 * Determine the axis order of a GML posList from its `srsName`.
 *
 * Per GML 3.2 / EPSG, the `urn:ogc:def:crs:EPSG::<code>` form is **lat,lon**
 * for geographic CRSs (EPSG:4326, EPSG:4258), while a plain `EPSG:<code>` or
 * `OGC:CRS84` is lon,lat. Turrutebasen serves `urn:ogc:def:crs:EPSG::4258`,
 * i.e. lat first — the opposite of the request bbox order.
 */
export function gmlAxisOrder(srsName: string): GmlAxisOrder {
  const trimmed = srsName.trim();
  if (/^urn:ogc:def:crs:EPSG::(4326|4258)$/i.test(trimmed)) return 'lat-lon';
  if (/^urn:ogc:def:crs:OGC:1\.3:CRS84$/i.test(trimmed)) return 'lon-lat';
  return 'lon-lat';
}

/**
 * Parse a GML `posList` into lon/lat points.
 *
 * Throws on a malformed list or on a lat/lon pair whose latitude is outside
 * ±90°, which is what a silently swapped axis order looks like. Returning
 * garbage coordinates would be worse than failing.
 */
export function parsePosList(posList: string, srsName: string): LonLat[] {
  const numbers = posList
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(Number);
  if (numbers.length === 0) return [];
  if (numbers.some((value) => !Number.isFinite(value))) {
    throw new Error(`GML posList contains a non-numeric value: ${posList.slice(0, 120)}…`);
  }
  if (numbers.length % 2 !== 0) {
    throw new Error(
      `GML posList has an odd number of ordinates (${numbers.length}); expected lon/lat pairs`,
    );
  }

  const order = gmlAxisOrder(srsName);
  const coords: LonLat[] = [];
  for (let i = 0; i < numbers.length; i += 2) {
    const first = numbers[i];
    const second = numbers[i + 1];
    const lat = order === 'lat-lon' ? first : second;
    const lon = order === 'lat-lon' ? second : first;
    if (Math.abs(lat) > 90) {
      throw new Error(
        `GML posList looks axis-swapped for srsName="${srsName}": ` +
          `latitude ${lat} is outside ±90° (pair ${first},${second})`,
      );
    }
    if (Math.abs(lon) > 180) {
      throw new Error(
        `GML posList has longitude ${lon} outside ±180° for srsName="${srsName}"`,
      );
    }
    coords.push({ lon, lat });
  }
  return coords;
}

function parseNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** `numberMatched`/`numberReturned` may be "unknown"; parse only real counts. */
function parseCount(value: string | null): number | undefined {
  return parseNumber(value);
}

/**
 * Parse a GetFeature response into polylines plus attributes.
 *
 * Namespace-prefix tolerant: matches on `localName`, so the documented `app:`
 * / `gml:` / `wfs:` prefixes are not hard-coded.
 *
 * Throws if the document is not a FeatureCollection or is an OWS exception —
 * an empty result is legitimately `[]`, but an XML error page is not.
 */
export function parseTurruteGml(xml: string): {
  lines: TurruteLine[];
  featureCount: number;
  numberMatched?: number;
  numberReturned?: number;
} {
  if (!xml || xml.trim() === '') {
    throw new Error('Turrute WFS response is empty');
  }

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
      `Turrute WFS response is not parseable XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const root =
    childNodesOf(doc).find((node) => typeof node.localName === 'string') ??
    (doc as unknown as { documentElement?: XmlNode }).documentElement ??
    doc;
  if (root.localName === 'ExceptionReport' || descendantsOf(root, 'ExceptionReport').length > 0) {
    const messages = descendantsOf(root, 'ExceptionText').map(textOf).filter(Boolean);
    throw new Error(
      `Turrute WFS returned an OWS exception${messages.length ? `: ${messages.join(' / ')}` : ''}`,
    );
  }
  if (root.localName !== 'FeatureCollection') {
    throw new Error(
      `Turrute WFS response root is <${root.localName ?? 'unknown'}>, expected <wfs:FeatureCollection>`,
    );
  }

  const numberMatched = parseCount(attributeOf(root, 'numberMatched'));
  const numberReturned = parseCount(attributeOf(root, 'numberReturned'));

  const lines: TurruteLine[] = [];
  let featureCount = 0;

  for (const member of elementsOf(root, 'member')) {
    const feature = childNodesOf(member).find((node) => node.localName === 'Fotrute');
    if (!feature) continue;
    featureCount++;

    const gmlId = attributeOf(feature, 'id') ?? '';
    const identifikasjon = descendantsOf(feature, 'Identifikasjon')[0];
    const lokalId = nonEmpty(
      textOf(identifikasjon ? descendantsOf(identifikasjon, 'lokalId')[0] : undefined),
      firstText(feature, 'lokalId'),
      gmlId,
    );

    // A feature may carry several FotruteInfo groups (one per route number);
    // flatten with "first non-empty wins" and keep every route number.
    const infoBlocks = descendantsOf(feature, 'FotruteInfo').filter((node) => {
      // `fotruteInfo` (lower-case f) is the group, `FotruteInfo` the entry.
      return node.localName === 'FotruteInfo';
    });
    const infoText = (name: string): string => {
      for (const block of infoBlocks) {
        const value = textOf(descendantsOf(block, name)[0]);
        if (value !== '') return value;
      }
      return '';
    };

    const attributeText = (name: string): string =>
      nonEmpty(firstText(feature, name), infoText(name));

    const attributes: TurruteAttributes = {
      lokalId,
      rutenavn: infoText('rutenavn'),
      rutenummer: infoText('rutenummer'),
      vedlikeholdsansvarlig: infoText('vedlikeholdsansvarlig'),
      gradering: infoText('gradering'),
      merking: attributeText('merking'),
      ruteFolger: attributeText('ruteFølger'),
      underlagstype: attributeText('underlagstype'),
      sesong: attributeText('sesong'),
      oppdateringsdato: firstText(feature, 'oppdateringsdato'),
    };

    const geometries = descendantsOf(feature, 'LineString');
    let geometryIndex = 0;
    for (const geometry of geometries) {
      const posList = textOf(descendantsOf(geometry, 'posList')[0]);
      if (posList === '') continue;
      const srsName = attributeOf(geometry, 'srsName') ?? '';
      const coords = parsePosList(posList, srsName);
      if (coords.length === 0) continue;
      const id = geometries.length === 1 ? lokalId : `${lokalId}#${geometryIndex}`;
      geometryIndex++;
      lines.push({ id, lokalId, attributes, coords, srsName });
    }
  }

  return { lines, featureCount, numberMatched, numberReturned };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Turrute request aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

class TurruteHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TurruteHttpError';
    this.status = status;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Combine the caller signal with a per-attempt timeout. */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([signal, timeout]);
  const controller = new AbortController();
  const abort = (source: AbortSignal): void => {
    controller.abort(source.reason);
  };
  if (signal.aborted) abort(signal);
  else signal.addEventListener('abort', () => abort(signal), { once: true });
  timeout.addEventListener('abort', () => abort(timeout), { once: true });
  return controller.signal;
}

/**
 * Fetch and parse a Turrutebasen bbox.
 *
 * Never widens the bbox. Retries 429/5xx/network/timeouts; definitive 4xx
 * responses fail immediately. Throws on failure; an empty result is `[]`.
 */
export async function fetchTurruteBox(
  bbox: LonLatBBox,
  options: FetchTurruteOptions = {},
): Promise<TurruteBoxResult> {
  const url = turruteGetFeatureUrl(bbox, options.count !== undefined ? { count: options.count } : {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 400);
  const fetchImpl = options.fetchImpl ?? fetch;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/gml+xml' },
        signal: combineSignals(options.signal, timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const snippet = body.slice(0, 300).replace(/\s+/g, ' ').trim();
        throw new TurruteHttpError(
          response.status,
          `Turrute WFS request failed: HTTP ${response.status} ${response.statusText} from ${url}` +
            (snippet ? ` — body: ${snippet}` : ''),
        );
      }
      const xml = await response.text();
      const parsed = parseTurruteGml(xml);
      return { ...parsed, url };
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw abortError(options.signal);
      if (error instanceof TurruteHttpError && !error.retryable) throw error;
      // Parse errors are retried once more: CDN error pages are usually
      // transient, while a real schema change fails every attempt anyway.
      if (attempt < attempts) {
        const backoff = Math.min(8_000, retryBaseMs * 2 ** (attempt - 1)) * (0.5 + Math.random());
        await sleep(backoff, options.signal);
      }
    }
  }

  const detail =
    isAbortError(lastError) && lastError instanceof Error && lastError.name === 'TimeoutError'
      ? `timed out after ${timeoutMs} ms`
      : lastError instanceof Error
        ? lastError.message
        : String(lastError);
  throw new Error(`Turrute WFS request failed after ${attempts} attempt(s): ${detail}`, {
    cause: lastError,
  });
}

/**
 * Cheap feature count via `resultType=hits`.
 *
 * Returns `undefined` when the server reports `numberMatched="unknown"`.
 */
export async function fetchTurruteHits(
  bbox: LonLatBBox,
  options: FetchTurruteOptions = {},
): Promise<number | undefined> {
  const url = turruteHitsUrl(bbox);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/gml+xml' },
    signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new TurruteHttpError(
      response.status,
      `Turrute WFS hits request failed: HTTP ${response.status} ${response.statusText} from ${url}`,
    );
  }
  const xml = await response.text();
  // A hits response is a normal (member-less) FeatureCollection; reuse the
  // parser so namespace prefixes and OWS exceptions are handled consistently.
  return parseTurruteGml(xml).numberMatched;
}

/**
 * Turrutebasen client with a request limiter.
 *
 * A 10 km urban bbox takes ~6.6 s server-side, so concurrency is capped at 2
 * by default. The limiter is per client instance; sharing one client across
 * prefetch runs is the intended usage.
 */
export class TurrutebasenClient {
  private readonly fetchOptions: FetchTurruteOptions;
  private readonly concurrency: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private _requestCount = 0;

  constructor(options: FetchTurruteOptions & { concurrency?: number } = {}) {
    const { concurrency, ...fetchOptions } = options;
    this.fetchOptions = fetchOptions;
    this.concurrency = Math.max(1, concurrency ?? DEFAULT_CONCURRENCY);
  }

  /** Total GetFeature requests issued by this client (including retries? no: calls). */
  get requestCount(): number {
    return this._requestCount;
  }

  /** Get the current number of in-flight requests (for tests/metrics). */
  get activeCount(): number {
    return this.active;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async fetchBox(bbox: LonLatBBox, options: FetchTurruteOptions = {}): Promise<TurruteBoxResult> {
    const signal = options.signal ?? this.fetchOptions.signal;
    await this.acquire(signal);
    this._requestCount++;
    try {
      return await fetchTurruteBox(bbox, { ...this.fetchOptions, ...options });
    } finally {
      this.release();
    }
  }

  async fetchHits(bbox: LonLatBBox, options: FetchTurruteOptions = {}): Promise<number | undefined> {
    const signal = options.signal ?? this.fetchOptions.signal;
    await this.acquire(signal);
    this._requestCount++;
    try {
      return await fetchTurruteHits(bbox, { ...this.fetchOptions, ...options });
    } finally {
      this.release();
    }
  }
}

/** Default process-wide client (2 concurrent requests, shares nothing else). */
let defaultClient: TurrutebasenClient | undefined;

export function getDefaultTurruteClient(): TurrutebasenClient {
  defaultClient ??= new TurrutebasenClient();
  return defaultClient;
}
