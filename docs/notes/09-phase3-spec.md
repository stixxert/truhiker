# Phase 3 — weather, GPX editing, trip storage

*The spec. Contracts live in `src/contracts/index.ts`; behaviour and acceptance
criteria live here. Read `docs/08-corrections.md` first — the rules there apply.*

---

## 0. The acceptance scenario

> **A user plans a multi-day Norwegian trip, checks the weather it will actually
> face, edits the route where it is wrong, and keeps the trip.**

1. Load a GPX (or the demo), or draw a new route on the map.
2. Edit it: insert/move/delete points, split, reverse, trim, rename, merge;
   undo and redo every step.
3. See shops/huts/fuel along it with distances between them.
4. Enter body/pack/pace; get kcal as a **range**, the intake ceiling, per-leg
   food kg and cost.
5. Open the weather timeline: a forecast for days inside MET's horizon, and an
   explicit "outside the forecast horizon" for every day beyond it.
6. Save the trip to localStorage; reload the page and find it intact; download it
   as GPX and re-import it without loss.

---

## 1. Weather — the honesty rules (non-negotiable)

MET Locationforecast 2.0 `compact` covers **~10 days** at a point (measured 2026-10-19: 85 hourly entries, first 13:00Z, last +10.0 days). A 100-day walk
therefore has weather for at most the first week. Anything else must be labelled,
never filled in.

| Situation | What the UI shows |
| --- | --- |
| Day within horizon | temperature, precipitation, wind, symbol, **issued at** |
| Day beyond horizon | **"utenfor varselhorisonten"** — no numbers, no placeholder values |
| Response headers | honour `expires` (measured: **+30 min**) but never poll; refetch only on explicit refresh |
| Fetch failed / off-grid | "ikke tilgjengelig", with the reason |
| No `startDate` set | the timeline explains that it needs a start date |

**Forbidden:** monthly averages presented as a forecast; extrapolation; a blank
that renders as `0°C`; a single number pretending to be a range.

### Client rules (MET terms, corrected)
- Called **directly from the browser**. Identification is automatic via `Origin`.
  No proxy, no Worker.
- **Truncate coordinates to 4 decimals** before the request. 5+ returns 403.
- Do **not** set `If-Modified-Since` from the browser: it is not a CORS-safelisted
  header, it would trigger a preflight, and MET explicitly does not support
  preflights. Rely on HTTP caching honouring the response's `Expires`.
- Never poll an idle page. No timers.
- **One request per unique rounded point**, not per day: a trip that stays in one
  valley for three days reuses one forecast.
- Cap concurrent requests at 2 and total points at ~40; beyond that, sample more
  sparsely and say so.
- Alerts (`MetAlerts`) are best-effort and clearly marked as such.

### Time model
Samples are taken at **local midday** (`Europe/Oslo`) of each trip day, at the
point reached by cumulative distance `dayIndex × dailyKm`. Days are derived from
distance and pace; if the profile has no pace, the timeline says why it is empty.

---

## 2. GPX editing — what "reroute" means here

We have snapping, not a routing engine. Be precise, and never invent a path.

| Action | Behaviour |
| --- | --- |
| Draw | Click adds a point. If a trail is within `R` (default 75 m), the point snaps to it and the leg records `provenance: snapped`. |
| Insert / move / delete | Operates on the leg's point array. Moving a point re-snaps it if snapping is enabled. |
| Split | Splits a leg at a vertex into two legs; both keep provenance. |
| Reverse | Reverses one leg; elevation samples are retained. |
| Trim | Keeps `points[from..to]`; the discarded span is recoverable by undo. |
| Rename | Leg name only; provenance untouched, `edited: true` recorded. |
| Merge | Concatenates two legs; provenance arrays are unioned. |
| **Reroute** | Re-snap the selected span to the trail network: each vertex moves to the nearest trail within `R`; runs of vertices on the same trail are replaced by that trail's polyline. Where no trail is within `R`, the original vertex stays and the span is marked **off-trail**. If two parts of the span are on different trails that do not connect, **do not bridge them** — mark the gap. |

**Invariants**
- Edits are immutable: `apply` returns a new trip and never mutates the input.
- Every edit is undoable, including merges and splits.
- A leg always has ≥2 points, or it does not exist.
- Point elevation is preserved across edits; new points get `eleSource:'none'`
  until sampled.
- No edit may silently change another leg.

---

## 3. Storage

