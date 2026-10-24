# Route editing (`src/route`)

Pure TypeScript. No DOM, no network, no rendering, no storage. The UI imports
only `src/route/index.ts`.

```ts
import {
  createEditor, emptyLeg, tripFromPoints, rerouteSpan, recomputeLeg, tripDistanceM,
  RouteEditError, type RouteCommand, type RerouteOptions,
} from '../route';
```

Types (`Trip`, `Leg`, `RoutePoint`, `EditCommand`, `RouteEditor`) live in
`src/contracts` — this module implements them, it does not redefine them.

---

## 1. The document is immutable

`trip` is the document; `editor.trip` is what is currently true. **Every**
operation returns a new `Trip`:

- the input trip is never mutated (no array is pushed to, no leg is edited in
  place — every command rebuilds the legs/points arrays it touches),
- a deeply frozen trip is a valid input,
- `next !== previous`, and legs/points that were not touched still hold their
  identity only by value, not by sharing a mutated array.

One consequence worth knowing: the numbers on a leg (`distanceM`, `ascentM`,
`descentM`) are recomputed by `recomputeLeg` after every geometry change, so
they can never disagree with `leg.points`.

### Timestamps
`updatedAt` moves forward on every applied command, clamped to at least
**+1 ms** over the previous value even if the wall clock returns the same
millisecond (or goes backwards). That makes `updatedAt` a reliable "this
changed" signal. `undo`/`redo` restore the snapshot's own `updatedAt` — which
is what makes an undo a *deep-equal* return to the previous trip.

---

## 2. Command set

`EditCommand` from `src/contracts`, plus one extension declared in
`src/route/commands.ts` because merge is required to be undoable but is absent
from the shared union. `RouteCommand = EditCommand | MergeLegsCommand`.

| Command | Effect on `leg.points` | Notes |
| --- | --- | --- |
| `insert {legId,index,point}` | inserts at `index` | `index` may equal `points.length` (append) |
| `move {legId,index,point}` | replaces `points[index]` | elevation of the replacement point is whatever the caller passes; nothing is resampled |
| `delete-vertex {legId,index}` | removes `points[index]` | refuses (below) if fewer than 2 would remain |
| `delete-leg {legId}` | — | remove the whole leg; removing the last leg is allowed and leaves a trip with no legs |
| `split-leg {legId,index}` | two legs: `[0..index]` and `[index..end]` | **both** halves keep the split vertex; first keeps the id and name, second gets a new id and name `"<name> (2)"`; `index` must be in `1..len-2` so both halves have ≥2 points |
| `reverse-leg {legId}` | points reversed | elevations travel with their points |
| `trim-leg {legId,from,to}` | keeps `points[from..to]` (inclusive) | the discarded span is recovered by undo |
| `rename-leg {legId,name}` | — | name is trimmed; an empty name removes `name` |
| `replace-span {legId,from,to,points,snapped}` | replaces `points[from..to]` with `points` | used after drawing/snapping; `snapped:true` records the `snapped` provenance marker |
| `merge-legs {legId,withLegId}` | appends `withLegId`'s points to `legId` | the repeated join vertex (what `split-leg` produces) is dropped, so split→merge restores the exact original sequence; provenance is unioned and de-duplicated; `withLegId` is removed |

Every applied command appends exactly one `{kind:'edited', modified:true}` to the
touched leg's provenance (merge: to the surviving leg). Existing entries are
never dropped or rewritten.

`applyCommand(trip, command, options)` is exported for a one-shot edit without
history.

### Errors — the editor refuses instead of repairing

`RouteEditError` carries a `code`:

| Code | Meaning |
| --- | --- |
| `unknown-leg` | the leg id is not in the trip |
| `index-out-of-range` | non-integer, negative, past the end, or `to < from` |
| `leg-too-short` | the command would leave a leg with fewer than 2 points |
| `invalid-point` | non-finite/out-of-range lon/lat, non-finite `ele`, unknown `eleSource` |
| `invalid-command` | malformed command (e.g. merging a leg with itself, no SnapIndex) |

**Deleting below the two-point floor throws `leg-too-short`; it does not delete
the leg.** Removing a leg the user asked only to shorten is data loss dressed as
a convenience. Removing the leg is `{type:'delete-leg'}` — explicit, and equally
undoable. (The alternative — implicit `delete-leg` — was rejected for exactly
that reason.)

