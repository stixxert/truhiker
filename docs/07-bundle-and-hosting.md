# Bundle & hosting — exactly what ships, and where it lives

*Definitive. Every byte below is measured, not estimated. Cloudflare limits quoted
from the live docs (2026-10).*

---

## 0. The decision, in one line

> **Ship everything as Cloudflare Workers *Static Assets*. Use neither KV nor R2.**
> Static-asset requests are **free and unlimited** on the Workers Free plan; KV
> caps at 100,000 reads/day and each read consumes a Worker invocation; R2 is for
> large or range-queried objects we do not have.

---

## 1. The complete bundle

Current build (`npm run verify`): **13 files**, **2.0 MB raw**, **512 KB brotli**.

| File | Raw | Brotli | Licence | Cache | Why it must be bundled |
| --- | ---: | ---: | --- | --- | --- |
| `maplibre-*.js` | 1,047,825 | 230,589 | BSD-3 (MapLibre) | 1 yr immutable | renderer |
| `maplibre-gl-worker-*.mjs` | 518,806 | 121,564 | BSD-3 | 1 yr immutable | MapLibre's own worker |
| `index-*.js` (app) | 169,326 | 48,333 | ours | 1 yr immutable | the app |
| `maplibre-*.css` | 71,339 | 8,204 | BSD-3 | 1 yr immutable | MapLibre UI |
| `index.html` | 17,854 | 3,423 | ours | `must-revalidate` | entry point |
| `index-*.css` (app) | 18,454 | 4,039 | ours | 1 yr immutable | styles |
| `dem.worker-*.js` | 12,731 | 4,781 | ours | 1 yr immutable | elevation sampling off-thread |
| `dem-*.js` | 10,816 | 3,969 | ours | 1 yr immutable | DEM fallback path |
| `demo/memurubu-glitterheim-jot21.gpx` | 56,497 | 4,554 | **CC BY 4.0 ©Kartverket** | 1 h | the landing demo (1,164 pts, real trail) |
| `data/shops.osm.bin` | 174,912 | **91,850** | **ODbL 1.0 © OSM contributors** | 1 h | resupply points — no live source (see §3) |
| `data/shops.osm.meta.json` | 7,786 | ~1,500 | ODbL | 1 h | counts, provenance, build date |
| `data/shops.osm.LICENSE` | 2,321 | ~900 | ODbL text | 1 h | licence compliance |
| `_headers` | ~3,000 | ~700 | ours | — | cache + security headers |
| **Total (13 files)** | **~2.0 MB** | **~512 KB** | | | |

Not yet present, planned and small: a DNT hut classification table (~15–30 KB)
and a `huts.LICENSE` note. Nutrition and translations live inside the app JS, so
they are already counted there.

### What the demo GPX costs, and why it stays
56 KB raw, **4.5 KB brotli**. It is the only way a first-time visitor sees a real
route without hunting for a file, and it carries its own attribution in
`<metadata>`. Worth 4.5 KB.

### The one big line item
MapLibre is **352 KB of the 522 KB** (core + worker + CSS). That is the price of
real 3D terrain and vector cartography. Everything we wrote is ~61 KB brotli.

---

## 2. What is *not* bundled

| Data | Live source | Transport |
| --- | --- | --- |
| Base map | Kartverket WMTS `topo` / `topograatone` | live raster tiles |
| Base map fallback | `wms.geonorge.no/skwms1/wms.topo` | live WMS |
| 3D terrain | Mapterhorn terrarium (`tiles.mapterhorn.com`) | live raster-dem |
| Elevation, profiles, ascent | `hoydedata.no` ArcGIS ImageServer | live float32 GeoTIFF |
| Trail geometry, snapping | Turrutebasen WFS (`wfs.geonorge.no`) | live bbox queries |
| DNT hut **positions** | Turrutebasen `app:RuteInfoPunkt` | live bbox queries |
| Weather / avalanche / flood | MET Norway / NVE | live (later phase, via Worker) |

Nothing in this table is redistributed, so none of it carries a share-alike
obligation. Attribution is shown in the map footer and the "Om data" panel.

---

## 3. Why the shops file is the one data bundle

Every live alternative was measured and rejected:

| Option | Result |
| --- | --- |
| Overpass live | **43.8 s** for a 2 km Oslo box; ~100 queries/day quota for a public app |
| `api.openstreetmap.org` | *"not for read-only purposes"*; blockable without notice |
| OSM Shortbread vector tiles | `pois` layer has **no fields** (checked TileJSON) |
| MapTiler / Thunderforest / OpenFreeMap | licence forbids extracting vector content |
| Enhetsregisteret + Adresse API | CORS works, but **no coordinates, no hours, no brand**, and one geocode request per shop |

The bundled file covers **8,571 POIs** (after collapsing 242 same-site duplicates):
supermarket 3,971 · convenience 554 · general 288 · grocery 24 · fuel 2,283 ·
post office 1,252 · parcel locker 199. `opening_hours` is present for **75.5 %**
overall and **96.3 % of supermarkets**.

**Size:** 237.5 KB before dedupe → **174,912 B raw → 91,850 B brotli**. Names cost
~60 KB of that and are worth it: a plan that says "Rema 1000 Otta" is usable; a
pin is not.

---

## 4. Cloudflare Free plan — exact limits and our headroom

| Limit (Workers Free) | Free allowance | This project | Headroom |
| --- | ---: | ---: | --- |
| **Static-asset requests** | **free & unlimited** | all page loads | none needed |
| Dynamic Worker requests | 100,000 / day (Error 1027 beyond) | only `/api/*` | effectively unused |
| CPU per invocation | 10 ms | assets bypass the Worker | — |
| **Static files per Worker version** | **20,000** | **12** | 1,666× |
| Individual file size | 25 MiB | 1.2 MB (`maplibre.js`) | 20× |
| Worker size | 64 MiB | ~5 KB | 12,000× |
| Subrequests per request | 50 | 0 today, 1 when MET lands | 50× |
| `_headers` rules | 100 | 6 | 16× |
| Workers per account | 100 | 1 | 100× |

