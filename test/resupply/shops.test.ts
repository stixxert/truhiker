/**
 * The bundled shop index — parsing, the corridor query, and the loader.
 *
 * Every test here is offline. The committed `data/shops.osm.bin` is read from
 * disk, so the numbers asserted are the numbers the app will see.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { LonLat } from '../../src/core/geo';
import { projectOntoRoute } from '../../src/plan/resupply';
import {
  ShopIndexFormatError,
  hasVerifiedHours,
  loadShopIndex,
  parseShopIndex,
  SHOP_INDEX_PATH,
  type ResupplyCandidate,
  type ShopIndex,
} from '../../src/resupply';

function committedBuffer(): ArrayBuffer {
  const file = readFileSync(new URL('../../data/shops.osm.bin', import.meta.url));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

/** Joker Dalsbygda, 62.52748 N 11.10911 E — a real supermarket in the file. */
const JOKER_DALSBYGDA: LonLat = { lon: 11.10911, lat: 62.52748 };
/** Coop Prix Budal, 50.85 km from Dalsbygda: far enough that it must not appear. */
const COOP_BUDAL: LonLat = { lon: 10.48376, lat: 62.88367 };

/**
 * A ~62 km east-west route at 62.529 N, i.e. 169 m north of the shop, so the
 * detour is measurable and the along-route distance is unambiguous.
 */
function dalsbygdaRoute(): LonLat[] {
  return [
    { lon: 10.5, lat: 62.529 },
    { lon: 11.7, lat: 62.529 },
  ];
}

function names(candidates: readonly ResupplyCandidate[]): string[] {
  return candidates.map((candidate) => candidate.name);
}

describe('parseShopIndex — the committed binary', () => {
  it('decodes 8,571 points with the measured per-kind counts, and reconstructs names', () => {
    const started = performance.now();
    const index = parseShopIndex(committedBuffer());
    const parseMs = performance.now() - started;

    expect(index.count).toBe(8571);
    // The binary stores no timestamp; the loader labels it with the extract date.
    expect(index.builtAt).toBe('2026-10-19T13:41:49.167Z');

    // Per-kind counts must sum to the total; each is the measured value in
    // data/MEASUREMENTS.md §1. `post`/`parcel` are the two addressable kinds that
    // the binary stores as `post_office` / `parcel_locker`.
    const byKind = new Map<string, number>();
    const all = index.near({ lon: 11.10911, lat: 62.52748 }, 5_000_000);
    expect(all.length).toBe(8571);
    for (const candidate of all) byKind.set(candidate.kind, (byKind.get(candidate.kind) ?? 0) + 1);
    expect(Object.fromEntries(byKind)).toEqual({
      supermarket: 3971,
      convenience: 554,
      general: 288,
      grocery: 24,
      fuel: 2283,
      post: 1252,
      parcel: 199,
    });

    // A known shop, reconstructed from brand + name suffix and sorted by distance.
    const near = index.near(JOKER_DALSBYGDA, 100);
    expect(near[0].name).toBe('Joker Dalsbygda');
    expect(near[0].kind).toBe('supermarket');
    expect(near[0].point.lon).toBeCloseTo(JOKER_DALSBYGDA.lon, 5);
    expect(near[0].evidence).toBe('osm');
    // OSM had an hours tag, but the value is not in the file: never "open".
    expect(near[0].hoursRecorded).toBe(true);
    expect(near[0].openingHours).toBeUndefined();
    // No bundled point is ever "verified open", however complete its OSM tags.
    expect(hasVerifiedHours(near[0])).toBe(false);
    // The post office in the same building is a separate, legitimate record.
    expect(names(near)).toContain('Dalsbygda post i butikk');

    // Parsing is a small, synchronous cost: keep it obviously so.
    expect(parseMs).toBeLessThan(500);
    console.log(`      parse ${index.count} POIs: ${parseMs.toFixed(1)} ms (offline)`);
  });
});