The editor does **not** validate the trip it is handed: a caller mid-draw may
hold a leg with one point. The editor simply never *produces* such a leg.

---

## 3. Undo / redo

Snapshot-based, not inverse-based. Legs are small (hundreds of points), and a
snapshot cannot drift: an inverse command computed from a mutated state is the
classic source of "undo left the trip almost where it was".

- One snapshot is pushed per `apply`, for **every** command including `split-leg`
  and `merge-legs`.
- `undo()` pops the past stack and pushes the current trip onto the future
  stack; `redo()` does the reverse. Round-trips are deep-equal, including
  `updatedAt` and the ids generated by split.
- A new `apply` **after** an undo clears the redo stack.
- `undo()`/`redo()` at the end of their stack are no-ops returning the current
  trip (a keyboard handler must not throw). Check `canUndo`/`canRedo` to drive UI
  affordances.
- `reset(trip)` replaces the document and clears **both** stacks (use it after
  loading a file, so you cannot undo into a different trip).

---

## 4. Metrics (`recomputeLeg`, `tripDistanceM`)

- `distanceM`: haversine over the vertices (`src/core/geo`). `null` for fewer
  than two points.
- `ascentM`/`descentM`: the **hysteresis** state machine from
  `src/core/profile.ts` (`elevationGainLoss`, 5 m threshold) — reused, not
  re-implemented. That is what stops float noise and micro-relief accumulating
  into fake climb.
  - Two deliberate differences from `buildProfile`'s pipeline: **no gap
    filling** and **no median filter**. A missing elevation has nothing to be
    filled from, and edit vertices are sparse and human-chosen — a lone summit
    waypoint is signal, not a DEM spike. Filtering it out would under-report
    climbing.
  - If **any** point lacks a finite `ele`, both are `null`. Never `0`.
  - Because of this, a leg's `ascentM` is a per-vertex figure and is not
    guaranteed to equal the resampled profile's number for the same geometry.
    The profile panel is the authoritative one; this is the leg-level summary.
- `tripDistanceM(trip)`: sum of leg distances, `null` when the trip has no legs
  or any leg's distance is unknown. A partial sum presented as a total would be
  the "unknown rendered as a number" failure the project forbids.

`hasElevation()` is the predicate: `typeof ele === 'number' && isFinite(ele)`, so
`ele: 0` counts as a real elevation at sea level.

---

## 5. `rerouteSpan` — re-snapping, not routing

```ts
rerouteSpan(trip, legId, from, to, { snapIndex, radiusM? }): Trip
```

Synchronous, offline, no I/O — the `SnapIndex` is populated by the caller.

**It does:**

1. Asks the index for the nearest trail point for **each** vertex in
   `[from..to]`, independently, within `radiusM` (default 75 m). No sticky
   hysteresis: a vertex farther than `radiusM` from every trail stays put, so
   the radius means what it says.
2. Moves a snapped vertex to the snapped position and **keeps its `ele` /
   `eleSource` verbatim**. The snapped point is tens of metres away; re-sampling
   elevation is the UI's job (it resamples from the DEM later).
3. Replaces a run of **two or more consecutive vertices snapped to the same
   `lineId`** with the corresponding stretch of that line's own polyline, walked
   in the direction of travel (trail bends, switchbacks and digitisation order
   are all handled; the stretch runs from the first snapped position to the last
   along the line, not through vertices 0..n). Interpolated vertices get
   elevation linearly interpolated along the stretch between the run's endpoint
   elevations, rounded to 0.1 m; if either endpoint has no elevation they get
   `eleSource:'none'` and no `ele`.
