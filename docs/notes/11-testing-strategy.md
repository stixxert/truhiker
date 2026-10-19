# Testing strategy — slim, hermetic, and complete

*The suite is a maintenance cost and a CI cost. Fewer tests, not fewer
behaviours. Numbers below come from an audit of all 39 test files.*

---

## 0. Current state (measured)

| | Value |
| --- | ---: |
| Test files | 39 |
| Tests | ~583 |
| Default-run wall clock | ~6 s |
| Network tests in `npm test` | **0** (isolated by filename) |

~583 tests for ~11 k lines is not a coverage problem; it is a duplication and
maintenance problem. The target is **~220**, without losing a behaviour.

## 1. Tiers

| Tier | File pattern | Runs in `npm test` | Rules |
| --- | --- | --- | --- |
| **Unit / contract** | `test/**/*.test.ts` | ✅ | hermetic, no network, no timers |
| **Acceptance** | `test/acceptance/*.test.ts` | ✅ | one per user journey, real modules, fakes only at the edges |
| **Live** | `test/**/*.live.test.ts` | ❌ (opt-in) | `npm run test:live`; never required by CI |

`npm test` runs `vitest run --exclude "**/*.live.test.ts"`. The default suite must
pass on a plane, in CI, and on a day when Kartverket or MET is down.

## 2. Rules

1. **One test per behaviour, grouped assertions inside.** A single `test` that
   loops over inputs with a descriptive message per row. Note: `it.each` rows are
   counted as separate test cases by vitest, so `it.each` does **not** reduce the
   budget — a loop inside one `test` does.
2. **No private internals.** If a refactor that keeps behaviour breaks a test, the
   test was wrong. (Exception: strings the spec mandates, e.g.
   `"utenfor varselhorisonten"`.)
3. **No wall-clock budgets** in tests (`Date.now() - start < 2000` is a flake,
   not a test).
4. **Every public export** in `src/contracts` and the `docs/09` §7 surfaces gets
   at least one contract test.
5. **A bug fix adds exactly one regression test**, in the file that owns the
   behaviour.
6. **Each module owns its behaviour.** Hysteresis is tested in `profile.test.ts`,
   not re-derived in `metrics.test.ts`; formatting is tested in `format.test.ts`,
   not re-asserted through the weather view.
7. **Fixtures must be used or deleted.** An unused fixture is a lie about coverage.

## 3. Budget (enforced by `npm run verify`)

- **Tests ≤ 250 cases** — exceeding it fails the build. `it.each` rows count as
  separate cases, so the fix is to group assertions into one test or delete
  duplication, not to rename the table.
- **Default-run wall clock ≤ 12 s.**
- **No live test may run in the default tier.**

A count ceiling is crude, but it is the only mechanical defence against the drift
that produced 583.

## 4. Target map (from the audit)

