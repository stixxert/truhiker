import { describe, expect, it } from 'vitest';

import { SnapIndex } from '../../src/snap/index';
import {
  Prefetcher,
  cellOf,
  mergeCells,
  planCorridor,
  planViewport,
  type FetchBox,
  type PrefetchReport,
} from '../../src/snap/prefetch';
import { memoryBackend, SnapCache } from '../../src/snap/cache';
import type { LonLatBBox, TurruteAttributes, TurruteLine } from '../../src/snap/wfs';

const ATTRIBUTES: TurruteAttributes = {
  lokalId: 'prefetch',
  rutenavn: 'Ukjent',
  rutenummer: 'jot15',
  vedlikeholdsansvarlig: 'DNT',
  gradering: '',
  merking: 'JA',
  ruteFolger: 'ST',
  underlagstype: '',
  sesong: '',
  oppdateringsdato: '',
};

/** A corridor of `count` points heading east from lon 8.0 at 61.5°N. */
function corridor(count: number, stepDeg = 0.005, startLon = 8.0): Array<{ lon: number; lat: number }> {
  return Array.from({ length: count }, (_, i) => ({ lon: startLon + i * stepDeg, lat: 61.5 }));
}

function lineFor(bbox: LonLatBBox): TurruteLine {
  const id = `line:${bbox.minLon.toFixed(3)}:${bbox.minLat.toFixed(3)}`;
  return {
    id,
    lokalId: id,
    attributes: { ...ATTRIBUTES, lokalId: id },
    coords: [
      { lon: bbox.minLon, lat: bbox.minLat },
      { lon: bbox.maxLon, lat: bbox.maxLat },
    ],
    srsName: 'urn:ogc:def:crs:EPSG::4258',
  };
}

interface RecordingFetch {
  fetch: FetchBox;
  calls: LonLatBBox[];
}

function recordingFetch(options: { delayMs?: number; failWhen?: (bbox: LonLatBBox) => boolean } = {}): RecordingFetch {
  const calls: LonLatBBox[] = [];
  const fetch: FetchBox = async (bbox, signal) => {
    calls.push(bbox);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (options.failWhen?.(bbox)) throw new Error(`synthetic failure for ${bbox.minLon}`);
    return [lineFor(bbox)];
  };
  return { fetch, calls };
}

function makePrefetcher(fetch: FetchBox, index?: SnapIndex, dataVersion = 'test-v1'): Prefetcher {
  return new Prefetcher({
    dataVersion,
    cacheBackend: memoryBackend(),
    fetchBox: fetch,
    index,
    debounceMs: 0,
  });
}

function assertReportShape(report: PrefetchReport): void {
  expect(report).toMatchObject({
    requested: expect.any(Number),
    cached: expect.any(Number),
    failed: expect.any(Number),
  });
}

