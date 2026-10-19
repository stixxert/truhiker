/**
 * The engine surface the UI is allowed to call.
 *
 * These are the exact names from `docs/09-phase3-spec.md` §7, restated as a
 * structural interface so that:
 *
 *  - UI modules and their tests can depend on the *shape* without importing the
 *    engine implementations (which are written by other agents, in parallel);
 *  - `src/app/engines.ts` is the single place that imports the real modules at
 *    their documented paths;
 *  - a missing engine degrades visibly instead of breaking the import graph.
 *
 * If an engine's real signature gains an optional parameter, add it here (the
 * wrapper accepts it) — do not widen a parameter the spec marks as required.
 */

import type { Leg, RouteEditor, RoutePoint, Trip, TripStore, UserProfile, WeatherPlan } from '../contracts';
import type { SnapIndex } from '../snap';

/**
 * Weather cache contract, as specified in docs/09 §7. Declared structurally
 * here so this file does not import `src/weather`.
 */
export interface WeatherCacheLike {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown, expiresAt?: string): void | Promise<void>;
}

export interface WeatherDepsLike {
  fetch: typeof fetch;
  cache: WeatherCacheLike;
  now: () => Date;
  maxPoints?: number;
  concurrency?: number;
}

export interface RerouteOptionsLike {
  radiusM?: number;
  snapIndex: SnapIndex;
}

export interface EngineSurface {
  // weather
  planTripWeather(trip: Trip, deps?: Partial<WeatherDepsLike>): Promise<WeatherPlan>;
  forecastHorizonDays(): number;

  // route editing
  createEditor(trip: Trip): RouteEditor;
  emptyLeg(name?: string): Leg;
  tripFromPoints(points: readonly RoutePoint[], name: string, profile: UserProfile): Trip;
  rerouteSpan(
    trip: Trip,
    legId: string,
    from: number,
    to: number,
    options: RerouteOptionsLike,
  ): Trip;

  // storage
  createTripStore(storage?: Storage): TripStore;
  emptyTrip(name: string, profile: UserProfile): Trip;
  defaultProfile(): UserProfile;
}

/**
 * Fallback forecast horizon, used only until the weather engine reports its own
 * (`engines.forecastHorizonDays()`).
 *
 * MUST equal `FORECAST_HORIZON_DAYS` in `src/weather/met.ts` (10, measured
 * 2026-10-19: 85 hourly entries, last +10.0 days). It previously said 9, and a
 * UI test passing a literal 9 hid the drift. `test/acceptance/weather-horizon`
 * now asserts the two agree.
 */
export const DOCUMENTED_HORIZON_DAYS = 10;
