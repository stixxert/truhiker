# `src/resupply` — where you can resupply, and what you carry between

The resupply engine: a bundled shop index, a live hut client, a metric corridor
query, and a leg-by-leg plan. Pure TypeScript, no UI, no storage, no DOM. The
only I/O is two injectable `fetch` clients.

```
corridor.ts   RouteCorridor — metric projection of a point onto a polyline
shopIndex.ts  data/shops.osm.bin (ODbL) → parse, corridor query, near query
huts.ts       Turrutebasen app:RuteInfoPunkt (CC BY 4.0 ©Kartverket) → huts
plan.ts       candidates + Trip → src/plan/resupply.ts + src/plan/energy.ts
index.ts      types + re-exports (the public surface)
```

`src/plan/resupply.ts` and `src/plan/energy.ts` are **wrapped, not duplicated**:
leg/gap arithmetic, `maxCarryDays`, the mail-drop scheduler, kcal/day
(`estimateDay().tdee`) and food mass (`nutrition.foodWeightFor`) all come from
those modules. If a number here disagrees with them, this module is wrong.

## Quick start

```ts
import { loadShopIndex, fetchHutsAlong, planResupplyForTrip } from './resupply';

const index = await loadShopIndex(fetch);          // /data/shops.osm.bin, 8,571 POIs
const shops = index.alongRoute(route, 2000);       // 2 km corridor, route order
const huts = await fetchHutsAlong(route, { radiusM: 5000 });

const plan = planResupplyForTrip(trip, [...shops, ...huts]);
// → { legs, warnings, totalFoodKg, totalCostNok, kcalPerDay, kcalRange, gap, … }

planResupplyForTrip(trip, [...shops, ...huts], { hutsSellFood: true }); // explicit
```

## 1. The binary format (`data/shops.osm.bin`)

Specified in `tools/README.md` and produced by `tools/build-shops.mjs`; the
layout below is a summary, not a second specification.

```
header   'NPLSHP01' (8 bytes) | count uint32 LE (4)
records  count × { latDelta zigzag-varint, lonDelta zigzag-varint,   ← int32 microdegrees
                   type u8, flags u8,                                  ← see tables
                   brandIdx varint, nameIdx varint }                   ← 1-based, 0 = absent
strings  stringCount uint32 LE | stringCount × { byteLength varint, UTF-8 bytes }
```

- Records are sorted by latitude, then longitude, and delta-encoded against the
  previous record, which is what makes the file 174,912 bytes.
- Coordinates are **integer microdegrees** (`59_123_456` → 59.123456°).
- The string table is deduplicated and sorted. A name equal to the brand is
  flagged (`0x08`), and a name starting with the brand is stored as the suffix
  only (`0x10`), so `brand + storedName` reconstructs it byte-for-byte.
- Type bytes: `0 supermarket, 1 convenience, 2 general, 3 grocery, 4 fuel,
  5 post_office, 6 parcel_locker`. `post_office`/`parcel_locker` become the
  candidate kinds `post`/`parcel`; `general`/`grocery` stay distinct here and
  are folded into the plan model's `supermarket` (it has no separate food-shop
  kinds — they are all `isFoodSource()`).
- Flags: `0x01` opening_hours present, `0x02` phone present, `0x04` fuel looks
  unmanned, `0x08` name == brand, `0x10` name is a brand suffix, `0x20`
  post-office-in-supermarket same-site hint (parsed but not used yet: the plan
  model has no same-site field, so a post office inside a supermarket is two
  stops, not one).

`parseShopIndex(buffer)` is **pure** — no network, no clock — so tests read the
built file from disk. `loadShopIndex(fetchImpl)` is the only fetch, and it asks
for two files: `/data/shops.osm.bin` and the `/data/shops.osm.json` beside it that
dates it. The artefact is a build output (D24): `tools/ensure-data.mjs` produces
or verifies it before every build.

