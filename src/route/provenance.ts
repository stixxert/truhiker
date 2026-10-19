/**
 * Provenance helpers.
 *
 * Rules encoded here (and documented in `src/route/README.md`):
 *
 * 1. An **edit** appends `{kind:'edited', modified:true}` and never discards or
 *    rewrites an existing entry. The edit log is not compressed: editing a leg
 *    ten times leaves ten markers. That is intentional — a flattened log would
 *    make it impossible to tell "edited once" from "edited on every import".
 * 2. A **fact about the data** (this geometry follows trail X; this span is
 *    off-trail) is recorded at most once per distinct marker, because repeating
 *    it adds no information. `ensureProvenance` does that.
 * 3. **Merge** unions two arrays and drops structural duplicates (same kind,
 *    label, url, fetchedAt, licence, modified). "Identity" here means the entry
 *    as a value — two separately constructed `{kind:'gpx-upload', url:'…'}`
 *    entries are the same claim and must not appear twice on one leg.
 */

import type { Provenance } from '../contracts';

/** Marker appended by every mutating command. Frozen: it is shared by trips. */
export const EDITED_MARKER: Provenance = Object.freeze({ kind: 'edited', modified: true });

/** Marker recording that geometry was moved onto a trail. */
export const SNAPPED_MARKER: Provenance = Object.freeze({ kind: 'snapped', modified: true });

/** Label used when a reroute snapped nothing at all. */
export const OFF_TRAIL_LABEL = 'off-trail';

/** Label used when a rerouted span is not one continuous trail. */
export const OFF_TRAIL_GAP_LABEL = 'off-trail gap';

/** Stable key for structural comparison of two provenance entries. */
function provenanceKey(entry: Provenance): string {
  return [
    entry.kind,
    entry.label ?? '',
    entry.url ?? '',
    entry.fetchedAt ?? '',
    entry.licence ?? '',
    entry.modified === true ? 'true' : 'false',
  ].join('\u0000');
}

/** Append without inspecting what is already there (rule 1). */
export function appendProvenance(
  existing: readonly Provenance[],
  ...added: readonly Provenance[]
): Provenance[] {
  return [...existing, ...added];
}

/** Append unless an identical entry is already present (rule 2). */
export function ensureProvenance(
  existing: readonly Provenance[],
  entry: Provenance,
): Provenance[] {
  const key = provenanceKey(entry);
  if (existing.some((item) => provenanceKey(item) === key)) return existing.slice();
  return [...existing, entry];
}

/** Union with structural de-duplication, first occurrence wins (rule 3). */
export function mergeProvenance(
  first: readonly Provenance[],
  second: readonly Provenance[],
): Provenance[] {
  const seen = new Set<string>();
  const out: Provenance[] = [];
  for (const entry of [...first, ...second]) {
    const key = provenanceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
