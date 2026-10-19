/**
 * Client side of the elevation worker, with an explicit fallback.
 *
 * If the browser refuses to construct a Worker (CSP, ancient engine), sampling
 * falls back to the main thread — slower and with a frozen UI, but the numbers
 * are the same. Both paths reject with a message on failure; nothing here turns
 * a failed fetch into 0 m.
 */

import type { LonLat } from '../core/geo';

export interface ElevationProgress {
  done: number;
  total: number;
}

export interface ElevationJob {
  promise: Promise<Float64Array>;
  /** Stop the job. A cancelled job neither resolves nor rejects. */
  cancel(): void;
}

export interface ElevationOptions {
  onProgress?: (progress: ElevationProgress) => void;
}

type WorkerResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; elevations: Float64Array }
  | { type: 'error'; message: string };

async function sampleOnMainThread(
  points: readonly LonLat[],
  options: ElevationOptions,
): Promise<Float64Array> {
  const { HoydedataDem } = await import('../core/dem');
  const source = new HoydedataDem();
  const elevations = await source.sampleElevations(points.slice());
  options.onProgress?.({ done: 1, total: 1 });
  return Float64Array.from(elevations);
}

export function createElevationJob(
  points: readonly LonLat[],
  options: ElevationOptions = {},
): ElevationJob {
  let worker: Worker | null = null;
  let settled = false;
  let cancelled = false;
  const promise = new Promise<Float64Array>((resolve, reject) => {
    try {
      worker = new Worker(new URL('../workers/dem.worker.ts', import.meta.url), {
        type: 'module',
        name: 'elevation',
      });
    } catch (error) {
      // Worker construction is the only synchronous failure we can recover
      // from; run the same pipeline on the main thread.
      void sampleOnMainThread(points, options)
        .then((elevations) => {
          if (!cancelled && !settled) {
            settled = true;
            resolve(elevations);
          }
        })
        .catch((fallbackError: unknown) => {
          if (!cancelled && !settled) {
            settled = true;
            reject(
              new Error(
                `elevation sampling failed (main-thread fallback after worker error: ` +
                  `${error instanceof Error ? error.message : String(error)}): ` +
                  `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
                { cause: fallbackError },
              ),
            );
          }
        });
      return;
    }

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerResponse | undefined;
      if (!message || cancelled) return;
      switch (message.type) {
        case 'progress':
          options.onProgress?.({ done: message.done, total: message.total });
          break;
        case 'result':
          if (!settled) {
            settled = true;
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
            reject(new Error(message.message));
          }
          break;
        default:
          break;
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      if (!settled && !cancelled) {
        settled = true;
        reject(new Error(event.message || 'elevation worker crashed'));
      }
    };

    worker.postMessage({ type: 'sample', points: points.map((p) => ({ lon: p.lon, lat: p.lat })) });
  });

  return {
    promise,
    cancel(): void {
      // A cancelled job stays pending on purpose: its result would be applied
      // to a route that is no longer loaded. The app drops the reference and
      // the promise is collected.
      cancelled = true;
      worker?.terminate();
      worker = null;
    },
  };
}
