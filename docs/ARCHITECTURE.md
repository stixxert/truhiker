# Architecture

A static web application. No backend, no accounts, no server-side storage.

## Request flow

```
┌──────────────────────── browser ────────────────────────┐
│  route (GPX / drawn)                                    │
│    ├─ src/core    elevation sampling, profile, ascent    │
│    ├─ src/snap    Turrutebasen WFS → snapping            │
│    ├─ src/route   edit commands, undo/redo, routing A*  │
│    ├─ src/resupply shops (bundled) + huts (live) → plan  │
│    ├─ src/plan    energy, food mass, resupply gaps       │
│    ├─ src/weather MET forecast + horizon discipline      │
│    ├─ src/store   IndexedDB persistence                  │
│    └─ src/ui/app/map  panels, dialogs, MapLibre          │
└──────────────────────────────────────────────────────────┘
```

Live sources, all CORS-enabled and called directly by the browser:

| Source | Purpose | Notes |
| --- | --- | --- |
| `cache.kartverket.no` WMTS | base map (`topo`, `topograatone`) | fallback to Geonorge WMS |
| `wfs.geonorge.no` Turrutebasen | trail geometry, hut points | bbox is **lon,lat** for `EPSG:4326` |
| `hoydedata.no` ImageServer | elevation | float32 GeoTIFF, 128 px tiled |
| `tiles.mapterhorn.com` | 3D terrain | terrarium raster-dem |
| `api.met.no` | weather | 4-decimal coordinates, `Origin` identifies us |

One bundled data set: an OpenStreetMap extract of resupply points (ODbL), because every
live alternative measured 40 s+ or was prohibited. It is **generated at build time**
by `tools/ensure-data.mjs` — from the Geofabrik PBF when one is available, otherwise
from a verified local or published copy — and it is never committed (D24);
`tools/data-manifest.json` is the committed pin (SHA-256, size, counts, source
date) and `tools/build-shops.mjs` regenerates the artefact and its provenance.
Nothing under `data/` is in git; `licences/ODbL-1.0.txt` is, because it is a notice. The file is 175 KB;
rebuilding it from source needs the ~1.5 GB PBF, which is why the pin exists: a
fresh clone verifies the artefact it gets instead of trusting it. The bytes the
deployment serves are the public ODbL copy, so they are the offer the licence
requires.

## Modules

| Module | Responsibility |
| --- | --- |
| `core` | geodesy, TIFF decoding, DEM sampling, profile (median filter + hysteresis ascent) |
| `snap` | Turrutebasen client, GML parsing, spatial index, nearest-segment snapping, IndexedDB cache |
| `route` | immutable trip document, commands, undo/redo, re-snapping, Turrutebasen routing (graph + A*, bounded WFS loader) |
| `store` | IndexedDB (`bodies` + `summaries`), migration from localStorage, GPX/GeoJSON IO |
| `resupply` | binary shop loader, corridor correlation, live huts, leg/gap planning |
| `plan` | energy model (Minetti, Mifflin–St Jeor/Cunningham), nutrition, resupply arithmetic |
| `weather` | MET client, cache, forecast-horizon discipline |
| `ui` / `app` / `map` | panels, dialogs, MapLibre integration |
| `i18n` | typed NO/EN dictionaries, `Intl` formatting |
| `workers` | the DEM sampling worker |

## Invariants

These are enforced in code and pinned by tests, not just described:

1. `null` never renders as `0`.
2. A day beyond the forecast horizon carries **no numeric keys at all**.
3. An unknown hut or an unmanned fuel station is not a food source.
4. A partial ascent is `null`.
5. Snapping never bridges two trails that do not connect.
6. A stale write cannot mark a different, newer trip as saved.
7. Every shipped file has a licence entry; every live source has an attribution.
8. A route is returned only when the fetched trail graph connects the endpoints;
   nothing is bridged and no straight line is substituted.

## Storage

IndexedDB database `truhiker`:

