/**
 * Elevation sampling in a Web Worker.
 *
 * A 3,000 km route touches ~600 DEM windows; doing that on the main thread
 * would freeze the map for a minute. The worker reuses `src/core/dem.ts`
 * unchanged and reports progress after every completed window, so the profile
 * panel can show "12 of 84 cells" instead of an indeterminate spinner.
 *
 * Protocol:
 *   in  { type: 'sample', points: LonLat[] }
 *   out { type: 'progress', done, total }
 *       { type: 'result', elevations: Float64Array }
 *       { type: 'error', message }
 */

import { HoydedataDem } from '../core/dem';
import { toUtm33, type LonLat } from '../core/geo';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

const CELL_SIZE_M = 5_000;

interface SampleRequest {
  type: string;
  points?: LonLat[];
}

/**
 * Number of distinct 5 km DEM windows — the denominator for progress. This
 * mirrors `HoydedataDem`'s grouping (same cell size, same floor division), and
 * is only used for the progress display.
 */
function countCells(points: readonly LonLat[]): number {
  const seen = new Set<string>();
  for (const point of points) {
    const { x, y } = toUtm33(point);
    seen.add(`${Math.floor(x / CELL_SIZE_M)},${Math.floor(y / CELL_SIZE_M)}`);
  }
  return seen.size;
}

scope.onmessage = (event: MessageEvent): void => {
  const request = event.data as SampleRequest | undefined;
  if (!request || request.type !== 'sample' || !Array.isArray(request.points)) return;
  const points = request.points;

  void (async () => {
    try {
      const source = new HoydedataDem({ cellSizeM: CELL_SIZE_M });
      const total = countCells(points);
      let done = 0;

      // Progress without changing the core: wrap the window loader, which is
      // called exactly once per distinct cell (the class de-duplicates).
      const loadWindow = source.getWindow.bind(source);
      source.getWindow = (ix: number, iy: number) => {
        const promise = loadWindow(ix, iy);
        return promise.then((raster) => {
          done++;
          scope.postMessage({ type: 'progress', done, total });
          return raster;
        });
      };

      const elevations = await source.sampleElevations(points.slice());
      const buffer = Float64Array.from(elevations);
      scope.postMessage({ type: 'result', elevations: buffer }, [buffer.buffer]);
    } catch (error) {
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
