# Plan v2 — GPX route analyser (supersedes the NPL-specific framing in 01)

*Revision 2026-10-19. `docs/01` remains the research record for route reality,
DNT huts, resupply data, the calorie model and hosting limits. **Where this
document and 01 disagree, this one wins.***

---

## 0. What changed

The product is no longer "a map of the NPL route". It is:

> **A GPX route analyser for Norwegian hiking.** Import, draw, or pick a route —
> then get elevation, terrain, resupply, water/hut/shop gaps, calorie burn and
> pack-weight planning for it. NPL is one bundled case study, not the product.

This is a better product and, as it happens, a *simpler* one: it needs no
server, no database and no accounts.

---

## 1. Route sources — settled by evidence

### 1.1 UT.no is out, and it does not matter

DNT blocks reuse three independent ways:

- **`robots.txt` literally contains `Disallow: /*/gpx/`** — they singled out
  exactly the resource, while leaving article pages crawlable.
- **Terms §4**: content is *«utelukkende til din personlige bruk»*; automated
  harvesting is prohibited, and republishing is not personal use.
- **Terms §3**: the only licence grant is **CC BY-NC 4.0**, and only to *"UT.no og
  andre brukere av Tjenesten"* — a third-party app is not a beneficiary.

Nasjonal Turbase (the old open API) is **dead**: domain redirects to a 404,
`api.nasjonalturbase.no` → 404, and the original terms document returns **410
Gone**. There is no successor.

**But UT.no was never the right source.** Kartverket states plainly:
*«Turforslag er ikkje ein del av databasen»* — and, crucially, UT.no is a
**consumer** of Turrutebasen: *«Ut.no er ei anna nettside som hentar stiar og
ruter frå turrutebasen.»* The upstream is open.

### 1.2 Turrutebasen is the import source

| Property | Value |
| --- | --- |
| WFS | `wfs.geonorge.no/skwms1/wfs.turogfriluftsruter` (**use `version=1.1.0`**; 2.0.0 returns an odd body) |
| Types | `app:Fotrute`, `app:AnnenRute`, `app:RuteInfoPunkt`, `app:Skiløype`, `app:Sykkelrute` |
| Volume | **137,196 foot routes**, 9,744 info points, 11,871 cycle routes |
| Bulk GPX | `nedlasting.geonorge.no/.../Friluftsliv_0000_Norge_4326_TurOgFriluftsruter_GPX.zip`, plus per-fylke and per-kommune |
| Contains DNT routes | **Yes, named by chapter** — e.g. `Gammelsetra–Dindalshytta` (`Dov12`), `vedlikeholdsansvarlig: DNT | Kristiansund og Nordmøre Turistforening`, `gradering: B`, `merking: JA` |
| Licence | Open data / **CC BY 4.0 ©Kartverket** (metadata says "no conditions"; take the stricter one — it costs nothing) |
| Caveat | Individual features are often old (sampled: 2023-10-25, 2021-01-07, 2026-09-28). `oppdateringsdato` must be **displayed**. |

Useful attributes per route: `rutenavn`, `rutenummer`, `vedlikeholdsansvarlig`,
`gradering` (**G** enkel / **B** middels / **R** krevende), `merking` (JA/NEI),
`ruteFølger`, `underlagstype`, `sesong` (S/V/H), `sperret`, plus accuracy in cm.
**That is a richer model than a GPX file carries** — it is the reason to import
from the WFS and not just the GPX zips.

Gotchas: `outputFormat` is mandatory; `application/json` is not supported; the
descriptive fields are unreachable via `propertyName` (nested group only).

### 1.3 The three-tier rule

| Tier | Sources | Allowed? |
| --- | --- | --- |
| **Bundled / live-fetch** | Turrutebasen, Miljødirektoratet areas, Kartverket | ✅ CC BY 4.0 / NLOD |
| **User uploads their own file** | their watch, their memory, a route they traced | ✅ their data |
| **User uploads a file they got elsewhere** (ut.no, Wikiloc, AllTrails) | — | ⚠️ **Yes, but private to that user.** Never republish, never add to a shared corpus, never re-serve. Say so in one sentence in the upload UI, and carry any `©` found in the file's `<metadata>`. |
| **Crawl / mirror** ut.no, Wikiloc, AllTrails, Outdooractive | — | ❌ Never |

Keeping user uploads in a **separate store from the Turrutebasen layer** also
keeps the ODbL/CC-BY provenance chains clean and avoids share-alike
contamination.

### 1.4 Route creation — draw + snap, no routing engine

Building Norway's walking graph is **110–400 MB** (measured: BRouter's Norwegian
tiles sum to ~334 MB for the full car+bike+foot graph; foot-only ~110–160 MB) —
400–1500× the app bundle. The only in-browser engines (Valhalla WASM) were
**created September 2026 with ≤19 commits**.

Free public routers are all unsuitable as a dependency:

- **`router.project-osrm.org/route/v1/foot/...` returns HTTP 200 with a car
  route** (measured: 47.4 km in 84 min = 34.2 km/h). It does not 404 — it lies.
- **FOSSGIS** (`routing.openstreetmap.de`) works for foot (measured 4.4 km/h) but
  the policy is 1 req/s, identifying User-Agent — *which a browser `fetch()`
  cannot set*.
- **BRouter** works and has `hiking-mountain` + CORS, but is one volunteer's
  server: *"one session kills the other"*, 60 s timeout.
- **GraphHopper free** excludes hiking profiles entirely.
- **Mapbox walking** caps at 1,000 km/request and 25 waypoints.

**Decision: nearest-trail snapping, not routing.** Pre-extract trail polylines
(Turrutebasen + OSM), index them (`flatbush`), and on click snap to the nearest
segment within ~50–100 m, following that polyline; otherwise draw a **dashed
line labelled "off-trail — verify"**. ~200 lines, no dependency, works offline,
and — decisively for this project — it never silently picks a trail for you.

Upgrade path (later, optional): a per-click "route along trails" action via
BRouter `hiking-mountain`, gated behind an explicit button, capped, attributed,
falling back to snapping on failure. Then Valhalla WASM per-5°-tile once it has
aged.

### 1.5 Import/export formats

Accept **GPX 1.0 and 1.1** (`trk`/`rte`/`wpt`), **KML**, **GeoJSON**, `.gpx.gz`.
Skip TCX.

Parse with **`@xmldom/xmldom`, not `DOMParser`** — a great deal of real-world GPX
is invalid XML and `DOMParser` silently parses it only in part. Use
`@tmcw/togeojson` + `@we-gold/gpxjs`. Not `gpxparser` (unmaintained).
Parse in a **Web Worker** with progress (a 14 MB / 100k-point file is the
realistic worst case).

Expect and handle: broken namespaces, missing `<ele>`, multi-track files (make
the user choose — never merge silently), `.gpx.gz`, comma decimal separators.

Export: `<trk>` primary; per-stage by default. Garmin eTrex caps at **10,000
points/track** (GPSMAP 67: 20,000) — so a 2,700 km line is ~27 tracks. Emit
`<ele>` from the **same DEM as the profile**, and carry the attribution block
inside `<metadata>`.

---

## 2. Elevation — validated, and it needs no backend

**`https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage`**

| Check | Result |
| --- | --- |
| CORS | `access-control-allow-origin: *` with an `Origin` header ✅ |
| Payload | float32 GeoTIFF for any bbox, `imageSR=25833`, max 15000 px |
| Accuracy | **Galdhøpiggen summit reads 2467.8 m vs true 2469 m — 1.2 m error** ✅ |
| Speed | 128×128 window in **240 ms**; 5 km @ 10 m/px (1.05 MB) in one request |
| Reliability | **`identify` on a NoData point returns "NoData"** — must be handled, not assumed |

Two implementation facts worth writing down:

1. Responses are **128 px tiled TIFFs**. A 500 px window is 16 tiles. Reading
   only `TileOffsets[0]` yields garbage (this bit me — min 0, max 2185, ascent
   10,551 m on a 7.8 km leg). Assemble the tile grid.
2. Reconstruct the profile with **hysteresis** (~5 m threshold) and a 3-point
   median filter, or DEM noise becomes thousands of metres of false ascent.

For a 3,000 km route: ~600 windows of 5 km at 10 m/px. Concurrency 6 → ~1–2 min,
~600 MB of transfer, once. For a day route: 2–10 requests, instant.

**Do not** sample per point (370 ms × N). Sample windows.

---

## 3. Basemap — live, legal, zero self-hosting

Kartverket's own terms distinguish **using the services** from **copying the
data**:

> *«WMS- og cache-tenestene … kan brukast som dei er i ulike tenester på same
> premiss som for øvrige data. Det må imidlertid innhentast særskild løyve frå
> rettshavarane dersom dataa skal kopierast eller brukast på annan måte.»*

So: **streaming live is permitted; building an offline tile archive is not** (at
z12–20, where Geovekst data lives).

| Option | Verdict |
| --- | --- |
| **WMTS `cache.kartverket.no` — `topo` / `topograatone` / `toporaster`** | ✅ **Use this.** CORS `*`, real 256 px topo tiles, matrix sets `webmercator` + `utm32n/33n/35n`, zoom 00–18. *Live use only.* |
| WMS `wms.geonorge.no/skwms1/wms.topo` | ✅ Working fallback (256 px PNG, 105 KB verified) |
| Own vector tiles from N50/N100/N250 | ⏸ **Deferred, not needed for MVP.** Only if you later want offline or clickable map objects |
| Bulk-copying cache tiles into PMTiles | ❌ Requires written permission from the Geovekst rights holders |

⚠️ **Operational caveat, observed live:** the cache served **identical 854-byte
blank tiles for every zoom ≥4** for a period, then recovered. A CDN glitch can
blank the map. Handle tile errors explicitly and keep the WMS as a fallback —
a silently blank basemap is exactly the failure mode we cannot ship.