4. Recomputes the leg's metrics and records provenance: `{kind:'edited',
   modified:true}`, plus `{kind:'snapped', modified:true}` once, plus
   `{kind:'edited', label:'off-trail gap'}` when the span is not one continuous
   trail.

**It does not:**

- **Bridge two different trails.** Runs on different lines are each replaced by
  their own stretch; the vertices between them are left exactly as they were.
  No connecting geometry is invented. The leg is marked `off-trail gap`.
- Fetch anything, widen the radius, or use a "sticky" radius to keep a point
  that is out of range.
- Snap vertices outside `[from..to]`, or touch any other leg.
- Invent elevation from the trail geometry, or drop an existing elevation.
- Rank or choose between trails: the index returns the nearest, reroute takes it.
- Preserve point count. A rerouted span can be longer (the trail has more
  vertices) or shorter (a single snapped vertex per run) than the original. Do
  not index into a leg by position after rerouting — re-read `leg.points`.

**Off-trail cases**

| Situation | Geometry | Provenance added |
| --- | --- | --- |
| Nothing in the span snaps | unchanged | `{kind:'edited', label:'off-trail'}` |
| Some vertices snap, some do not | snapped ones move, the rest stay | `off-trail gap` |
| Snap runs on ≥2 distinct lines | each run follows its own trail, no bridge | `off-trail gap` |
| All vertices snap to one line | replaced by that line's stretch | `snapped` |

`radiusM` must be a positive finite number, and `from`/`to` must be a valid span
of the leg (`RouteEditError` otherwise, thrown before anything is touched).

---

## 6. Provenance rules

1. An **edit** appends `{kind:'edited', modified:true}` and never discards or
   rewrites existing entries. The log is not compressed: ten edits leave ten
   markers.
2. A **fact about the data** ("this follows trail X", "this span is off-trail")
   is recorded **at most once per distinct marker** (`ensureProvenance`),
   because repeating it adds nothing. Two reroutes that both find nothing
   off-trail leave one `off-trail` marker.
3. **Merge** unions the two arrays and drops structural duplicates (same kind,
   label, url, `fetchedAt`, licence, `modified`). "Identity" is by value: two
   separately constructed entries making the same claim appear once.

---

## 7. Other exports

- `emptyLeg(name?)` — a **placeholder** leg: two identical points at
  `PLACEHOLDER_POINT` (0°N 0°E, "null island"), zero distance, `null` ascent and
  empty provenance. It keeps the two-point invariant while being obviously not a
  route, and drawing replaces it wholesale (`replace-span` over `0..points.length-1`)
  rather than appending to a dummy vertex. The UI detects it by "all points share
  one coordinate"; `PLACEHOLDER_POINT` is exported so a consumer need not guess.
- `tripFromPoints(points, name, profile, options?)` — one-leg trip,
  `schemaVersion: 1`, ISO `createdAt`/`updatedAt`, metrics computed. Throws
  `leg-too-short` for fewer than two points and `invalid-point` for bad
  coordinates. Default provenance `[{kind:'drawn'}]`; pass
  `options.provenance` (e.g. `[{kind:'gpx-upload', …}]`) so an import is not
  mislabelled. `options.now`/`options.id`/`options.legId`/`options.legName` are
  available for deterministic tests.
- `EditorOptions { now?, newLegId? }` — inject a clock/id source in tests.

---

## 8. Decisions where the contract is silent

| Question | Choice |
| --- | --- |
| Delete a vertex below the two-point floor | throw `leg-too-short`; never silently delete the leg |
| Merge command type | not in `EditCommand`; declared as `MergeLegsCommand` in `src/route/commands.ts`, accepted by `createEditor(...).apply`. Contract compatibility kept (an `EditCommand` is still a valid `RouteCommand`) |
| Split vertex ownership | the vertex stays in **both** halves, so merge can drop the duplicate and restore the exact sequence |
| Rename vs "provenance untouched" | existing entries are untouched, and an `edited` marker is appended, so a rename is recorded without rewriting where the route came from |
| Reroute hysteresis | not used — each vertex snaps independently within `radiusM` |
| Elevation of reroute-inserted vertices | linear interpolation between the run's endpoint elevations, rounded to 0.1 m, source inherited from the endpoints (documented approximation; UI re-samples) |
| Elevation of moved/inserted points | never invented: whatever the caller supplies; new points should carry `eleSource:'none'` until sampled |
| `off-trail gap` trigger | span contains ≥2 distinct `lineId`s **or** leaves some vertices unsnapped while others snapped |
| `tripDistanceM` with an unknown leg | `null`, not a partial sum |
| `emptyLeg` | two identical placeholder points at 0°N 0°E, not a zero-point leg: a leg inside a trip must have ≥2 points, and the UI's draw flow replaces the placeholder wholesale |
| Repeated edits' provenance growth | unbounded by design (rule 1 above) |
| `undo` at the start of history | no-op returning the current trip |
