/**
 * Acceptance #5 — the Galdhøpiggen elevation anchor, offline.
 *
 * `test/fixtures/galdhopiggen-128.tif` is a captured hoydedata.no response for
 * a 1000 × 1000 m window around the summit (bbox 145496,6851374 →
 * 146496,6852374, 128 × 128 px). Until now the 2469 m anchor lived only in the
 * live test, so CI never guarded it.
 *
 * The `HoydedataDem` window geometry is chosen so the cell containing the
 * summit is exactly that bbox at 128 × 128: only the injected fetch is fake, the
 * decode, georeferencing, bilinear sampling and the profile pipeline are real.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { HoydedataDem } from '../../src/core/dem';
import { fromUtm33 } from '../../src/core/geo';
import { buildProfile } from '../../src/core/profile';

const FIXTURE = readFileSync(new URL('../fixtures/galdhopiggen-128.tif', import.meta.url));
const TIFF = FIXTURE.buffer.slice(
  FIXTURE.byteOffset,
  FIXTURE.byteOffset + FIXTURE.byteLength,
) as ArrayBuffer;

/** The captured window, metres in EPSG:25833. */
const WINDOW = { minX: 145496, minY: 6851374, maxX: 146496, maxY: 6852374 };
/** 128 px across a 1000 m window. */
const PIXEL_M = (WINDOW.maxX - WINDOW.minX) / 128;
/** The peak pixel (64, 61) of the captured raster, in window metres. */
const PEAK = {
  x: WINDOW.minX + (64 + 0.5) * PIXEL_M,
  y: WINDOW.maxY - (61 + 0.5) * PIXEL_M,
};

const TRUE_SUMMIT_M = 2469;

describe('acceptance: the Galdhøpiggen anchor through HoydedataDem → buildProfile', () => {
  it('decodes the captured window offline and profiles the summit within 2469 ± 5 m', async () => {
    const requests: string[] = [];
    const dem = new HoydedataDem({
      // cellSizeM/padM are chosen so the summit's cell window is exactly the
      // captured bbox; pixelSizeM makes it 128 × 128.
      cellSizeM: 473.244733,
      padM: 263.377634,
      pixelSizeM: PIXEL_M,
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return new Response(TIFF, { status: 200, headers: { 'content-type': 'image/tiff' } });
      }) as typeof fetch,
    });

    // A 210 m west→east line through the summit pixel, sampled at 10 m.
    const coords = [];
    for (let x = PEAK.x - 100; x <= PEAK.x + 100; x += 10) {
      coords.push(fromUtm33({ x, y: PEAK.y }));
    }
    const elevations = await dem.sampleElevations(coords);

    // One window, all elevations real: the fetch is the only fake, and a
    // failure could not sneak in as 0 m.
    expect(requests).toHaveLength(1);
    expect(dem.cacheSize).toBe(1);
    for (const elevation of elevations) expect(elevation).toBeGreaterThan(2000);

    const profile = buildProfile(coords, elevations);
    expect(profile.samples).toHaveLength(coords.length);

    const highest = Math.max(...profile.samples.map((sample) => sample.ele));
    expect(highest).toBeGreaterThan(TRUE_SUMMIT_M - 5);
    expect(highest).toBeLessThan(TRUE_SUMMIT_M + 5);
    // The captured raster's local maximum is 2467.8 m (1.2 m below the surveyed
    // summit); the median filter trims the single-pixel peak by ~1.5 m.
    expect(highest).toBeCloseTo(2466, 0);

    // The profile is a climb and a descent, not a flat line or a spike.
    expect(profile.ascentM).toBeGreaterThan(50);
    expect(profile.descentM).toBeGreaterThan(20);
    expect(profile.distanceM).toBeGreaterThan(190);
    expect(profile.distanceM).toBeLessThan(210);
    expect(profile.filledSamples).toBe(0);
  });
});