Failures are typed, not generic: `ShopIndexFormatError.reason` is one of
`bad-magic`, `bad-version`, `truncated`, `bad-record`, `trailing-bytes`. A magic
of `NPLSHP02` reports `bad-version` rather than being treated as a foreign file,
because a silent reinterpretation of a changed record layout would be worse than
failing.

Measured on the built file: **8,571 points, 174,912 bytes, parse ≈ 6–9 ms**
(Node 22, cold; the first call includes the `TextDecoder` warm-up).

## 2. The corridor maths

`alongRoute(points, radiusM)` returns every POI within `radiusM` of the polyline
with two metric numbers:

- `alongRouteM` — distance from the start of the polyline to the projection of
  the POI, from cumulative **haversine** segment lengths;
- `detourM` — perpendicular distance to that projection.

Nothing is compared in degrees. Each segment is projected with a local
equirectangular scale (111,132 m/deg latitude, 111,320·cos(lat) m/deg longitude)
and the point is clamped to the segment's `[0, 1]` parameter range. This is the
same approximation as `projectOntoRoute()` in `src/plan/resupply.ts`, and
`test/resupply/shops.test.ts` asserts the two agree; it is duplicated here only
because that function tests every segment for every point (43 M segment tests for
a 5,000-point route and the full index), while `RouteCorridor` indexes segments
by 0.05° latitude band and tests only what can be within the radius. Composite
segments spanning more than four bands, and radii above 100 km, fall back to a
full scan — still exact, just slower.

Two further rules:

- **Sorting** is by `alongRouteM`, then detour, then name, so successive shops
  are a leg order, not an alphabetical one.
- **Deduplication**: a point that appears twice (a route that passes the same
  shop on the way out and back) yields one candidate, at the first passage. Two
  rows for one building are noise; the second passage is not a resupply.

Measured: 8,571 POIs against a 5,000-point route at a 2 km radius → ~27 ms cold,
~8 ms warm, 56 hits.

## 3. Huts: live, curated, and not a food source

`fetchHutsAlong(route, { radiusM })` queries the same Geonorge WFS as snapping,
for `app:RuteInfoPunkt` (the waypoint layer — 9,744 points nationally). The traps
are the same, so the guards are imported from `src/snap/wfs.ts` rather than
retyped:

1. **`outputFormat` is mandatory** (`application/gml+xml; version=3.2`); without
   it the service returns an OWS exception.
2. **The bbox is lon,lat**, spelled `EPSG:4326`. The `urn:ogc:def:crs:EPSG::4326`
   spelling flips the axes and returns **zero features with HTTP 200 and no
   error** — the worst failure mode there is. The URL builder asserts the order
   (`assertLonLatBBox`) and a test asserts the first bbox component is a
   longitude.
3. `cql_filter` is silently ignored, so there is no server-side radius: one bbox
   request for the padded route extent, then a client-side projection against the
   polyline.
4. The response geometry is `urn:ogc:def:crs:EPSG::4258`, i.e. **lat,lon** — the
   opposite of the request. `parsePosList` applies the axis order from `srsName`
   and throws if a value could only come from swapped axes.

Each hut becomes `kind: 'hut'`, `evidence: 'curated'` (Kartverket's curated data,
not OSM), and **no `openingHours`** — the service carries none, and an unknown hut
is not "always open". `app:opphav` is the name; `app:vedlikeholdsansvarlig`
(maintainer) and `app:tilrettelegging` (facility code, e.g. `42` at Fondsbu) are
parsed by `parseHutGml` and kept **opaque**. The codelist was never decoded
(`docs/DECISIONS.md` D1), so the code is never interpreted as
betjent/selvbetjent/ubetjent.

**The evidence rule.** A hut is a *location*, not a *shop*. No food is asserted,
so a hut closes no gap by default: `planResupplyForTrip` excludes it from the
plan and says so in `warnings`. A caller may assert otherwise with
`{ hutsSellFood: true }`, and the plan then reports that the food is at the
caller's request and unverified — the assertion is the user's, never ours.

