/**
 * The bundled shop index — parsing, the corridor query, and the loader.
 *
 * Every test here is offline. The generated `data/shops.osm.bin` (build output,
 * never committed — D24) is read from disk, so the numbers asserted are the
 * numbers the app will see. `npm run verify` builds it first; a bare clone
 * needs the one-off step in README.md.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { LonLat } from '../../src/core/geo';
import { projectOntoRoute } from '../../src/plan/resupply';
import {
  COMMITTED_INDEX_BUILT_AT,
  SHOP_INDEX_PATH,
  SHOP_PROVENANCE_PATH,
  ShopIndexFormatError,
  hasVerifiedHours,
  loadShopIndex,
  parseShopIndex,
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

describe('parseShopIndex — the bundled extract', () => {
  it('decodes 8,571 points with the measured per-kind counts, and reconstructs names', () => {
    const started = performance.now();
    const index = parseShopIndex(committedBuffer());
    const parseMs = performance.now() - started;

    expect(index.count).toBe(8571);
    // The binary stores no timestamp; the loader labels it with the extract date.
    expect(index.builtAt).toBe('2026-10-19T13:41:49.167Z');

    // Per-kind counts must sum to the total; each is a measured value from the
    // pinned extract. `post`/`parcel` are the two addressable kinds that
    // the binary stores as `post_office` / `parcel_locker`.
    //
    // A query returns the area the app can plan in, not every record: the
    // national extract also carries 13 Svalbard points (74.5–78.9°N) and 86 in
    // the zone-35 north-east, where there is no elevation, trail or weather data
    // to plan with. `index.count` still reports the artefact.
    const byKind = new Map<string, number>();
    const all = index.near({ lon: 11.10911, lat: 62.52748 }, 5_000_000);
    expect(all.length).toBe(8472);
    for (const candidate of all) byKind.set(candidate.kind, (byKind.get(candidate.kind) ?? 0) + 1);
    expect(Object.fromEntries(byKind)).toEqual({
      supermarket: 3940,
      convenience: 542,
      general: 284,
      grocery: 24,
      fuel: 2254,
      post: 1230,
      parcel: 198,
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

describe('loadShopIndex — fetch twice, parse offline', () => {
  it('labels the index with the served date, falls back to the committed one, and rejects a bad magic or version with a typed error', async () => {
    const buffer = committedBuffer();
    const calls: string[] = [];
    const provenance = { buildDate: '2026-11-01T04:00:00.000Z', source: { extractDate: '2026-10-31' } };
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = String(input);
      calls.push(path);
      if (path === SHOP_PROVENANCE_PATH) return new Response(JSON.stringify(provenance));
      return new Response(buffer);
    }) as unknown as typeof fetch;

    const index = await loadShopIndex(fetchImpl);
    // The provenance is asked for alongside the artefact, not after it.
    expect(calls.slice().sort()).toEqual([SHOP_INDEX_PATH, SHOP_PROVENANCE_PATH].sort());
    expect(index.count).toBe(8571);
    // A refreshed deployment serves points newer than the commit, so the served
    // provenance dates the index — the committed constant is only the fallback.
    expect(index.builtAt).toBe('2026-10-31');

    // No provenance (404, or a copy that is not JSON): the committed date stands in
    // rather than the load failing, because a missing date is no reason to show an
    // empty map.
    const noProvenance = (async (input: string | URL | Request) =>
      String(input) === SHOP_PROVENANCE_PATH
        ? new Response('gone', { status: 404 })
        : new Response(buffer)) as unknown as typeof fetch;
    expect((await loadShopIndex(noProvenance)).builtAt).toBe(COMMITTED_INDEX_BUILT_AT);

    const notJson = (async (input: string | URL | Request) =>
      String(input) === SHOP_PROVENANCE_PATH
        ? new Response('<html>a cached error page</html>')
        : new Response(buffer)) as unknown as typeof fetch;
    expect((await loadShopIndex(notJson)).builtAt).toBe(COMMITTED_INDEX_BUILT_AT);

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

describe('loadShopIndex — a server that stops answering', () => {
  it('bounds both requests, and a stall fails with a message instead of hanging', async () => {
    const buffer = committedBuffer();

    // Every request carries a deadline. Bound to 20 ms here so the timeout path is
    // exercised without a 15-second wait; the default is asserted by the constant.
    const signals: Array<AbortSignal | undefined> = [];
    const answering = (async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal | undefined);
      return String(input) === SHOP_PROVENANCE_PATH
        ? new Response('gone', { status: 404 })
        : new Response(buffer);
    }) as unknown as typeof fetch;
    await loadShopIndex(answering, { timeoutMs: 20 });
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);

    // The artefact request accepts the connection and never answers.
    let stalled: AbortSignal | undefined;
    const stall = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === SHOP_PROVENANCE_PATH) {
        return Promise.resolve(new Response('gone', { status: 404 }));
      }
      const signal = init?.signal;
      if (!signal) throw new Error('the index request was given no deadline');
      stalled = signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject((signal as AbortSignal).reason), { once: true });
      });
    }) as unknown as typeof fetch;

    const error = await loadShopIndex(stall, { timeoutMs: 20 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `shop index fetch failed: no response within 20 ms from ${SHOP_INDEX_PATH}`,
    );
    expect(((error as Error).cause as Error | undefined)?.name).toBe('TimeoutError');
    expect(stalled?.aborted).toBe(true);

    // The same deadline covers the body: headers that arrive and then stop moving
    // is the half-open stream this bounds, not a successful response.
    const haltBody = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === SHOP_PROVENANCE_PATH) {
        return Promise.resolve(new Response('gone', { status: 404 }));
      }
      const signal = init?.signal;
      if (!signal) throw new Error('the index request was given no deadline');
      return Promise.resolve({
        ok: true,
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject((signal as AbortSignal).reason), {
              once: true,
            });
          }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    await expect(loadShopIndex(haltBody, { timeoutMs: 20 })).rejects.toThrow(
      /no response within 20 ms/,
    );

    // A failure, not "no index": nothing is cached, so the panel's retry runs the
    // loader again and a working server still yields the full index.
    expect((await loadShopIndex(answering, { timeoutMs: 20 })).count).toBe(8571);
  });
});

describe('the served artefact', () => {
  it('matches its published checksum, stays inside Norway, and decodes every name', () => {
    const bytes = readFileSync(new URL('../../data/shops.osm.bin', import.meta.url));
    // The pin, not the artefact's own provenance: the provenance is written by the
    // same run as the bytes, so it can only agree with itself (D24).
    const manifest = JSON.parse(
      readFileSync(new URL('../../tools/data-manifest.json', import.meta.url), 'utf8'),
    ) as {
      artefacts: Array<{ sha256: string; bytes: number; counts: { total: number } }>;
    };
    const pin = manifest.artefacts[0];

    // A count-only test would pass on a file with the right number of wrong
    // points. The checksum is what pins the bytes that ship.
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(pin.sha256);
    expect(bytes.byteLength).toBe(pin.bytes);

    const index = parseShopIndex(committedBuffer());
    expect(index.count).toBe(pin.counts.total);

    // The Geofabrik Norway extract includes Svalbard (Longyearbyen has a
    // supermarket at 78.2 N), so the box is the realm, not the mainland. A point
    // outside it means a projection bug upstream.
    const all = index.near({ lon: 11, lat: 65 }, 3_000_000);
    for (const point of all) {
      expect(point.point.lat).toBeGreaterThan(57.5);
      expect(point.point.lat).toBeLessThan(81.5);
      expect(point.point.lon).toBeGreaterThan(3);
      expect(point.point.lon).toBeLessThan(32);
      // No placeholder names, no broken UTF-8 (U+FFFD), nothing blank.
      expect(point.name.trim().length).toBeGreaterThan(0);
      expect(point.name).not.toContain('\uFFFD');
    }

    // The viewport query the map layer uses: a plausible, capped subset.
    const oslo = index.within({ west: 10.68, south: 59.88, east: 10.82, north: 59.95 });
    expect(oslo.length).toBeGreaterThan(50);
    expect(oslo.length).toBeLessThan(500);
    expect(index.within({ west: 10.68, south: 59.88, east: 10.82, north: 59.95 }, 10)).toHaveLength(10);

    // The cap is a stride, not a stop in the scan: the records are stored in
    // latitude order, so truncating kept only the southern edge of a wide view
    // (a country-sized view drew a band of badges on the south coast and left
    // the rest of the map bare). A capped wide box must still span the box.
    const country = index.within({ west: 4, south: 57.9, east: 12.5, north: 62.5 }, 60);
    expect(country).toHaveLength(60);
    const latitudes = country.map((point) => point.point.lat);
    expect(Math.max(...latitudes) - Math.min(...latitudes)).toBeGreaterThan(3);
  });

  it('never hands out a point outside the mainland area, though the national extract contains them', () => {
    // The Geofabrik Norway extract includes Svalbard (13 points, 74.5–78.9°N).
    // The app has no elevation, trails or weather there, so a Svalbard glyph on
    // the map is a promise nothing downstream can keep.
    const index = parseShopIndex(committedBuffer());
    expect(index.count).toBe(8_571); // the artefact is still the national file

    const world = index.within({ west: -180, south: -90, east: 180, north: 90 }, 100_000);
    expect(world.length).toBeGreaterThan(8_000);
    expect(world.some((candidate) => candidate.point.lat > 72.5)).toBe(false);
    expect(world.some((candidate) => candidate.point.lon < 3 || candidate.point.lon > 27)).toBe(false);

    // Queries aimed straight at Svalbard come back empty rather than plausible.
    expect(index.near({ lon: 15.639, lat: 78.218 }, 50_000)).toEqual([]);
    expect(
      index.alongRoute(
        [
          { lon: 15.5, lat: 78.1 },
          { lon: 15.7, lat: 78.3 },
        ],
        5_000,
      ),
    ).toEqual([]);
  });
});
