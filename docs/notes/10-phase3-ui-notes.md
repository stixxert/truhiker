# Phase 3 — UI notes (weather, editing, trip storage)

*What the user-facing half of Phase 3 contains, what is wired, what is still
waiting, and how it was verified. Read `docs/08-corrections.md` first: a phase is
done when the acceptance step passes, not when the tests do.*

---

## 1. What the acceptance scenario now does

Following `docs/09-phase3-spec.md` §0, in one session and with no account:

1. Load the demo (or a GPX) → the route, profile and stats are unchanged from
   Phase 2, and the header now shows **Lagre** with a status line (`ikke lagret`
   / `lagret 14:32` / the quota error). **Turer → Ny tur** starts an empty trip
   and switches to draw mode, so a route can be drawn from nothing.
2. **Turer** lists saved trips (name, distance, updated date) with *open,
   rename, duplicate, delete, export GPX, export GeoJSON* and an import area
   that accepts a file picker **and** drag-and-drop.
3. **Vær** shows one row per trip day: day number, date, distance, and either
   temperature / precipitation / wind / symbol / issued time, or the badge
   **“utenfor varselhorisonten”** with no numbers. The panel states where the
   data came from (`varsel hentet HH:MM`) and that MET covers about ten days.
   Without a start date or daily distance it says exactly which field to fill in
   and offers a button that opens the settings.
4. **Vis / Tegn / Rediger** over the map. Draw adds points (snapping to the
   Turrutebasen network within a configurable radius); edit selects vertices,
   drags them, inserts on a segment click, splits, reverses, trims, renames,
   deletes a leg, and reroutes a span. Off-trail stretches are drawn dashed and
   listed as labelled chips. Undo/redo has correct disabled states.
5. **Turinnstillinger** (gear) edits the `UserProfile` and says plainly that
   these are the user’s numbers, not assumptions about them.
6. Save with the button or `Ctrl/Cmd+S`; the autosave writes ~1 s after the last
   edit. Reload → the trips are still in the library. Export GPX → re-import →
   the trip returns with its name and provenance.
7. `Esc` closes every dialog (native `<dialog>` behaviour, focus restored by the
   platform).

The demo and shared links are **not** written to storage until the user edits or
presses Lagre. Without that rule every page load would create a new library
entry for the demo.

---

## 2. File map (this wave)

```
src/app/engine-types.ts     the documented engine surface, restated structurally
src/app/engines.ts          the only file that imports src/weather|route|store
src/app/engine-loader.ts    dynamic import → { engines } | { error }
src/app/trip-session.ts     editor + store + autosave + save status (no DOM)
src/app/editor-state.ts     UI selection/mode → EditCommand (no DOM)
src/app/snap-service.ts     SnapIndex + Prefetcher + explicit network status
src/map/edit-overlay.ts     draw/edit interaction on the MapLibre canvas
src/ui/weather-view.ts      the honesty rules, as data
src/ui/weather-panel.ts     timeline DOM (table semantics, aria-live status)
src/ui/weather-icon.ts      nine local SVG symbol families
src/ui/trip-library.ts      saved-trip dialog (inline rename/delete, import)
src/ui/trip-library-view.ts trip rows / empty / problem states
src/ui/trip-settings.ts     settings dialog
src/ui/settings-view.ts     field limits and validation
src/ui/editor-toolbar.ts    mode switch, undo/redo, snap, selection actions
src/ui/save-status.ts       “ikke lagret” / “lagret HH:MM” / quota text
src/ui/store-error.ts       StoreError codes → plain language
src/lib/weather-cache.ts    in-memory, keyed, TTL-aware cache for the engine
src/lib/weather-symbol.ts   MET symbol_code → nine families
src/lib/snap-label.ts       “Ukjent” route names → number / short id
src/lib/trip-route.ts       trip legs → one polyline + global↔leg indices
src/lib/ids.ts              trip ids with an insecure-context fallback
```

`index.html` gained the header actions, the editor bar, the weather panel and
two dialogs; `src/styles.css` gained one section plus responsive rules.

### How the engines are wired

`src/app/engines.ts` is the single place that imports
`../weather/index`, `../route/index` and `../store/index` — exactly the names in
`docs/09` §7. It is loaded through `engine-loader.ts` with a dynamic import, so a
missing or broken engine chunk becomes a **visible** state instead of an
unresolvable static import that would take down the map and the profile. When it
fails:

- a warning banner says trip library, weather and editing are unavailable, with
  the technical reason in the tooltip and a retry that reloads;
- the save status reads “Lagring er utilgjengelig …”;
- the trips/weather/settings/save buttons are disabled;
- the weather panel and the editor bar render their own specific message
  (`weather.engineMissing`, `editor.engineMissing`).

The surface is declared structurally in `engine-types.ts`, so the UI and its
tests compile against the documented contract rather than an implementation’s
internal types.

---

## 3. Decisions worth knowing

1. **The horizon number comes from the engine.** `forecastHorizonDays()` reports
   10 (the weather engine measured 10.0 days on 2026-10-19), so the panel says
   “omtrent 10 døgn”, not the 9 in the spec prose. The UI never hardcodes it;
   the fallback constant is used only when the engine cannot answer.
2. **Reroute is applied as a `replace-span` edit.** `rerouteSpan` returns a trip,
   not a command, so the panel extracts the re-snapped slice and applies it
   through `createEditor`. That keeps reroute on the undo stack like every other
   edit. If the geometry is unchanged (no trail within the radius) the UI does
   not fake an edit: it says so and lets the off-trail computation mark the span.
3. **Off-trail is sampled at segment midpoints.** A segment counts as off-trail
   when its midpoint is farther than the radius from any indexed trail. That is
   cheap enough to run after every edit and honest about what it measured; it
   can miss a short excursion that leaves and returns within one segment.
4. **Weather symbols are nine local families.** MET publishes ~40 symbol codes.
   Nine SVG families (clear, fair, partly cloudy, cloudy, fog, rain, sleet, snow,
   thunder) plus the family name in text and the raw code in a tooltip convey the
   sky without 40 translated strings and without fetching an icon set.
5. **Distance from the trip can differ slightly from the profile.** The stored
   leg keeps the uploaded geometry (so `<ele>` survives as `eleSource: 'gpx'`),
   while the profile pipeline resamples at 25 m for the DEM. The demo reads
   9.16 km in the library and 9.01 km in the stats — both are measured, neither
   is invented. If this proves confusing, the fix is to build the trip from the
   resampled points and lose the uploaded elevations; that trade was not taken.
6. **Weather cache is in memory only.** localStorage belongs to the trip store
   (`npl:trips:v1`, `npl:trip:<id>`); MET responses already carry `Expires`, so
   HTTP caching survives reloads and the page itself makes at most one request
   per rounded point.
7. **The weather panel refreshes only on open and after an edit while open.**
   There are no timers and no polling.
8. **Deleting the open trip clears the view.** Leaving the route on screen with
   no trip and no save status would misrepresent what is open.
9. **A new trip is genuinely empty** (`emptyTrip` has no legs). The first drawn
   point creates the placeholder leg through `emptyLeg()` and one
   `editor.reset` — the only whole-trip replacement in the drawing flow, with no
   history to lose. Every later point goes through `EditCommand`.
10. **The editor bar is compact in Vis mode** (one row) and expands in Tegn and
   Rediger. At 390 px it caps its height and scrolls; vertex handles are hidden
   in Tegn mode and thinned to ≥16 px apart in Rediger mode, so a 1,164-point
   GPX does not become a caterpillar of handles.

---

## 4. Degradation matrix (new surfaces)

| Failure | What the user sees |
| --- | --- |
| Engine chunk missing/broken | Warning banner + retry; trips/weather/settings/save disabled; each panel says why |
| No `startDate` | Weather panel: “Værvinduet trenger en startdato …” + button opening settings |
| No `dailyKm` | Same, naming kilometres per day |
| MET fetch fails | Panel-level “Værvarselet er ikke tilgjengelig: <reason>” with a retry; days that did resolve still render |
| A single day outside coverage | That row reads “ikke tilgjengelig” with the reason; no numbers |
| Day beyond the horizon | Badge “utenfor varselhorisonten”; every numeric field is `null` |
| `localStorage` blocked | Save status “Lagring er utilgjengelig i denne nettleseren”; editing still works |
| Quota exceeded | `StoreError('quota-exceeded')` → “Lagring mislyktes: nettleserlageringen er full. Last ned turen som GPX i stedet.” plus a banner |
| Corrupt index | Trip library says the library could not be read (never an unexplained empty list) |
| Malformed import | Banner with the translated `StoreError`; the map still shows the file through the Phase 2 GPX path |
| Turrutebasen WFS fails | Editor bar: “stinettet er ikke tilgjengelig”; snapping and reroute refuse, drawing still works unsnapped |
| Off-trail unknown | “avstikk ikke beregnet – stinettet er ikke lastet”, never “the whole route follows trails” |
| Demo route missing | Unchanged from Phase 2 (empty state + banner) |

