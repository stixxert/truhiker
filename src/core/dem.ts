/**
 * Elevation source: Kartverket's DTM (bare earth) via hoydedata.no.
 *
 * The service (`.../DTM/ImageServer/exportImage`) returns a float32 GeoTIFF for
 * an arbitrary EPSG:25833 bounding box. It is tiled at 128×128, so every
 * response with a side longer than 128 px is multi-tile.
 *
 * Strategy: never sample per point (each request costs ~250 ms). Group route
 * points into 5 km cells, request each cell once at ~10 m/px, cache the window
 * in memory, and bilinearly interpolate within it. Concurrency is capped at 6
 * to stay polite; 5xx/429 responses are retried with exponential backoff, and a
 * failure is always thrown — never converted into 0 m, which would silently
 * produce a flat (and completely wrong) profile.
 */

import { toUtm33, type LonLat } from './geo';
import { readTiffRaster, type Raster } from './tiff';

export type { LonLat };

/** Axis-aligned bounding box in EPSG:25833 (metres). */
export interface BBox25833 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A decoded DEM window with georeferencing. */
export interface DemRaster extends Raster {
  readonly bbox: BBox25833;
  /**
   * Bilinearly interpolated elevation at an EPSG:25833 coordinate (metres).
   * Returns `NaN` outside the window or where all contributing pixels are
   * NoData. Pixels that are NoData are ignored in the interpolation and the
   * remaining weights are renormalised.
   */
  sampleUtm(x: number, y: number): number;
}

/** The one thing the profile pipeline needs from an elevation provider. */
export interface ElevationSource {
  /** Elevation (metres) for each point, in the same order. `NaN` = NoData. */
  sampleElevations(points: LonLat[]): Promise<number[]>;
}

/** Pixel dimensions for a DEM window. */
export interface RasterSize {
  width: number;
  height: number;
}