| Module (file) | Now | Keep | How |
| --- | ---: | ---: | --- |
| `store` core | 33 | 10 | merge quota variants into one grouped test (4→1); drop index-JSON literal and `memory.length`; move 4 version cases to `migrate` |
| `store` GPX | 26 | 8 | tables: `<ele>` presence (3→1), escaping (4→2), error taxonomy (3→1); merge round-trips (5→2); drop tag-order & precision asserts; use `parseGpxMetadata` instead of string-matching XML |
| `store` GeoJSON | 12 | 5 | tables: 3D/2D (2→1), rejections (4→1) |
| `store` migrate | 10 | 3 | drop `MIGRATIONS === {}`; table corrupt + validateTrip (6→1) |
| `route` editor | 20 | 7 | keep the 12-snapshot undo/redo test; drop freeze duplicates |
| `route` metrics | 15 | 6 | drop re-derived hysteresis (owned by `profile`); merge recompute cases |
| `route` reroute | 13 | 7 | merge the two "no bridging" tests; loosen vertex-count asserts |
| `weather` plan | 26 | 10 | tables: empty plans (5→1), concurrency (2→1), cache (4→2); **add 3 gap tests** (no-`Expires`, throwing cache, horizon-probe skip) |
| `weather` met | 25 | 9 | table truncation (3→1); one horizon-constant assertion |
| `weather` live | 1 | 1 | keep (gated) |
| `core` DEM | 14 | 5 | table error policy (4→1); assert `searchParams`, not order |
| `core` DEM live | 3 | 1 | collapse to one anchor journey (gated) |
| `core` TIFF | 8 | 4 | stride instead of 250 000 assertions; table synthetic rasters |
| `core` geo | 25 | 8 | keep the PROJ table; one round-trip; one resample table |
| `core` GPX | 7 | 4 | table throws (3→1) |
| `core` profile | 17 | 5 | merge sawtooth/triangle/spike pairs (8→2) |
| `lib` chart | 20 | 5 | drop padding-constant asserts |
| `lib` format | 17 | 7 | tables by output rule; keep the `'—'` honesty tests |
| `lib` gpx-meta | 7 | 3 | table both parsers; fix cwd-relative path |
| `lib` route | 14 | 5 | three tables |
| `lib` share | 9 | 4 | two tables |
| `lib` sync | 14 | 4 | two tables + marker round-trip |
| `plan` energy | 32 | 7 | one TDEE/ceiling narrative; table helpers; one `toEqual` for constants |
| `plan` nutrition | 14 | 6 | table zero/linear/negative |
| `plan` resupply | 34 | 10 | one opening-hours table, one `isFoodSource`, one warnings, one gap; drop message regexes |
| `snap` index | 16 | 7 | hysteresis table (4→1), null table (3→1) |
| `snap` cache | 11 | 5 | two tables |
| `snap` prefetch | 22 | 6 | `maxRequests` table (4→1); drop the `Date.now()` budget |
| `snap` wfs | 22 | 8 | trim fixture-attribute test |
| `i18n` | 12 | 5 | keep parity invariants; drop copy assertions |
| `pace` | 5 | 3 | one table |
| `hosting` | 6 | 3 | merge the two CSP tests |
| `app` editor-state | 12 | 6 | fold one-liner command builders |
| `app` trip-session | 13 | 6 | table rename cases; drop fake-mutation assert |
| `app` snap-service | 7 | 4 | `MemoryWeatherCache` table (4→1) |
| `ui` weather-view | 12 | 5 | two tables; loosen formatted values |
| `ui` library-labels | 12 | 5 | merge `flattenTrip` (4→2) |
| `ui` save-status | 8 | 3 | two tables |
| `ui` settings-view | 9 | 4 | accepted/rejected tables |
| **acceptance (new)** | 0 | **5** | §5 — all five now exist |
| **Total** | **579** | **~214** | |

## 5. The five acceptance tests

None need the network. Each closes a seam currently covered only by fakes on both
sides.

1. **`acceptance/edit-save-reload`** — import demo → insert/move/split/merge/trim/
   reverse/rename → save → **new store over the same Storage** → deep-equal,
   including `eleSource`, provenance and `updatedAt`; a fresh editor has
   `canUndo === false` (history must not persist).
2. **`acceptance/gpx-roundtrip`** — import (currently unused
   `test/fixtures/gjendesheim-besseggen.gpx`) → sample elevations → edit → `toGpx`
   → `fromFile` → distance within 1 m, `ele[]` element-wise equal, **`ascentM`/
   `descentM` within 0.5 m**, provenance preserved.
3. **`acceptance/weather-horizon`** — engine → view in one journey: day 0 has
   numbers; day +30 has `status:'beyond-horizon'` with `Object.keys(sample)` exactly
   `['point','status','when']` and three `null` labels plus the
   `"utenfor varselhorisonten"` badge. Assert the wire URL used 4 decimals.
4. **`acceptance/reroute-real-trails`** — parse `test/snap/fixtures/turrute.gml`
   (the only real trail network, currently never used by the rerouter) → snap a
   leg drawn 30 m off it → every point within 1 m of the polyline; a span across
   two non-connecting features adds no bridging geometry.
5. **`acceptance/elevation-anchor`** — feed `test/fixtures/galdhopiggen-128.tif`
   through `HoydedataDem` → `buildProfile` **offline** and assert **2469 ± 5 m**.
   Today that anchor lives only in the live file, so CI does not guard it.

## 6. Defects the audit found (fix these regardless of test count)

1. `src/app/engine-types.ts` had `DOCUMENTED_HORIZON_DAYS = 9` while
   `src/weather/met.ts` has `FORECAST_HORIZON_DAYS = 10` — two sources of truth,
   and a UI test passed `9` as a literal, hiding it.
2. `EditCommand` was missing `'merge-legs'`, which `src/route/commands.ts`
   implements and `docs/09` §2 requires. **Fixed**: added to the contract.
3. `SupportModel` was declared twice. **Fixed**: `plan/resupply.ts` now re-exports
   the contract type.
4. `vitest.config.ts` claimed network tests were on by default with
   `SKIP_NETWORK` — a flag nothing reads. **Fixed.**
5. `test/dem.live.test.ts`'s docstring said it ran by default and that
   `NETWORK_TESTS=1` meant *offline*. **Fixed.**
6. `hosting.test.ts` / `gpx-meta.test.ts` read files by cwd-relative path — fragile
   in CI. Use `new URL(..., import.meta.url)`.
