/**
 * The live hoydedata.no (Kartverket DTM) anchor journey.
 *
 * OPT-IN and excluded from `npm test`, so the default suite stays hermetic.
 *
 *     npm run test:live
 *     NETWORK_TESTS=1 npx vitest run test/dem.live.test.ts
 *
 * REGRESSION NOTE (kept deliberately, not executed here): a bbox query to the
 * Turrutebasen WFS (`https://wfs.geonorge.no/skwms1/wfs.turrutebasen`) with
 * coordinates in **lat,lon** order returns 0 features, while the same bbox in
 * **lon,lat** order returns >0. That axis-order bug silently produced empty
 * routes during the feasibility work. Any WFS/ArcGIS query in this project must
 * use lon,lat (x,y) order and assert a non-empty result. We do not call the WFS
 * from unit tests; this comment is the regression record.
 */

import { describe, expect, it } from 'vitest';

import { HoydedataDem, fetchDemWindow } from '../src/core/dem';
import { toUtm33 } from '../src/core/geo';

const runNetworkTests = process.env.NETWORK_TESTS === '1';
const describeLive = runNetworkTests ? describe : describe.skip;

/** Galdhøpiggen (8.3124E, 61.6363N) in EPSG:25833. */
const SUMMIT_UTM = toUtm33({ lon: 8.3124, lat: 61.6363 });
/** 5 km box around the summit: 500×500 px at 10 m/px = 16 tiles of 128×128. */
const SUMMIT_BBOX = {
  minX: SUMMIT_UTM.x - 2500,
  minY: SUMMIT_UTM.y - 2500,
  maxX: SUMMIT_UTM.x + 2500,
  maxY: SUMMIT_UTM.y + 2500,
};

const TRUE_SUMMIT_M = 2469;

describeLive('hoydedata.no — Galdhøpiggen anchor', () => {
  it('assembles the 16-tile window, reads the summit and samples a route from it', async () => {
    const raster = await fetchDemWindow(SUMMIT_BBOX, { width: 500, height: 500 });
    expect(raster.width).toBe(500);
    expect(raster.height).toBe(500);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let finite = 0;
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const v = raster.get(x, y);
        if (!Number.isFinite(v)) continue;
        finite++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    expect(finite).toBeGreaterThan(240_000); // not a mostly-empty tile grid
    expect(min).toBeGreaterThan(1000); // never 0 — the classic tile-assembly garbage
    expect(max).toBeGreaterThan(TRUE_SUMMIT_M - 5);
    expect(max).toBeLessThan(TRUE_SUMMIT_M + 5);
    // The service's local maximum is ~2467.8 m (1.2 m below the surveyed summit).
    expect(max).toBeCloseTo(2467.8, 0);

    // Bilinear sample at the nominal summit coordinate. The DEM's local maximum
    // is ~20 m north of this WGS84 coordinate, so the point reads ~2460 m —
    // documented in src/core/README.md.
    const point = raster.sampleUtm(SUMMIT_UTM.x, SUMMIT_UTM.y);
    expect(point).toBeGreaterThan(2455);
    expect(point).toBeLessThan(2470);

    // The route sampler reuses one cached 5 km window for all three points.
    const dem = new HoydedataDem();
    const points = [
      { lon: 8.3124, lat: 61.6363 }, // the summit itself
      { lon: 8.3115, lat: 61.6355 }, // ~90 m south-west, below the peak
      { lon: 8.313, lat: 61.637 }, // ~80 m north-east, on the north ridge
    ];
    const elevations = await dem.sampleElevations(points);
    expect(elevations).toHaveLength(3);
    for (const e of elevations) expect(Number.isFinite(e)).toBe(true);
    // A failed fetch cannot sneak in as 0; these are all high-mountain values.
    for (const e of elevations) expect(e).toBeGreaterThan(2000);
    expect(elevations[0]).toBeGreaterThan(2450);
    for (const e of elevations) expect(e).toBeLessThan(TRUE_SUMMIT_M + 10);
    expect(dem.cacheSize).toBe(1);
    await dem.sampleElevations(points);
    expect(dem.cacheSize).toBe(1);

    // Outside DEM coverage (open sea west of Norway) the answer is NaN, not 0.
    const sea = await fetchDemWindow(
      { minX: -20_000, minY: 7_300_000, maxX: -19_000, maxY: 7_301_000 },
      { width: 128, height: 128 },
    );
    expect(sea.width).toBe(128);
    expect(Number.isNaN(sea.sampleUtm(-19_500, 7_300_500))).toBe(true);
  });
});
