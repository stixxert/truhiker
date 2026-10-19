# TruHiker

A route planner for long-distance walking in Norway. Load a GPX or draw one, edit
it, and see the elevation, the resupply gaps, the food you must carry and the
weather the walk will face.

<!-- One screenshot, full width. Side-by-side shots become unreadable at README size. -->
![TruHiker showing the Memurubu–Glitterheim route with the resupply panel open](docs/screenshots/02-resupply.jpg)

## What it does

- **Routes.** Import GPX or GeoJSON, or draw on the map. Move, insert, split,
  reverse, trim, merge and undo. Snapping follows mapped trails; where no trail is
  near, the line is dashed and marked off-trail.
- **Routing.** Pick two points and follow mapped Turrutebasen trails. Where no
  trail connects them, the app says so instead of drawing a line.
- **Elevation.** From Kartverket's national 1 m terrain model, sampled live:
  profile, ascent, descent, grade and walking time.
- **Resupply.** Shops, fuel, post points and huts along the corridor, with the
  distance along the route, the detour, and the gap to the next usable point.
- **Energy.** Calories as a range, the intake ceiling, the food mass per leg and
  the projected weight change. When the deficit cannot be eaten away, it says so.
- **Weather.** MET Norway's forecast day by day along the route — and nothing at
  all beyond its ten-day reach.

## How it works

```mermaid
flowchart LR
  route["GPX or drawn route"] --> core["Elevation<br/>Kartverket DTM"]
  route --> snap["Trails and huts<br/>Turrutebasen"]
  route --> supply["Resupply<br/>bundled OSM extract"]
  route --> weather["Weather<br/>MET Norway"]
  core --> ui["Map, profile<br/>and panels"]
  snap --> ui
  supply --> ui
  weather --> ui
  ui <--> store[("IndexedDB<br/>this browser")]
```

Everything runs in the browser. There is no account, no database and no server-side
storage of routes; a trip lives in IndexedDB and can be downloaded as GPX.

Five services are called directly by the browser — Kartverket's basemap and
elevation, Turrutebasen's trails and huts, Mapterhorn's terrain, and MET Norway's
weather. One data set is bundled: an OpenStreetMap extract of Norwegian resupply
points. Nothing else is copied or re-hosted.

## Run it

Node 22 or newer.

```bash
npm install
npm run dev            # http://localhost:5173
```

```bash
npm test               # hermetic, no network
npm run verify         # types, tests, build, budget, browser gates, licences
npm run build          # static build into dist/
npm run preview        # serve the build
```

One command reaches the network on purpose:

```bash
npm run test:live     # real Kartverket and MET requests
```

## Deploy

```bash
npm run build
npx wrangler deploy
```

## Limits

- Routing uses Turrutebasen marked trails only, for a box up to 1.5° around the
  two points. Where the network does not connect them, it says so; it never
  bridges a gap or draws a straight line. OSM routing is not available yet.
- Routing endpoints are placed with the pointer; there is no keyboard way to
  pick them yet.
- Planning only: there is no offline mode for use on the trail.
- Elevation covers mainland Norway.
- A hut's food status is not published as data, so a hut never counts as resupply
  unless you opt in.
- Weather outside the forecast horizon is shown as unknown, not estimated.
- All figures are estimates.

## Data and attribution

| Source | Used for | Licence |
| --- | --- | --- |
| **Kartverket** — topo, DTM, Turrutebasen | basemap, elevation, trails and huts | CC BY 4.0 · ©Kartverket |
| **MET Norway** | weather forecasts | NLOD / CC BY 4.0 |
| **Mapterhorn** | 3D terrain (derived from Kartverket) | derived; see `docs/LICENSES.md` |
| **OpenStreetMap contributors** | resupply points | ODbL 1.0 · © OpenStreetMap contributors |

Attribution is part of the interface: the map footer names Kartverket and
Mapterhorn, and **About data** (*Om data*) lists every source with its licence and
a link.

Two data sets ship with the app:

- **Demo route** — *Memurubu–Glitterheim* (`jot21`), real trail geometry from
  Kartverket Turrutebasen, CC BY 4.0, maintained by DNT Oslo og omegn.
- **Resupply points** — a derivative database of OpenStreetMap, served under
  ODbL 1.0.

## How it was built

With an AI coding agent working against a written specification.
