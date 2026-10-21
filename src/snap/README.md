# `src/snap` — Turrutebasen snapping engine

Pure logic for snapping a pointer to Norwegian foot trails from
[Turrutebasen](https://kartkatalog.geonorge.no/metadata/turruter/6e7b8a2f-…)
(Geonorge WFS, layer `app:Fotrute`). No UI, no DOM dependency — only the one
live WFS client and IndexedDB access, both injectable.

```
wfs.ts       GetFeature client + GML parser (the traps live here)
index.ts     uniform-grid spatial index + nearest-segment snapping + hysteresis
cache.ts     versioned IndexedDB cache (gzip), in-memory fallback
prefetch.ts  corridor/viewport → minimal bbox set; debounce, dedupe, abort
```

## Quick start

```ts
import { fetchTurruteBox } from './snap/wfs';
import { SnapIndex, SnapTracker } from './snap/index';
import { SnapCache, indexedDbBackend } from './snap/cache';
import { Prefetcher } from './snap/prefetch';

const index = new SnapIndex();
index.addLines((await fetchTurruteBox({ minLon: 8.3, minLat: 61.47, maxLon: 8.4, maxLat: 61.53 })).lines);

const tracker = new SnapTracker(index); // radius 75 m, sticky max(120 m, 1.5×radius)
const hit = tracker.snap({ lon: 8.321, lat: 61.507 });
// → { lineId, attributes, snappedPoint, distanceM, t, bearing, segmentIndex } | null

const cache = new SnapCache({ dataVersion: 'turrute-2026-10', backend: indexedDbBackend() });
const prefetcher = new Prefetcher({ index, cache });
const report = await prefetcher.prefetchViewport({ minLon: 8.2, minLat: 61.4, maxLon: 8.5, maxLat: 61.6 });
// → { requested, cached, failed, deduped, boxes, lines, aborted, failures }
```

## The WFS traps (all encoded as tests)

### 1. `outputFormat` is mandatory and literal

The only value that works is

```
application/gml+xml; version=3.2
```

with the `+` URL-encoded as `%2B` and the semicolon as `%3B`. Omitting it (or
using `GML3`, `gml`, `text/xml`, …) returns an OWS exception. `wfs.ts` always
sets it, and the test asserts the encoded form appears in the URL.

### 2. Axis order is decided by the CRS spelling

| `bbox` CRS | axis order |
| --- | --- |
| `EPSG:4326` (the one we send) | **lon,lat** |
| `urn:ogc:def:crs:EPSG::4326` | **lat,lon** |

The wrong spelling does **not** error: the server returns `HTTP 200` with
`numberMatched="unknown"` and zero features. This project sends `EPSG:4326`
with lon,lat only, and `assertLonLatBBox()` throws when a box *looks* swapped
(first axis in Norway's latitude band 55–73, second axis in the longitude band
0–35). Never build a bbox by hand — use `turruteGetFeatureUrl()`.

### 3. `cql_filter` is silently ignored

No error, no filtering, just unfiltered data. There is no server-side radius
query either: fetch the bbox and apply the distance test client-side with
`SnapIndex.snap()`. `wfs.ts` never sends `cql_filter`; a test asserts its
absence.

### 4. The response axis order is the opposite of the request order

Geometry arrives as `gml:LineString/gml:posList` with
`srsName="urn:ogc:def:crs:EPSG::4258"` (ETRS89) and **lat lon** ordinates.
`parsePosList()` resolves the order from `srsName` and rejects a list whose
“latitude” is outside ±90° (the signature of a swap). Note the spec says
`srsName` is EPSG:4326; live responses use EPSG:4258 — the parser handles both
`urn:ogc:def:crs:EPSG::4258` and `::4326`, and CRS84/lon-lat forms.

### 5. Counts lie

Live responses say `numberReturned="0"` even when members are present, and
`numberMatched="unknown"` for bbox queries. Ignore both for control flow:
`featureCount`/`lines.length` are computed by walking the document.
`resultType=hits` does work (`numberMatched` is a real number, e.g. 137 196
national total) and is available as `fetchTurruteHits()`.

### 6. Returned geometry is not clipped to the bbox

A bbox query returns whole features; coordinates can lie outside the requested
box. That is intentional (a trail that enters the viewport should be usable),
and it is why the index deduplicates by route id.

### 7. The service is slow and shared

Measured from this project (matches the feasibility spike):

| box | time |
| --- | --- |
| 1 km rural | ~176 ms |
| 10 km rural | ~669 ms |
| 10 km urban | ~6.6 s |

Therefore: cache aggressively, cap concurrency at **2** (`TurrutebasenClient`
enforces a semaphore, including abort-while-queued), and never widen a bbox
beyond what the caller asked for. A bbox request is the source of truth; the
client does not add padding.

## Snapping

- **Metric distances only.** Every distance is computed in a local
  equirectangular plane scaled at the query latitude
  (`x = Δlon·R·cos(lat)`, `y = Δlat·R`). At 61.5°N a degree of longitude is
  ~0.48 of a degree of latitude; degree-space distances would be biased by
  more than 2×. `localDistanceM()` agrees with haversine to <1 % over the
  distances that matter (verified in `index.test.ts`).
- **Uniform grid** (default 0.02° ≈ 1.1 km N–S) over lon/lat. Segments are
  inserted along their path (not their whole bbox, which would be O(n²) for
  diagonals). Lookups touch only the cells within the radius. Cell indices add
  a 1e-9-cell epsilon so boundary values such as `8.02 / 0.02 =
  400.99999999999994` do not land in the wrong cell.
- **Radius**: default 75 m (`DEFAULT_SNAP_RADIUS_M`). Nothing within the
  radius returns `null`; it never guesses.
- **Hysteresis**: pass the previous `lineId` as `currentLineId` (or use
  `SnapTracker`). The current line is kept while it is within
  `stickyRadiusM` (default `max(120 m, 1.5 × radius)` — derived, so the dock's
  20–300 m range all works; an explicit value must be ≥ the snap
  radius). This prevents flicker between parallel trails. Outside the sticky
  band the nearest line within the normal radius wins.
- `t` is the position along the matched segment (0…1); `bearing` is the
  segment's direction in degrees clockwise from north (not the direction of
  the offset from the pointer).

