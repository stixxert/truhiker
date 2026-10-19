/**
 * Prefetch planning and loading for Turrutebasen boxes.
 *
 * Given a viewport or a route corridor, the planner turns lon/lat input into
 * the *smallest useful set* of WFS bboxes:
 *
 * - every input point falls into a uniform grid cell (default 0.02°, ~2 km at
 *   61°N);
 * - points in the same cell collapse to one request (a 30-point corridor that
 *   crosses three cells issues three requests, not thirty);
 * - if the plan still exceeds `maxRequests`, neighbouring cells are merged
 *   greedily (smallest resulting bbox area first), so the cap is a hard limit.
 *
 * The loader debounces bursts of viewport updates, deduplicates in-flight
 * cells, caps concurrency at 2 (the WFS is slow and shared), aborts a run when
 * a newer one supersedes it, and reports `{ requested, cached, failed }` so the
 * UI can show a degraded-data state instead of pretending the map is complete.
 */

import {
  SnapCache,
  type SnapCacheBackend,
  type SnapCacheOptions,
} from './cache';
import { SnapIndex, type LonLat } from './index';
import {
  DEFAULT_DATA_VERSION,
  TurrutebasenClient,
  getDefaultTurruteClient,
  type LonLatBBox,
  type TurruteLine,
} from './wfs';

export type { LonLat, LonLatBBox, TurruteLine };

/** Default grid cell size in degrees (~2 km at 61°N). */
export const DEFAULT_PREFETCH_CELL_DEG = 0.02;
/** Default maximum number of WFS boxes per prefetch run. */
export const DEFAULT_MAX_REQUESTS = 6;
/** WFS concurrency cap. A 10 km urban box takes ~6.6 s server-side. */
export const DEFAULT_PREFETCH_CONCURRENCY = 2;
/** Default debounce for viewport pan/zoom bursts, ms. */
export const DEFAULT_DEBOUNCE_MS = 200;

/** Upper bound on cells enumerated for a viewport before coarsening. */
const MAX_VIEWPORT_CELLS = 400;

/** One grid cell, with its stable cache id and geographic bbox. */
export interface GridCell {
  ix: number;
  iy: number;
  id: string;
  bbox: LonLatBBox;
}

/** One bbox to request: either a single cell or a merged rectangle of cells. */
export interface PlannedBox {
  id: string;
  bbox: LonLatBBox;
  cells: Array<{ ix: number; iy: number }>;
}

/** Fetch one bbox. Must reject on failure and honour the abort signal. */
export type FetchBox = (bbox: LonLatBBox, signal: AbortSignal) => Promise<TurruteLine[]>;

export interface PrefetchReport {
  /** WFS requests issued by this run (successful + failed). */
  requested: number;
  /** Cells served from the cache without any request. */
  cached: number;
  /** Requests that failed (including ones aborted by a supersede). */
  failed: number;
  /** In-flight requests from another run that were reused (not re-requested). */
  deduped: number;
  /** Total boxes planned for this run. */
  boxes: number;
  /** Lines added to the index from cache and network combined. */
  lines: number;
  /** True when a newer prefetch superseded this one (or it was cancelled). */
  aborted: boolean;
  /** Failure details, for logs/telemetry. At most one entry per box. */
  failures: Array<{ boxId: string; error: string }>;
}

export interface PrefetchPlanOptions {
  /** Grid cell size in degrees. Default 0.02. */
  cellDeg?: number;
  /** Hard cap on the number of boxes. Default 6. */
  maxRequests?: number;
}

export interface PrefetchRunOptions extends PrefetchPlanOptions {
  /** Debounce before starting, ms. Default 200; 0 disables. */
  debounceMs?: number;
  /** Concurrency cap. Default 2. */
  concurrency?: number;
  /** Optional external abort signal. */
  signal?: AbortSignal;
}