**3D terrain:** Mapterhorn live terrarium tiles (`tiles.mapterhorn.com`), whose
Norwegian coverage *is* Kartverket-derived — so it is still Norwegian data, just
re-served. Self-host to R2 later if we want independence. Never Mapzen/AWS
terrarium as primary: for Norway that is SRTM, and it is visibly wrong.

---

## 4. Hosting — final shape

```
Cloudflare Pages (free, unmetered static requests, 20k files)
├── index.html + app (~400–450 KB gzip)
├── /data/shops.bin        Norwegian food/fuel/post POIs (compact index, bbox-queryable)
├── /data/huts.json        DNT huts — curated, with type & season
├── /data/routes-npl.geojson   bundled NPL benchmark route
└── /data/trails/…         optional simplified trail polylines for snapping

Kartverket WMTS ──live──▶ basemap raster
Mapterhorn      ──live──▶ 3D terrain
hoydedata       ──live──▶ elevation profile (float32, client-side)
Turrutebasen    ──live──▶ route import (WFS)
```

**No R2 required for the MVP.** No backend, no database, no accounts. Routes live
in `localStorage` / URL / file — which is also the privacy answer for user
uploads.

Keep R2 in reserve for the day we self-host terrain tiles (~0.5–0.9 GB).

---

## 5. Resupply & calories for a *general* route

Because any route can be imported, the engine must work from geometry, not from
a curated NPL table.

**Resupply node types** (both support models are in scope):

| Node | Data | Notes |
| --- | --- | --- |
| Supermarket / convenience | OSM (4,042 + 577 NO), chain-verified hours for the corridor | Sunday-closed by statute; ≤100 m² exemption |
| DNT hut | Curated | `selvbetjent` larder = **probability**, not a boolean; **Agder→Trøndelag only**; `ubetjent` = nothing, not even gas |
| Fuel station | OSM `amenity=fuel` | **`automat` vs `bemannet`** must be classified by hand — an automat has no shop |
| Post i butikk / parcel point | OSM `amenity=post_office` | For the mail-drop model |
| User-defined cache | user | Arbitrary drop points |

**Support model = both**, so the scheduler does both:

- **Carry-all**: gap analysis → "this leg is 110 km with no shop, carry 7 days =
  6.3 kg of food at 4.4 kcal/g".
- **Mail drops**: `arrival = leg_start + N days` → `ship_by = arrival - 5` and
  `ship_from = arrival - 7` (parcel window) or `-21` (poste restante). Warn
  loudly when the window cannot fit the hike.

**Calories** (from `docs/01` D8, unchanged): component-sum with Minetti for
grade, present a **range**, and lead with the ceiling — max sustainable intake
≈ **2.5 × BMR**. Outputs per leg: kcal/day, food kg, cost, and the body-mass
projection.

---

## 6. Internationalisation

Norwegian **and** English from day one, with Norwegian as the default for
Norwegian data. Not a retrofit: build a tiny typed `t()` with a flat NO/EN
dictionary, no library. Place names come from SSR/Turrutebasen and are *not*
translated; UI chrome is. Numbers/dates via `Intl` with `nb-NO` / `en-GB`.

---

## 7. Phases

| # | Deliverable | Notes |
| --- | --- | --- |
| **1** | **Elevation core** — GPX in → resampled profile, ascent/descent, grade, per-segment terrain class | Pure functions, fully tested. This is the number engine everything else depends on. |
| **2** | **Map shell** — MapLibre, live Kartverket basemap, route draped, profile chart synced to camera, 3D terrain toggle | |
| **3** | **Route input** — upload GPX/KML/GeoJSON, draw+snap, Turrutebasen import by area | |
| **4** | **Resupply** — shops/huts/fuel/post, gap analysis, carry-all + mail-drop scheduler, per-leg buy list (kg + kcal + NOK) | |
| **5** | **Calories & body** — TDEE range, pack-weight curve, weight projection, mid-trek calibration | |
| **6** | **Polish & publish** — i18n, provenance badges, attribution page, Pages deploy | |

Out of scope, deliberately: accounts, shared route hosting, offline/PWA,
routing engine, PDF atlas.

---

## 8. Still open (needs your call)

1. **Public or personal?** Public app (anyone can use it, routes stay in their
   browser) or your private tool? Same code, different framing and disclaimers.
2. **NPL as bundled benchmark** — keep the FKT line as a built-in demo route
   (attributed, not redistributed as "the route")? Or leave it out entirely?
3. **Snapping in MVP** or straight-line-only with off-trail flags first?
4. **Your numbers** (mass/height/age/sex, target pack, realistic km/day) so the
   calorie model is a plan and not a demo.
5. **Trail data basis for snapping**: Turrutebasen only (clean CC BY), or also
   OSM (better coverage of informal paths, ODbL share-alike on a derived graph —
   kept as a separate layer)?
