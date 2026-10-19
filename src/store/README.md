# `src/store` — trip persistence and file interchange

One engine, three jobs: keep trips (**IndexedDB**, with localStorage as the
fallback), write them out as GPX 1.1 or GeoJSON, and read them back without
losing the geometry.

```ts
import { createTripStorage, emptyTrip, defaultProfile } from '../store';

const store = await createTripStorage();   // IndexedDB; localStorage fallback
console.log(store.backend);                // 'indexeddb' | 'localstorage'
const trip = emptyTrip('Jotunheimen', defaultProfile());
await store.save(trip);
store.toGpx(trip);                          // ← download this
store.fromFile(text, 'route.gpx');          // ← upload this
```

`createTripStore()` (synchronous, localStorage/memory) still exists: it is the
fallback and what the tests use. `src/app/trip-session.ts` talks to `TripStoreLike`
and awaits everything, so it works with either.

Anything that goes wrong is a `StoreError` from `src/contracts`, never a bare
`Error` and never a silent no-op:

| code | when |
| --- | --- |
| `quota-exceeded` | over the 50 MB per-trip ceiling, over the 1.5 MB localStorage guard, or the browser refused the write |
| `corrupt` | a stored body / uploaded file is not a readable trip (malformed XML is `corrupt`) |
| `unsupported` | a future `schemaVersion`, a file type we do not read, or no IndexedDB at all |
| `not-found` | reserved; `load()` returns `null` instead of throwing |

---

## IndexedDB — the durable backend

Database `truhiker`, version 1, two object stores:

| store | keyPath | contents |
| --- | --- | --- |
| `bodies` | `id` | the whole `Trip`, structured-cloned — not a JSON string |
| `summaries` | `id` | `{ id, name, updatedAt, legCount, distanceM, byteSize }`, index `updatedAt` |

- `save` and `remove` open **one** `readwrite` transaction over both stores, so a
  body and its summary cannot disagree. `list()` opens a transaction over
  `summaries` **only**: a 10 MB trip is never deserialised to draw a row.
- The per-trip ceiling is `MAX_INDEXEDDB_TRIP_BYTES = 50_000_000`; the old 1.5 MB
  guard belongs to the localStorage backend alone.
- `usage()` reports `navigator.storage.estimate()`; `requestPersistence()` calls
  `navigator.storage.persist()` once.
- `migrateLegacy()` imports the `npl:trips:v1` / `npl:trip:<id>` keys in one
  transaction and deletes them **after** it commits. Idempotent, and a failure
  leaves the old copies untouched.
- `createTripStorage()` falls back to `createTripStore()` when IndexedDB is
  unavailable (private mode, blocked storage) and sets `problem` to the reason —
  the UI shows it rather than pretending.

The full reasoning, the measured numbers and what is still not durable are in
`docs/12-storage.md`.

---

## localStorage key layout (fallback + migration source)

| key | value |
| --- | --- |
| `npl:trips:v1` | JSON array of trip ids, newest first |
| `npl:trip:<id>` | one JSON object — the trip, exactly as saved |

Nothing else is ever written. `storage` is injectable: tests pass a fake, the
browser passes `localStorage`, and `createTripStore()` falls back to an in-memory
`Storage` in Node/SSR (and when `localStorage` is unreachable, as in Safari
private mode).

The body is written before the index entry, and rolled back (to the previous
version, or removed entirely if the trip is new) if the index write fails, so a
failed save never leaves a half-visible trip or destroys the version it was
replacing.

The body is stored verbatim: `save()` then `load()` deep-equals what you passed
in, including fields this build does not know about (a newer field survives a
read/write cycle untouched). `save()` does **not** touch `updatedAt` — the caller
owns that field, so the trip you saved is the trip you read back.

## Reading is defensive, writing is strict

- A corrupt index (`npl:trips:v1` is not a JSON array of strings) is rewritten to
  `[]` and `list()` returns `[]`. The app stays usable.
