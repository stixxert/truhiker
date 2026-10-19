# `src/weather` — MET Locationforecast 2.0, honestly

One network client ([`met.ts`](./met.ts)), one cache contract
([`cache.ts`](./cache.ts)), one planner ([`index.ts`](./index.ts)), and a
deliberately empty alerts module ([`alerts.ts`](./alerts.ts)). Pure TypeScript,
no UI, no timers, no dependencies.

```ts
import { planTripWeather, memoryWeatherCache } from './weather';

const plan = await planTripWeather(trip, { cache: memoryWeatherCache() });
for (const day of plan.days) {
  if (day.sample.status === 'forecast') show(day.sample.tempC, day.headline);
  else if (day.sample.status === 'beyond-horizon') show('utenfor varselhorisonten');
  else show('ikke tilgjengelig', day.sample.reason);
}
```

## What is requested

```
https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=61.6363&lon=8.3124
```

- Called **directly from the browser**, with **no request headers at all** — no
  `User-Agent` (browsers cannot set it), no `If-Modified-Since` (not a
  CORS-safelisted header; it would trigger a preflight MET does not support).
  The browser sets `Origin`, which is what MET asks for.
- Coordinates are **truncated to four decimals** before the URL is built, both
  to follow the recorded rule and to make dedupe/cache hits as likely as
  possible. The "5+ decimals returns 403" claim in `docs/09-phase3-spec.md` is
  **unverified from this environment**; truncation is harmless either way.
- **One request per unique rounded point**, keyed `met:<lat4>:<lon4>`. A trip
  that stays in one valley for three days makes one request, not three.
- At most **2** requests in flight (configurable) and at most **40** sampled
  days (configurable). Beyond the cap the plan is sampled every *N* days and
  says so — see `sampledEveryNDays`.

## The horizon model

MET's compact forecast covers roughly nine to ten days at a point. A 100-day
walk therefore has weather for at most the first ten days, and every day after
that must be labelled, never filled in.

The authority is **the response**, not a constant:

1. Request the forecast for the day's rounded point (once, shared by all days
   in that cell).
2. Take the **last `timeseries` entry** of that response.
3. If the day's target instant is later than that entry plus a small tolerance
   (**3 hours**), the day is `beyond-horizon`.

A `beyond-horizon` sample is exactly `{ when, point, status }`. There is no
`tempC`, no `precipMm`, no `windMs`, no `symbol`, no `issuedAt` — not even as
`undefined` keys. A test asserts `Object.keys(sample)` equals
`['point', 'status', 'when']`. Nothing is interpolated and nothing is
extrapolated.

`forecastHorizonDays()` returns **10**, the length measured on 2026-10-19. It is
a *fallback for UI copy* ("MET forecasts about ten days ahead"), and it never
decides a day's status: an 8-day-out target against a 5-day response is
`beyond-horizon`, and a test pins that.

Why 10 and not 9: a browser-shaped request
(`Origin`, no `User-Agent`) to the Galdhøpiggen point returned HTTP 200,
`access-control-allow-origin: *`, and 85 entries from `2026-10-19T13:00:00Z` to
`2026-10-29T12:00:00Z` — **10.0 days**. `docs/09-phase3-spec.md` said ~9; the
measurement wins. Those measurement numbers were supplied for this
implementation and are not re-run by the test suite; the live test re-checks the
shape and the temperature band only.

## The time model

- Trip days = `ceil(totalDistance / (dailyKm × 1000))`. Distance comes from the
  trip's **geometry** (haversine over the legs' points), never from
  `leg.distanceM`, so a stale stored distance cannot move a sample.
- Day `i` is sampled at the point reached by `i × dailyKm`, clamped to the route
  end.
- Each day is sampled at **local midday, Europe/Oslo**: 12:00 local, i.e.
  11:00 UTC (CET) or 10:00 UTC (CEST). `Intl` with `timeZone: 'Europe/Oslo'`
  does the conversion; if `Intl` is unavailable the EU summer-time rule is
  applied instead. Calendar days are added in UTC, so DST can never shift a date
  by one.
- An empty plan is returned — never an exception — when `dailyKm <= 0`, when
  the geometry has no measurable distance, or when there is no usable
  `startDate`. The reason is in `notes`.

## MET's terms we are honouring

Quoted from MET's terms of service as reproduced in
[`docs/08-corrections.md`](../../docs/08-corrections.md) (the terms page itself
is not reachable from this environment, so the quotes are second-hand and the
first-hand evidence we have is the measured response above):

> "Low-volume websites and mobile apps **may use simple cross-origin Javascript
> requests** and direct image links, provided the site identifies itself as
> described above. If you start generating a lot of traffic against the API, you
> must set up a caching proxy gateway."

> "In cases where this is not possible (e.g. … simple cross-origin requests in
> Javascript), the website must instead identify itself using an `Origin`
> (Javascript) or `Referer` (for image links) header."

Encoded as:

| Term | Where |
| --- | --- |
| Direct browser call, no proxy/Worker | `met.ts` — the only endpoint; there is no proxy code |
| Identify via `Origin` (browser-set) | no headers are set; nothing overrides `Origin` |
| No preflight-inducing headers | no `If-Modified-Since`, no custom headers |
| Respect `Expires` | `cacheExpiry()` reads `expires`; `planTripWeather()` refetches past it |
| Dedupe and cache before scaling up | one request per rounded point, injected `WeatherCache` |
| No polling | no timers anywhere in this module; a plan is computed only when the caller asks |