export interface PrefetcherOptions {
  /** Dataset version used as the cache partition. */
  dataVersion?: string;
  /** Cache instance; otherwise one is created from `backend`. */
  cache?: SnapCache;
  /** Backend for the default cache (fake store in tests). */
  cacheBackend?: SnapCacheBackend;
  /** Cache options passed to the default cache. */
  cacheOptions?: Omit<SnapCacheOptions, 'dataVersion'>;
  /** Index receiving every loaded line. */
  index?: SnapIndex;
  /** WFS client; defaults to the process-wide 2-concurrency client. */
  client?: TurrutebasenClient;
  /** Custom fetcher (tests, alternative transport). Overrides `client`. */
  fetchBox?: FetchBox;
  /** Defaults for every run. */
  cellDeg?: number;
  maxRequests?: number;
  concurrency?: number;
  debounceMs?: number;
}

function cellDegLabel(cellDeg: number): string {
  return Number(cellDeg.toFixed(6)).toString();
}

/**
 * Floating-point-tolerant cell index.
 *
 * `8.02 / 0.02` is `400.99999999999994` in IEEE-754, which would put a point
 * that lies exactly on a cell boundary into the *lower* cell. The epsilon
 * (1e-9 of a cell, ~20 nanometres on the ground) keeps boundary points in the
 * upper cell deterministically.
 */
function cellIndex(value: number, cellDeg: number): number {
  return Math.floor(value / cellDeg + 1e-9);
}

/** Grid cell containing a point. */
export function cellOf(point: LonLat, cellDeg: number = DEFAULT_PREFETCH_CELL_DEG): GridCell {
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
    throw new RangeError(`cellOf: point must have finite lon/lat, got ${JSON.stringify(point)}`);
  }
  assertCellDeg(cellDeg);
  const ix = cellIndex(point.lon, cellDeg);
  const iy = cellIndex(point.lat, cellDeg);
  return makeCell(ix, iy, cellDeg);
}

function assertCellDeg(cellDeg: number): void {
  if (!Number.isFinite(cellDeg) || cellDeg <= 0 || cellDeg >= 1) {
    throw new RangeError(`prefetch cellDeg must be in (0, 1), got ${cellDeg}`);
  }
}

function makeCell(ix: number, iy: number, cellDeg: number): GridCell {
  return {
    ix,
    iy,
    id: `c:${cellDegLabel(cellDeg)}:${ix}:${iy}`,
    bbox: {
      minLon: ix * cellDeg,
      minLat: iy * cellDeg,
      maxLon: (ix + 1) * cellDeg,
      maxLat: (iy + 1) * cellDeg,
    },
  };
}

function makeMergedBox(
  cells: readonly { ix: number; iy: number }[],
  cellDeg: number,
): PlannedBox {
  let minIx = Number.POSITIVE_INFINITY;
  let minIy = Number.POSITIVE_INFINITY;
  let maxIx = Number.NEGATIVE_INFINITY;
  let maxIy = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    minIx = Math.min(minIx, cell.ix);
    minIy = Math.min(minIy, cell.iy);
    maxIx = Math.max(maxIx, cell.ix);
    maxIy = Math.max(maxIy, cell.iy);
  }
  if (cells.length === 1) {
    const single = makeCell(cells[0].ix, cells[0].iy, cellDeg);
    return { id: single.id, bbox: single.bbox, cells: [{ ...cells[0] }] };
  }
  return {
    id: `m:${cellDegLabel(cellDeg)}:${minIx},${minIy},${maxIx},${maxIy}`,
    bbox: {
      minLon: minIx * cellDeg,
      minLat: minIy * cellDeg,
      maxLon: (maxIx + 1) * cellDeg,
      maxLat: (maxIy + 1) * cellDeg,
    },
    cells: cells.map((cell) => ({ ...cell })),
  };
}

/** Union area in degree², used to pick the cheapest groups to merge. */
interface CellRef {
  ix: number;
  iy: number;
}

interface CellGroup {
  cells: CellRef[];
  minIx: number;
  minIy: number;
  maxIx: number;
  maxIy: number;
}

function makeGroup(cells: CellRef[]): CellGroup {
  let minIx = Number.POSITIVE_INFINITY;
  let minIy = Number.POSITIVE_INFINITY;
  let maxIx = Number.NEGATIVE_INFINITY;
  let maxIy = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    minIx = Math.min(minIx, cell.ix);
    minIy = Math.min(minIy, cell.iy);
    maxIx = Math.max(maxIx, cell.ix);
    maxIy = Math.max(maxIy, cell.iy);
  }
  return { cells, minIx, minIy, maxIx, maxIy };
}

