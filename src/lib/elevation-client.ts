/**
 * Client side of the elevation worker, with an explicit fallback.
 *
 * If the browser refuses to construct a Worker (CSP, ancient engine), sampling
 * falls back to the main thread — slower and with a frozen UI, but the numbers
 * are the same. Both paths reject with a message on failure; nothing here turns
 * a failed fetch into 0 m.
 *
 * There is exactly **one** worker for the page. A new job does not get a new
 * worker, and cancelling does not terminate it: the worker owns the DEM window
 * cache, so an edit that re-samples the same route costs nothing but the maths.
 * Stale jobs are dropped by id instead of by killing the worker that would have
 * warmed the cache.
 */

import { cumulativeDistances, type LonLat } from '../core/geo';

export interface ElevationProgress {
  done: number;
  total: number;
  /**
   * What the job is doing: `download` while DEM windows are on the wire (with a
   * cell count), `compute` once they are all here and the profile is being built.
   */
  phase: 'download' | 'compute';
}

export interface ElevationJob {
  promise: Promise<Float64Array>;
  /** Stop the job. A cancelled job neither resolves nor rejects. */
  cancel(): void;
}

interface ElevationOptions {
  onProgress?: (progress: ElevationProgress) => void;
}

type WorkerResponse =
  | { type: 'progress'; jobId: number; phase: 'download' | 'compute'; done?: number; total?: number }
  | { type: 'result'; jobId: number; elevations: Float64Array }
  | { type: 'error'; jobId: number; message: string };

/**
 * Pixel size for a route of this length. A profile is read at a glance; 10 m
 * data over 200 km is 20× the bytes for detail nobody can see on a 900 px chart.
 */
export function pixelSizeFor(routeLengthM: number): number {
  if (!Number.isFinite(routeLengthM) || routeLengthM <= 20_000) return 10;
  if (routeLengthM <= 60_000) return 15;
  if (routeLengthM <= 150_000) return 20;
  return 30;
}

let sharedWorker: Worker | null = null;
let nextJobId = 1;

function getWorker(): Worker | null {
  if (sharedWorker) return sharedWorker;
  try {
    sharedWorker = new Worker(new URL('../workers/dem.worker.ts', import.meta.url), {
      type: 'module',
      name: 'elevation',
    });
    return sharedWorker;
  } catch {
    return null;
  }
}

async function sampleOnMainThread(
  points: readonly LonLat[],
  pixelSizeM: number,
  options: ElevationOptions,
): Promise<Float64Array> {
  const { HoydedataDem } = await import('../core/dem');
  const source = new HoydedataDem({ pixelSizeM });
  const elevations = await source.sampleElevations(points.slice());
  options.onProgress?.({ done: 1, total: 1, phase: 'compute' });
  return Float64Array.from(elevations);
}

export function createElevationJob(
  points: readonly LonLat[],
  options: ElevationOptions = {},
): ElevationJob {
  const distances = cumulativeDistances(points);
  const pixelSizeM = pixelSizeFor(distances[distances.length - 1] ?? 0);
  const jobId = nextJobId++;
  let cancelled = false;
  let settled = false;

  const promise = new Promise<Float64Array>((resolve, reject) => {
    const worker = getWorker();
    if (!worker) {
      void sampleOnMainThread(points, pixelSizeM, options)
        .then((elevations) => {
          if (!cancelled && !settled) {
            settled = true;
            resolve(elevations);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled && !settled) {
            settled = true;
            reject(error);
          }
        });
      return;
    }

    const handler = (event: MessageEvent): void => {
      const message = event.data as WorkerResponse | undefined;
      // A job that was replaced must not paint into the new one.
      if (!message || message.jobId !== jobId || cancelled) return;
      switch (message.type) {
        case 'progress':
          options.onProgress?.({
            done: message.done ?? 0,
            total: message.total ?? 0,
            phase: message.phase,
          });
          break;
        case 'result':
          if (!settled) {
            settled = true;
            worker.removeEventListener('message', handler);
            resolve(
              message.elevations instanceof Float64Array
                ? message.elevations
                : Float64Array.from(message.elevations as unknown as number[]),
            );
          }
          break;
        case 'error':
          if (!settled) {
            settled = true;
            worker.removeEventListener('message', handler);
            reject(new Error(message.message));
          }
          break;
        default:
          break;
      }
    };

    worker.addEventListener('message', handler);
    worker.addEventListener(
      'error',
      (event: ErrorEvent) => {
        // A crashed worker is replaced on the next job, cache and all.
        sharedWorker = null;
        if (!settled && !cancelled) {
          settled = true;
          reject(new Error(event.message || 'elevation worker crashed'));
        }
      },
      { once: true },
    );

    worker.postMessage({
      type: 'sample',
      jobId,
      pixelSizeM,
      points: points.map((p) => ({ lon: p.lon, lat: p.lat })),
    });
  });

  return {
    promise,
    cancel(): void {
      // A cancelled job stays pending on purpose: its result would be applied
      // to a route that is no longer loaded. The app drops the reference and
      // the promise is collected. The worker keeps running, because the windows
      // it is downloading are the ones the next job will ask for.
      cancelled = true;
    },
  };
}
