# `tools/` — resupply POI extractor

Two self-contained scripts, no npm dependencies (Node ≥ 22 only):

| File | What it does |
| --- | --- |
| `build-shops.mjs` | Two-pass streaming extractor for a Geofabrik Norway `.osm.pbf`; writes `data/shops.osm.bin`, `data/shops.osm.meta.json`, `data/MEASUREMENTS.md` |
| `inspect-shops.mjs` | Decodes the binary: `--stats`, `--verify`, `--near LAT,LON`, or name/brand substring queries |

`build-shops.mjs` includes its own minimal PBF reader (zlib blobs, dense nodes,
ways) — it never loads the whole file and caps at ~10 k tagged objects in memory.

## Rebuild

```sh
curl -L -o /tmp/norway-latest.osm.pbf \
  https://download.geofabrik.de/europe/norway-latest.osm.pbf

node --max-old-space-size=1400 tools/build-shops.mjs \
  --pbf /tmp/norway-latest.osm.pbf \
  --out data \
  --source-date 2026-10-18

node tools/inspect-shops.mjs data/shops.osm.bin --verify
rm /tmp/norway-latest.osm.pbf
```

## Tag filter

Keep an object if it has any of:

- `shop=supermarket|convenience|general|grocery`
- `amenity=fuel|post_office|parcel_locker`

Exclude if it has `tourism=alpine_hut`, `tourism=wilderness_hut` or
`amenity=shelter` (huts come from a live source; shelters are not resupply).

If an object matches several tags it is stored **once**, under the first match in
this priority order: `supermarket > general > grocery > fuel > convenience >
post_office > parcel_locker`. A petrol station with a convenience kiosk is
therefore `fuel`; a supermarket with a fuel pump stays `supermarket`.

Ways are reduced to a **centre**: the arithmetic mean of the resolved
coordinates of their member nodes (not a polygon area centroid). The metadata
records how many POIs came from nodes vs ways.

### Duplicate collapsing and same-site hints

After extraction, records of the **same primary type** within **50 m** of each
other are collapsed into one (union-find, so a chain A–B–C collapses even if
A–C is 80 m apart). Records with **different non-empty brands** are never
merged, even within 50 m: an Esso and an Uno-X across the road are two stations,
not a duplicate. An unbranded duplicate can join either. The survivor is chosen
by:

1. it has a name;
2. it has more of `brand`, `opening_hours`, `phone`;
3. deterministic tie-break (first in the lat/lon sort).

The survivor keeps its own coordinates and fields. **Different types are never
merged**, because a post office inside a supermarket is legitimately two
records. Instead, a `post_office` within 50 m of a `supermarket` gets the
**same-site hint** (flag `0x20`) — useful for the resupply planner, without
double-counting the site. `data/shops.osm.meta.json` records the per-type
collapse counts and up to ten examples.

## `shops.osm.bin` — byte layout

All multi-byte integers are **little-endian**. Varints are unsigned LEB128.
Deltas are two's-complement **zigzag**-encoded before varint encoding
(`n >= 0 → 2n`, `n < 0 → -2n - 1`).

### Header

| Offset | Size | Field | Value |
| ---: | ---: | --- | --- |
| 0 | 8 | magic | ASCII `NPLSHP01` |
| 8 | 4 | `count` | `uint32` number of POI records |

### POI records — `count` of them, immediately after the header

Records are sorted by **latitude ascending, then longitude ascending**. This is
what makes the deltas small and lets a consumer binary-search or stream
north-to-south.

| Size | Field | Encoding |
| ---: | --- | --- |
| 1–5 | `latDelta` | zigzag varint, **int32 microdegrees** relative to the previous record's latitude (first record: relative to 0) |
| 1–5 | `lonDelta` | zigzag varint, **int32 microdegrees** relative to the previous record's longitude (first record: relative to 0) |
| 1 | `type` | see type table |
| 1 | `flags` | see flags table |
| 1–5 | `brandIdx` | varint; 0 = no brand, otherwise 1-based index into the string table |
| 1–5 | `nameIdx` | varint; 0 = no stored name, otherwise 1-based index into the string table |

Coordinates are integer microdegrees: `lat = 59_123_456` → 59.123456°. A record
is 6 bytes minimum, typically 8–12.

Type byte:

| Value | Type |
| ---: | --- |
| 0 | `shop=supermarket` |
| 1 | `shop=convenience` |
| 2 | `shop=general` |
| 3 | `shop=grocery` |
| 4 | `amenity=fuel` |
| 5 | `amenity=post_office` |
| 6 | `amenity=parcel_locker` |

Flags byte (bits 4–7 reserved, zero):

| Bit | Mask | Meaning |
| ---: | ---: | --- |
| 0 | `0x01` | `opening_hours` was present in OSM (the value itself is **not** stored) |
| 1 | `0x02` | `phone` was present in OSM (value not stored) |
| 2 | `0x04` | fuel station looks **unmanned** (heuristic in `build-shops.mjs`) |
| 3 | `0x08` | name is identical to the brand, so the name string was omitted — display the brand |
| 4 | `0x10` | stored name string is a **suffix** of the brand: display `brand + suffix` |
| 5 | `0x20` | **same site** hint: this `post_office` is within 50 m of a supermarket |

Display rule, in order:

1. `0x10` set → `brand + storedName` (exact reconstruction, including any leading space)
2. `0x08` set → `brand`
3. otherwise → `storedName` (may be absent)
4. fallback → `'(unnamed)'`

Display rule: `name ?? (flags & 0x08 ? brand : null) ?? '(unnamed)'`.

### String table — after the last record

| Size | Field |
| ---: | --- |
| 4 | `stringCount` (`uint32`) |
| … | `stringCount` entries: varint `byteLength`, then `byteLength` bytes of UTF-8 |

The table is **deduplicated** and sorted lexicographically (so indices are
stable and nearby records tend to share indices). It holds:

- every distinct `brand`;
- only the **necessary** part of each `name`:
  - name identical to the brand → omitted, flagged `0x08` (display the brand);
  - name starting with the brand (case-sensitive, e.g. `Joker Dalsbygda`) → only
    the suffix (` Dalsbygda`) is stored, flagged `0x10`; display is
    `brand + suffix`, which is byte-identical to the original name;
  - otherwise → the full name is stored.

This is what collapses most chain names to a brand index: 6,217 of 8,299 names
were brand-prefixed and are stored as short suffixes. A name is kept in full
whenever dropping or trimming it would lose information.

`opening_hours` and `phone` are recorded only as presence bits, not as strings:
they are the fields most likely to go stale, so the planner treats them as
"call to confirm" rather than as facts to render.

A variant with **no name strings** (brands only, all `nameIdx=0`) is built in
memory during the build solely to measure what names cost; it is not written to
disk. See `data/MEASUREMENTS.md` §3.

## Measuring

Sizes are measured on the exact output bytes with Node's `zlib`:

- gzip — `level: 9`
- brotli — `quality: 11`, `lgwin: 22`, generic mode

No estimate is recorded in `MEASUREMENTS.md`; every number there is produced by
the build.

## Licence

The output binary is a **Derivative Database** of OpenStreetMap data, offered
under **ODbL 1.0**. © OpenStreetMap contributors.
See `data/shops.osm.LICENSE` and `LICENSES/ODbL-1.0.txt`.