describe('planCorridor / planViewport / cellOf / mergeCells', () => {
  it('collapses a corridor into the cells it crosses, one box per cell, never exceeding maxRequests', () => {
    // 11 points at 0.005° spacing cross three 0.02° cells (400, 401, 402).
    const boxes = planCorridor(corridor(11, 0.005), { cellDeg: 0.02, maxRequests: 6 });
    expect(boxes.map((box) => box.id)).toEqual([
      'c:0.02:400:3075',
      'c:0.02:401:3075',
      'c:0.02:402:3075',
    ]);

    // Points in one cell share a box.
    expect(
      planCorridor(
        [
          { lon: 8.001, lat: 61.501 },
          { lon: 8.002, lat: 61.502 },
          { lon: 8.003, lat: 61.503 },
        ],
        { cellDeg: 0.02 },
      ),
    ).toHaveLength(1);

    // Ten cells are merged into at most maxRequests boxes inside the corridor.
    const merged = planCorridor(corridor(10, 0.02, 8.0), { cellDeg: 0.02, maxRequests: 3 });
    expect(merged).toHaveLength(3);
    for (const box of merged) {
      expect(box.bbox.minLon).toBeGreaterThanOrEqual(8.0);
      expect(box.bbox.maxLon).toBeLessThanOrEqual(8.2 + 1e-9);
      expect(box.bbox.minLat).toBeGreaterThanOrEqual(61.5);
      expect(box.bbox.maxLat).toBeLessThanOrEqual(61.52);
    }

    // maxRequests = 1 covers everything in one box.
    const one = planCorridor(corridor(5, 0.02), { cellDeg: 0.02, maxRequests: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.bbox.maxLon - one[0]!.bbox.minLon).toBeCloseTo(0.1, 9);

    // 500 cells are still covered exactly once by four boxes.
    const long = planCorridor(corridor(500, 0.02), { cellDeg: 0.02, maxRequests: 4 });
    expect(long).toHaveLength(4);
    expect(long.reduce((sum, box) => sum + box.cells.length, 0)).toBe(500);

    expect(() => planCorridor(corridor(2), { cellDeg: 0 })).toThrow(RangeError);
    expect(() => planCorridor(corridor(2), { cellDeg: 1 })).toThrow(RangeError);

    // cellOf gives a stable id and bbox; mergeCells caps rectangles.
    const cell = cellOf({ lon: 8.31, lat: 61.51 }, 0.02);
    expect(cell.ix).toBe(Math.floor(8.31 / 0.02));
    expect(cell.id).toBe(`c:0.02:${cell.ix}:${cell.iy}`);
    expect(cell.bbox.minLon).toBeCloseTo(8.3, 9);
    expect(cell.bbox.minLat).toBeCloseTo(61.5, 9);
    expect(cellOf({ lon: 8.31, lat: 61.51 }, 0.02).id).toBe(cell.id);

    expect(mergeCells([])).toEqual([]);
    expect(
      mergeCells(
        [
          { ix: 400, iy: 3075 },
          { ix: 401, iy: 3075 },
        ],
        { cellDeg: 0.02, maxRequests: 5 },
      ).map((box) => box.id),
    ).toEqual(['c:0.02:400:3075', 'c:0.02:401:3075']);

    const rectangles = mergeCells(
      Array.from({ length: 10 }, (_, i) => ({ ix: 400 + i, iy: 3075 })),
      { cellDeg: 0.02, maxRequests: 2 },
    );
    expect(rectangles).toHaveLength(2);
    expect(rectangles.every((box) => box.id.startsWith('m:0.02:'))).toBe(true);
    expect(rectangles.reduce((sum, box) => sum + box.cells.length, 0)).toBe(10);
  });

  it('covers a viewport with at most maxRequests non-empty boxes, coarsens huge viewports and validates input', () => {
    const viewport: LonLatBBox = { minLon: 8.0, minLat: 61.5, maxLon: 8.1, maxLat: 61.6 };
    const boxes = planViewport(viewport, { cellDeg: 0.02, maxRequests: 4 });
    expect(boxes).toHaveLength(4);
    for (const box of boxes) {
      expect(box.bbox.minLon).toBeGreaterThanOrEqual(viewport.minLon - 1e-9);
      expect(box.bbox.maxLon).toBeLessThanOrEqual(viewport.maxLon + 1e-9);
      expect(box.bbox.minLat).toBeGreaterThanOrEqual(viewport.minLat - 1e-9);
      expect(box.bbox.maxLat).toBeLessThanOrEqual(viewport.maxLat + 1e-9);
    }

    // Exactly two cells wide: 8.0–8.02 and 8.02–8.04.
    expect(
      planViewport(
        { minLon: 8.0, minLat: 61.5, maxLon: 8.04, maxLat: 61.52 },
        { cellDeg: 0.02, maxRequests: 8 },
      ),
    ).toHaveLength(2);

    // A huge viewport is coarsened instead of enumerating millions of cells.
    const huge = planViewport({ minLon: 5, minLat: 58, maxLon: 10, maxLat: 62 }, { cellDeg: 0.02, maxRequests: 2 });
    expect(huge).toHaveLength(2);
    expect(huge[0]!.bbox.maxLon - huge[0]!.bbox.minLon).toBeGreaterThan(1);

    expect(() =>
      planViewport({ minLon: 8.1, minLat: 61.5, maxLon: 8.0, maxLat: 61.6 }),
    ).toThrow(RangeError);
  });
});

describe('Prefetcher', () => {
  it('requests one bbox per cell, hits the cache on a repeat, reports failures and caps concurrency at 2', async () => {
    const recorder = recordingFetch();
    const index = new SnapIndex();
    const prefetcher = makePrefetcher(recorder.fetch, index);

    const report = await prefetcher.prefetchCorridor(corridor(11, 0.005), { debounceMs: 0 });
    assertReportShape(report);
    expect(report).toMatchObject({ boxes: 3, requested: 3, cached: 0, failed: 0, aborted: false, lines: 3 });
    expect(recorder.calls).toHaveLength(3);
    expect(index.lineCount).toBe(3);

    const again = await prefetcher.prefetchCorridor(corridor(11, 0.005), { debounceMs: 0 });
    expect(again).toMatchObject({ requested: 0, cached: 3, failed: 0 });
    expect(recorder.calls).toHaveLength(3);

    // A failing cell is reported, not thrown.
    const failing = recordingFetch({ failWhen: (bbox) => Math.round(bbox.minLon * 100) === 802 });
    const failed = await makePrefetcher(failing.fetch).prefetchCorridor(corridor(11, 0.005), {
      debounceMs: 0,
    });
    expect(failed).toMatchObject({ boxes: 3, requested: 3, failed: 1 });
    expect(failed.failures[0]!.error).toMatch(/synthetic failure/);

    // Concurrency never exceeds 2.
    let active = 0;
    let maxActive = 0;
    const throttled: FetchBox = async (bbox, signal) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      if (signal.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return [lineFor(bbox)];
    };
    const concurrent = await makePrefetcher(throttled).prefetchCorridor(corridor(6, 0.02), {
      debounceMs: 0,
    });
    expect(concurrent.requested).toBe(6);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(concurrent.failed).toBe(0);
  });

  it('aborts a superseded run and a debounced burst, honours an external signal and is version-aware', async () => {
    // A superseded run resolves with aborted: true; the new one succeeds.
    let calls = 0;
    const hanging: FetchBox = (bbox, signal) => {
      calls++;
      return new Promise<TurruteLine[]>((resolve, reject) => {
        if (calls <= 2) {
          if (signal.aborted) {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
            return;
          }
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        } else {
          setTimeout(() => resolve([lineFor(bbox)]), 1);
        }
      });
    };
    const prefetcher = makePrefetcher(hanging);
    const points = corridor(11, 0.005);
    const firstPromise = prefetcher.prefetchCorridor(points, { debounceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondPromise = prefetcher.prefetchCorridor(points, { debounceMs: 0 });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(second.failed).toBe(0);
    expect(second.requested).toBeGreaterThanOrEqual(1);
    expect(calls).toBeGreaterThanOrEqual(3);

    // A debounced burst is cancelled by the immediate call.
    const recorder = recordingFetch();
    const debounced = makePrefetcher(recorder.fetch);
    const [cancelled, kept] = await Promise.all([
      debounced.prefetchCorridor(points, { debounceMs: 20 }),
      debounced.prefetchCorridor(points, { debounceMs: 0 }),
    ]);
    expect(cancelled.aborted).toBe(true);
    expect(cancelled.requested).toBe(0);
    expect(kept).toMatchObject({ aborted: false, requested: 3 });
    expect(recorder.calls).toHaveLength(3);

    // An external signal aborts the run.
    const slow = recordingFetch({ delayMs: 50 });
    const controller = new AbortController();
    const abortedPromise = makePrefetcher(slow.fetch).prefetchCorridor(corridor(6, 0.02), {
      debounceMs: 0,
      signal: controller.signal,
    });
    controller.abort();
    expect((await abortedPromise).aborted).toBe(true);

    // A new dataVersion misses the old cache.
    const backend = memoryBackend();
    const versionRecorder = recordingFetch();
    const v1 = new Prefetcher({
      dataVersion: 'v1',
      cache: new SnapCache({ dataVersion: 'v1', backend }),
      fetchBox: versionRecorder.fetch,
      debounceMs: 0,
    });
    await v1.prefetchCorridor(points, { debounceMs: 0 });
    const v2 = new Prefetcher({
      dataVersion: 'v2',
      cache: new SnapCache({ dataVersion: 'v2', backend }),
      fetchBox: versionRecorder.fetch,
      debounceMs: 0,
    });
    const report = await v2.prefetchCorridor(points, { debounceMs: 0 });
    expect(report.cached).toBe(0);
    expect(report.requested).toBe(3);
    expect(versionRecorder.calls).toHaveLength(6);
  }, 5_000);
});
