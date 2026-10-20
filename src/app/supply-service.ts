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
 * The index is fetched the first time the map needs places — which is when it
 * first settles on a view, because the shops are drawn whether or not the panel
 * is open (D20). It is 175 KB, loaded once, then served from memory.
 */

import type { LonLat } from '../core/geo';
import {
  DEFAULT_HUT_RADIUS_M,
  fetchHutsAlong,
  loadShopIndex,
  type ResupplyCandidate,
  type ShopIndex,
} from '../resupply';

interface SupplyResult {
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

/** What the map needs for "show me the shops and huts around here". */
export interface ViewBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly zoom: number;
}

export interface PlacesResult {
  /** Points inside the box. `alongRouteM` is 0: there is no route in play. */
  readonly places: readonly ResupplyCandidate[];
  readonly hutsError: string | null;
}

/** Huts are live WFS: only ask once the view is small enough to be worth it. */
export const HUT_VIEW_MIN_ZOOM = 12;
/** A hut answer is reused for this long before the box is asked again. */
const VIEW_HUTS_TTL_MS = 5 * 60_000;

interface SupplyDeps {
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
  /** Hut answers per rounded view box, so a pan back and forth is free. */
  private readonly viewHuts = new Map<
    string,
    { at: number; huts: ResupplyCandidate[]; error: string | null }
  >();

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
   * Places inside the current view, route or no route.
   *
   * Shops come from the bundled index and are complete for Norway — the scan is
   * local and instant. Huts are a live WFS query, so they are only asked for at
   * `HUT_VIEW_MIN_ZOOM` and above, where the box is small; below that the map
   * shows shops only, and the panel still has the route's own hut query.
   */
  async placesIn(bounds: ViewBounds): Promise<PlacesResult> {
    const index = await this.shopIndex();
    // A country-sized view does not need every one of 8,571 points in the GeoJSON
    // source: clustering merges them anyway. The cap grows with the zoom so a
    // street-level view can show the whole block.
    const limit = bounds.zoom < 9 ? 600 : bounds.zoom < 11 ? 1_500 : 2_000;
    const places: ResupplyCandidate[] = index.within(bounds, limit);
    if (bounds.zoom < HUT_VIEW_MIN_ZOOM) return { places, hutsError: null };

    const cacheKey = `${bounds.west.toFixed(2)},${bounds.south.toFixed(2)},${bounds.east.toFixed(2)},${bounds.north.toFixed(2)}`;
    const cached = this.viewHuts.get(cacheKey);
    const nowMs = (this.deps.now ? this.deps.now() : new Date()).getTime();
    if (cached && nowMs - cached.at < VIEW_HUTS_TTL_MS) {
      return { places: [...places, ...cached.huts], hutsError: cached.error };
    }

    const loadHuts = this.deps.loadHuts ?? fetchHutsAlong;
    let huts: ResupplyCandidate[] = [];
    let hutsError: string | null = null;
    try {
      // Two opposite corners are a route as far as the tiler is concerned: it
      // pads and tiles the box, with the same request cap as a corridor query.
      huts = await loadHuts(
        [
          { lon: bounds.west, lat: bounds.south },
          { lon: bounds.east, lat: bounds.north },
        ],
        { radiusM: 1_000, fetchImpl: this.deps.fetchImpl },
      );
    } catch (error) {
      hutsError = error instanceof Error ? error.message : String(error);
    }
    this.viewHuts.set(cacheKey, { at: nowMs, huts, error: hutsError });
    return { places: [...places, ...huts], hutsError };
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