The measured `expires` is **+30 minutes**. The cache is therefore *short-lived by
MET's decision*, not ours: a stale entry is refetched on the next explicit plan,
and nothing refreshes in the background.

## Precipitation: `0` is a fact, `undefined` is ignorance

`next_1_hours.details.precipitation_amount` is extracted verbatim, falling back
to `next_6_hours` (the entry then records `precipPeriod: '6h'`, and the headline
labels the accumulation `/6 h` rather than pretending it is an hourly rate).

- A measured `0.0` stays `0` — the MET response really does send it, and a dry
  day is information.
- An absent block stays `undefined`; it never becomes `0`.
- A missing `air_temperature` makes the day `unavailable` with a reason; it is
  never `0 °C`.

## Cache

```ts
interface WeatherCache {
  get(key: string): Promise<{ body: unknown; expiresAt: string } | null>;
  set(key: string, value: { body: unknown; expiresAt: string }): Promise<void>;
}
```

`memoryWeatherCache()` is the default (per call, so pass one in for a session).
The engine, not the cache, enforces `expiresAt`, so any backend behaves the
same. A corrupt cached body is treated as a miss and refetched. A cache whose
`get`/`set` throws degrades to "fetched again" and adds a note — it never fails
a plan.

## Failure behaviour

Everything is per point; one failure never aborts the plan:

| Failure | Result for those days |
| --- | --- |
| non-2xx response | `unavailable`, reason `HTTP <status> from MET Locationforecast` |
| network error / rejected `fetch` | `unavailable`, reason from the thrown error |
| body that is not a forecast | `unavailable`, reason from the parser |
| target before MET's series | `unavailable`, "precedes MET's series…" |
| nearest entry more than 7 h away | `unavailable`, "no MET entry within 7 h…" |
| no `fetch` in the environment | all sampled days `unavailable`, plan note |

There are **no retries and no backoff**. Hammering MET to turn an honest
"unavailable" into a late number is the wrong trade; the user re-runs the plan.

## Plan shape extension

`docs/09-phase3-spec.md` §7 fixes `WeatherPlan`. `src/contracts` is owned by the
orchestrator, so the additions are made in `src/weather/index.ts` as
`WeatherPlanDetail extends WeatherPlan`:

| field | meaning |
| --- | --- |
| `notes: string[]` | why the plan is empty/partial, e.g. `profile.dailyKm is 0…`, `N of M sampled days fall past the last entry of MET's series…` |
| `sampledEveryNDays: number` | 1 = every day sampled; >1 = the `maxPoints` cap forced sparse sampling |
| `daysTotal: number` | trip length in days before sampling |

`WeatherDay.sample` remains exactly the contract's `WeatherSample`; `WeatherDay`
also carries `headline` (e.g. `6.3 °C · wind 4.1 m/s · 0.4 mm`) when the status is
`forecast`.

## Deliberately not implemented

- **`MetAlerts` (warnings).** `fetchWarnings()` returns `[]` and makes no
  request. The endpoint path, JSON shape, severity vocabulary and CORS behaviour
  are unverified here, and a guessed parser would produce either silent
  `undefined`s or a plausible-looking list that was never checked. Alerts never
  block a plan: `planTripWeather` does not call it and always returns
  `warnings: []`. See [`alerts.ts`](./alerts.ts) for what evidence to record
  first.
- **Interpolation and extrapolation.** Beyond the series: `beyond-horizon`, no
  numbers. Outside the sampled instants: nothing.
- **Monthly averages, "typical weather", climate normals.** Forbidden by the
  spec; they are not forecasts.
- **Polling / auto-refresh.** No timers. The plan is recomputed on explicit
  user action.
- **Cancellation.** There is no `AbortSignal` in the fixed surface; a plan in
  flight runs to completion. Requests are capped (2 concurrent, ≤40 points), so
  the worst case is bounded.
- **Retry/backoff.** See above.
- **Persistent caching.** `memoryWeatherCache()` is in-memory; a localStorage or
  IndexedDB `WeatherCache` is the app's job (and must be given to
  `planTripWeather`).
- **Hourly detail, sea/avalanche/flood products, symbol translation.** One
  sample per day; symbol codes are passed through untranslated (i18n belongs to
  the UI).

## Tests

```sh
npm test                              # 51 offline weather tests + 1 live (skipped)
NETWORK_TESTS=1 npx vitest run test/weather   # includes the live MET anchor
```

- `test/weather/met.test.ts` — URL truncation and shape, parser (including a
  measured `0.0` preserved as `0` and `next_6_hours` fallback), the response-
  derived horizon, midday Oslo across DST, date arithmetic.
- `test/weather/plan.test.ts` — `forecast` inside the horizon, `beyond-horizon`
  with no numeric keys at all, 30-day-out and 8-day-out/5-day-response cases,
  dedupe (3 days → 1 request), captured URL assertions, cache reuse and expiry,
  one failing point among several, empty plans, precipitation `0` vs absent,
  `≤ 2` requests in flight, and sparse sampling under `maxPoints`.
- `test/weather/live.test.ts` — Galdhøpiggen, today, HTTP 200, `expires`
  present, temperature in −60…40 °C, series 7–12 days. Requires
  `NETWORK_TESTS=1`.
