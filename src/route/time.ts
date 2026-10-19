/**
 * `updatedAt` bookkeeping.
 *
 * Every command must move `updatedAt` forward, otherwise "was this trip edited
 * after I loaded it?" is unanswerable and a store that compares timestamps sees
 * nothing. A wall clock can return the same millisecond twice (or even go
 * backwards, on a device with a corrected clock), so the timestamp is clamped
 * to at least one millisecond after the previous one.
 *
 * Consequence to know about: two edits in the same millisecond produce
 * timestamps 1 ms apart rather than identical — deliberately, so the value is
 * always a change signal. Undo/redo restore the snapshot's own `updatedAt`,
 * which is what makes an undo a *deep-equal* return to the previous trip.
 */

export function nextUpdatedAt(previousIso: string, now: Date): string {
  const previous = Date.parse(previousIso);
  const candidate = now.getTime();
  const ms = Number.isFinite(previous) && candidate <= previous ? previous + 1 : candidate;
  return new Date(ms).toISOString();
}
