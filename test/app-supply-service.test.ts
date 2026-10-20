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
import { SupplyService } from '../src/app/supply-service';
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
});
