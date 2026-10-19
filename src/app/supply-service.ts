/**
 * Where the resupply points come from, and what happens when a source is down.
 *
 * Two very different sources, deliberately kept apart:
 *
 *  - the **bundled shop index** (`data/shops.osm.bin`, ODbL) is loaded lazily on
 *    first open and cached for the session. A failure is fatal for the panel and
 *    is reported as such: an empty list would read as "no shops here", which is
 *    the one thing it must never say;
 *  - the **huts** come live from Turrutebasen (CC BY 4.0 ©Kartverket) and can
 *    fail independently. A failed hut query is a *partial* result with the
 *    reason attached, never a blank panel.
 *
 * The index is only fetched when the panel is first opened, so a user who never
 * asks for resupply never downloads the 175 KB file.
 */

import type { LonLat } from '../core/geo';
import {
  DEFAULT_HUT_RADIUS_M,
  fetchHutsAlong,
  loadShopIndex,
  type ResupplyCandidate,
  type ShopIndex,
} from '../resupply';

export interface SupplyResult {
  /** Shops, fuel, post and huts, sorted by distance along the route. */
  readonly candidates: readonly ResupplyCandidate[];
  /** ISO label of the bundled extract (the binary carries no timestamp). */
  readonly indexBuiltAt: string;
  /** Points in the bundled index, not on this route. */
  readonly indexCount: number;
  /** Why the live hut query failed, when it did. */
  readonly hutsError: string | null;
  /** ISO timestamp of this query. */
  readonly fetchedAt: string;
}

export interface SupplyDeps {
  readonly fetchImpl: typeof fetch;
  /** Injectable for tests and for a different data file. */
  readonly loadIndex?: (fetchImpl: typeof fetch) => Promise<ShopIndex>;
  readonly loadHuts?: (
    route: readonly LonLat[],
    opts: { radiusM: number; fetchImpl: typeof fetch },
  ) => Promise<ResupplyCandidate[]>;
  readonly now?: () => Date;
}

export class SupplyService {
  private readonly deps: SupplyDeps;
  private index: ShopIndex | null = null;
  private pending: Promise<ShopIndex> | null = null;

  constructor(deps: SupplyDeps) {
    this.deps = deps;
  }

  /** True once the bundled file has been parsed (so the UI can say "lazy"). */
  get indexLoaded(): boolean {
    return this.index !== null;
  }

  get indexCount(): number | null {
    return this.index?.count ?? null;
  }

  /**
   * The bundled index, fetched once.
   *
   * A rejected promise is not cached: the panel's retry button must be able to
   * try again after a network blip.
   */
  async shopIndex(): Promise<ShopIndex> {
    if (this.index) return this.index;
    if (this.pending) return this.pending;
    const load = this.deps.loadIndex ?? loadShopIndex;
    this.pending = load(this.deps.fetchImpl).then(
      (index) => {
        this.index = index;
        this.pending = null;
        return index;
      },
      (error: unknown) => {
        this.pending = null;
        throw error;
      },
    );
    return this.pending;
  }

  /**
   * Correlate the route with both sources.
   *
   * Throws only when the shop index is unusable. A hut failure is captured in
   * `hutsError` and the shops are still returned.
   */
  async corridor(
    route: readonly LonLat[],
    radiusM: number,
    hutRadiusM: number = Math.min(radiusM, DEFAULT_HUT_RADIUS_M),
  ): Promise<SupplyResult> {
    if (route.length < 2) throw new Error('a route needs at least two points');
    if (!(radiusM > 0)) throw new RangeError(`invalid corridor radius: ${radiusM}`);
    if (!(hutRadiusM > 0)) throw new RangeError(`invalid hut radius: ${hutRadiusM}`);
    const index = await this.shopIndex();
    const loadHuts = this.deps.loadHuts ?? fetchHutsAlong;

    let huts: ResupplyCandidate[] = [];
    let hutsError: string | null = null;
    try {
      huts = await loadHuts(route, { radiusM: hutRadiusM, fetchImpl: this.deps.fetchImpl });
    } catch (error) {
      hutsError = error instanceof Error ? error.message : String(error);
    }

    const candidates = [...index.alongRoute(route, radiusM), ...huts].sort(
      (a, b) => a.alongRouteM - b.alongRouteM,
    );
    const now = this.deps.now ? this.deps.now() : new Date();
    return {
      candidates,
      indexBuiltAt: index.builtAt,
      indexCount: index.count,
      hutsError,
      fetchedAt: now.toISOString(),
    };
  }
}