---

## 5. Verification performed

### Tests

`npx vitest run test/app-*.test.ts test/ui-*.test.ts` — **74 tests** in seven
files:

| File | Covers |
| --- | --- |
| `test/app-trip-session.test.ts` (13) | dirty→autosave→saved with injected clock/scheduler, immediate save, `updatedAt`, undo/redo no-ops, quota error as `StoreError`, unavailable store, library sorting, broken index, rename (open and stored), duplicate, remove, import + malformed import, export without adopting |
| `test/app-editor-state.test.ts` (12) | mode switching, radius clamping, selection + span, command availability matrix, every `EditCommand` generator, placeholder-leg drawing, move, insertion index |
| `test/app-snap-service.test.ts` (7) | viewport load → snap, explicit failure state, degenerate bbox, cache TTL/eviction |
| `test/ui-weather-view.test.ts` (13) | forecast numbers, zero is a measurement, **no numeric fields beyond the horizon**, unavailable reason, horizon note, warning severity/link safety, missing start date/daily km, loading/error/engine-missing/no-trip, singular vs plural, date/time formatting |
| `test/ui-library-labels.test.ts` (12) | library rows/empty/problem, MET symbol families, `snapRouteLabel`, trip flattening and index mapping |
| `test/ui-save-status.test.ts` (8) | status texts, quota explanation, `StoreError` translation |
| `test/ui-settings-view.test.ts` (9) | round trip, comma decimals, optional body fat, optional start date, limits, per-field errors, invalid calendar dates |

The full suite at hand-off: **581 passed, 4 skipped** (the two live-network
tests are skipped without network). The Phase 2 map/profile behaviour is
unchanged: the demo still loads, the profile still samples the DEM, and the
“planning aid — verify on the ground” notice is visible at every width.

### Browser acceptance run

A Playwright script (temporary, not committed) walked the acceptance scenario at
1440×900 against the dev server, stubbing `api.met.no` with a 5-day compact
response. All checks passed:

```
PASS  demo load writes no trip to storage
PASS  "Ny tur" starts an empty trip in draw mode; three clicks → 2, 2, 3 points
PASS  the drawn trip gets a distance, a profile and is saved on Ctrl/Cmd+S
PASS  empty trip library explains itself
PASS  Ctrl/Cmd+S saves and stamps the time — lagret 14:17
PASS  weather without a start date says what to fill in
PASS  weather offers a button to open the settings
PASS  the weather action opens trip settings
PASS  weather table has rows — "varsel hentet 14:16 · 6 dager med varsel, 4 dager utenfor horisonten"
PASS  beyond-horizon days show no numbers
PASS  vertex handles are rendered in edit mode
PASS  a vertex drag enables undo
PASS  undo restores the previous trip
PASS  draw mode adds a point — 1164 -> 1165
PASS  shift-click selects a span — Testetappe: punkt 464–840
PASS  reroute is enabled for a span
PASS  reroute explains what it does and does not do
PASS  reroute either applies an undoable edit or explains why not
PASS  the leg name is shown for renaming
PASS  rename is applied and undoable
PASS  GPX export downloads a .gpx file — Memurubu-Glitterheim.gpx
PASS  exported GPX carries provenance metadata
PASS  importing the exported GPX creates a trip — 1 -> 2
PASS  import reports success
PASS  saved trips survive a reload — 2
PASS  the imported trip kept the exported name
PASS  opening a saved trip loads its route
PASS  the opened trip is marked as saved
PASS  delete asks for confirmation inline
PASS  confirming deletes one trip
PASS  English: weather/status/library/settings/editor strings are translated
PASS  no console errors
```

A bug found by this run and fixed: the “suppress the click that follows a drag”
flag stayed set if a drag ended outside the map, swallowing the next draw click.

### Screenshots

