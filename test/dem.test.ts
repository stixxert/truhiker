import { describe, expect, it } from 'vitest';

import { HoydedataDem, demExportUrl, fetchDemWindow, type BBox25833 } from '../src/core/dem';
import { toUtm33, type LonLat } from '../src/core/geo';
import { buildTiff } from './helpers/tiff-writer';

const BBOX: BBox25833 = { minX: 1000, minY: 2000, maxX: 2000, maxY: 3000 };

/** Elevation as a function of EPSG:25833 x/y — bilinear interpolation is exact for a plane. */
function planeElevation(x: number, y: number): number {
  return 1000 + (x - 1000) / 1000 + (y - 2000) / 10000;
}

interface SyntheticServer {
  fetch: typeof fetch;
  calls: number;
  urls: string[];
}

/** A fake hoydedata.no that serves a plane at whatever bbox/size is requested. */
function syntheticServer(options: { width?: number; height?: number; noData?: number } = {}): SyntheticServer {
  const state: SyntheticServer = {
    calls: 0,
    urls: [],
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      state.calls++;
      const url = new URL(String(input));
      state.urls.push(url.toString());
      const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
      const [requestedWidth, requestedHeight] = (url.searchParams.get('size') ?? '').split(',').map(Number);
      const width = options.width ?? requestedWidth;
      const height = options.height ?? requestedHeight;

      const data = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const px = bbox[0] + ((x + 0.5) * (bbox[2] - bbox[0])) / width;
          const py = bbox[3] - ((y + 0.5) * (bbox[3] - bbox[1])) / height;
          data[y * width + x] = planeElevation(px, py);
        }
      }
      const buffer = buildTiff({ width, height, data, noData: options.noData });
      return new Response(buffer, { status: 200, headers: { 'content-type': 'image/tiff' } });
    }) as typeof fetch,
  };
  return state;
}

describe('demExportUrl', () => {
  it('carries the ArcGIS exportImage parameters the service requires', () => {
    const url = new URL(demExportUrl(BBOX, { width: 128, height: 64 }));
    expect(url.origin + url.pathname).toBe(
      'https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      bbox: '1000,2000,2000,3000',
      bboxSR: '25833',
      imageSR: '25833',
      size: '128,64',
      format: 'tiff',
      f: 'image',
    });
  });
});

describe('fetchDemWindow (synthetic service)', () => {
  it('parses the TIFF, georeferences it from the request bbox and interpolates bilinearly', async () => {
    const server = syntheticServer();
    const raster = await fetchDemWindow(BBOX, { width: 128, height: 128 }, { fetchImpl: server.fetch });

    expect(server.calls).toBe(1);
    expect(raster.width).toBe(128);
    expect(raster.height).toBe(128);
    expect(raster.bbox).toEqual(BBOX);

    // Pixel centres.
    const dx = 1000 / 128;
    const dy = 1000 / 128;
    for (const [col, row] of [
      [0, 0],
      [10, 20],
      [64, 64],
      [127, 127],
    ] as const) {
      const cx = BBOX.minX + (col + 0.5) * dx;
      const cy = BBOX.maxY - (row + 0.5) * dy;
      expect(raster.sampleUtm(cx, cy)).toBeCloseTo(planeElevation(cx, cy), 2);
    }

    // Midpoint between pixel centres (10, 20) and (11, 20).
    const x = BBOX.minX + 11 * dx;
    const y = BBOX.maxY - 20.5 * dy;
    const expected = (planeElevation(x - dx / 2, y) + planeElevation(x + dx / 2, y)) / 2;
    expect(raster.sampleUtm(x, y)).toBeCloseTo(expected, 2);

    // Outside the window is unknown, never 0.
    expect(raster.sampleUtm(BBOX.minX - 100, BBOX.minY - 100)).toBeNaN();
    expect(raster.sampleUtm(BBOX.maxX + 100, BBOX.maxY + 100)).toBeNaN();

    // NoData pixels are dropped from the interpolation and the rest renormalised.
    const width = 64;
    const height = 64;
    const data = new Float32Array(width * height).fill(500);
    data[10 * width + 10] = -32767;
    const noDataServer = (async () =>
      new Response(buildTiff({ width, height, data, noData: -32767 }))) as typeof fetch;
    const noData = await fetchDemWindow(BBOX, { width, height }, { fetchImpl: noDataServer });
    expect(noData.sampleUtm(BBOX.minX + 11 * (1000 / width), BBOX.maxY - 10.5 * (1000 / height))).toBe(500);
  });

  it('fails loudly for every failure mode instead of returning zeros', async () => {
    // 5xx is retried with backoff and then succeeds.
    const good = syntheticServer();
    let attempts = 0;
    const flaky: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      attempts++;
      if (attempts < 3) return new Response('server error', { status: 503, statusText: 'Service Unavailable' });
      return good.fetch(input, init);
    }) as typeof fetch;
    const raster = await fetchDemWindow(
      BBOX,
      { width: 32, height: 32 },
      { fetchImpl: flaky, attempts: 3, retryBaseMs: 1 },
    );
    expect(attempts).toBe(3);
    expect(raster.width).toBe(32);

    // A definitive 4xx is not retried.
    let calls = 0;
    const badRequest: typeof fetch = (async () => {
      calls++;
      return new Response('bad request', { status: 400, statusText: 'Bad Request' });
    }) as typeof fetch;
    await expect(
      fetchDemWindow(BBOX, { width: 16, height: 16 }, { fetchImpl: badRequest, attempts: 5, retryBaseMs: 1 }),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);

    // A non-TIFF body (an HTML error page) is retried and then rejected.
    let htmlCalls = 0;
    const html: typeof fetch = (async () => {
      htmlCalls++;
      return new Response('<html><body>temporarily unavailable</body></html>', { status: 200 });
    }) as typeof fetch;
    await expect(
      fetchDemWindow(BBOX, { width: 16, height: 16 }, { fetchImpl: html, attempts: 2, retryBaseMs: 1 }),
    ).rejects.toThrow(/non-TIFF/);
    expect(htmlCalls).toBe(2);

    // A hung request times out.
    const hanging: typeof fetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        );
      })) as typeof fetch;
    await expect(
      fetchDemWindow(BBOX, { width: 16, height: 16 }, { fetchImpl: hanging, timeoutMs: 20, attempts: 1 }),
    ).rejects.toThrow(/timed out after 20 ms/);

    // A response whose dimensions do not match the request is refused.
    const wrongSize = syntheticServer({ width: 64, height: 64 });
    await expect(
      fetchDemWindow(BBOX, { width: 128, height: 128 }, { fetchImpl: wrongSize.fetch, attempts: 1 }),
    ).rejects.toThrow(/64×64 but 128×128 was requested/);

    // bbox and size are validated before any request is made.
    const counting = syntheticServer();
    await expect(
      fetchDemWindow({ minX: 10, minY: 10, maxX: 0, maxY: 20 }, { width: 8, height: 8 }, { fetchImpl: counting.fetch }),
    ).rejects.toThrow(/bbox must have/);
    await expect(
      fetchDemWindow(BBOX, { width: 0, height: 8 }, { fetchImpl: counting.fetch }),
    ).rejects.toThrow(/positive integers/);
    expect(counting.calls).toBe(0);
  });
});