describe('ShopIndex.alongRoute — the corridor query', () => {
  it('finds a known shop on a synthetic route, excludes distant ones, and dedupes a second pass', () => {
    const index: ShopIndex = parseShopIndex(committedBuffer());
    const route = dalsbygdaRoute();

    const onRoute = index.alongRoute(route, 400);
    const shop = onRoute.find((candidate) => candidate.name === 'Joker Dalsbygda');
    expect(shop).toBeDefined();

    // The shop is 169 m north of a route that runs past it, 31.3 km from the
    // start (the route starts at 10.5 E). Both are metric, not degrees.
    expect(shop!.detourM).toBeGreaterThan(150);
    expect(shop!.detourM).toBeLessThan(190);
    expect(shop!.alongRouteM).toBeGreaterThan(31_200);
    expect(shop!.alongRouteM).toBeLessThan(31_400);

    // Nothing beyond the radius survives, and a shop 50 km away is absent.
    for (const candidate of onRoute) expect(candidate.detourM).toBeLessThanOrEqual(400);
    expect(names(onRoute)).not.toContain('Coop Prix Budal');
    const nearBudal = index.near(COOP_BUDAL, 20_000).map((c) => c.name);
    expect(nearBudal).toContain('Coop Prix Budal');
    // …but a 5 km probe from Dalsbygda does not reach it.
    expect(names(index.near(JOKER_DALSBYGDA, 5000))).not.toContain('Coop Prix Budal');

    // Results are ordered by distance along the route.
    for (let i = 1; i < onRoute.length; i += 1) {
      expect(onRoute[i].alongRouteM).toBeGreaterThanOrEqual(onRoute[i - 1].alongRouteM);
    }

    // Reusing the same point twice: an out-and-back route passes the shop twice
    // but must return it once, at the first passage.
    const outAndBack: LonLat[] = [
      { lon: 11.0, lat: 62.529 },
      { lon: 11.2, lat: 62.529 },
      { lon: 11.0, lat: 62.529 },
    ];
    const twice = index.alongRoute(outAndBack, 400).filter((c) => c.name === 'Joker Dalsbygda');
    expect(twice).toHaveLength(1);
    // ~5.6 km along from 11.0 E on the first pass, ~14.9 km on the return leg.
    expect(twice[0].alongRouteM).toBeGreaterThan(5_500);
    expect(twice[0].alongRouteM).toBeLessThan(5_700);

    // This corridor maths duplicates the metric projection in src/plan/resupply
    // only for speed; the two must agree or one of them is wrong.
    const cumulative: number[] = [0];
    for (let i = 1; i < route.length; i += 1) {
      cumulative.push(cumulative[i - 1] + haversineM(route[i - 1], route[i]));
    }
    const reference = projectOntoRoute({ points: route, distances: cumulative }, shop!.point);
    expect(shop!.detourM).toBeCloseTo(reference.offsetM, 3);
    expect(shop!.alongRouteM).toBeCloseTo(reference.alongM, 3);
  });
});

function haversineM(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

describe('loadShopIndex — fetch once, parse offline', () => {
  it('fetches /data/shops.osm.bin and rejects a bad magic or version with a typed error', async () => {
    const buffer = committedBuffer();
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(buffer);
    }) as unknown as typeof fetch;

    const index = await loadShopIndex(fetchImpl);
    expect(calls).toEqual([SHOP_INDEX_PATH]);
    expect(index.count).toBe(8571);

    const reasonOf = (bytes: Uint8Array): string => {
      try {
        parseShopIndex(bytes.buffer.slice(0) as ArrayBuffer);
      } catch (error) {
        expect(error).toBeInstanceOf(ShopIndexFormatError);
        return (error as ShopIndexFormatError).reason;
      }
      throw new Error('expected a ShopIndexFormatError');
    };

    const wrongMagic = new Uint8Array(16);
    wrongMagic.set([0x4e, 0x50, 0x4c, 0x53, 0x48, 0x50, 0x30, 0x32]); // 'NPLSHP02'
    expect(reasonOf(wrongMagic)).toBe('bad-version');

    const notOurs = new Uint8Array(16).fill(0x41); // 'AAAAAAAA'
    expect(reasonOf(notOurs)).toBe('bad-magic');

    const truncated = new Uint8Array(committedBuffer().slice(0, 40));
    expect(reasonOf(truncated)).toBe('truncated');
  });
});
