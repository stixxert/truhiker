# TruHiker

**A rigorous, interactive route planner for long-distance walking in Norway.**
<https://github.com/stixxert/truhiker> (private)

Originally scoped around *Norge på langs* (Lindesnes → Nordkapp, ~2,700 km); now a
general GPX route analyser, with NPL as one bundled case study.

Everything runs in your browser. Routes never leave the device: they are stored
locally (IndexedDB) and can be downloaded as GPX. There is no account and no
server-side database.

**Status: product redefined as a general GPX route analyser (see plan v2).
Phase 1 (elevation core) and Phase 2 (map shell) are complete and green; later
phases are in progress.**

## Read in this order

| Document | What it covers |
| --- | --- |
| [`docs/08-corrections.md`](docs/08-corrections.md) | **Read this first** — corrections of fact and an audit of the planning fallacies in this project |
| [`docs/07-bundle-and-hosting.md`](docs/07-bundle-and-hosting.md) | Exactly what ships, byte by byte; Cloudflare Workers limits; why not KV/R2 |
| [`docs/06-bundle-manifest.md`](docs/06-bundle-manifest.md) | The bundling principle and licence obligations (ODbL, CC BY, database right) |
| [`docs/05-phase2-notes.md`](docs/05-phase2-notes.md) | The map shell: features, bundle size, visual verification, gaps |
| [`docs/04-data-delivery.md`](docs/04-data-delivery.md) | Live-first data delivery, measured latencies, and the traps |
| [`docs/03-snapping-and-graph.md`](docs/03-snapping-and-graph.md) | Snapping design, the route graph, where DEM earns its place |
| [`docs/02-plan-v2.md`](docs/02-plan-v2.md) | The product as a GPX route analyser; phases |
| [`docs/01-options-and-decisions.md`](docs/01-options-and-decisions.md) | Route reality, DNT huts, resupply data, calorie model, hosting limits |
| [`docs/00-feasibility-spike.md`](docs/00-feasibility-spike.md) | Measured facts (including one correction: the Kartverket tile cache *does* work live) |

## What this is

A GPX route analyser for Norwegian hiking: import, draw or fetch a route, then
get elevation, terrain, resupply, shop/hut gaps, calorie burn and pack weight.
*Norge på langs* is a bundled case study, not the whole product.

## What this is not

- Not a navigation device. It is a planning aid; terrain, shops and huts must be
  verified on the ground.
- Not a route authority, and it never fetches from UT.no — DNT's robots.txt
  disallows `/*/gpx/` and their terms confine content to personal use. The open
  upstream is Kartverket Turrutebasen (CC BY 4.0).

## Non-negotiables

- Terrain and elevation come from **Kartverket DTM (bare earth)** — never DOM,
  never a global 30 m DEM as the primary source for Norway.
- Every displayed fact carries **provenance** and a **last-verified date**.
- Attribution: ©Kartverket (CC BY 4.0); OSM data is ODbL (share-alike);
  MET Norway / NVE under NLOD.

## Status

**Phase 1 complete and green.** The elevation core (`src/core/`) turns a GPX
into an authoritative profile from Kartverket DTM: resample → DEM sample →
median filter → hysteresis ascent/descent → grade. Verified anchors:
Galdhøpiggen reads **2467.8 m vs 2469 m true**; Gjende lake level reads
**984.4 m vs 984 m true**.

**Phase 2 complete.** A static SPA loads a GPX route onto live Kartverket topo
tiles with 3D terrain (Mapterhorn), a profile chart synchronised with the
camera, Naismith walking time with an editable pace, NO/EN, and visible
degradation for every live service. The bundled demo is real Turrutebasen
geometry (Memurubu–Glitterheim, jot21). See
[`docs/05-phase2-notes.md`](docs/05-phase2-notes.md).

```
npm install
npm run dev                           # http://localhost:5173
npm run build                         # typecheck + static build to dist/ + data files
npm run verify                        # THE GATE: types, tests, build, host limits
npm run preview                       # serve the production build
npm test                              # all tests, incl. live DEM anchors
npm run size                          # JS budget check (gzip + brotli)
npm run cf:dev                        # build + run under the Cloudflare Worker locally
npm run deploy                        # build + wrangler deploy
npm run profile -- route.gpx          # elevation profile as JSON (CLI)
```

Next: routing the snapping, resupply and calorie engines into the UI, then
weather.

## Hosting

Cloudflare **Workers Static Assets** — static-only, no Worker script, no KV, no R2.
Static-asset requests are free and unlimited on the Workers free plan, and the
whole bundle is **14 files / 512 KB brotli**, against a 20,000-file and
25 MiB-per-file ceiling. A Worker script was tried and removed: it added a cold
start and a 100,000-requests/day budget to do what `_headers` and `404.html`
already do. KV would cap reads at 100,000/day; R2 would add a custom domain and
Class B operations for a 171 KB file. Full reasoning and the limit table:
[`docs/07-bundle-and-hosting.md`](docs/07-bundle-and-hosting.md).

MapLibre is **bundled**, not served from a CDN: its v6 build loads a separate
worker module relative to `import.meta.url`, so a CDN copy fails with
`Worker failed to load` and renders without DEM decoding. The CDN build is also
larger (240 KB brotli vs 225 KB) because Vite re-minifies it.

**Nothing is proxied server-side.** Kartverket (WMTS/WFS), Mapterhorn terrain and
hoydedata elevation are all called directly by the browser — they are CORS-enabled
and permitted for live use, and proxying would be the only thing consuming a
request budget.

## Environment

Node 22 and npm are available; **pnpm is not installed** (`corepack enable pnpm`
if you want it). There is no GDAL, no numpy/PIL, and no geo libraries: the
elevation pipeline is pure TypeScript with a hand-written TIFF reader, and it
reads Kartverket's float32 GeoTIFFs directly from `hoydedata.no`.
