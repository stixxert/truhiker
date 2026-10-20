/**
 * Elevation sampling in a Web Worker.
 *
 * A 3,000 km route touches ~600 DEM windows; doing that on the main thread
 * would freeze the map for a minute. The worker reuses `src/core/dem.ts`
 * unchanged and reports progress after every completed window, so the profile
 * panel can say what is happening instead of showing an indeterminate spinner.
 *
 * Two things make the second and third sampling of a route cheap:
 *
 *  - the worker is **shared across jobs** (see `elevation-client.ts`), and
 *  - the `HoydedataDem` caches are kept **per pixel size** for the worker's
 *    lifetime, so an edit that moves one vertex re-uses every window that was
 *    already downloaded.
 *
 * The pixel size adapts to the route length: 10 m for a day walk, coarser for a
 * multi-day route where the difference is invisible on a profile and the request
 * count is what hurts (D9).
 *
 * Protocol:
 *   in  { type: 'sample', jobId, points: LonLat[], pixelSizeM? }
 *   out { type: 'progress', jobId, phase: 'download', done, total }
 *       { type: 'progress', jobId, phase: 'compute' }
 *       { type: 'result', jobId, elevations: Float64Array }
 *       { type: 'error', jobId, message }
 */

import { HoydedataDem } from '../core/dem';
import { toUtm33, type LonLat } from '../core/geo';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

const DEFAULT_PIXEL_SIZE_M = 10;

/**
 * Cell size, paired with the pixel size.
 *
 * Requests are latency-bound, not bandwidth-bound: 48 five-kilometre windows for
 * a 165 km route cost ~29 s at concurrency 6, while 12 twenty-kilometre windows
 * of the same data cost a quarter of that. Bigger cells only stay reasonable
 * because the pixel size grows at the same time — the pixel count per request is
 * what has to stay bounded (20 km at 30 m is 667x667).
 */
function cellSizeFor(pixelSizeM: number): number {
  if (pixelSizeM <= 10) return 5_000;
  if (pixelSizeM <= 15) return 10_000;
  if (pixelSizeM <= 20) return 15_000;
  return 20_000;
}

/** Four to six windows in flight: fast enough, polite enough. */
const CONCURRENCY = 8;

/** One cached source per pixel size: a 20 m raster cannot answer a 10 m job. */
const sources = new Map<number, HoydedataDem>();

function sourceFor(pixelSizeM: number): HoydedataDem {
  let source = sources.get(pixelSizeM);
  if (!source) {
    source = new HoydedataDem({
      cellSizeM: cellSizeFor(pixelSizeM),
      pixelSizeM,
      concurrency: CONCURRENCY,
    });
    sources.set(pixelSizeM, source);
  }
  return source;
}

interface SampleRequest {
  type: string;
  jobId?: number;
  points?: LonLat[];
  pixelSizeM?: number;
}

/**
 * Number of distinct 5 km DEM windows — the denominator for progress. This
 * mirrors `HoydedataDem`'s grouping (same cell size, same floor division), and
 * is only used for the progress display.
 */
function countCells(points: readonly LonLat[], cellSizeM: number): number {
  const seen = new Set<string>();
  for (const point of points) {
    const { x, y } = toUtm33(point);
    seen.add(`${Math.floor(x / cellSizeM)},${Math.floor(y / cellSizeM)}`);
  }
  return seen.size;
}

scope.onmessage = (event: MessageEvent): void => {
  const request = event.data as SampleRequest | undefined;
  if (!request || request.type !== 'sample' || !Array.isArray(request.points)) return;
  const points = request.points;
  const jobId = request.jobId ?? 0;
  const pixelSizeM =
    typeof request.pixelSizeM === 'number' && request.pixelSizeM > 0
      ? request.pixelSizeM
      : DEFAULT_PIXEL_SIZE_M;

  void (async () => {
    try {
      const source = sourceFor(pixelSizeM);
      const total = countCells(points, cellSizeFor(pixelSizeM));
      let done = 0;

      // Progress without changing the core: wrap the window loader, which is
      // called exactly once per distinct cell (the class de-duplicates, and a
      // cached cell still resolves through here on a repeat job).
      const loadWindow = source.getWindow.bind(source);
      source.getWindow = (ix: number, iy: number) => {
        const promise = loadWindow(ix, iy);
        return promise.then((raster) => {
          done++;
          scope.postMessage({ type: 'progress', jobId, phase: 'download', done, total });
          return raster;
        });
      };

      const elevations = await source.sampleElevations(points.slice());
      source.getWindow = loadWindow;
      // Everything is downloaded; what remains is the profile maths on the main
      // thread. Saying so is the difference between "still waiting" and "done in
      // a moment".
      scope.postMessage({ type: 'progress', jobId, phase: 'compute' });
      const buffer = Float64Array.from(elevations);
      scope.postMessage({ type: 'result', jobId, elevations: buffer }, [buffer.buffer]);
    } catch (error) {
      scope.postMessage({
        type: 'error',
        jobId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