export interface FetchDemOptions {
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Total attempts (1 = no retry). Default 3. */
  attempts?: number;
  /** Base backoff in ms for retries (doubles each attempt). Default 400. */
  retryBaseMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 3;

export const DEM_EXPORT_URL =
  'https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage';

/** Build the ArcGIS exportImage URL (exported for logging and tests). */
export function demExportUrl(bbox: BBox25833, size: RasterSize): string {
  const params = new URLSearchParams({
    bbox: `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`,
    bboxSR: '25833',
    imageSR: '25833',
    size: `${size.width},${size.height}`,
    format: 'tiff',
    f: 'image',
  });
  return `${DEM_EXPORT_URL}?${params.toString()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An HTTP error from the DEM service; 429/5xx are retryable, other 4xx are not. */
class DemHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DemHttpError';
    this.status = status;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function looksLikeTiff(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const view = new DataView(buffer);
  const order = view.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  const little = order === 0x4949;
  const magic = view.getUint16(2, little);
  return magic === 42 || magic === 43;
}

function assertValidRequest(bbox: BBox25833, size: RasterSize): void {
  for (const [name, value] of Object.entries(bbox)) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`fetchDemWindow: bbox.${name} is not finite (${value})`);
    }
  }
  if (!(bbox.maxX > bbox.minX) || !(bbox.maxY > bbox.minY)) {
    throw new RangeError(
      `fetchDemWindow: bbox must have maxX > minX and maxY > minY, got ${JSON.stringify(bbox)}`,
    );
  }
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1) {
    throw new RangeError(
      `fetchDemWindow: size must be positive integers, got ${JSON.stringify(size)}`,
    );
  }
}

/**
 * Fetch one DEM window from hoydedata.no.
 *
 * Throws on any failure — HTTP errors, timeouts, non-TIFF bodies, truncated or
 * malformed TIFFs. Retries 429/5xx/network/timeout failures up to `attempts`
 * with exponential backoff + jitter. Other 4xx responses fail immediately.
 */
export async function fetchDemWindow(
  bbox: BBox25833,
  size: RasterSize,
  options: FetchDemOptions = {},
): Promise<DemRaster> {
  assertValidRequest(bbox, size);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 400);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = demExportUrl(bbox, size);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'image/tiff' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const snippet = body.slice(0, 300).replace(/\s+/g, ' ').trim();
        throw new DemHttpError(
          response.status,
          `DEM request failed: HTTP ${response.status} ${response.statusText} from ${url}` +
            (snippet ? ` — body: ${snippet}` : ''),
        );
      }

      const buffer = await response.arrayBuffer();
      if (!looksLikeTiff(buffer)) {
        const text = new TextDecoder().decode(buffer.slice(0, 300));
        throw new Error(
          `DEM request returned a non-TIFF response (${buffer.byteLength} bytes) from ${url}` +
            (text ? ` — body starts: ${text.replace(/\s+/g, ' ').trim()}` : ''),
        );
      }
      if (buffer.byteLength === 0) {
        throw new Error(`DEM request returned an empty body from ${url}`);
      }

      const raw = readTiffRaster(buffer);
      if (raw.width !== size.width || raw.height !== size.height) {
        throw new Error(
          `DEM response is ${raw.width}×${raw.height} but ${size.width}×${size.height} was requested; ` +
            `refusing to georeference a mismatched raster (${url})`,
        );
      }
      return createDemRaster(raw, bbox);
    } catch (error) {
      lastError = error;
      // Definitive client errors (400, 404, ...) will not get better by retrying.
      if (error instanceof DemHttpError && !error.retryable) throw error;

      // Everything else is retried: 429/5xx, network errors, timeouts, and
      // non-TIFF/malformed bodies (a CDN error page is usually transient).
      if (attempt < attempts) {
        const backoff = Math.min(8_000, retryBaseMs * 2 ** (attempt - 1)) * (0.5 + Math.random());
        await sleep(backoff);
      }
    }
  }

  const detail =
    lastError instanceof Error && (lastError.name === 'AbortError' || lastError.name === 'TimeoutError')
      ? `timed out after ${timeoutMs} ms`
      : lastError instanceof Error
        ? lastError.message
        : String(lastError);
  throw new Error(`DEM request failed after ${attempts} attempt(s): ${detail}`, {
    cause: lastError,
  });
}

function createDemRaster(raw: Raster, bbox: BBox25833): DemRaster {
  const dx = (bbox.maxX - bbox.minX) / raw.width;
  const dy = (bbox.maxY - bbox.minY) / raw.height;

  return {
    width: raw.width,
    height: raw.height,
    bbox: { ...bbox },
    get: (x: number, y: number): number => raw.get(x, y),

    sampleUtm(x: number, y: number): number {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Number.NaN;

      // Continuous pixel coordinates, with pixel centres at i + 0.5.
      let col = (x - bbox.minX) / dx - 0.5;
      let row = (bbox.maxY - y) / dy - 0.5;
      if (col < -0.5 || col > raw.width - 0.5 || row < -0.5 || row > raw.height - 0.5) {
        return Number.NaN;
      }
      col = Math.min(Math.max(col, 0), raw.width - 1);
      row = Math.min(Math.max(row, 0), raw.height - 1);

      const c0 = Math.floor(col);
      const r0 = Math.floor(row);
      const c1 = Math.min(c0 + 1, raw.width - 1);
      const r1 = Math.min(r0 + 1, raw.height - 1);
      const fx = col - c0;
      const fy = row - r0;

      const v00 = raw.get(c0, r0);
      const v10 = raw.get(c1, r0);
      const v01 = raw.get(c0, r1);
      const v11 = raw.get(c1, r1);

      // Weighted average over the finite corners only.
      let sum = 0;
      let weight = 0;
      if (Number.isFinite(v00)) {
        const w = (1 - fx) * (1 - fy);
        sum += v00 * w;
        weight += w;
      }
      if (Number.isFinite(v10)) {
        const w = fx * (1 - fy);
        sum += v10 * w;
        weight += w;
      }
      if (Number.isFinite(v01)) {
        const w = (1 - fx) * fy;
        sum += v01 * w;
        weight += w;
      }
      if (Number.isFinite(v11)) {
        const w = fx * fy;
        sum += v11 * w;
        weight += w;
      }
      return weight > 0 ? sum / weight : Number.NaN;
    },
  };
}

// ---------------------------------------------------------------------------
// Window grouping, caching, concurrency
// ---------------------------------------------------------------------------

export interface SampleOptions extends FetchDemOptions {
  /** Side length of a sampling cell, metres. Default 5000. */
  cellSizeM?: number;
  /** Requested DEM resolution, metres per pixel. Default 10. */
  pixelSizeM?: number;
  /**
   * Padding added on every side of a cell window, metres. Default 25 (2.5 px
   * at 10 m/px), so points on a cell boundary still have interpolation
   * neighbours on all sides.
   */
  padM?: number;
  /** Maximum concurrent DEM requests. Default 6. */
  concurrency?: number;
}

const DEFAULT_CELL_SIZE_M = 5_000;
const DEFAULT_PIXEL_SIZE_M = 10;
const DEFAULT_PAD_M = 25;
const DEFAULT_CONCURRENCY = 6;

interface PendingPoint {
  index: number;
  x: number;
  y: number;
}

interface Cell {
  ix: number;
  iy: number;
  points: PendingPoint[];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * The hoydedata.no-backed elevation source.
 *
 * Windows are cached in memory by cell key, and in-flight requests are
 * de-duplicated (two routes sharing a cell issue one request). Failed requests
 * are evicted from the cache so a later call can retry.
 */
export class HoydedataDem implements ElevationSource {
  private readonly cache = new Map<string, Promise<DemRaster>>();
  private readonly cellSizeM: number;
  private readonly pixelSizeM: number;
  private readonly padM: number;
  private readonly concurrency: number;
  private readonly fetchOptions: FetchDemOptions;

  constructor(options: SampleOptions = {}) {
    this.cellSizeM = options.cellSizeM ?? DEFAULT_CELL_SIZE_M;
    this.pixelSizeM = options.pixelSizeM ?? DEFAULT_PIXEL_SIZE_M;
    this.padM = options.padM ?? DEFAULT_PAD_M;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.fetchOptions = {
      timeoutMs: options.timeoutMs,
      attempts: options.attempts,
      retryBaseMs: options.retryBaseMs,
      fetchImpl: options.fetchImpl,
    };
    if (!(this.cellSizeM > 0) || !(this.pixelSizeM > 0) || !(this.padM >= 0) || !(this.concurrency >= 1)) {
      throw new RangeError('HoydedataDem: cellSizeM and pixelSizeM must be > 0, padM >= 0, concurrency >= 1');
    }
  }

  async sampleElevations(points: LonLat[]): Promise<number[]> {
    const out = new Array<number>(points.length).fill(Number.NaN);
    if (points.length === 0) return out;

    const cells = new Map<string, Cell>();
    for (let i = 0; i < points.length; i++) {
      const { x, y } = toUtm33(points[i]);
      const ix = Math.floor(x / this.cellSizeM);
      const iy = Math.floor(y / this.cellSizeM);
      const key = `${ix},${iy}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { ix, iy, points: [] };
        cells.set(key, cell);
      }
      cell.points.push({ index: i, x, y });
    }

    const list = [...cells.values()];
    const rasters = await mapWithConcurrency(list, this.concurrency, (cell) =>
      this.getWindow(cell.ix, cell.iy),
    );

    for (let c = 0; c < list.length; c++) {
      const raster = rasters[c];
      for (const point of list[c].points) {
        out[point.index] = raster.sampleUtm(point.x, point.y);
      }
    }
    return out;
  }

  /** Fetch (or reuse) the window covering cell (ix, iy). Public for tests/CLI. */
  getWindow(ix: number, iy: number): Promise<DemRaster> {
    const key = `${ix},${iy}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const cell = this.cellSizeM;
    const bbox: BBox25833 = {
      minX: ix * cell - this.padM,
      minY: iy * cell - this.padM,
      maxX: (ix + 1) * cell + this.padM,
      maxY: (iy + 1) * cell + this.padM,
    };
    const width = Math.max(1, Math.round((bbox.maxX - bbox.minX) / this.pixelSizeM));
    const height = Math.max(1, Math.round((bbox.maxY - bbox.minY) / this.pixelSizeM));

    const promise = fetchDemWindow(bbox, { width, height }, this.fetchOptions);
    this.cache.set(key, promise);
    // Do not cache failures: a retry should hit the network again.
    promise.catch(() => {
      if (this.cache.get(key) === promise) this.cache.delete(key);
    });
    return promise;
  }

  /** Number of cached cell windows (fetched or in flight). */
  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

let defaultSource: HoydedataDem | undefined;

/** The process-wide default source (shares its window cache). */
export function getDefaultDemSource(): HoydedataDem {
  defaultSource ??= new HoydedataDem();
  return defaultSource;
}

/**
 * Sample elevations for a list of lon/lat points against hoydedata.no.
 * Points are grouped into 5 km EPSG:25833 cells; each cell is requested once.
 */
export async function sampleElevations(points: LonLat[], options?: SampleOptions): Promise<number[]> {
  const source = options ? new HoydedataDem(options) : getDefaultDemSource();
  return source.sampleElevations(points);
}
