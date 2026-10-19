# Phase 2 — the map shell

*What was built, what it costs, how it was verified, and what is still missing.*

Phase 2 turns the Phase 1 elevation engine into an application: a GPX route on a
live Kartverket topo map, a 3D terrain view, and an elevation profile whose
cursor is synchronised with the camera in both directions. No backend, no
accounts, no bundled datasets, no third-party fonts, no analytics.

---

## 1. What is delivered

| Area | Implementation |
| --- | --- |
| Shell | Static Vite + TypeScript SPA (`index.html`, `src/main.ts`, `src/app/app.ts`) |
| Basemap | Live Kartverket WMTS `topo` and `topograatone`, plus a Geonorge WMS fallback |
| 3D | Mapterhorn raster-DEM (terrarium, 512 px, explicit `maxzoom: 13`), hillshade, sky/atmosphere, pitch capped at 60° |
| Route | GPX drag-and-drop, file picker, bundled Turrutebasen demo, URL-hash sharing |
| Profile | Canvas chart at ~1 px per aggregated column, min/max envelope + area, hover/keyboard/camera cursor, map marker, tooltip |
| Stats | Distance, ascent, descent, Naismith walking time with editable pace, elevation range, elevation-source badge |
| i18n | Typed NO/EN dictionary (NO default), `?lang=en`, localStorage, `Intl` numbers |
| Degradation | DEM outage, WMTS outage → WMS fallback, terrain outage, off-Norway routes, unreadable GPX — all visible |
| A11y | Profile is a keyboard-operable `role="slider"`, `aria-live` stats, focus rings, reduced motion, native dialogs |
| Responsive | 390 px (two-row header, compact stats, collapsible profile) and 1440 px |

### File map

```
index.html                     static shell, all ids the app binds to
src/main.ts                    entry: MapLibre worker URL, fatal fallback, start
src/app/app.ts                 state, route loading, DEM orchestration, rendering
src/i18n/{no,en,index}.ts      typed dictionaries + t()/Intl wrapper
src/map/map-controller.ts      style, basemap health, terrain, route/cursor layers
src/ui/profile-chart.ts        canvas profile (drawing + pointer/keyboard)
src/ui/stats.ts                stats bar with disabled states
src/ui/banners.ts              visible degradation banners
src/ui/pace-store.ts           persisted Naismith pace
src/lib/{chart,sync,format,route,share,gpx-meta,elevation-client}.ts
src/workers/dem.worker.ts      DEM sampling off the main thread
src/styles.css                 graphite/teal UI
public/demo/memurubu-glitterheim-jot21.gpx
scripts/{visual-check,bundle-size}.mjs
```

## 2. The demo route

`public/demo/memurubu-glitterheim-jot21.gpx` is real Turrutebasen geometry:
**Memurubu–Glitterheim, route `jot21`**, 9.0 km in 1,164 points, maintained by
**DNT | DNT Oslo og omegn**, marked on the ground. The GPX carries its
provenance in `<metadata>` (©Kartverket, CC BY 4.0) and has no `<ele>` — the
profile is sampled live from Kartverket DTM.

The header badge is a native `<details>` disclosure: the tooltip and the popover
show route name, route number, maintainer, marking, source and a note that the
elevation is sampled live. It is keyboard- and touch-operable and closes on
outside click or Escape.

The old synthetic `gjendesheim-besseggen.gpx` remains only as a unit-test/CLI
fixture under `test/fixtures/`.

## 3. Bundle

Measured with `npm run size` (gzip level 9, brotli quality 11, every emitted JS
file):

| File | raw KB | gzip KB | brotli KB |
| --- | ---: | ---: | ---: |
| `maplibre-*.js` | 1023.3 | 274.1 | 225.2 |
| `maplibre-gl-worker-*.mjs` | 506.6 | 143.7 | 118.7 |
| `index-*.js` (app + xmldom) | 164.7 | 54.0 | 47.1 |
| `dem.worker-*.js` | 12.4 | 5.2 | 4.7 |
| `dem-*.js` (main-thread fallback) | 10.6 | 4.4 | 3.9 |
| **JS total** | **1717.6** | **481.4** | **399.6** |

Budget: **< 500 KiB gzip JS → PASS (481.4 KiB)**. CSS is a further 14.4 KiB
gzip / 12.0 KiB brotli.

`npm run size` exits non-zero if the JS total exceeds the budget, so this cannot
regress silently.

Notes:

