# TruHiker

A browser-only route planner for multi-day walking in Norway. Load a GPX or draw a
route, and get the elevation, the resupply gaps, the food you have to carry and the
weather the walk will face — and, where the data does not know something, the word
*unknown* rather than a plausible number.

**[Try it at truhiker.stixxert.dev](https://truhiker.stixxert.dev)** — it runs in the
browser, with nothing to install and no account.

![TruHiker showing a Memurubu–Glitterheim route with the resupply panel and elevation profile open](docs/screenshots/truhiker.jpg)

## What it does

- **Routes.** Import GPX or GeoJSON, or draw on the map. Clicks snap to mapped
  trails, and a step that snaps at both ends follows the trail instead of cutting
  across it. Where no trail is near, the line is dashed and labelled *off-trail*.
- **Routing.** Pick two points and follow the marked trails. Where no trail
  connects them, it says so — it never bridges a gap or draws a straight line.
- **Elevation.** Profile, ascent, descent, grade and walking time, from
  Kartverket's national terrain model.
- **Resupply.** Shops, fuel, post points and huts around the route, by kind, with
  each point's distance along the route, its detour and the gap to the next one.
- **Energy.** Calories as a range, the intake ceiling, the food mass per leg and the
  projected weight change. When the deficit cannot be eaten away, it says so.
- **Weather.** MET Norway's forecast day by day along the route — and nothing at all
  beyond its ten-day reach.

## Honest by design

These are the rules the product is built around, and the tests pin them:

- an unknown value is `null`, never `0` — a missing ascent prints `—`, not `0 m`;
- weather beyond the forecast horizon carries no numeric fields at all;
- a hut is **not** food (its staffing and opening hours are not published data), and
  an unmanned fuel station counts for nothing;
- a partial ascent is unknown, not a smaller number;
- a route exists only where the fetched trail graph connects the endpoints;
- every live source is named in the interface.

## Quick start

Node 22.12 or newer (the floor in `package.json`); a browser with WebGL2. Trips
are stored in IndexedDB, with a localStorage fallback.

```bash
npm ci
npx playwright install chromium   # only needed for `npm run verify`
npm run dev                       # http://localhost:5173
```

The resupply points are built rather than committed, so a fresh clone has to
obtain them once. The cheapest way is to fetch a published copy, which is
verified against the pin in `tools/data-manifest.json` (~175 KB):

```bash
TRUHIKER_DATA_URL=https://truhiker.stixxert.dev npm run build
```

Without a deployment to fetch from, `npm run refresh:shops` downloads the
national OpenStreetMap extract (~1.4 GB) and builds the file, and
`OSM_PBF=… npm run data:build` rebuilds it from an extract you already have. If
anything is missing, the first command says what and how to fix it.

```bash
npm run build          # typecheck, bundle, copy data and notices into dist/
npm run verify         # the release gate: run this before claiming anything works
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | build `dist/` |
| `npm run verify` | the release gate |
| `npm test` | the hermetic suite: no network |
| `npm run test:live` | opt-in: real Kartverket and MET requests |
| `npm run preview` | serve the build |
| `npm run deploy:rehearsal` | build a bare clone the way the deploy container does |

## Deploy

Static **Cloudflare Workers Assets** only — no server. `wrangler.jsonc` declares no
`main`.

```bash
npm run build
npx wrangler deploy
```

The resupply extract refreshes monthly from a separate Worker with its own secrets;
the commands and the configuration are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

A repository-connected **Workers Builds** project needs no configuration beyond the
commands it infers: the extract is build output and is never committed, so in a
build container `npm run build` produces it before bundling. Nothing to set in the
dashboard, and `npm run deploy:rehearsal` builds a bare clone the way the container
does if you want to check that path locally.

## Data and attribution

| Source | Used for | Licence |
| --- | --- | --- |
| **Kartverket** — topo map, Sentinel-2 aerial, Turrutebasen trails, elevation model | basemap, trails, elevation | CC BY 4.0 · ©Kartverket |
| **Mapterhorn** | 3D terrain | attribution required, derived from open data |
| **MET Norway** | weather forecasts | NLOD / CC BY 4.0 |
| **OpenStreetMap contributors** | resupply points (bundled) | ODbL 1.0 |

Attribution is part of the interface: the map footer names ©Kartverket and
© Mapterhorn, and **About data** (*Om data*) lists every source with its attribution
and a link.

The resupply points are the only dataset bundled with the app; everything else is
fetched live from the service that owns it, and none of it is re-served by TruHiker.

## Privacy and network

The trip lives in this browser's IndexedDB. There is no account, no database, no
analytics and no third-party script. To draw a map and compute a plan, route
positions are sent to Kartverket (basemap, elevation, trails), Mapterhorn (terrain)
and MET (weather) — and nothing else leaves the browser.

## Limits

- **Routing** uses Kartverket's marked trails, within a box capped at 1.5° per side
  and 1.5 deg² in area (so a 1.5° square is refused). OpenStreetMap is not used; the
  reasoning is D25 in [docs/DECISIONS.md](docs/DECISIONS.md).
- **Drawing** is click-by-click, and a step that snaps at both ends follows the
  trail. Double-click, or **Fullfør**, ends the leg. There is no freehand mode and
  no keyboard way to place a vertex; dragging a vertex needs a pointer.
- **Elevation** covers mainland Norway inside the UTM 33 window, so west of 27°E;
  the far north-east is zone 35 and is reported as outside the model rather than
  guessed. A long route can take tens of seconds to profile; the panel says
  *Henter høydedata …* while it does.
- **Weather** stops at MET's horizon; outside it there are no numbers.
- **Saving** is local and debounced by one second, so an edit made in the last
  moment before you close the tab can be lost. Nothing is uploaded anywhere.
- **3D:** labels near the horizon are soft — a raster tile draped over terrain is
  minified there.
- **Hosting** is at the root of a domain, and the app also runs under a path prefix;
  only the caching and security headers then have to be set at the proxy instead.
- All figures are estimates. None of it replaces a map, a compass and your own
  judgement.

## Docs

[docs/DECISIONS.md](docs/DECISIONS.md) records every default a user could reasonably
expect to differ, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) the module boundaries
and what the release gate does and does not prove, and [AGENTS.md](AGENTS.md) the
rules for changing the repository.

## How it was built

AI-driven development.