Sources: Workers [limits](https://developers.cloudflare.com/workers/platform/limits/)
and [pricing](https://developers.cloudflare.com/workers/platform/pricing/)
("Requests to static assets are free and unlimited.").

**The binding constraint is not bandwidth or requests — it is the 20,000-file
ceiling**, and we use 12. That is the whole argument for this architecture.

### Why not KV
Free KV: **100,000 reads/day**, **1,000 writes/day**, 1 GB, 25 MiB/value. Three
reasons it loses:
1. A KV read inside a Worker **is a Worker request**, so it draws from the same
   100,000/day budget that static assets do not touch.
2. It adds latency to every page load for data that never changes between builds.
3. 1,000 writes/day makes it awkward as a build artefact store.

KV is for *mutable, low-volume* values (a feature flag, a cached forecast). It is
the wrong tool for 92 KB of immutable POI data.

### Why not R2
Free R2: 10 GB, 1 M Class A, **10 M Class B/month**, free egress. Generous — and
irrelevant here, because:
1. Nothing we ship is large; the biggest file is 1.2 MB.
2. We need no `Range` requests (that was the PMTiles plan, which we dropped).
3. Public R2 requires **a custom domain** — `r2.dev` is documented as
   *non-production* — which is extra DNS for zero benefit.
4. Every R2 read is a billed Class B operation; static assets are free.

**R2 stays the documented escape hatch**: if we ever self-host terrain PMTiles or
a sharded trail graph (measured at 42.4 MB / 1,309 tiles), R2 is exactly right
because it serves `206`. Today, it would be a dependency with no upside.

---

## 5. There is no Worker script — and that is the point

An earlier revision added one. It was removed, because nothing needed it:

| What the Worker did | Who does it now |
| --- | --- |
| Security headers | `_headers` — applied by the edge to static assets |
| 404 page | `public/404.html` with `not_found_handling: "404-page"` |
| `/api/health` | Not needed; the site being up *is* the signal |
| `/api/met/*` proxy | Not needed until weather exists |

Deleting it buys three things: no cold start, no 10 ms CPU ceiling, and
**zero dynamic requests** — page loads and asset fetches never touch the
100,000/day budget because there is no Worker to invoke.

### It would not come back for weather either — corrected
An earlier revision claimed MET Norway requires a server-side proxy. **That was
wrong.** Their terms:

> "Low-volume websites and mobile apps **may use simple cross-origin Javascript
> requests** and direct image links, provided the site identifies itself…"

Browsers cannot set `User-Agent`, and MET accommodates exactly that: the site
identifies itself with an `Origin` header instead. A caching proxy is required
*only* "if you start generating a lot of traffic" — not for a personal planning
tool.

So weather is a client-side `fetch` with `Origin`, `Expires` /
`If-Modified-Since`, and coordinates truncated to 4 decimals. **No Worker.**
The correction is recorded in [`docs/08-corrections.md`](08-corrections.md).

### When a Worker would actually be justified
A secret we cannot ship to the browser, or traffic high enough that MET asks us
to proxy. Neither exists today. `wrangler.jsonc` declares assets and no `main`,
and `npm run verify` **fails the build if a `main` is reintroduced** without the
decision being documented.

### What is never proxied either way
**Kartverket, Mapterhorn and hoydedata are called directly by the browser.** All
three are CORS-enabled and publicly permitted for live use. Proxying them would
defeat the point — and it would be the only thing that consumes a request budget.

### The CSP was tested against the real app, not assumed
A restrictive CSP is the classic way to break a mapping app in production only.
`dist/` was served locally with the exact production headers and screenshotted:
the live Kartverket basemap, the Mapterhorn terrain source, the hoydedata
elevation fetch and the MapLibre worker all load under the policy as written.
**Verified: 9.01 km route, +125 m / −261 m, profile rendered, no console errors.**

### Why not serve MapLibre from a CDN instead of bundling it?
It was tested, because on paper it removes 344 KB from our origin. The result is
negative, and not for the reason one might expect:

```
imported in 195ms; exports=87
map.error: Worker failed to load. Check that the worker URL is correct.
```

- MapLibre v6 ships `maplibre-gl.mjs` **and a separate `maplibre-gl-worker.mjs`**.
- It resolves the worker relative to `import.meta.url`, so a CDN-loaded module
  requests a **cross-origin worker**, which the Worker spec forbids; MapLibre's
  blob fallback did not rescue it.
- The worker is not optional — it decodes the DEM tiles. The map renders, but
  degraded.

Making it work would mean hosting the worker ourselves (so the “saving” is
118 KB, not 344 KB) or blob-wrapping it at runtime, which is more moving parts
than the thing it replaces. On top of that the CDN build is **larger** than ours:
240 KB brotli vs 225 KB, because Vite re-minifies it.

Bundling also keeps: same-origin CSP, no third-party availability risk, no user
IPs sent to a CDN, and a build our own gate can actually verify. A regression
test now fails if `cdn.jsdelivr.net` is added to `script-src`.

---

## 6. Licences, per shipped file

| File | Licence | Obligation |
| --- | --- | --- |
| App code, translations, nutrition | ours | none |
| MapLibre JS/CSS/worker | BSD-3-Clause | reproduce copyright notice |
| `demo/*.gpx` | CC BY 4.0 ©Kartverket (Turrutebasen) | attribute, indicate changes (we converted GML→GPX, no elevation) |
| `data/shops.osm.bin` | **ODbL 1.0** | §4.3 notice, §4.4 share-alike (this file **is** the derivative DB, published under ODbL), §4.6 access (served publicly) |

**Hard rule:** never merge ODbL rows with non-ODbL rows in one file. `shops.osm.*`
stays ODbL; hut classification and nutrition stay ours. Displayed output is a
Produced Work — the §4.3 notice suffices, and share-alike does not reach the app.

---

## 7. Enforcement

`npm run verify` fails the build if any of these regress:

- more than **20,000** files in `dist/` (the Workers free ceiling)
- any file above **25 MiB**
- JS above **500 KiB gzip**
- any non-code asset above **1 MB** (i.e. someone quietly bundling data)
- missing `data/shops.osm.bin`, `.meta.json` or `.LICENSE`
- a CSP in `public/_headers` that differs from the one in `worker/index.ts`
  (they must not drift)
- the `_headers` rule count exceeding 100

---

## 8. Deploy

```bash
npm run build      # typecheck + vite build + copy data/
npm run verify     # the gate above
npx wrangler deploy
```

`wrangler.jsonc` is committed; no secrets are involved, and there is no CI.
