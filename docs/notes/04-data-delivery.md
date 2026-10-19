# Data delivery — live-first, bundle only what is tiny

*Supersedes the transport discussion in `docs/03` §2. All numbers measured in
this sandbox.*

---

## 0. The rule

> **Retrieve from the source, directly in the user's browser. Bundle only what is
> (a) tiny, and (b) has no usable live source.**

No large assets, no national bundles, no tile archives. The app ships as static
HTML/JS plus a few hundred KB of curated data.

---

## 1. What goes live, and what it measures

| Data | Source | Transport | Measured | Verdict |
| --- | --- | --- | --- | --- |
| Basemap | Kartverket WMTS `topo` | live raster | 121 KB/tile, CORS `*` | ✅ |
| 3D terrain | Mapterhorn terrarium | live | — | ✅ |
| Elevation | `hoydedata.no` ImageServer | live float32 GeoTIFF | **240 ms**/window, **2467.8 m vs 2469 m** | ✅ |
| **Trails (snapping)** | **Turrutebasen WFS** | live bbox, small | **176 ms** (1 km rural) → **669 ms** (10 km); 330 ms urban | ✅ **primary** |
| Shops / fuel / post | Overpass | live | **45 s** Oslo, **502** rural, **timeout** Norway-wide | ❌ **unusable** |
| OSM trail supplement | Overpass / OSM API | live | 35–45 s; API use prohibited for reads | ⚠️ optional only |
| DNT huts, food, prices | — | **bundled** | a few KB | ✅ |
| Shop index | OSM extract, prebuilt | **bundled** | ~4,000 points ≈ **~250 KB** (~80 KB brotli) | ✅ tiny |

**Why shops move to the bundle:** Overpass is not merely slow, it is
*structurally* unusable for a public app. overpass-api.de's own terms: *"If you
have an app or website, then the usage counts towards the sum of requests made by
all your users"* and *"divide those numbers by 100"* ⇒ roughly **100 queries and
10 MB per day in total**. Load shedding is explicit and starts with heavy users.
In practice it returned 35–45 s and 502/504 while idle.

A shop point index is ~250 KB. That is the right thing to bundle: it is small,
it changes quarterly, and there is no live alternative.

---

## 2. Turrutebasen WFS — the one live source that works

### Measured

| Query | Latency | Payload |
| --- | --- | --- |
| 1 km rural bbox | 176 ms | 5 KB |
| 10 km rural bbox (Jotunheimen) | 669 ms | 130 KB, 24 features |
| 1 km urban bbox (Oslo) | 330 ms | 26 KB, 7 features |
| 10 km urban bbox (Oslo) | 6.6 s | 942 KB, 371 features |
| Bulk count `app:Fotrute` | — | `137196` |

### Four traps, all confirmed the hard way

1. **Axis order depends on how you spell the CRS.** Definitive test:
   `bbox=…,EPSG:4326` expects **x,y = lon,lat**; `bbox=…,urn:ogc:def:crs:EPSG::4326`
   expects **lat,lon**. Get it wrong and you receive **zero features with HTTP
   200 and no error**. We recommend `EPSG:4326` + lon,lat (matches GeoJSON).
2. **`cql_filter` is silently ignored.** A `DWITHIN(…,200,meters)` filter returns
   `137196` — the entire national dataset. There is **no server-side radius
   filter**. Always fetch a bbox and distance-test client-side.
3. **GML only.** `application/json` and `text/xml` are rejected; the only working
   `outputFormat` is `application/gml+xml; version=3.2` (the `+` must be encoded).
   So the client needs a ~200-line GML parser or OpenLayers' WFS format.
4. **`resultType=hits`** works and is a cheap pre-flight; `maxFeatures` +
   `startIndex` paging works.

### Politeness, since no limit is published

Kartverket publishes **no** rate limit for this service, and their terms restrict
*copying*, not *querying*. That is permission, not an invitation: a public app can
still degrade a national service in a small country. Enforce in the client:
one request per *click or prefetch*, never per *pan*; debounce; concurrency ≤ 2;
cache in IndexedDB; and never request a box larger than the viewport plus margin.

---

## 3. OSM — what is actually available

| Route | Verdict |
| --- | --- |
| `api.openstreetmap.org/api/0.6/map` | ❌ policy: *"not for read-only purposes… clients may be blocked without notice"*; 0.25 deg² + 50k-node caps; 7 MB for a 1.5 km Oslo box in our test |
| Overpass live | ❌ quota + instability (above) |
| MapTiler / Thunderforest / OpenFreeMap tiles | ❌ licence forbids extracting/modifying vector content |
| **Protomaps / VersaTiles** | ✅ ODbL, extraction is the intended workflow — but that means self-hosting or bundling |
| OSM Shortbread tiles (viewed tiles only) | ⚠️ grey; `path` only at z13+, bulk fetching prohibited |

**Conclusion: OSM is a *coverage* nicety, not a viable live dependency.** Ship
without it for v1; snap to Turrutebasen, and let it fail visibly where there are
no official trails. Revisit only if Protomaps' hosted API proves suitable.

---

## 4. If we ever *do* need to ship geometry (the fallback, measured)

Kept for the record, because it is the escape hatch if live latency disappoints:

| Set | Grid | Tiles | Total brotli | Largest tile | Median |
| --- | --- | --- | --- | --- | --- |
| OSM trail-only | 0.25° | 1,309 | **42.4 MiB** | **1.35 MiB** | 12.3 KB |
| OSM trail-only | 0.1° | 6,520 | 41.7 MiB | 0.51 MiB | 2.5 KB |
| OSM walkable | 0.1° | 6,720 | 109.1 MiB | 0.78 MiB | 7 KB |
| Turrutebasen foot | 0.25° | 1,075 | ~101 MB raw est. | 1.17 MB | 50 KB |

Rule for that path: **0.25° grid, manifest-first (never 404-probe), store the
whole trail in every cell its bbox touches (+18% bytes, zero cross-tile
stitching), index OFF, versioned immutable paths.** Cloudflare Pages' 20,000-file
ceiling is the binding limit, not bytes.

---

## 5. Client-side caching rules

- **IndexedDB keyed by bbox + data version**; a tile/response is stale iff the
  manifest version changed, not by wall-clock TTL.
- Store compressed bytes; decode on read.
- Budget ~200 MB, evict by `fetchedAt`.
- **Safari wipes script-writable storage after 7 days without interaction** —
  so a cold start must work in a few hundred KB and a handful of requests. Cache
  is a speedup, never the source of truth.
- Every live failure has a visible degraded state ("trails unavailable here").
  Never a silent empty map.