## Cache

- Key: `<dataVersion>:<cellId>`. **No wall-clock TTL** — staleness is
  version-based only. Bumping `dataVersion` makes every old entry unreachable
  immediately, without a migration or a sweep.
- Payload: JSON → gzip (`CompressionStream`) → backend, prefixed with a
  one-byte tag (`0` raw, `1` gzip) so the format is self-describing and still
  readable where compression is unavailable.
- Backends: `indexedDbBackend()` (falls back to memory if IndexedDB is absent,
  e.g. Node, or fails to open, e.g. Safari private mode), `memoryBackend()`,
  and any object implementing `SnapCacheBackend` (`get`/`set`/`delete`/`clear`
  over `Uint8Array`) for UI fakes.
- Corrupt or undecodable entries are treated as misses and deleted. A broken
  cache never breaks snapping.

## Prefetch

- `planCorridor(points)` puts each point in a grid cell and deduplicates:
  30 points crossing 3 cells → **3 bboxes**, not 30. `planViewport(bbox)`
  enumerates intersecting cells (coarsening first if a viewport would produce
  more than 400 cells).
- If the plan exceeds `maxRequests` (default 6), neighbouring cells are merged
  greedily (smallest resulting rectangle first) until the cap holds. The cap
  is a hard limit; the selector is bounded by the input extent.
- Runs are debounced (default 200 ms), in-flight cells are deduplicated across
  runs, concurrency is capped at 2, and starting a new prefetch aborts the
  previous one. A superseded or cancelled run resolves with `aborted: true`
  (it does not throw).
- `PrefetchReport` reports `{ requested, cached, failed }` plus
  `deduped`, `boxes`, `lines`, `aborted` and per-box `failures` so the UI can
  show a degraded-data banner instead of silently drawing an incomplete map.

## Failure behaviour

- Any HTTP/network/parse failure **throws** from `fetchTurruteBox`; an empty
  bbox is `[]`, never an error. 429/5xx/timeouts retry with exponential
  backoff; definitive 4xx do not.
- A failed cell in a prefetch run is counted in `failed` and listed in
  `failures`; the other cells still load. It is not cached (the next run
  retries it).
- `parseTurruteGml` rejects an OWS `ExceptionReport`, a non-FeatureCollection
  root, malformed posLists and axis-swapped ordinates rather than returning
  junk coordinates.

## Fixture

`test/snap/fixtures/turrute.gml` — a real unfiltered `GetFeature` response
recorded from the live service on 2026-10-19 for

```
bbox=8.30,61.47,8.40,61.53,EPSG:4326
```

34 138 bytes, **7 features** (jot15/jot16/Jot16/jot34, all maintained by
“DNT | DNT Oslo og omegn”), geometry `urn:ogc:def:crs:EPSG::4258`. It is small
enough (<200 kB) to commit and it exercises the multi-`FotruteInfo` case
(two route numbers on one feature). Attribute values that are empty in this
box (grade, season, surface) are asserted as empty — the parser preserves the
real sparsity instead of inventing values.

## Tests

```sh
npm test                     # whole suite, including the snap tests
SKIP_NETWORK=1 npm test      # offline; the snap suite is entirely offline
```

The snap tests use only the fixture and synthetic lines; they make no network
calls. Live behaviour was verified manually against the service (1 km bbox,
`resultType=hits` → 1 feature in ~180 ms).
