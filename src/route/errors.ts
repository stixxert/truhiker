/**
 * Typed errors from the route editor.
 *
 * Every one of these is a *caller* bug or a decision the caller must make
 * explicitly (e.g. "deleting this vertex would leave one point — remove the
 * leg instead"). The editor never silently repairs geometry, and it never
 * throws for a condition that only the data can resolve.
 */

export type RouteEditErrorCode =
  /** The command names a leg id the trip does not contain. */
  | 'unknown-leg'
  /** A vertex/span index is out of range, non-integer, or reversed. */
  | 'index-out-of-range'
  /** The command would leave a leg with fewer than two points. */
  | 'leg-too-short'
  /** A point has non-finite lon/lat, or a non-finite `ele`. */
  | 'invalid-point'
  /** The command itself is malformed (e.g. a missing SnapIndex). */
  | 'invalid-command';

export class RouteEditError extends Error {
  constructor(
    readonly code: RouteEditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RouteEditError';
  }
}
