/**
 * The command set the editor accepts.
 *
 * `EditCommand` in `src/contracts` is the shared vocabulary and it is closed
 * (`insert | move | delete-vertex | delete-leg | split-leg | reverse-leg |
 * trim-leg | rename-leg | replace-span`). `replace-span` gained an optional
 * `provenance` list so a routed span can record its source; older callers are
 * unaffected. Merge is missing from it, yet merge has to be an undoable edit
 * with unioned provenance, so it is declared *here* as an extension and the
 * editor accepts the union. Contract compatibility is preserved: anything typed
 * as `EditCommand` is still a valid `RouteCommand`, and `RouteEditor.apply`
 * remains satisfied.
 */

import type { EditCommand } from '../contracts';

/**
 * Merge `withLegId` into `legId`.
 *
 * The merged leg keeps `legId`'s id and name, the second leg's points are
 * appended, and where the join is a repeated vertex (the first point of the
 * second leg equals the last point of the first — exactly what `split-leg`
 * produces) that duplicate is dropped. Provenance is unioned and de-duplicated.
 * The second leg is removed. This is what makes "split then merge" restore the
 * original point sequence.
 */
export interface MergeLegsCommand {
  readonly type: 'merge-legs';
  /** Leg that survives; receives the other's points. */
  readonly legId: string;
  /** Leg that is consumed and removed. */
  readonly withLegId: string;
}

export type RouteCommand = EditCommand | MergeLegsCommand;