- MapLibre 6 ships its worker as a separate file. Vite cannot rewrite
  MapLibre's dynamic `new URL('./' + name, import.meta.url)`, so `main.ts`
  imports `maplibre-gl/dist/maplibre-gl-worker.mjs?url` and calls
  `setWorkerUrl(...)`. Without that the production build silently loses its
  worker — worth knowing before "optimising" it away.
- `assetsDir` is empty: assets sit next to `index.html`. This is a flat static
  build; there is no asset subdirectory to get out of sync with a deploy.
- The main-thread DEM fallback is a dynamic import, so it is only downloaded if
  `new Worker()` throws.

## 4. Tests

`npm test` (Vitest). Phase 1's 74 tests are untouched and green. Phase 2 adds
**95** tests:

| File | Covers |
| --- | --- |
| `test/format.test.ts` (17) | distance/elevation/duration/grade formatting in both locales, Naismith maths and pace clamping |
| `test/chart.test.ts` (20) | elevation domain/axis/ticks, interpolation, grade window, per-column aggregation |
| `test/sync.test.ts` (13) | Web-Mercator projection, nearest-route-point (coarse + refine), point-at-distance round trips |
| `test/route.test.ts` (12) | resampling and sample cap, display decimation, bounds, Norway support check |
| `test/share.test.ts` (9) | base64url, hash round trips, length cap, malformed input |
| `test/i18n.test.ts` (12) | key parity, placeholder parity, language resolution, formatting switch |
| `test/pace.test.ts` (5) | pace persistence, clamping, corrupt/blocked storage |
| `test/gpx-meta.test.ts` (7) | Turrutebasen metadata parsing against the real demo file |

At the time of writing the whole repository runs **324 tests (321 pass, 3 live
network tests skipped with `SKIP_NETWORK=1`)**. The count exceeds Phase 2
because other phases are being developed in the same tree.

## 5. How it was verified visually

```
npm run dev                 # http://localhost:5173
node scripts/visual-check.mjs http://localhost:5173/ /tmp/npl-shots
```

`scripts/visual-check.mjs` drives headless Chromium (Playwright, honours
`HTTPS_PROXY`), captures 1440×900 and 390×844 screenshots, and prints the
observable state plus console/network errors. It reports the attribution line
and demo-badge tooltip so the "verify on the ground" notice and provenance
cannot disappear unnoticed.

Screenshots reviewed during development: default desktop, default 390 px,
English, profile hover with tooltip + map marker, keyboard cursor, 3D terrain,
about dialog, pace dialog, demo-route popover (desktop + mobile), DEM outage,
WMTS→WMS fallback, no-demo empty state, off-Norway route, uploaded GPX with the
hash set, profile collapsed.

Additional checks (Playwright, not committed):

- Hovering the chart moves the map marker and updates the readout; leaving clears it.
- `Home`/`End`/arrows/PageUp/PageDown move the cursor; `aria-valuenow` and
  `aria-valuetext` update.
- `?lang=en` wins on load, and toggling language rewrites `?lang=` so a reload
  keeps the choice.
- Uploading a GPX updates the header tag to "Fra fil", writes a `#r=…` hash, and
  a reload restores it as "Delt rute"; an invalid file leaves the old route and
  shows a banner.
- Pace 4 km/h + 400 m/h changes the estimate (9.0 km / +125 m → 2 t 6 min) and
  persists.
- 3D sets `terrain` + pitch 55 and stays enabled; with Mapterhorn blocked the
  button is disabled with a reason.

Production build was served with `vite preview` and re-checked: no console
errors, worker loads, tiles and DEM stream.

## 6. Degradation matrix

| Failure | UI behaviour |
| --- | --- |
| DEM (`hoydedata.no`) fails | Profile panel shows "Høydedata utilgjengelig" + retry; ascent, descent, walking time and elevation range render **—** (never 0); source badge turns red; banner carries the technical detail in its tooltip; distance remains because it comes from the GPX, not the DEM |
| DEM succeeds | The profile header shows the fetch time ("Høydedata hentet 13:34") — the last-verified stamp for live numbers |
| Route outside Norway | Route and distance still load; DEM sampling is skipped with an explicit "utenfor Norge" message; all DEM-derived numbers disabled |
| WMTS cache fails (≥3 errors, no tile ever loaded) | Automatic switch to Geonorge WMS, warning banner with "retry cache"; basemap buttons follow the fallback |
| WMS also fails | Error banner; map keeps its background colour and the route stays visible — never a blank white box |
| Mapterhorn TileJSON fails / DEM tiles fail | Terrain source is not added; 3D button disabled with a reason in `aria-label`, tooltip and an on-map hint; banner offers retry |
| Demo GPX missing | Empty state with file picker + "try demo" banner; map still usable |
| Unreadable GPX | Error banner with parser message; previous route is kept |
| Worker construction fails | Same elevation pipeline runs on the main thread from a dynamic chunk |

