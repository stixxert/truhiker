# NPL-Map — Feasibility spike (verified, not assumed)

All facts below were **measured from this sandbox** on the dates of the spike, not
read from a blog. Anything unverified is marked as such.

## 1. Kartverket elevation data — WORKS, and is cheaper than expected

**Finding: the national 1 m LiDAR DEM can be sampled over HTTP range requests,
without downloading terabytes.** This was the main technical risk and it is now
retired.

| Fact | Value |
| --- | --- |
| Dataset | Nasjonal høydemodell, **DTM 1** (terrengmodell, LiDAR) |
| Catalogue | `https://kartkatalog.geonorge.no` → "DTM 1 Høydedata" |
| Bulk index (ATOM) | `https://nedlasting.geonorge.no/geonorge/ATOM/hoydedata/datasett/DTM1.atom` |
| Tiles advertised | **2033** GeoTIFF tiles |
| Total size | **1.59 TB** (median tile ~0.98 GB, max 1.2 GB) |
| Tile size on ground | 15 010 × 15 010 px @ 1 m ≈ 15 × 15 km |
| Internal tiling | 512 px tiles, Deflate, float32, nodata `-32767` |
| **Overviews** | **YES — chained IFDs: 15010², 7505², 3753², 1877², 939², 470², 235²** |
| Coarsest resolution | **~64 m/px** (235 px overview) |
| Licence | Open data (NLOD / CC BY 4.0) — confirm attribution text before launch |

Reading a 16×16 window from the coarsest overview of a **remote** tile took
**~370 ms total** including open (176 ms) and read (138 ms). Elevations returned
were plausible (1052–1082 m in Hordaland). This means:

- A route elevation profile at ~30–60 m spacing is a *few hundred MB of range
  requests*, not a terabyte download.
- A 20–30 m DEM for the route corridor can be derived once at build time.
- **Do not** plan on downloading DTM 1 in bulk.

Toolchain note: the sandbox has **no GDAL, no numpy, no PIL**. Pure-JS works:
`geotiff` (v2, `fromUrl` does range reads) + `proj4` (EPSG:25833 needs an
explicit proj string — `+proj=utm +zone=33 +ellps=GRS80 …`; the `EPSG:25833`
alias alone throws).

## 2. Kartverket WCS — usable, but fussy

- `https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?service=WCS&request=GetCapabilities`
  → 200, open data.
- **The coverage ID is `nhm_dtm_topo_25833`, lowercase — not the WMS layer name
  `NHM_DTM_25833`.** Using the layer name yields an opaque ArcGIS 400.
- Native format `image/tiff`, float32, EPSG:25833, extent
  `-100275 6399725 → 1150255 8000275`, 1 m grid, `axisLabels="x y"`.
- A large GetCoverage window returned **502** in testing; small/odd requests
  returned 400/502. Treat WCS as a fallback, **not** the primary path. The
  ATOM + range-read route is more reliable and has no service limits.
- The "Høyde DTM **Sømløs** WCS" entries are marked **open: false** — do not use.
- `https://ws.geonorge.no/hoyde/v1/hoeyde` (point API) returns **403** —
  appears to require registration/API key. Not relied on.

## 3. Kartverket raster map tiles — WORKS LIVE (earlier verdict was wrong)

> **Correction.** An earlier pass of this spike concluded the cache was "gated"
> because every tile at z≥4 returned an identical 854-byte blank PNG. That was
> a **transient CDN/origin fault**, not access control: the same URL later
> returned a real 121 KB tile with **no special headers at all**, and
> `access-control-allow-origin: *` for `Origin` requests. **Live use from a
> browser is fine and is explicitly permitted — see §3b.**

### 3b. The live-use permission

Kartverket's terms distinguish *using the services* from *copying the data*:

> «WMS- og cache-tenestene … kan brukast som dei er i ulike tenester på same
> premiss som for øvrige data. Det må imidlertid innhentast særskild løyve frå
> rettshavarane dørsom dataa skal kopierast eller brukast på annan måte.»

So: **stream live = allowed; bulk-copy z12–20 into a tile archive = needs
permission** (Geovekst data). Verified working: `topo` 256×256 PNG, 121,022
bytes, CORS `*`. Legendary fallback: `wms.geonorge.no/skwms1/wms.topo` (105 KB
PNG, verified).

⚠️ Because the outage above really happened, the app must handle tile failures
explicitly and keep a WMS fallback — a silently blank basemap is the worst
possible failure for this product.

## 3c. (superseded) Kartverket raster map tiles — earlier, incorrect verdict

`https://cache.kartverket.no/v1/wmts/1.0.0/{topo|topograatone|toporaster|sjokartraster}/default/webmercator/{z}/{y}/{x}.png`

- WMTS capabilities: 200. Tile matrix sets: `webmercator`, `utm32n`, `utm33n`,
  `utm35n`.
- **Every tile at z≥4 returned the identical 854-byte 256×256 blank PNG**
  (same md5 with and without an `apikey` param). z0 returned a different
  1811-byte tile. Response headers show `access-control-allow-origin: *` and
  `cache-control: max-age=345600`, i.e. a valid CDN response — for a blank
  image.
- **Conclusion: the public raster cache is not freely usable as-is** (keyed /
  placeholder). A tile service cannot be built on it without an API key, and a
  key must not be exposed in a public front-end.
- **Implication: pre-render and self-host the topo raster** from open *vector*
  data (N50/N100/N250 + DTM hillshade), or put the keyed service behind a Worker.
  This is a real architectural decision, see the options doc.

## 3d. `hoydedata.no` ArcGIS ImageServer — the runtime elevation endpoint

**`https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage`**

This is the endpoint the app should use, and it beats the WCS (which kept
returning 400/502 on `GetCoverage` regardless of axis labels, subset order or
format).

| Check | Result |
| --- | --- |
| CORS | `access-control-allow-origin: *` when `Origin` is sent ✅ |
| Pixel type | `F32` (float32 metres), `imageSR=25833`, max 15000×15000 |
| **Accuracy** | **Galdhøpiggen summit = 2467.8 m vs true 2469 m → 1.2 m error** ✅ |
| Speed | 128×128 window **240 ms**; 5 km @ 10 m/px (1.05 MB) in one request |
| NoData | `identify` returns `"NoData"` — must be handled, not assumed ✅ |
| Failure mode | Responses are **128 px tiled** TIFFs; reading only `TileOffsets[0]` gives garbage |

Also `.../ImageServer/identify` gives single-point elevation with metadata —
useful for spot checks and tests.

## 4. Global DEM fallbacks confirmed reachable

- Copernicus DEM GLO-30 S3 open data: 200.
- Mapzen/AWS terrarium tiles (`elevation-tiles-prod`): 200.
- These are the pragmatic source for *rendering* terrain in 3D; Kartverket DTM
  remains the source of truth for the *numbers* (profile, ascent, Naismith).

## 5. Environment

- Node v22.22.1, npm 9.x, git, gh present. **pnpm is NOT installed** (rule says
  prefer pnpm — needs `corepack enable pnpm` or fall back to npm).
- No GDAL/tippecanoe binaries; no Python geospatial libs.
