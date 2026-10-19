# Snapping, the route graph, and where DEM fits

*Design for the "production grade" requirement. Numbers marked MEASURED were
taken in this sandbox.*

> **§2 of this document is superseded by [`docs/04-data-delivery.md`](04-data-delivery.md).**
> The project direction is now **live-first**: trails are fetched from Kartverket's
> WFS on demand, and almost nothing is bundled. §3–§5 (snapping algorithm, graph,
> DEM usage) still stand.

---

## 0. The scope decision, stated up front

There are two different features people call "snapping", and they cost very
different amounts of money:

| Feature | What it does | Needs a graph? | Cost |
| --- | --- | --- | --- |
| **A. Snap-to-trail** | A click/drag lands **on** the nearest real trail geometry; the route then follows that trail's polyline | **No** | Low. The geometry is already shipped for display. |
| **B. Route-along-trails** | Two points are connected by a **path through the network**, chosen by a cost function | **Yes** — noding, connectivity, A*, border stitching | High. This is a real routing engine. |

**Recommendation: build A to production grade first; treat B as a phase 2 that
degrades gracefully into A.** A is what makes drawing feel right, and it is
honest — it never invents a connection that does not exist. B is what makes the
app occasionally *lie* (silently confident paths through private land or across a
ford), which is the failure mode this project has decided to avoid.