function groupArea(minIx: number, minIy: number, maxIx: number, maxIy: number): number {
  return (maxIx - minIx + 1) * (maxIy - minIy + 1);
}

/**
 * Collapse a cell set into at most `maxRequests` boxes.
 *
 * When the set already fits, one box per cell is returned (in insertion
 * order). Beyond the cap, the globally smallest-area merge is applied
 * repeatedly; adjacent groups always win over distant ones. Very large cell
 * sets are pre-clustered on a coarser grid first, so the O(n²) pair scan never
 * runs on thousands of groups.
 */
export function mergeCells(
  cells: readonly CellRef[],
  options: PrefetchPlanOptions = {},
): PlannedBox[] {
  const cellDeg = options.cellDeg ?? DEFAULT_PREFETCH_CELL_DEG;
  const maxRequests = Math.max(1, options.maxRequests ?? DEFAULT_MAX_REQUESTS);
  assertCellDeg(cellDeg);

  const unique = new Map<string, CellRef>();
  for (const cell of cells) {
    unique.set(`${cell.ix},${cell.iy}`, { ix: cell.ix, iy: cell.iy });
  }
  const initial = [...unique.values()];
  if (initial.length === 0) return [];

  if (initial.length <= maxRequests) {
    return initial.map((cell) => makeMergedBox([cell], cellDeg));
  }

  let groups: CellGroup[] = initial.map((cell) => makeGroup([cell]));

  // Pre-cluster only for performance: bucket groups on a coarser grid until
  // the pair scan is small. This does not affect coverage (every cell is kept).
  const PRE_MERGE_LIMIT = 64;
  let factor = 2;
  while (groups.length > PRE_MERGE_LIMIT) {
    const buckets = new Map<string, CellRef[]>();
    for (const group of groups) {
      const key = `${Math.floor(group.minIx / factor)},${Math.floor(group.minIy / factor)}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      for (const cell of group.cells) bucket.push(cell);
    }
    const next = [...buckets.values()].map((bucket) => makeGroup(bucket));
    if (next.length >= groups.length) {
      // The groups are spread across buckets at this resolution; coarsen
      // further instead of spinning on the same partition.
      factor *= 2;
      continue;
    }
    groups = next;
  }

  while (groups.length > maxRequests) {
    let bestI = 0;
    let bestJ = 1;
    let bestArea = Number.POSITIVE_INFINITY;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        const area = groupArea(
          Math.min(a.minIx, b.minIx),
          Math.min(a.minIy, b.minIy),
          Math.max(a.maxIx, b.maxIx),
          Math.max(a.maxIy, b.maxIy),
        );
        if (area < bestArea) {
          bestArea = area;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const merged = makeGroup([...groups[bestI].cells, ...groups[bestJ].cells]);
    groups = groups.filter((_, index) => index !== bestI && index !== bestJ);
    groups.push(merged);
  }

  return groups.map((group) => makeMergedBox(group.cells, cellDeg));
}

/**
 * Plan boxes for a route corridor: the cells its points pass through, merged
 * to `maxRequests` if needed. Order follows first appearance along the route.
 */
export function planCorridor(
  points: readonly LonLat[],
  options: PrefetchPlanOptions = {},
): PlannedBox[] {
  const cellDeg = options.cellDeg ?? DEFAULT_PREFETCH_CELL_DEG;
  assertCellDeg(cellDeg);
  const cells: Array<{ ix: number; iy: number }> = [];
  for (const point of points) {
    const cell = cellOf(point, cellDeg);
    cells.push({ ix: cell.ix, iy: cell.iy });
  }
  return mergeCells(cells, { cellDeg, maxRequests: options.maxRequests });
}

/**
 * Plan boxes for a viewport.
 *
 * A large viewport is coarsened first (so we never enumerate millions of
 * cells), then merged to the request cap. Coarsening keeps the bbox inside the
 * viewport.
 */
export function planViewport(
  bbox: LonLatBBox,
  options: PrefetchPlanOptions = {},
): PlannedBox[] {
  let cellDeg = options.cellDeg ?? DEFAULT_PREFETCH_CELL_DEG;
  assertCellDeg(cellDeg);
  const maxRequests = Math.max(1, options.maxRequests ?? DEFAULT_MAX_REQUESTS);
  for (const [name, value] of Object.entries(bbox)) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`prefetch viewport.${name} is not finite (${String(value)})`);
    }
  }
  if (!(bbox.maxLon > bbox.minLon) || !(bbox.maxLat > bbox.minLat)) {
    throw new RangeError(`prefetch viewport must have max > min, got ${JSON.stringify(bbox)}`);
  }

  const countCells = (deg: number): { nx: number; ny: number } => ({
    nx: Math.max(1, Math.ceil((bbox.maxLon - bbox.minLon) / deg)),
    ny: Math.max(1, Math.ceil((bbox.maxLat - bbox.minLat) / deg)),
  });
  let { nx, ny } = countCells(cellDeg);
  while (nx * ny > MAX_VIEWPORT_CELLS) {
    cellDeg *= 2;
    ({ nx, ny } = countCells(cellDeg));
  }

  const cells: Array<{ ix: number; iy: number }> = [];
  for (let iy = cellIndex(bbox.minLat, cellDeg); iy <= cellIndex(bbox.maxLat, cellDeg); iy++) {
    for (let ix = cellIndex(bbox.minLon, cellDeg); ix <= cellIndex(bbox.maxLon, cellDeg); ix++) {
      // Skip cells whose intersection with the viewport is empty (possible at
      // the exact max edge).
      const cell = makeCell(ix, iy, cellDeg);
      if (
        cell.bbox.maxLon <= bbox.minLon ||
        cell.bbox.minLon >= bbox.maxLon ||
        cell.bbox.maxLat <= bbox.minLat ||
        cell.bbox.minLat >= bbox.maxLat
      ) {
        continue;
      }
      cells.push({ ix, iy });
    }
  }
  return mergeCells(cells, { cellDeg, maxRequests });
}

function abortError(): Error {
  const error = new Error('Prefetch aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function emptyReport(boxes: number, aborted: boolean): PrefetchReport {
  return {
    requested: 0,
    cached: 0,
    failed: 0,
    deduped: 0,
    boxes,
    lines: 0,
    aborted,
    failures: [],
  };
}

/**
 * Debounced, deduplicated prefetcher.
 *
 * A Prefetcher owns at most one active run: starting a new prefetch aborts the
 * previous one (including its pending debounce). The debounce means a pan
 * gesture generates one plan, not one per pointer event.
 */
export class Prefetcher {
  private readonly dataVersion: string;
  private readonly cache: SnapCache;
  private readonly index?: SnapIndex;
  private readonly fetcher: FetchBox;
  private readonly defaults: Required<Pick<PrefetchRunOptions, 'cellDeg' | 'maxRequests' | 'concurrency' | 'debounceMs'>>;
  private readonly inflight = new Map<string, Promise<TurruteLine[]>>();
  private currentController: AbortController | null = null;
  private currentRunId = 0;

  constructor(options: PrefetcherOptions = {}) {
    this.dataVersion = options.dataVersion ?? DEFAULT_DATA_VERSION;
    this.cache =
      options.cache ??
      new SnapCache({
        dataVersion: this.dataVersion,
        backend: options.cacheBackend,
        ...options.cacheOptions,
      });
    this.index = options.index;
    const client = options.client ?? getDefaultTurruteClient();
    this.fetcher =
      options.fetchBox ??
      ((bbox, signal) => client.fetchBox(bbox, { signal }).then((result) => result.lines));
    this.defaults = {
      cellDeg: options.cellDeg ?? DEFAULT_PREFETCH_CELL_DEG,
      maxRequests: options.maxRequests ?? DEFAULT_MAX_REQUESTS,
      concurrency: options.concurrency ?? DEFAULT_PREFETCH_CONCURRENCY,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    };
  }

  /** The cache used by this prefetcher (exposed for diagnostics/tests). */
  get snapCache(): SnapCache {
    return this.cache;
  }

  /** Cancel the active run; its promise resolves with `aborted: true`. */
  cancel(): void {
    this.currentController?.abort();
  }

  /** Prefetch a route corridor. Resolves with a report; never rejects on abort. */
  prefetchCorridor(points: readonly LonLat[], options: PrefetchRunOptions = {}): Promise<PrefetchReport> {
    return this.run(planCorridor(points, this.resolvePlanOptions(options)), options);
  }

  /** Prefetch a viewport. Resolves with a report; never rejects on abort. */
  prefetchViewport(bbox: LonLatBBox, options: PrefetchRunOptions = {}): Promise<PrefetchReport> {
    return this.run(planViewport(bbox, this.resolvePlanOptions(options)), options);
  }

  private resolvePlanOptions(options: PrefetchRunOptions): PrefetchPlanOptions {
    return {
      cellDeg: options.cellDeg ?? this.defaults.cellDeg,
      maxRequests: options.maxRequests ?? this.defaults.maxRequests,
    };
  }

  private async run(
    boxes: PlannedBox[],
    options: PrefetchRunOptions,
  ): Promise<PrefetchReport> {
    const runId = ++this.currentRunId;
    this.currentController?.abort();
    const controller = new AbortController();
    this.currentController = controller;

    const externalSignal = options.signal;
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const report = emptyReport(boxes.length, false);
    const isCurrent = (): boolean => runId === this.currentRunId && !controller.signal.aborted;

    try {
      const debounceMs = options.debounceMs ?? this.defaults.debounceMs;
      if (debounceMs > 0) {
        try {
          await delay(debounceMs, controller.signal);
        } catch {
          report.aborted = true;
          return report;
        }
      } else if (controller.signal.aborted) {
        report.aborted = true;
        return report;
      }

      const concurrency = Math.max(1, options.concurrency ?? this.defaults.concurrency);
      let next = 0;

      const worker = async (): Promise<void> => {
        for (;;) {
          if (!isCurrent()) return;
          const index = next++;
          if (index >= boxes.length) return;
          await this.loadBox(boxes[index], controller.signal, report);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, Math.max(1, boxes.length)) }, worker),
      );

      if (!isCurrent()) report.aborted = true;
      return report;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (runId === this.currentRunId) this.currentController = null;
    }
  }

  private addLines(lines: readonly TurruteLine[]): void {
    if (!this.index) return;
    this.index.addLines(lines);
  }

  private async loadBox(
    box: PlannedBox,
    signal: AbortSignal,
    report: PrefetchReport,
  ): Promise<void> {
    if (signal.aborted) return;

    // 1. Persistent cache.
    let cached: TurruteLine[] | undefined;
    try {
      cached = await this.cache.get<TurruteLine[]>(box.id);
    } catch {
      cached = undefined;
    }
    if (cached) {
      report.cached++;
      report.lines += cached.length;
      this.addLines(cached);
      return;
    }

    // 2. In-flight request started by another (possibly superseded) run.
    const existing = this.inflight.get(box.id);
    if (existing) {
      try {
        const lines = await existing;
        report.deduped++;
        report.lines += lines.length;
        this.addLines(lines);
        return;
      } catch {
        if (signal.aborted) return;
        // The shared request was aborted (its run was superseded) or failed;
        // fall through and issue a fresh request for this run.
      }
    }

    if (signal.aborted) return;

    // 3. Network.
    report.requested++;
    const promise = this.fetcher(box.bbox, signal);
    this.inflight.set(box.id, promise);
    try {
      const lines = await promise;
      // Do not write a superseded response: the next run will refetch and
      // the data would be identical, but writing after abort risks racing a
      // cache clear.
      if (!signal.aborted) {
        await this.cache.set(box.id, lines);
      }
      report.lines += lines.length;
      this.addLines(lines);
    } catch (error) {
      report.failed++;
      report.failures.push({
        boxId: box.id,
        error: isAbortError(error) ? 'aborted' : error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.inflight.get(box.id) === promise) this.inflight.delete(box.id);
    }
  }
}
