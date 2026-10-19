/**
 * The one place that imports the three Phase 3 engine modules, at the paths and
 * names fixed in `docs/09-phase3-spec.md` §7.
 *
 * This module is loaded dynamically by `engine-loader.ts`, so a missing or
 * broken engine produces a visible "not available" state in the UI instead of
 * an unresolvable static import that takes the whole app (map, profile) down.
 *
 * The wrappers below restate the public types from `engine-types.ts`. That is
 * deliberate: the UI must compile against the documented contract even while an
 * engine is still being written, and a changing internal type must not ripple
 * into every UI file.
 */

import { createEditor, emptyLeg, rerouteSpan, tripFromPoints } from '../route/index';
import { createTripStorage, createTripStore, defaultProfile, emptyTrip } from '../store/index';
import { forecastHorizonDays, planTripWeather } from '../weather/index';
import type { EngineSurface, WeatherCacheLike, WeatherDepsLike } from './engine-types';

export const engines: EngineSurface = {
  planTripWeather(trip, deps) {
    const partial: Partial<WeatherDepsLike> | undefined = deps;
    // The engines may type their cache slightly differently; the documented
    // contract is `get`/`set` keyed by a string, which WeatherCacheLike states.
    return planTripWeather(trip, partial as never);
  },
  forecastHorizonDays() {
    return forecastHorizonDays();
  },
  createEditor,
  emptyLeg,
  tripFromPoints,
  rerouteSpan,
  createTripStore,
  createTripStorage,
  emptyTrip,
  defaultProfile,
};

/** Type export used by the loader (`typeof import(...)` would need the module). */
export type { EngineSurface, WeatherCacheLike };