## 4. The plan

```ts
const plan = planResupplyForTrip(trip, candidates, {
  maxCarryDays: 7,     // default; a longer leg sets carryDanger
  detourPenaltyM: 2000, // warn above this; never filter (a dropped shop is a
                        // food gap nobody sees)
  hutsSellFood: false,  // the honest default
});
```

kcal/day is `estimateDay(...).tdee` for the trip's own body profile and daily
distance (terrain `trail`), never a hard-coded 4,000; `kcalPerDay` and the honest
`kcalRange` (`×0.75 … ×1.30`) are both returned. Food mass and cost come from the
plan engine and the food-mix table, so the default mix resolves to ≈4.38 kcal/g —
the "4.4 kcal/g" planning figure.

The first leg starts at the route start and the last ends at the route end, so
carrying food *to* the first shop is part of the plan. `carryDanger` is
`days > maxCarryDays`, and the warning names the kilograms.

A trip whose legs do not meet is bridged by a straight line — the plan engine
takes one polyline — and the bridged length is reported in `warnings` rather than
counted silently.

Warnings are **aggregated, not repeated per point** — a city route has hundreds
of shops and a per-point list buries the four warnings that matter. Codes
`verify-hours`, `unverified`, `hut-unknown-no-food`, `fuel-no-shop` and
`post-not-food` are folded into one sentence each; leg warnings appear both on
the leg and in `plan.warnings`.

## 5. What is deliberately unknown

| Question | Our answer |
| --- | --- |
| Is a shop **open**? | Unknown. `openingHours` is never set from the binary — the value is not stored. `hasVerifiedHours()` is `false` for every bundled point, and the plan says so once. |
| Does a **hut** sell food? | Unknown, and therefore **no**. Opt in explicitly and the plan flags the assumption. |
| Is a **fuel station** staffed? | Unknown. `0x04` is the extractor's heuristic; an unmanned station counts for nothing, a staffed one is an assumption the plan names. Food there is convenience-grade. |
| Is a point's **position** right? | As good as OSM. Way-derived POIs are a mean of member nodes, not a building centroid. |
| Is the **index current**? | `builtAt` is the served file's own date: `loadShopIndex` takes `source.extractDate` (or `buildDate`) from `data/shops.osm.json`, so a refreshed deployment reports the extract it actually ships. Falling back to the committed build date only when that file cannot be read. The binary itself stores no timestamp. |
| Which **chain** is it? | Unknown as a fact: `evidence` is `'osm'` for everything bundled. `'chain-verified'` exists in the type but no chain store-locator join exists, so it is never produced. |
| **Whether the detour is walkable** | Unknown. Points beyond `detourPenaltyM` are flagged, and the extra walking distance is stated but not added to the plan. |
| **Whether two legs connect** | Only that they do, if `alongRouteM` says so. Non-adjacent legs are bridged by a straight line and the bridged length is warned about. |

Deliberately out of scope: weather, pricing, stock, opening hours text, and any
notion of a shop being "probably open".

## Tests

`test/resupply/` — 7 cases, all offline:

- `shops.test.ts` — parse the built binary (8,571 points, per-kind counts, a
  known shop, name reconstruction), corridor query (known shop, radius exclusion,
  out-and-back dedupe, agreement with `projectOntoRoute`), loader + typed errors.
- `huts.test.ts` — lon,lat bbox and `outputFormat` in the URL, radius filtering,
  lat,lon geometry reading, curated evidence and no hours, opaque facility code.
- `plan.test.ts` — a 110 km gap warns with the required kg within 5 % of
  `days × kcal/day ÷ 4.4`; a hut closes no gap unless opted in; unmanned fuel
  counts for nothing while staffed fuel is an assumption.