- A corrupt body returns `null` from `load()` and is skipped by `list()`. It is
  **not** deleted — the bytes are still there for a bug report or a newer build.
- A body from a future build (`schemaVersion` > 1) is skipped by `list()` but
  makes `load()` throw `StoreError('unsupported')`, so the UI can say *why* that
  trip will not open. It is never deleted.
- `save()` validates and refuses: missing id, broken coordinates, non-numeric
  `ele` or a trip that is too large. Nothing is ever written partially.

## Size limits

**IndexedDB:** a per-trip ceiling of **50 MB**
(`MAX_INDEXEDDB_TRIP_BYTES = 50_000_000` UTF-8 bytes of the serialised trip). That
is a sanity bound, not the old guard: the 3,000 km / 100,000-point route measured
in `test/acceptance/large-trip.test.ts` is **8.01 MB** and saves without
complaint. A trip above the ceiling is refused with a message naming its size and
the limit.

**localStorage:** `MAX_TRIP_BYTES = 1_500_000` of **UTF-8 bytes** of the
serialised JSON. localStorage holds ~5 MB per origin, and most browsers count
UTF-16 code units, so 1.5 MB of UTF-8 is roughly 3 MB of real quota — the rest
stays available for the app's other keys.

Either way a trip above the limit is **refused** with a message naming the size,
the limit and the remedy (download the GPX) — never truncated, never partially
stored, and never simplified behind the user's back.

`QuotaExceededError` is recognised by `name` (`QuotaExceededError`,
`NS_ERROR_DOM_QUOTA_REACHED`), by `code` (22 or 1014) or by message text, and is
always rethrown as `StoreError('quota-exceeded')` including the byte size that
failed to fit.

## Schema version and migration

Every body carries `schemaVersion` (currently `1`). On read it is migrated
forward through the `MIGRATIONS` map in `trip.ts`; a version newer than this build
is `StoreError('unsupported')`. A missing version is read as v1. There is no
migration to write yet — the hook exists so bumping the schema is a local change.

## `defaultProfile()` — placeholders, not assumptions

75 kg, 178 cm, 35 years, male, 12 kg pack, 20 km and 8 h per day, carrying all
food. **These are placeholders so the first screen is not empty. They are not
averages, recommendations, or assumptions about the person using the app**, and
none of them is derived from the route. Every value is editable and nothing in
the app is blocked on accepting them. A trip imported from a file gets this
profile too; the caller replaces it with the user's own.

## GPX metadata contract

`toGpx()` writes GPX 1.1, namespace-declared, escaped, and always well-formed —
every structural element is closed explicitly (no self-closing `<trkseg>`).

```
<gpx version="1.1" creator="npl-map" xmlns=… xmlns:xsi=… xmlns:npl="urn:npl-map:gpx:1" …>
  <metadata>
    <name>          trip name, XML-escaped
    <desc>          multi-line, see below
    <copyright>     only when provenance mentions Kartverket / Turrutebasen
      <license>     the licence strings found in the provenance
    <time>          trip.updatedAt
  <trk>             one per leg
    <name>          leg name (or "Leg N")
    <desc>          "kind=… label=… url=… licence=… fetchedAt=… modified=true"
    <extensions>
      <npl:eleSource>  dem | gpx | none, when the whole leg agrees
      <npl:legId>      the leg id
    <trkseg>
      <trkpt lat="…" lon="…">
        <ele>       only when the elevation is known — never 0 for unknown
```

`<metadata><desc>` always carries:

1. `schemaVersion N` and the trip id;
2. the elevation source of the whole file (`dem` = Kartverket DTM, bare earth,
   from hoydedata.no; `gpx` = the upload's own elevations, kept as-is; `none` =
   unknown);
3. `©Kartverket` / `Turrutebasen` attribution **when the provenance mentions
   them**, with the licence strings we were given and an explicit
   "modified by npl-map" note — CC BY 4.0 requires that statement. When the
   provenance does not mention them, no attribution is invented;
4. one line per leg with its id, name, provenance and elevation source.

