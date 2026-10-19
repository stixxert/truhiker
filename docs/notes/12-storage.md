# Storage — IndexedDB, and what is still not durable

*Replaces the localStorage-only storage documented in `docs/09` §3. Read
`docs/08-corrections.md` first: the numbers below are measured, and the claims
that are not measured say so.*

---

## 0. Why this changed

`docs/09` §3 specified localStorage plus a **1.5 MB per-trip guard**, justified by
"a 3,000 km trace is 5–10 MB of JSON". The guard was honest about the limit but
wrong about the consequence: it made the very trip the plan is about
**unsavable**. localStorage holds ~5 MB per origin, so the ceiling was not the
problem to design around — it was the reason to move.

Measured, on the synthetic 3,000 km acceptance route (`test/acceptance/large-trip.test.ts`):
100 000 points, two legs, elevation and provenance on every point — **8.01 MB**.
That is 1.6× the whole localStorage quota, and 5.3× the old guard.

IndexedDB has no comparable per-trip ceiling, stores structured clones instead of
strings, and can be made persistent. It is now the durable store.

---

## 1. Schema

Database **`truhiker`**, version **1**, two object stores.

| store | keyPath | row | index |
| --- | --- | --- | --- |
| `bodies` | `id` | the whole `Trip` as a **structured clone** (not a JSON string) | — |
| `summaries` | `id` | `{ id, name, updatedAt, legCount, distanceM, byteSize }` | `updatedAt` |

Upgrade path: `onupgradeneeded` creates both stores and the index if they are
absent. There is no v0 to migrate inside IndexedDB — the pre-IndexedDB data lives
in localStorage (§3).

`summary.byteSize` is the UTF-8 length of the serialised trip, computed at save
time. It is stored, not recomputed, because recomputing it means reading the body.

`distanceM` is `null` — never `0` — when any leg's distance is unknown or the trip
has no legs (`docs/09` §4.2).

### Why two stores instead of one

`list()` must draw a library row. With one store it would have to read and
deserialise every trip, so showing a list of ten 8 MB trips would parse 80 MB to
produce ten lines. With a summary row beside the body, `list()` reads ~100 bytes
per trip and never touches a body.

The cost is consistency, which is why the writes are structured the way they are.

---

## 2. Transaction discipline

| operation | transaction | stores | mode |
| --- | --- | --- | --- |
| `save(trip)` | one | `bodies` + `summaries` | `readwrite` |
| `remove(id)` | one | `bodies` + `summaries` | `readwrite` |
| `load(id)` | one | `bodies` | `readonly` |
| `list()` | one | `summaries` | `readonly` |

- **One transaction per save** means a body and its summary are written together
  or not at all: no crash, no quota refusal, no cross-tab interference can leave a
  row that points at a missing body, or a body with no row.
- **`list()` opens no transaction over `bodies`.** The test asserts this on the
  transaction itself rather than inferring it from the result
  (`test/store/indexeddb.test.ts`, "lists from summaries only").
- Every promise resolves on `transaction.oncomplete`, not on the last request's
  `success`: a write is confirmed only when it has committed.
- A request error aborts its transaction, so a partially applied write cannot
  survive.
- `bodies` holds the trip object. If a body is somehow not a trip (a corrupt row,
  a body from a future build) `load()` returns `null` / throws
  `StoreError('unsupported')`, and the row **stays in the library** because the
  summary is independent of it.

### Validation and measurement on save

1. `validateTrip()` — missing id, broken coordinates, non-numeric `ele` → `corrupt`.
2. `JSON.stringify` → `TextEncoder` → exact UTF-8 bytes. Over the ceiling →
   `quota-exceeded`, naming the size and the limit; nothing is written.
3. The write. A `QuotaExceededError` from the browser (any of its three spellings)
   becomes `quota-exceeded` naming the byte size that did not fit.

---

## 3. Migration from localStorage

The old keys are `npl:trips:v1` (JSON array of ids, newest first) and
`npl:trip:<id>` (one JSON body). `createTripStorage()` runs the import on first
use:

1. **Read.** Union of the ids in the index and every key with the `npl:trip:`
   prefix (so a lost index does not orphan the bodies). Each body is parsed and
   `migrate()`d; a body that cannot be read is **kept, not deleted** — a newer
   build may still understand it.
2. **Decide.** An existing IndexedDB row wins when it is at least as new
   (`updatedAt`), so running the migration twice cannot roll a newer edit back.
3. **Write** every candidate in **one transaction** over both stores.
4. **Delete** the legacy keys — and only then. If the transaction aborts, nothing
   is removed: the localStorage copy is still the only copy, and it is intact.

Idempotent: a second run finds no index and no bodies, reports
`{ imported: 0, removed: 0 }`, and does nothing. A failed run reports
`{ error }`; `migration.error` reaches the trip library as a visible note (the
trips are still in localStorage, which the note says).

The unreadable-body case keeps its key **and** stays in the rewritten index, so it
is retried on the next load rather than silently dropped.

---

## 4. Limits

| limit | value | where | behaviour |
| --- | --- | --- | --- |
| per-trip ceiling (IndexedDB) | **50 MB** (`MAX_INDEXEDDB_TRIP_BYTES`) | `src/store/indexeddb.ts` | `StoreError('quota-exceeded')` naming the size; nothing written |
| origin quota (IndexedDB) | browser-defined, typically ~60 % of free disk | `navigator.storage.estimate()` | `QuotaExceededError` → `StoreError('quota-exceeded')` naming the size |
| per-trip guard (localStorage fallback) | **1.5 MB** (`MAX_TRIP_BYTES`) | `src/store/local.ts` | same, plus "download the GPX" |
| origin quota (localStorage) | ~5 MB, not measurable | — | the fallback reports its own sum as an *estimate* |

The 50 MB ceiling is a runaway-import guard, not a statement about what fits. The
old 1.5 MB guard remains **only** on the localStorage backend, where 5 MB of
quota makes it true.

### Persistence and usage