Every `catch` names what it handles; there is no empty `catch {}`.

## 7. Accessibility notes

- The chart is a `role="slider"` with `aria-valuemin/max/now/valuetext`; arrows
  step 1/500 of the route, Shift multiplies by 10, PageUp/Down 10 %, Home/End.
- Stats are an `aria-live="polite"` region; disabled values carry an
  `aria-label` ("Utilgjengelig – krever høydedata").
- Focus-visible rings on every control; the chart has an inset ring.
- Banners use `role="alert"` for errors and `role="status"` for warnings.
- Dialogs are native `<dialog>` elements; the demo provenance uses native
  `<details>` (keyboard and touch operable, no hover dependency).
- `prefers-reduced-motion` disables camera easing, the chart reveal animation
  and CSS transitions.
- The "planning aid — verify on the ground" notice is visible at every width;
  at 390 px it wraps onto a second line under the attribution instead of hiding.
- All UI strings go through the typed dictionary; the MapLibre scale bar is the
  only library-rendered text and is unit-only ("m"/"km").

## 8. Compromises and deviations

1. **`assetsDir: ''`** — the sandbox this was built in could not create a nested
   `dist/assets` directory; a flat output is also simpler for static hosting.
2. **No React** — vanilla TS + ~900 lines of UI code. A framework would have
   spent 40–60 KiB gzip of the budget on render scheduling this app does not
   need.
3. **MapLibre worker asset** — see §3; it is ~144 KiB gzip and is the main
   reason the total is 481 KiB rather than ~340 KiB.
4. **`@xmldom/xmldom` stays in the browser bundle** — `src/core/gpx.ts` uses it
   for namespace repair, and swapping in the browser's `DOMParser` would turn
   undeclared-prefix GPX files from "repaired" into "rejected". Correctness over
   ~20 KiB.
5. **Camera → profile sync ignores bearing** — the camera centre is the same
   ground point at any bearing, and pitch does not change it. Nearest route
   point is computed in Web-Mercator at the current zoom.
6. **"Terrain vs flat" profile toggle was not built** — the 3D/flat *map*
   toggle is the meaningful version of that idea; a flat profile would show the
   same numbers with less information.
7. **URL hash sharing caps at 12,000 characters** and refuses to write a
   truncated route; the user is told to upload the file instead. The demo and
   very large routes use the plain URL.
8. **No animation of the route being drawn** — the reveal is on the chart only.
9. **Profile axis ticks are padded, not snapped** — labels stay round while the
   chart uses its full height; a snapped axis wasted up to a whole 200 m step.
10. **The route is decimated to 25,000 points for the map** (resampling is at
    25 m, capped at 60,000 samples). Long routes stay responsive; the profile
    still uses every sample.

## 9. Known gaps

- Snapping to Turrutebasen, route drawing, resupply, calories: later phases.
- No offline/PWA support (the shell loads, but tiles and DEM are live).
- Elevation is limited to mainland Norway (the DEM service's coverage). Routes
  outside it load but cannot be profiled.
- Terrain is off by default; the toggle is the entry point to 3D.
- No route history/undo, no multi-track comparison, no GPX export of sampled
  elevation.
- Cold-start experience depends on three external services; all failures are
  visible, but there is no local cache yet.
- The visual check is a developer script, not a CI job; there is no screenshot
  diffing.
- `test/fixtures/gjendesheim-besseggen.gpx` is still synthetic by design (CLI
  demo), and is no longer used by the app.

## 10. Attribution

- Basemap: **©Kartverket** (topo / topograatone, WMS topo), CC BY 4.0.
- Elevation: **Kartverket DTM** (bare earth) via `hoydedata.no`, CC BY 4.0.
- 3D terrain: **Mapterhorn**, derived from Kartverket elevation data.
- Demo route: **Kartverket Turrutebasen** (jot21), CC BY 4.0.
- Map engine: MapLibre GL JS (BSD-3).

These appear in the map attribution line (with the planning notice), in the
"Om data" dialog, and in the demo-route popover.