Captured with headless Chromium via the Phase 2 `scripts/visual-check.mjs`
(`webshot` is not available in this sandbox) plus a temporary harness for the
new states; the MET response was stubbed for the weather views.

```
/tmp/npl-shots-p3/desktop.png       1440×900 default (Phase 2 smoke test)
/tmp/npl-shots-p3/mobile.png        390×844 default
/tmp/npl-shots-p3/d-1-default.png   compact editor bar, save status "ikke lagret"
/tmp/npl-shots-p3/d-2-settings.png  trip settings dialog
/tmp/npl-shots-p3/d-3-weather.png   weather timeline: 4 forecast days + 6 beyond-horizon
/tmp/npl-shots-p3/d-4-trips.png     trip library with one saved demo trip
/tmp/npl-shots-p3/d-5-edit.png      edit mode: vertex handles, selection actions, reroute note
/tmp/npl-shots-p3/d-6-draw.png      draw mode
/tmp/npl-shots-p3/m-1-default.png   390 px: two-row header, editor bar, planning notice
/tmp/npl-shots-p3/m-2-settings.png  settings dialog at 390
/tmp/npl-shots-p3/m-3-weather.png   weather bottom sheet at 390
/tmp/npl-shots-p3/m-4-trips.png     trip library at 390
/tmp/npl-shots-p3/m-5-edit.png      edit mode at 390 (bar scrolls)
/tmp/npl-shots-p3/m-6-draw.png      draw mode at 390
/tmp/npl-shots-p3/d-7-new-trip.png  “Ny tur” → draw mode, empty trip saved
```

---

## 6. What is wired vs. waiting

**Wired and working end to end:** trip creation from GPX/demo, autosave and
manual save, the trip library (all six actions + import), settings persistence,
the weather timeline with the horizon rule, draw/edit/undo/redo, snapping to the
WFS network, off-trail marking, reroute-as-edit, renaming, split/trim/reverse/
delete leg, GPX and GeoJSON export, and import of an exported file.

**Waiting on future engine work, not on this UI:**

1. **Weather warnings.** `src/weather/alerts.ts` deliberately returns `[]` until
   a real MetAlerts response has been recorded. The panel’s warning list
   (severity chip, area, period, https-only link) is implemented and unit-tested
   with a fixture, but it will not appear in the browser until the engine fetches
   alerts.
2. **Real MET calls in production.** The browser run used a stubbed response.
   The request itself is the engine’s, and the CSP already allows
   `https://api.met.no`; a real deployment should still be watched for MET’s
   `Expires` behaviour under the CDN.
3. **Reroute provenance.** Because reroute is applied as `replace-span`, the
   leg’s provenance is whatever the editor records for that command. If the
   route engine starts attaching per-span provenance from `rerouteSpan`, the UI
   should consume that trip directly instead (and accept that history is reset).
4. **Quota error in a browser.** The path is unit-tested with an injected
   `StoreError`; filling a real origin to ~5 MB was not attempted here. The
   1.5 MB per-trip guard lives in the store.
5. **Drag-and-drop import** is wired (window drop → store import; dialog drop
   zone) but the automated run exercised the file picker; a manual pass at 390 px
   with a touch drag has not been done.

**Known at hand-off:** `npx tsc --noEmit` reports one error in
`test/weather/plan.test.ts` (a `HeadersInit` typing issue in the weather
engine’s own test file, written concurrently). Nothing under `src/app`,
`src/ui`, `src/map`, `src/lib` or `test/{ui,app}-*.test.ts` fails type-checking.

---

## 7. Remaining integration steps (exact)

1. When `src/weather/alerts.ts` fetches real warnings, call it from
   `refreshWeather()` (best-effort, after the plan resolves) and merge into
   `WeatherPlan.warnings`; the panel already renders them.
2. If `rerouteSpan` grows provenance output, replace the `replace-span`
   extraction in `EditorOverlay`/`App.rerouteSelection` with `session.rewrite`
   and surface “undo history was reset” in the editor hint.
3. Add a real-quota browser test (fill `localStorage` with a large string, then
   save) and assert the quota sentence and banner.
4. Decide the geometry source for stored trips (raw GPX vs. 25 m resample) so the
   library distance and the profile distance agree; document whichever wins.
5. Capture a real MET response (headers included) as a fixture and run the
   browser acceptance script against the live endpoint once, with the network
   available, to confirm `Origin`-identified CORS behaves as the terms say.
