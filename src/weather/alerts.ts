/**
 * MET alerts (`MetAlerts`) — deliberately **not** implemented.
 *
 * This module returns `[]` and makes no network call. Why:
 *
 * 1. Read the primary terms before asserting a requirement (`docs/DECISIONS.md`
 *    D12). This environment has no web access, so the MetAlerts endpoint
 *    path, its CAP-derived JSON shape and its CORS behaviour are **unverified**.
 *    Writing a parser against a guessed shape would produce either silent
 *    `undefined`s or a plausible-looking warning list that was never checked
 *    against the service. That is exactly the failure mode the project is
 *    trying to stop.
 * 2. Alerts must never block or delay a plan. `planTripWeather` does not call
 *    this function at all; a caller that wants alerts awaits it separately and
 *    shows nothing if it resolves to `[]`.
 *
 * To implement it later, the minimum evidence needed is: one recorded response
 * from the real endpoint (headers included), the endpoint's CORS response for a
 * browser-shaped request, and the severity vocabulary actually used. Add the
 * fixture first, then the parser.
 */

import type { WeatherWarning } from '../contracts';

/**
 * Best-effort hazard warnings for a place and time. Currently returns `[]`.
 *
 * The signature is stable so the UI can already render "no warnings available"
 * without knowing why.
 */
export async function fetchWarnings(_options: {
  readonly lat: number;
  readonly lon: number;
  readonly timeoutMs?: number;
}): Promise<readonly WeatherWarning[]> {
  return [];
}
