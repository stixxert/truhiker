# Architecture

A static web application. No backend, no accounts, no server-side storage.

## Request flow

```
┌──────────────────────── browser ────────────────────────┐
│  route (GPX / drawn)                                    │
│    ├─ src/core    elevation sampling, profile, ascent    │
│    ├─ src/snap    Turrutebasen WFS → snapping            │
│    ├─ src/route   immutable edit commands, undo/redo     │
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
live alternative measured 40 s+ or was prohibited. It is committed as a build
input and served by the app; `data/shops.osm.json` records its SHA-256 and
`tools/build-shops.mjs` regenerates it from the OSM extract.

## Modules

| Module | Responsibility |
| --- | --- |
| `core` | geodesy, TIFF decoding, DEM sampling, profile (median filter + hysteresis ascent) |
| `snap` | Turrutebasen client, GML parsing, spatial index, nearest-segment snapping, IndexedDB cache |
| `route` | immutable trip document, commands, undo/redo, re-snapping |
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
exhaust. Bundle: 19 files, ~0.57 MB brotli, against a 20,000-file ceiling.

`npm run verify` runs the gate: typecheck, hermetic tests (≤250 cases, ≤12 s),
build, bundle budget, licence audit, decisions check, hosting contract.

## Known limits

- Snapping, not routing: the app will not compute a path between two arbitrary
  points.
- No offline mode; the app is a planning tool, not a trail companion.
- Elevation is mainland Norway only.
- Hut food status is not machine-readable; the app will not guess it.