- **localStorage** is the store: index key `npl:trips:v1`, trip body
  `npl:trip:<id>`. Keys are namespaced; nothing else is written.
- Reads migrate older `schemaVersion`s and never throw on unknown fields.
- `QuotaExceededError` becomes a visible `StoreError('quota-exceeded')` with the
  bytes used and a suggestion to download instead — never a silent failure.
- **Size guard:** a trip over ~1.5 MB is refused with a clear message, because
  localStorage is ~5 MB per origin and a 3,000 km trace is 5–10 MB of JSON.
  Simplification for storage is allowed *only* if elevation and provenance
  survive and the stored trip is visibly marked "simplified for storage".
- **Download/import round-trip must be lossless** for metres-level geometry:
  GPX with `<ele>` where known, `<metadata>` carrying provenance, licence and the
  elevation source. Re-importing the downloaded file must produce an equal trip.

---

## 4. Authoritative — the rules that make that word mean something

1. Every number is traceable to a source with a timestamp; every panel has a way
   to see it.
2. `null` means unknown. It never renders as `0`, `—` next to a unit, or a blank
   that looks like zero.
3. Degradation is visible: DEM down ⇒ profile and derived numbers disabled;
   weather out of horizon ⇒ stated, not estimated.
4. Exports carry provenance, licence and the elevation source in `<metadata>`.
5. Elevation is Kartverket DTM (bare earth) whenever sampled; an uploaded GPX's
   own elevations are kept and labelled `gpx`.
6. Nothing is called "official". No route, no season, no opening time.

---

## 5. Acceptance tests (these define "done")

- Weather: a day inside the horizon yields `status:'forecast'` with a temperature;
  a day at +30 days yields `beyond-horizon` **with no numeric fields**.
- Weather: two days in the same rounded location produce **one** upstream request.
- Weather: coordinates sent have ≤4 decimals (asserted on the request URL).
- Editing: apply/undo/redo returns to a deep-equal trip after any sequence.
- Editing: reversing twice is identity; splitting then merging preserves points.
- Editing: a reroute over a span with no trail within `R` marks it off-trail and
  leaves the geometry unchanged.
- Storage: save → reload → deep-equal; quota error surfaces as `StoreError`.
- Round-trip: export GPX → import → distance within 1 m and elevation array equal.
- UI: the acceptance scenario above is walkable end to end at 1440 px and 390 px.

---

## 6. Ownership (this wave)

| Agent | Owns | Must not touch |
| --- | --- | --- |
| weather | `src/weather/**`, `test/weather/**` | everything else |
| route-editing | `src/route/**`, `test/route/**` | everything else |
| store | `src/store/**`, `test/store/**` | everything else |
| ui | `src/app/**`, `src/ui/**`, `src/map/**`, `src/lib/**`, `index.html`, `src/styles.css` | `src/contracts`, `src/core`, `src/snap`, `src/plan`, the three above |

The orchestrator owns `src/contracts`, `public/_headers`, `scripts/`, `docs/`.

---

## 7. Module surface (fixed — this is how the four pieces meet)

Every agent implements exactly these names. The UI imports only these.

```ts
// src/weather/index.ts
export interface WeatherDeps {
  fetch: typeof fetch;
  cache: WeatherCache;          // get/set by key, TTL by `expiresAt`
  now: () => Date;
  maxPoints?: number;           // default 40
  concurrency?: number;         // default 2
}
export function planTripWeather(trip: Trip, deps?: Partial<WeatherDeps>): Promise<WeatherPlan>;
export function forecastHorizonDays(): number;   // 10; prefer deriving from the response's last entry

// src/route/index.ts
export function createEditor(trip: Trip): RouteEditor;
export interface RerouteOptions {
  radiusM?: number;             // default 75
  snapIndex: SnapIndex;         // from src/snap
}
/** Re-snaps points[from..to]; never bridges unconnected trails. */
export function rerouteSpan(trip: Trip, legId: string, from: number, to: number, opts: RerouteOptions): Trip;
export function emptyLeg(name?: string): Leg;
export function tripFromPoints(points: readonly RoutePoint[], name: string, profile: UserProfile): Trip;

// src/store/index.ts
export function createTripStore(storage?: Storage): TripStore;
export function emptyTrip(name: string, profile: UserProfile): Trip;
export function defaultProfile(): UserProfile;
```

Rules for the UI agent: import these paths even before they exist; if a module is
missing at build time, keep the import behind the documented signature and show a
visible "not available" state — do not stub inside `src/weather|route|store`.