The graph is still built in phase 1 — because A needs it the moment a user draws
a route that jumps between two trails — but A **fails visibly** (dashed "off-trail
— verify") where B would invent a bridge.

---

## 1. What we actually have to work with

### Turrutebasen (Kartverket) — CC BY 4.0

| Metric | MEASURED |
| --- | --- |
| Bulk GPX (national, zipped) | **141.2 MB** |
| Uncompressed | **657.4 MB**, a single GPX file |
| Routes | 47,706 total |
| — `Fotrute` (foot) | **36,288 routes, 8,430,997 points** |
| — `Skiløype` | 7,998 / 717,010 pts |
| — `Sykkelrute` | 1,884 / 1,401,102 pts |
| — `AnnenRute` | 1,536 / 112,279 pts |
| — `RuteInfoPunkt` | 9,744 waypoints |
| Geometry density | median 82 pts/route ⇒ ~25–30 m spacing |
| Binary footprint (foot only) | ~67 MB raw float32, ~34 MB delta-int32, **~15–20 MB brotli (estimate)** |

**Critical gotcha, MEASURED:** the bulk GPX carries **only** `name` (which is a
localId like `F_20180315_1`, *not* the human name), `cmt`, `desc`, `src`, `type`.
It does **not** carry `gradering`, `merking`, `vedlikeholdsansvarlig`, `sesong` or
`onderlagstype`. Those exist **only in the WFS**. So the build must join:
geometry from the bulk file, attributes from the WFS (or a GML/FGDB bulk format).

It also contains **Swedish** routes (`cmt: "Data fra Sverige"`), so the build must
filter to Norway.

Also note a discrepancy to resolve before shipping: the WFS reports **137,196**
`app:Fotrute`, the GPX contains **36,288**. Both cannot be right; the difference
is probably segmentation or versioning. Settle it before claiming completeness.

### OSM — ODbL

To be filled from the measurement run (node/way counts, walkable-set size, tile
balance). Anchor for comparison: BRouter's Norwegian `.rd5` tiles total **~334 MB**
for its full car+bike+foot graph.

### Attributes that decide snapping quality

| Source | Field | Use |
| --- | --- | --- |
| Turrutebasen | `gradering` G/B/R | surface difficulty |
| Turrutebasen | `merking` JA/NEI | **is it marked on the ground?** → a strong trust signal |
| Turrutebasen | `ruteFølger` (ST=sti, traktorveg, skogsbilveg…) | quality |
| Turrutebasen | `underlagstype` | surface → terrain factor |
| Turrutebasen | `sesong` S/V/H | seasonal closure |
| Turrutebasen | `oppdateringsdato` | **staleness — must be shown** |
| OSM | `highway`, `sac_scale`, `trail_visibility`, `surface`, `access` | difficulty/legality |
| OSM | `ford=yes` | **hazard flag** |
| OSM | `informal=yes` | not an official trail |

---

## 2. Where the geometry comes from — and what we actually publish

**Correction to an earlier draft.** It proposed a prebuilt national FlatGeobuf on
R2. The right answer is a split, and it is decided by licensing, not by taste.

The legal distinction that matters is **distribution**, not computation:

| What happens | Consequence |
| --- | --- |
| We ship a file of **OSM-derived** polylines | That file **is** a Derivative Database being distributed → **ODbL applies** (attribution + share-alike + offer the file) |
| The user's browser fetches OSM and builds a graph in memory | **Nothing is distributed by us.** The user is *Using*, not *Publicly Using*. |
| We ship a file of **Turrutebasen** polylines | **CC BY 4.0 — no share-alike.** Attribution only. |
| We display a route on a map | Produced Work → attribution only |

So: **a graph built on demand in the browser and never transferred triggers no
obligation.** But the *geometry file itself* is distributed the moment we ship it
— and that is true whoever derived it.

### The split that falls out

| Layer | Transport | Licence | Why |
| --- | --- | --- | --- |
| **Turrutebasen trails (primary)** | **Shipped bundle** | CC BY 4.0 | No share-alike ⇒ we may bundle freely, and bundling is what makes snapping instant |
| **OSM paths (supplement)** | **Live only** (Overpass, per-user) | ODbL | Covers informal paths Turrutebasen lacks. Never redistributed ⇒ no share-alike arises |
| Shops / fuel / post | Live only (Overpass) | ODbL | Same reasoning |
| Huts, food, prices | Shipped | Ours | Not derived from anyone |

This is the answer to "do we need to publish the graph?" — **no, we never publish
a graph.** We publish a CC BY trail layer and our own curation; every ODbL input
is fetched by the browser and never redistributed.

### Measured behaviour of the live path

| Query | Result |
| --- | --- |
| WFS 20 km bbox at Jotunheimen, GML | **1.08 MB, 4.3 s** |
| WFS 2 km bbox | ~10 KB, 0.2 s (that box happened to contain no trails) |
| Overpass shops query, 20 km radius | 0.3 s |
| Coverage check | **120 `Fotrute` features in the Jotunheimen box** — Turrutebasen **does** cover national-park trails |

Two practical facts learned the hard way:
- **The bbox axis order is `lon,lat` (x,y) even for `EPSG:4326`.** Sending
  `lat,lon` silently returns zero features — no error. This cost an hour and is
  now a test case.
- Requests need `outputFormat`; `application/json` is rejected; attributes live in
  the nested `fotruteInfo` group (`rutenavn` is often literally `Ukjent`, but
  `rutenummer` like `jot27` and `vedlikeholdsansvarlig: DNT` are present).

At 4.3 s / 1 MB per 20 km box, live-only is *possible* but not production-grade
for interactive snapping. That is precisely why Turrutebasen is bundled and only
OSM stays live.

### Bundle format (for the Turrutebasen layer only)

| Option | Verdict |
| --- | --- |
| **FlatGeobuf on R2** (packed Hilbert R-tree, Range queries) | ✅ Best. The JS reader does bbox queries over HTTP Range. R2 serves 206; **Pages does not** (it returns 200 and the reader breaks — the same trap as PMTiles). |
| Per-fylke bundles (15 files) on Pages | ✅ Fine fallback — small enough to fetch whole, no R2 dependency |
| Per-0.25° tile files | ⚠️ ~5,700 files, and cross-tile trails need stitching |

Format note: store geometry in **EPSG:4326** (interoperable) but compute snapping
distances in a **local metric projection** — snapping in raw degrees is biased at
high latitude, which in Norway is most of the country.

---

## 3. The snapping algorithm (feature A)

```
on pointer move / click:
  1. candidate query: fgb.search(minX,minY,maxX,maxY)  ← bbox = R around cursor
  2. for each candidate line, for each segment:
        d = point-to-segment distance (projected, metres)
        keep the minimum, with its projection parameter t
  3. accept if d ≤ R (default 75 m; "sticky" R of 120 m while already snapped)
  4. hysteresis: once snapped to a polyline, stay on it until the user
     clearly leaves (> 1.5 R) — prevents flicker between two parallel paths
  5. reject the snap if:
        - |Δelevation| to the snapped point > 60 m AND the approach grade > 45 %
        - the connecting chord crosses a water polygon (N50) or a fenced barrier
        - the candidate is `access=private` / `season` incompatible with the trip date
  6. otherwise: dashed straight segment, labelled "off-trail — verify"
```

Why this is production-grade rather than a toy:
- It **never silently invents geometry** — every output vertex is either on a
  mapped line or on a visibly dashed segment.
- It carries the **attributes of the line it snapped to** (grading, marking,
  maintainer, staleness) into the UI, so the user sees *what they are walking on*.
- The rejection rules use DEM and N50, which is exactly where "consider DEM data"
  pays off (see §5).

No Dijkstra is needed for A. Following a polyline is array slicing from the
projection parameter — ~200 lines plus the index.

---

## 4. The route graph (feature B)

### Build (Node, at build time — no GDAL needed)

1. **Extract** Turrutebasen foot geometry + WFS attributes; OSM walkable ways
   (`path, footway, track, bridleway, steps`, plus `route=hiking` relations).
2. **Node the network:**
   - OSM: connectivity comes free from shared node IDs.
   - Turrutebasen: no shared IDs → **geometric noding**: split at shared
     coordinates within ~1 m, and at crossings.
   - Cross-source: snap Turrutebasen endpoints onto OSM ways within ~15 m, and
     mark the join explicitly (`snapped: 15m`) rather than pretending it is real.
3. **Simplify** to ~10 m tolerance for routing (keep full geometry for display).
4. **Cost** per edge from surface + grade + marking, e.g.
   `cost = length × terrainFactor(surface) × gradeFactor(grade)` — so "shortest",
   "easiest" and "fastest" are genuinely different paths.
5. **Tile** on a 0.1–0.25° grid with duplicated border nodes; emit one FlatGeobuf
   + one CSparse-ish adjacency blob per tile.
6. **Validate**: every edge has a cost; no isolated components above a size
   threshold; report the count of connected components (Norway's trail network is
   genuinely fragmented — ferries and fjords do that).

### Runtime

- Load the tiles intersecting the drawn corridor.
- **A\*** with a binary heap in a Web Worker, haversine heuristic.
- Budgeted: if the search exceeds N nodes, return the best partial path **and say
  so** ("gave up after 250k nodes — the trail network may be disconnected here").

### Honest limits

The Norwegian network is fragmented by fjords, ferries and genuinely pathless
areas (Børgefjell, Sulitjelma→Narvik). The graph will **fail to connect** there,
and that is correct behaviour. The UI must show "no continuous trail between these
points — draw a straight segment to continue".

---

## 5. Where DEM earns its place

DEM is not decoration in this design; it is what makes snapping defensible.

| Use | How |
| --- | --- |
| **Profile & ascent** | `hoydedata.no` ImageServer `exportImage` (float32 GeoTIFF, CORS, 128 px tiled). Validated to **1.2 m on Galdhøpiggen**. Sample per *window*, never per point. |
| **Reject absurd snaps** | A trail 200 m above the click point is almost certainly a different line; a chord with >45 % mean grade is a cliff. |
| **Grade per edge** | Needed for time/cost estimation and for the "is this realistic in a day" answer. |
| **Slope relief / steepness shading** | A coarse derived slope raster is genuinely useful for route planning (and cheap). |
| **Lake/river crossing detection** | N50 water polygons + `ford=yes`; combine with the DEM to spot where a straight line cuts a canyon. |
| **3D terrain** | Mapterhorn terrarium (Kartverket-derived) or self-hosted PMTiles. |

**Do not** pre-sample elevation for 8.4 M vertices at build time — that is a
huge job for a number you only need for the ~5,000 points actually drawn. Sample
on demand, cache by bbox, and store the elevation **in the route**, so the profile
is reproducible even if the service is down.

**Failure must be loud.** If `hoydedata` is unavailable: draw the route, show the
profile as unavailable, and **block the calorie/resupply numbers** rather than
silently computing them from zero elevation. Silent zeros are how this app could
actually hurt someone.

---

## 6. What "production grade" means here, concretely

1. **Everything heavy runs in a Web Worker** — GPX parsing, DEM fetch/decode,
   snapping, A*. The main thread only renders.
2. **Versioned, dated data.** Every layer records `built_at` and its source
   snapshot date. The UI shows it.
3. **Degradation ladder**, explicitly implemented:
   R2 down → per-fylke fallback → geometry only, no snapping.
   Kartverket DEM down → no profile, **numbers disabled**.
   Tiles down → blank map handled as an error state, not a white map.
4. **No silent fallbacks.** Every degraded state is visible in the UI.
5. **Tests against real data**: Galdhøpiggen = 2469 ± 5 m; a known trail's ascent
   within ~10 % of its published figure; snapping a known point returns the known
   trail.
6. **Deterministic build**: pinned source snapshots ⇒ byte-identical output, so a
   bug is reproducible. (Applies to the optional bundles; the live path is
   inherently non-deterministic, so the UI shows the fetch date.)
7. **The graph is disposable.** It lives in memory for the session, keyed by
   bbox. Losing it costs one refetch, never data — which is also why nothing we
   build has to be published.
