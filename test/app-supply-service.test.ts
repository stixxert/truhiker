/**
 * `SupplyService` — lazy index, partial hut failures.
 *
 * The two sources fail differently and the user must see which one did:
 *
 *  - the **bundled index** is fetched once, on first open, and a failure is a
 *    dead end for the panel (an empty list would read as "no shops here");
 *  - the **live huts** can fail on their own and the shops still arrive, with
 *    the reason attached.
 *
 * The loaders are injected so nothing here touches the network or the 175 KB
 * binary.
 */

import { describe, expect, it, vi } from 'vitest';

import type { LonLat } from '../src/core/geo';
import {
  SupplyService,
  mergePlacesForView,
  placesDrawBounds,
} from '../src/app/supply-service';
import type { ResupplyCandidate, ShopIndex } from '../src/resupply';

const ROUTE: LonLat[] = [
  { lon: 10.0, lat: 62.5 },
  { lon: 11.0, lat: 62.5 },
];

const fetchImpl = (() => Promise.reject(new Error('the test must not fetch'))) as unknown as typeof fetch;

function index(candidates: readonly ResupplyCandidate[]): ShopIndex {
  return {
    count: 8571,
    builtAt: '2026-10-19T13:41:49.167Z',
    alongRoute: () => [...candidates],
    near: () => [...candidates],
    within: () => [...candidates],
  };
}

function candidate(
  kind: ResupplyCandidate['kind'],
  name: string,
  alongRouteM: number,
): ResupplyCandidate {
  return {
    kind,
    name,
    point: { lon: 10.5, lat: 62.5 },
    alongRouteM,
    detourM: 30,
    evidence: kind === 'hut' ? 'curated' : 'osm',
  };
}

