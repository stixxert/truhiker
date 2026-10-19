# TruHiker

**Plan a long walk in Norway — elevation, resupply, calories and weather — without a spreadsheet, and without the app ever inventing a number.**

A browser-only planning tool for multi-day hiking. Load a GPX or draw a route,
edit it, see where you can resupply and what you must carry between those points,
how much you will burn and eat, and what weather the walk will actually face.

![TruHiker planning the Memurubu–Glitterheim route in Jotunheimen](docs/screenshots/01-route.jpg)

---

## What it does

- **Loads or draws a route.** GPX, KML and GeoJSON import; draw on the map with
  snapping to the mapped trail network; move, insert, split, reverse, trim, merge
  and undo, all the way back.
- **Reads the terrain properly.** Elevation comes from Kartverket's national 1 m
  LiDAR model (bare earth), sampled live, not from a 30 m global DEM. Ascent,
  descent, grade and walking time follow from it.
- **Answers the resupply question.** Shops, fuel, post points and huts along your
  corridor, with the distance along the route, the detour, and **the gap to the
  next usable point** — so you know what you carry and for how long.
- **Answers the eating question.** A component energy model (Minetti for grade,
  Mifflin–St Jeor or Cunningham for BMR) gives a **range**, the intake ceiling,
  the food mass per leg, and the projected body-mass change.
- **Shows weather with an explicit horizon.** MET Norway's forecast, day by day
  along the route — and nothing at all beyond its ~10-day reach.

| Resupply | Energy | Weather |
|---|---|---|
| ![Resupply panel](docs/screenshots/02-resupply.jpg) | ![Energy panel](docs/screenshots/03-energy.jpg) | ![Weather panel](docs/screenshots/04-weather.jpg) |

## What makes it different

Most hiking planners are confident. This one is careful, in ways you can check:

- **A day outside the forecast horizon shows no numbers.** No monthly averages
  dressed as a forecast, no interpolation. A badge says *"utenfor
  varselhorisonten"* and the row stays empty.
- **An unknown hut is not a food source.** The staffed/self-service/no-service
  classification is not machine-readable, so huts never close a food gap unless
  you explicitly say so.
- **Unknown is `null`, never `0`.** A partial ascent is reported as unknown, not
  as a smaller number that looks complete. If elevation is unavailable, the
  derived numbers are **disabled**, not zeroed.
- **Rerouting snaps, it never invents.** The app follows mapped trails within a
  radius; where no trail is near, the line is drawn dashed and labelled off-trail.
  It will not bridge two trails that do not connect.
- **Every fact carries its provenance** — source, licence, and when it was fetched.

## Quickstart

Requires Node 22 or newer.

```bash
npm install
npm run dev          # http://localhost:5173

npm test             # hermetic suite, no network
npm run verify       # the gate: types, tests, build, bundle, licence, decisions
npm run build        # static build into dist/
npm run preview      # serve the production build
```

Optional, and explicitly opt-in because they hit the network:

```bash
npm run test:live                        # real Kartverket and MET requests
npm run profile -- path/to/route.gpx     # elevation profile as JSON, from the CLI
```

`npm run verify` is the definition of done: typecheck, ≤250 hermetic test cases,
build, bundle budget, licence audit, decisions check, and the hosting contract.

## How it works

Everything is client-side. There is no accounts system, no database and no
server-side storage of routes.

```
browser ──▶ Kartverket WMTS/WFS ── basemap, trails, huts
        ──▶ hoydedata.no        ── elevation (1 m DTM)
        ──▶ Mapterhorn          ── 3D terrain
        ──▶ api.met.no          ── weather
        ──▶ /data/shops.osm.bin ── 8,571 resupply points (bundled, ODbL)
```

- **Elevation** is sampled as float32 GeoTIFF windows and turned into a profile
  with a median filter and a hysteresis ascent counter (so DEM noise cannot invent
  climb).
- **Trails** come from Kartverket's Turrutebasen over WFS, queried per bounding
  box and snapped client-side.
- **Routes** are immutable documents edited by commands, with undo/redo, persisted
  to IndexedDB (`bodies` + `summaries`, one transaction).
- **Deployment** is static-only Cloudflare Workers: no Worker script, no KV, no
  R2. The whole bundle is 19 files, ~0.57 MB brotli.

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Data and licences

| Source | Used for | Licence |
|---|---|---|
| **Kartverket** (WMTS, WFS, DTM) | basemap, trails, huts, elevation | CC BY 4.0 |
| **Mapterhorn** | 3D terrain | derived from Kartverket; see attribution |
| **MET Norway** | weather | NLOD / CC BY 4.0 |
| **OpenStreetMap** | resupply points (bundled extract) | ODbL 1.0 |
| **Turrutebasen** | the bundled demo route (`jot21`) | CC BY 4.0 |

UT.no, Wikiloc, AllTrails and Outdooractive are **not** used: their terms either
forbid extraction or restrict content to personal use. Kartverket's Turrutebasen,
which UT.no itself reads from, is open data and is what this project uses.
Full inventory and obligations: [`docs/LICENSES.md`](docs/LICENSES.md).

## Privacy

No account, no analytics, no third-party scripts, no cookies. Routes are stored in
your browser's IndexedDB and never leave the device. The only network requests go
to the six documented origins above.

## Deploy

```bash
npm run build
npx wrangler deploy      # Cloudflare Workers Static Assets
```

`wrangler.jsonc` declares static assets only. There is no server-side code to
deploy, no secret to configure and no storage to provision.

## Scope

**In:** route import and editing, elevation and time, resupply gaps, energy and
food mass, weather inside the forecast horizon, local storage and GPX export.

**Deliberately out:** offline/PWA use, a routing engine, weather beyond the
forecast horizon, accounts, sharing routes to a server, and coverage outside
mainland Norway.

Each ambiguous behaviour has a documented default in
[`docs/DECISIONS.md`](docs/DECISIONS.md) — including what the app refuses to claim.

## Status

Working end to end: import, edit, save, reload, resupply, energy, weather, export.
Verified by 246 hermetic tests, five acceptance journeys, and rendered checks at
1440 px and 390 px. Not yet built: trail routing between arbitrary points, and an
offline mode for use on the trail.

## Engineering record

The design reasoning, the data-source research, the corrected mistakes and the
measured numbers live in [`docs/notes/`](docs/notes/). Start with
[`docs/notes/08-corrections.md`](docs/notes/08-corrections.md) if you want to know
why the architecture looks the way it does.