`toGpx(trip, { legIds, includeElevation })` can export a subset of legs, or drop
elevations for a receiver that does not want them. Dropping them is explicit, not
a fallback.

## Round-trip guarantee

`fromFile(toGpx(trip))` returns the same geometry:

- **distance within 1 m** — coordinates are written with 7 decimals (~1.1 cm);
- **the elevation array exactly** — elevation is written with 1 decimal (10 cm,
  the finest precision any of our sources has). A source value with more than one
  decimal is rounded on export; feed it 1-decimal elevations and the round trip
  is bit-exact;
- **the elevation source survives** — via `<npl:eleSource>`, so a DEM trip does
  not come back mislabelled as "elevations from the uploaded file";
- **leg ids and names survive** — via `<npl:legId>` and `<trk><name>`.

Measured on the 50-point synthetic route in `test/store/helpers.ts`
(12,551.5 m, one leg, every point with a DEM elevation):
**the export is 5,703 bytes of GPX** (≈ 88 bytes per point). GeoJSON for the same
trip is 5,246 bytes; the stored JSON body is 4,518 bytes.

That extrapolates to ~90 bytes per point, and the measured 3,000 km acceptance
trip (100,000 points, two legs, elevation and provenance on every point) is
**8.01 MB of JSON**. The old comment here claimed a 1.5 MB trip would be "on the
order of 17,000 points — far beyond any walk anyone plans"; that was wrong, and a
100,000-point long-distance route is precisely the case that made localStorage
unusable. It is also why the per-trip ceiling is now 50 MB on IndexedDB.

## Import

| extension | behaviour |
| --- | --- |
| `.gpx` | GPX 1.0/1.1 via `src/core/gpx.ts`. **Every track becomes a leg** (tracks are never merged); when a file has no tracks, its `<rte>` routes are used. Track names, our `<npl:legId>` and `<npl:eleSource>` extensions are recovered. |
| `.geojson`, `.json` | `LineString`, `MultiLineString`, `Feature`, bare geometry or `FeatureCollection`. A `MultiLineString` becomes one leg per line. `properties.legId`, `.name` and `.provenance` are restored. |
| anything else | `StoreError('unsupported')`. There is no sniffing: the extension decides. |

Malformed content of a *supported* type is `StoreError('corrupt')` — including
malformed XML, which is deliberately `corrupt` and not `unsupported`: the file
type is one we read, the file is broken. A file with no line of at least two
points is also `corrupt`, because a leg with fewer than two points must not exist.

Points without `<ele>` import as `ele: undefined` with `eleSource: 'none'` — an
unknown stays unknown. `ascentM`/`descentM` are `null` unless at least one
consecutive pair of points has elevation on both ends.

## Known compromises

- **Elevation precision is 1 decimal.** Preserving more would inflate the file
  for precision no source has. A trip whose elevations carry more decimals loses
  them on export (and therefore on re-import).
- **`eleSource` is per leg in the GPX, not per point.** A leg with mixed sources
  writes no `<npl:eleSource>`; the per-point array is not encoded in the GPX
  (GeoJSON keeps the per-leg list in `properties.elevationSources`).
- **An imported trip always gets `defaultProfile()`.** `fromFile(text, filename)`
  has no profile parameter in the fixed contract, so the caller must replace it.
- **A trip with no legs exports to a GPX that cannot be re-imported** (a GPX with
  no track is rejected as `corrupt`). An empty trip is not something to download;
  the app should disable the button rather than rely on this.
- **`list()` on localStorage reads and parses every body** to build summaries.
  At tens of trips that is nothing; that is one of the reasons IndexedDB — where
  summaries are their own store — is the default backend.
- **The metadata reader in `serialize.ts` is a small, local XML reader**, not a
  general GPX parser — `src/core/gpx.ts` does the real work. It only recovers the
  `<metadata><name>` and `<extensions>` elements this module writes, and it never
  throws: missing metadata simply means an unnamed trip.