- `navigator.storage.persist()` is called **once**, when the backend opens. The
  result is `store.persistent` and is shown in the trip library ("persistent
  storage" / "the browser may clear it"). It is a request, not a guarantee: a
  browser may refuse, and then evict under storage pressure.
- `navigator.storage.estimate()` is exposed as `store.usage()` →
  `{ usedBytes, quotaBytes, source }`, and the library prints
  "12.3 MB of ~8 GB used". `source: 'localstorage-estimate'` marks our own sum of
  the localStorage strings against the documented ~5 MB cap — that number is an
  estimate and is labelled as one in code; when the browser exposes nothing,
  `usage()` returns `null` and the line is omitted rather than shown as `0`.

### Fallback, never silent

`createTripStorage()` returns the localStorage store, with `problem` set to the
reason, when:

- `indexedDB` is missing (private mode, blocked storage), or
- opening the database fails or is blocked by another tab's upgrade.

The session's `storageInfo` carries `{ backend, persistent, problem }`; the trip
library renders a visible warning ("IndexedDB is unavailable, so trips are kept in
localStorage (about 5 MB). Large trips cannot be saved until this works.") with
the technical reason in the tooltip. There is no path where the app writes to the
fallback and says nothing.

---

## 5. Session and UI

`TripSession` awaits storage, so these became `async`:

`open`, `list`, `saveNow`, `remove`, `renameSaved`, `duplicate`, `importFile`,
`exportGpxFor`, `exportGeoJsonFor`, `flush`, `usage`.

`adopt(trip, { save: 'now' })` stays synchronous and starts a save; the status is
`'saving'` from that call until the write commits. `toGpx`, `toGeoJson` and
`fromFile` are synchronous and pure — a download does not wait for a database.

Status sequence, and what it is allowed to claim:

| status | meaning |
| --- | --- |
| `dirty` | the trip differs from what is stored |
| `saving` | the trip has been handed to the store; **not saved yet** |
| `saved` | the transaction committed at `status.at` |
| `error` | the write failed; `code` (`quota-exceeded`, …) and the message are shown |
| `unavailable` | there is no store at all |

A slow save cannot mark a newer edit as saved: every change bumps a sequence
number, and a completed write only sets `'saved'` if no change happened while it
was in flight. Saves are queued, so two rapid saves cannot interleave in the
database.

**`pagehide` flush.** A `pagehide` (and `visibilitychange` → hidden) handler calls
`session.flush()`, which cancels the autosave timer and writes immediately. See
§6 for what that does *not* guarantee.

---

## 6. Measured performance

Same 100,000-point / 8.01 MB trip, two environments:

**Headless Chromium (Playwright 1.58), real IndexedDB on disk** (measured with Playwright against
the dev server; not a test, a one-off measurement):

| step | time |
| --- | --- |
| `save` | **64 ms** |
| `load` | **26 ms** |
| `list` (summaries only) | **0.3 ms** |

Geometry comes back deep-equal; the summary carries `byteSize = 8 010 382`.

**`fake-indexeddb` in Node** (`test/acceptance/large-trip.test.ts`, so CI has a
number to guard against a regression in the *shape* of the write):

| step | time |
| --- | --- |
| `save` (validate + measure + one transaction) | **100 ms** |
| `load` (one transaction + structured clone) | **61 ms** |
| `list` (summaries only) | < 1 ms |

The save includes `JSON.stringify` of the whole trip for the size check — the
price of an honest `byteSize` and an exact ceiling message. Both numbers are far
below the 1 s autosave debounce: the delay a user sees between the last edit and
"saved" is the timer, not the write.

`navigator.storage.estimate()` is a browser estimate and can lag the write it
should reflect: in the Chromium run above it reported **1.4 MB used** immediately
after an 8 MB trip was written. The UI prints what the browser says; it does not
pretend to be exact.

---

## 7. What is still not durable (honest list)

1. **An edit made in the last second before the tab closes.** Autosave fires 1 s
   after the last change. `pagehide` flushes, but an IndexedDB write is
   asynchronous and the browser is not obliged to let it finish. `flush()` awaits
   the write in normal use; at teardown it may be cut off. **Consequence: the
   status can say "not saved" one final time and the edit is lost.**
2. **Unsaved edits of a trip that was never saved at all.** A drawn route that was
   never adopted+autosaved lives only in memory.
3. **Durability under storage pressure.** Even with `persist()` granted, a browser
   may evict an origin's data. There is no backup: the GPX download is the only
   copy the user owns.
4. **Another tab.** There is no cross-tab coordination. Two tabs open the same
   trip, the last write wins, and neither notices. (IndexedDB would let us do
   better with `versionchange`/`BroadcastChannel`; not done.)
5. **A failed migration** leaves the trips in localStorage, which still has the
   ~5 MB cap. They are visible (the library says so) but a large legacy trip could
   not have been in localStorage in the first place.
6. **Private browsing.** IndexedDB is often unavailable or ephemeral there; the
   app falls back and says so, but nothing survives the window.
7. **A trip that cannot be read** (corrupt body, future `schemaVersion`) keeps its
   library row and cannot be opened. Nothing rewrites or reinterprets it.

---

## 8. Tests that hold this design

| file | what it pins |
| --- | --- |
| `test/acceptance/large-trip.test.ts` | 3,000 km / ~100 000 points / 8.01 MB: save → load deep-equal geometry and provenance, `byteSize > 1_500_000` |
| `test/store/indexeddb.test.ts` | summaries-only list, one transaction per save/remove, ceiling and quota messages, migration success/idempotence/failure, fallback with a stated reason, usage/persistence reporting |
| `test/app-trip-session.test.ts` | `saving` → `saved`, no `saved` for an uncommitted or superseded write, rejected write surfaces, `flush` |
| `test/acceptance/edit-save-reload.test.ts` | the whole edit → save → reload journey through the real session and store |
| `test/ui-library-labels.test.ts` | the storage line and the fallback warning |

Measured suite: **245 cases**, 7.3 s, no network (`docs/11` budget: 250).