describe('SupplyService', () => {
  it('loads the index once, keeps the huts separate, and never hides a failure', async () => {
    const loadIndex = vi.fn(async () => index([candidate('supermarket', 'Joker', 400)]));
    const shopOnly = new SupplyService({
      fetchImpl,
      loadIndex,
      loadHuts: async () => [candidate('hut', 'Fondsbu', 200)],
      now: () => new Date('2026-10-20T09:00:00.000Z'),
    });

    const first = await shopOnly.corridor(ROUTE, 5_000);
    // Merged and sorted by distance along the route, with provenance attached.
    expect(first.candidates.map((entry) => entry.name)).toEqual(['Fondsbu', 'Joker']);
    expect(first.indexCount).toBe(8571);
    expect(first.hutsError).toBeNull();
    expect(first.fetchedAt).toBe('2026-10-20T09:00:00.000Z');

    await shopOnly.corridor(ROUTE, 5_000);
    expect(loadIndex).toHaveBeenCalledTimes(1);
    expect(shopOnly.indexLoaded).toBe(true);

    // A hut failure is partial: the shops still arrive, with the reason.
    const hutsDown = new SupplyService({
      fetchImpl,
      loadIndex,
      loadHuts: async () => {
        throw new Error('HTTP 504 from RuteInfoPunkt');
      },
      now: () => new Date('2026-10-20T09:00:00.000Z'),
    });
    const partial = await hutsDown.corridor(ROUTE, 5_000);
    expect(partial.candidates).toHaveLength(1);
    expect(partial.hutsError).toContain('HTTP 504');

    // An index failure is a dead end — and a retry may try again.
    let attempts = 0;
    const indexDown = new SupplyService({
      fetchImpl,
      loadIndex: async () => {
        attempts += 1;
        throw new Error('HTTP 503 from /data/shops.osm.bin');
      },
      loadHuts: async () => [],
    });
    await expect(indexDown.corridor(ROUTE, 5_000)).rejects.toThrow('HTTP 503');
    await expect(indexDown.corridor(ROUTE, 5_000)).rejects.toThrow('HTTP 503');
    expect(attempts).toBe(2);
    expect(indexDown.indexLoaded).toBe(false);
  });

  /**
   * The map's "around here" query.
   *
   * It asks for the **box**: handing the corners to the corridor client filtered
   * against the box's diagonal and silently dropped the huts in its corners. And
   * below the hut zoom there is no live call at all.
   */
  it('asks for view huts by box, only at close zoom, and keeps the shops when they fail', async () => {
    const loadHutsInBounds = vi.fn(async () => [candidate('hut', 'Fondsbu', 0)]);
    const service = new SupplyService({
      fetchImpl,
      loadIndex: async () => ({
        ...index([]),
        within: () => [candidate('supermarket', 'Joker', 0)],
      }),
      // A corridor query here would be the bug this test exists for.
      loadHuts: async () => {
        throw new Error('the view query must not use the corridor client');
      },
      loadHutsInBounds,
      now: () => new Date('2026-10-20T09:00:00.000Z'),
    });

    const view = { west: 8.2, south: 61.3, east: 8.4, north: 61.5, zoom: 13 };
    const near = await service.placesIn(view);
    expect(near.hutsError).toBeNull();
    expect(near.places.map((place) => place.name)).toEqual(['Joker', 'Fondsbu']);
    // The query covers the view plus the overscan margin, so a pan inside that
    // margin needs no new answer (and the glyphs do not move).
    const covered = placesDrawBounds(view);
    expect(covered.west).toBeLessThan(view.west);
    expect(covered.north).toBeGreaterThan(view.north);
    expect(covered.zoom).toBe(view.zoom);
    expect(loadHutsInBounds).toHaveBeenCalledWith(
      { minLon: covered.west, minLat: covered.south, maxLon: covered.east, maxLat: covered.north },
      expect.anything(),
    );

    // Far out, the live layer is not asked: the box is too big to be worth it.
    loadHutsInBounds.mockClear();
    const far = await service.placesIn({ ...view, zoom: 8 });
    expect(loadHutsInBounds).not.toHaveBeenCalled();
    expect(far.places.map((place) => place.name)).toEqual(['Joker']);

    // A hut failure is partial here too: the shops still reach the map, with the
    // reason attached — never a silently shorter list.
    const hutsDown = new SupplyService({
      fetchImpl,
      loadIndex: async () => ({
        ...index([]),
        within: () => [candidate('supermarket', 'Joker', 0)],
      }),
      loadHutsInBounds: async () => {
        throw new Error('HTTP 504 from RuteInfoPunkt');
      },
    });
    const partial = await hutsDown.placesIn({ ...view, zoom: 14 });
    expect(partial.places.map((place) => place.name)).toEqual(['Joker']);
    expect(partial.hutsError).toContain('HTTP 504');
  });

  /**
   * The layer is merged, not replaced.
   *
   * Replacing it re-placed every symbol on every camera settle: panning at a
   * zoomed-out level made the glyphs in front of the user disappear and come back
   * as "new" ones, over and over.
   */
  it('keeps what is already drawn, drops only what left the covered box, and lets the fresh reading win', () => {
    const box = { west: 8, south: 61, east: 9, north: 62, zoom: 12 };
    const at = (place: ResupplyCandidate, lon: number, lat: number): ResupplyCandidate => ({
      ...place,
      point: { lon, lat },
    });
    const drawnJoker = at({ ...candidate('supermarket', 'Joker', 0), detourM: 90 }, 8.5, 61.5);
    const drawnHut = at(candidate('hut', 'Fondsbu', 0), 8.6, 61.4);
    const goneKiwi = at(candidate('supermarket', 'Kiwi', 0), 10.5, 62.5); // outside the box
    const freshJoker = at({ ...candidate('supermarket', 'Joker', 0), detourM: 10 }, 8.5, 61.5);
    const freshFuel = at(candidate('fuel', 'Circle K', 0), 8.2, 61.2);

    const merged = mergePlacesForView([drawnJoker, drawnHut, goneKiwi], [freshJoker, freshFuel], box);
    // The fresh answer's own points first, then what only the drawn layer had.
    expect(merged.map((place) => place.name)).toEqual(['Joker', 'Circle K', 'Fondsbu']);
    // A place is one row, not two: the same key from both sides collapses.
    expect(new Set(merged.map((place) => `${place.kind}|${place.name}|${place.point.lon}`)).size).toBe(
      merged.length,
    );
    // The newer reading of a place is the one that is kept.
    expect(merged[0]?.detourM).toBe(10);
    // And a point that left the box is not quietly kept forever.
    expect(merged.some((place) => place.name === 'Kiwi')).toBe(false);
  });
});