describe('HoydedataDem.sampleElevations (synthetic service)', () => {
  it('requests one window per 5 km cell, interpolates every point and caches the windows', async () => {
    const server = syntheticServer();
    const dem = new HoydedataDem({ fetchImpl: server.fetch });

    const nearSummit: LonLat = { lon: 8.3124, lat: 61.6363 };
    const points: LonLat[] = [
      nearSummit,
      { lon: 8.313, lat: 61.636 },
      { lon: 8.311, lat: 61.637 },
      { lon: 8.318, lat: 61.638 },
      { lon: 8.32, lat: 61.6363 },
    ];
    const elevations = await dem.sampleElevations(points);
    expect(elevations).toHaveLength(points.length);
    expect(server.calls).toBe(1); // all five points are in the same cell
    for (let i = 0; i < points.length; i++) {
      const p = toUtm33(points[i]);
      expect(elevations[i]).toBeCloseTo(planeElevation(p.x, p.y), 1);
    }

    // A second call reuses the cached window.
    await dem.sampleElevations([nearSummit]);
    expect(server.calls).toBe(1);
    expect(dem.cacheSize).toBe(1);

    // A multi-cell route issues one request per cell and never returns NaN.
    const wide: LonLat[] = [
      { lon: 8.3124, lat: 61.6363 },
      { lon: 8.5, lat: 61.7 },
      { lon: 8.7, lat: 61.8 },
    ];
    const cells = new Set(
      wide.map((p) => {
        const { x, y } = toUtm33(p);
        return `${Math.floor(x / 5000)},${Math.floor(y / 5000)}`;
      }),
    );
    expect(cells.size).toBeGreaterThan(1);
    const before = server.calls;
    const spread = await new HoydedataDem({ fetchImpl: server.fetch }).sampleElevations(wide);
    expect(spread).toHaveLength(3);
    for (const elevation of spread) expect(Number.isFinite(elevation)).toBe(true);
    expect(server.calls - before).toBe(cells.size);
  });

  it('rejects off-zone points instead of sampling garbage', async () => {
    const server = syntheticServer();
    const dem = new HoydedataDem({ fetchImpl: server.fetch });
    await expect(dem.sampleElevations([{ lon: 40, lat: 60 }])).rejects.toThrow(/central meridian/);
    expect(server.calls).toBe(0);
  });
});