- `bodies` — the full trip (structured clone), keyed by id;
- `summaries` — name, distance, updated time, byte size (so the library never
  deserialises a large trip to draw a row);
- saves and deletes are a single transaction across both stores;
- per-trip ceiling 50 MB; localStorage fallback is 1.5 MB and says so;
- migration from the old localStorage keys runs once, after commit.

A 3,000 km / 100,000-point trip (8.0 MB) is an acceptance test: save ~64 ms,
load ~26 ms in Chromium.

## Accessibility

`npm run a11y` drives the built app through `wrangler dev` (workerd, production
CSP) in Chromium and fails on any critical or serious axe-core violation
(WCAG 2.0/2.1/2.2 A and AA) in four states: desktop 1440×900, mobile 390×844,
and the mobile layout with the Forsyning and Vær panels open.

The keyboard path is asserted, not assumed: on mobile, Tab reaches the menu
toggle, Space opens it, Tab reaches Forsyning, Enter opens the panel and moves
focus to its first tab, Escape closes it and returns focus to the trigger. On
desktop, Tab reaches the elevation profile without a pointer (about thirty
presses from a fresh load), ArrowRight/ArrowLeft move the cursor — `aria-valuenow`
counts metres along the route — and the position is re-announced through
`aria-valuetext`. No pointer event is used anywhere in the journey.

The gate found a real defect on its first run: every resupply row carried an
`aria-label` whose wording did not match the visible row, failing WCAG 2.5.3
(label in name). The label was redundant — the row's own text is its name — so it
and its translation key were removed.

Limit: automated rules plus one scripted keyboard path are not a screen-reader
test, and Chromium is the only engine available here (see Known limits).

## Performance

Measured by `npm run perf` under throttled Slow 4G (200 kb/s, 150 ms RTT) through
a compressing server, which is what Cloudflare serves:

| Metric | Budget | Measured |
| --- | ---: | ---: |
| First contentful paint | < 1 500 ms | **592 ms** |
| Map interactive (canvas + a numeric stat) | < 8 000 ms | **5 195 ms** |
| JS + CSS transfer | < 500 KB | **408 KB** |

MapLibre is roughly 85 % of that transfer; it is the renderer and the 3D terrain.
The gate fails if any of the three regresses.

## Deployment

Cloudflare Workers **Static Assets** only: `wrangler.jsonc` has no `main`.
Static-asset requests are free and unlimited; there is no dynamic budget to
exhaust. Bundle: 19 files, ~0.59 MB brotli, against a 20,000-file ceiling.

`npm run verify` runs the gate: typecheck, hermetic tests (≤280 cases, ≤12 s),
build, bundle budget, a headless render and an end-to-end journey under workerd
with the production CSP, an axe and keyboard accessibility audit, a blocked-network
failure-path run, licence audit and hosting contract.

## Known limits

- Routing is Turrutebasen marked trails only, for a box up to 1.5° around the two
  points. Where the network does not connect them, it says so. OSM routing is not
  implemented; snapping still covers drawing and editing.
- Routing endpoints are placed with the pointer; the keyboard can pan and zoom the
  map but cannot place a route endpoint. Drawing has a preview and a double-click
  finish, but no freehand drag.
- The trail network is drawn from the same `SnapIndex` the snapper queries, and
  only while it is actionable (draw/edit with snapping on). Prefetch is skipped
  below z10 and on a data-saver connection; the index is pruned back to the view
  past 20 000 lines.
- OSM is not a routing source. Measured in two boxes, its `highway=path` layer is
  chains rather than a network: it lost to Turrutebasen on pair routability in
  both (31 % vs 67 % in Jotunheimen, 7 % vs 72 % in Reisadalen) and made the
  union worse as soon as it was deduplicated against Turrutebasen. See D25.
- No offline mode; the app is a planning tool, not a trail companion.
- Elevation is mainland Norway only.
- Hut food status is not machine-readable; the app will not guess it.
