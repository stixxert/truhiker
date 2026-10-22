/**
 * The route editor: an immutable document, a command set, and undo/redo.
 *
 * ## Immutability
 * `apply` returns a **new** `Trip` and never mutates its input; the same is true
 * of every command implementation below (every array is rebuilt, every leg is a
 * fresh object). A frozen input works fine — the tests assert exactly that — and
 * `editor.trip` is never the same object as the trip a command produced before
 * it.
 *
 * ## Undo model
 * **Snapshots**, not inverses. Each leg is a few hundred points at most, so the
 * history is cheap, and snapshots are the only model that cannot drift: an
 * inverse command computed from a mutated state is a classic source of
 * "undo leaves the trip almost where it was". `undo`/`redo` therefore restore
 * byte-identical trips, including each snapshot's own `updatedAt`, which is why
 * `apply → undo` is deep-equal to the original.
 *
 * A new command after an undo clears the redo stack (the future that never
 * happened is not reachable any more).
 *
 * ## Validation
 * - Out-of-range, non-integer or reversed indices throw
 *   `RouteEditError('index-out-of-range')`.
 * - A command that would leave a leg with fewer than two points throws
 *   `RouteEditError('leg-too-short')`. The invariant "a leg has ≥2 points or
 *   does not exist" is enforced by refusing, **not** by silently deleting the
 *   leg: removing a leg the user only asked to shorten is a data loss
 *   expressed as a convenience. Deleting a leg is `{type:'delete-leg'}`, which
 *   is explicit and undoable.
 * - The editor does not police the trip it is handed. A caller mid-draw may
 *   hold a leg with one point; the editor simply never *produces* one.
 *
 * ## Timestamps
 * Every applied command moves `updatedAt` forward by at least 1 ms (see
 * `./time.ts`). Undo/redo restore the previous value.
 */

import type { Leg, RouteEditor, RoutePoint, Trip } from '../contracts';
import type { RouteCommand } from './commands';
import { RouteEditError } from './errors';
import { newId } from './ids';
import { recomputeLeg } from './metrics';
import { assertRoutePoint } from './points';
import {
  EDITED_MARKER,
  SNAPPED_MARKER,
  appendProvenance,
  ensureProvenance,
  mergeProvenance,
} from './provenance';
import { nextUpdatedAt } from './time';

export interface EditorOptions {
  /** Clock for `updatedAt`. Default `() => new Date()`. Inject it in tests. */
  now?: () => Date;
  /** Id source for the second leg produced by `split-leg`. */
  newLegId?: () => string;
}

/**
 * The editor as the UI uses it: `RouteEditor` (apply/undo/redo/reset) plus the
 * `merge-legs` command the shared `EditCommand` union does not carry.
 */
export type RouteEditorWithCommands = RouteEditor & {
  apply(command: RouteCommand): Trip;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function assertIndex(value: number, min: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RouteEditError(
      'index-out-of-range',
      `${what}: index ${String(value)} is outside ${min}..${max}`,
    );
  }
}

function assertMinPoints(points: readonly RoutePoint[], legId: string, what: string): void {
  if (points.length < 2) {
    throw new RouteEditError(
      'leg-too-short',
      `${what} would leave leg '${legId}' with ${points.length} point(s). ` +
        `A leg always has at least two points or does not exist; use {type:'delete-leg'} to remove it.`,
    );
  }
}

function locateLeg(trip: Trip, legId: string): number {
  const index = trip.legs.findIndex((leg) => leg.id === legId);
  if (index < 0) {
    throw new RouteEditError('unknown-leg', `leg '${legId}' is not part of trip '${trip.id}'`);
  }
  return index;
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return [...items.slice(0, index), value, ...items.slice(index + 1)];
}

/** Append the edit marker. Existing provenance is preserved verbatim. */
function edited(leg: Leg): Leg {
  return { ...leg, provenance: appendProvenance(leg.provenance, EDITED_MARKER) };
}

function withName(leg: Leg, name: string | undefined): Leg {
  const { name: _dropped, ...rest } = leg;
  const copy: Leg = rest;
  return name === undefined ? copy : { ...copy, name };
}

function sameLonLat(a: RoutePoint, b: RoutePoint): boolean {
  return a.lon === b.lon && a.lat === b.lat;
}

/** New trip object with replaced legs and a later `updatedAt`. */
function reload(trip: Trip, legs: readonly Leg[], options: EditorOptions): Trip {
  const now = options.now ? options.now() : new Date();
  return { ...trip, legs, updatedAt: nextUpdatedAt(trip.updatedAt, now) };
}

// ---------------------------------------------------------------------------
// Command application
// ---------------------------------------------------------------------------

/**
 * Apply one command, returning a new trip. Pure: the input trip is not
 * touched. Exported for callers that want a single edit without history.
 */
export function applyCommand(
  trip: Trip,
  command: RouteCommand,
  options: EditorOptions = {},
): Trip {
  if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
    throw new RouteEditError('invalid-command', `expected a command object, got ${String(command)}`);
  }
  const commit = (legIndex: number, leg: Leg): Trip =>
    reload(trip, replaceAt(trip.legs, legIndex, leg), options);
  const commitLegs = (legs: readonly Leg[]): Trip => reload(trip, legs, options);

  switch (command.type) {
    case 'insert': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      assertIndex(command.index, 0, leg.points.length, `insert into leg '${leg.id}'`);
      const point = assertRoutePoint(command.point, 'insert: point');
      const placed: RoutePoint = command.snapped === true ? { ...point, snapped: true } : point;
      const points = [...leg.points.slice(0, command.index), placed, ...leg.points.slice(command.index)];
      assertMinPoints(points, leg.id, 'insert');
      const inserted = edited(recomputeLeg({ ...leg, points }));
      // A drawn point that snapped to a trail says so. This is the flow that used
      // to drop the marker: only `replace-span` recorded `snapped`, so every point
      // after the first two lost its provenance (D5 says the leg records it).
      const provenance = command.snapped
        ? ensureProvenance(inserted.provenance, SNAPPED_MARKER)
        : inserted.provenance;
      return commit(legIndex, { ...inserted, provenance });
    }

    case 'move': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      assertIndex(command.index, 0, leg.points.length - 1, `move on leg '${leg.id}'`);
      const point = assertRoutePoint(command.point, 'move: point');
      const points = leg.points.slice();
      points[command.index] = command.snapped ? { ...point, snapped: true } : point;
      return commit(legIndex, edited(recomputeLeg({ ...leg, points })));
    }

    case 'delete-vertex': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      assertIndex(command.index, 0, leg.points.length - 1, `delete-vertex on leg '${leg.id}'`);
      const points = leg.points.filter((_, index) => index !== command.index);
      assertMinPoints(points, leg.id, 'delete-vertex');
      return commit(legIndex, edited(recomputeLeg({ ...leg, points })));
    }

    case 'delete-leg': {
      const legIndex = locateLeg(trip, command.legId);
      return commitLegs(trip.legs.filter((_, index) => index !== legIndex));
    }

    case 'split-leg': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      const lastSplittableIndex = leg.points.length - 2;
      if (
        !Number.isInteger(command.index) ||
        command.index < 1 ||
        command.index > lastSplittableIndex
      ) {
        throw new RouteEditError(
          'index-out-of-range',
          `split-leg on leg '${leg.id}': index ${String(command.index)} is outside 1..${lastSplittableIndex} ` +
            `for a ${leg.points.length}-point leg (both halves need at least two points)`,
        );
      }
      const firstPoints = leg.points.slice(0, command.index + 1);
      const secondPoints = leg.points.slice(command.index);
      const first = edited(recomputeLeg({ ...leg, points: firstPoints }));
      const secondId = options.newLegId ? options.newLegId() : newId('leg');
      const secondBase: Leg = {
        id: secondId,
        points: secondPoints,
        provenance: appendProvenance(leg.provenance, EDITED_MARKER),
        distanceM: null,
        ascentM: null,
        descentM: null,
      };
      const namedSecond: Leg = leg.name ? { ...secondBase, name: `${leg.name} (2)` } : secondBase;
      const second = recomputeLeg(namedSecond);
      const legs = [
        ...trip.legs.slice(0, legIndex),
        first,
        second,
        ...trip.legs.slice(legIndex + 1),
      ];
      return commitLegs(legs);
    }

    case 'reverse-leg': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      const points = [...leg.points].reverse();
      return commit(legIndex, edited(recomputeLeg({ ...leg, points })));
    }

    case 'trim-leg': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      assertIndex(command.from, 0, leg.points.length - 1, `trim-leg from on leg '${leg.id}'`);
      assertIndex(command.to, 0, leg.points.length - 1, `trim-leg to on leg '${leg.id}'`);
      if (command.to < command.from) {
        throw new RouteEditError(
          'index-out-of-range',
          `trim-leg on leg '${leg.id}': to (${command.to}) is before from (${command.from})`,
        );
      }
      const points = leg.points.slice(command.from, command.to + 1);
      assertMinPoints(points, leg.id, 'trim-leg');
      return commit(legIndex, edited(recomputeLeg({ ...leg, points })));
    }

    case 'rename-leg': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      if (typeof command.name !== 'string') {
        throw new RouteEditError('invalid-command', 'rename-leg: name must be a string');
      }
      const name = command.name.trim();
      return commit(legIndex, edited(withName(leg, name === '' ? undefined : name)));
    }

    case 'replace-span': {
      const legIndex = locateLeg(trip, command.legId);
      const leg = trip.legs[legIndex];
      assertIndex(command.from, 0, leg.points.length - 1, `replace-span from on leg '${leg.id}'`);
      assertIndex(command.to, 0, leg.points.length - 1, `replace-span to on leg '${leg.id}'`);
      if (command.to < command.from) {
        throw new RouteEditError(
          'index-out-of-range',
          `replace-span on leg '${leg.id}': to (${command.to}) is before from (${command.from})`,
        );
      }
      const replacement = command.points.map((point, index) => {
        const asserted = assertRoutePoint(point, `replace-span: points[${index}]`);
        // A snapped span places its vertices on a trail, so each one records it.
        return command.snapped ? { ...asserted, snapped: true } : asserted;
      });
      const points = [
        ...leg.points.slice(0, command.from),
        ...replacement,
        ...leg.points.slice(command.to + 1),
      ];
      assertMinPoints(points, leg.id, 'replace-span');
      let provenance = appendProvenance(leg.provenance, EDITED_MARKER);
      if (command.snapped) provenance = ensureProvenance(provenance, SNAPPED_MARKER);
      for (const entry of command.provenance ?? []) provenance = ensureProvenance(provenance, entry);
      return commit(legIndex, recomputeLeg({ ...leg, points, provenance }));
    }

    case 'merge-legs': {
      const merge = command;
      if (merge.legId === merge.withLegId) {
        throw new RouteEditError('invalid-command', 'merge-legs: a leg cannot be merged with itself');
      }
      const keepIndex = locateLeg(trip, merge.legId);
      const dropIndex = locateLeg(trip, merge.withLegId);
      const keep = trip.legs[keepIndex];
      const drop = trip.legs[dropIndex];

      // A split leaves the join vertex in both halves; merging must not double it.
      const joinPointRepeats =
        keep.points.length > 0 &&
        drop.points.length > 0 &&
        sameLonLat(keep.points[keep.points.length - 1], drop.points[0]);
      const points = [
        ...keep.points,
        ...(joinPointRepeats ? drop.points.slice(1) : drop.points),
      ];
      assertMinPoints(points, keep.id, 'merge-legs');
      const merged = edited(
        recomputeLeg({
          ...keep,
          points,
          provenance: mergeProvenance(keep.provenance, drop.provenance),
        }),
      );
      const legs: Leg[] = [];
      trip.legs.forEach((leg, index) => {
        if (index === dropIndex) return;
        legs.push(index === keepIndex ? merged : leg);
      });
      return commitLegs(legs);
    }

    default: {
      const unreachable = command;
      throw new RouteEditError(
        'invalid-command',
        `unknown command ${JSON.stringify((unreachable as { type?: string }).type)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

class Editor implements RouteEditorWithCommands {
  private current: Trip;
  private readonly past: Trip[] = [];
  private readonly future: Trip[] = [];

  constructor(
    trip: Trip,
    private readonly options: EditorOptions,
  ) {
    this.current = trip;
  }

  get trip(): Trip {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  apply(command: RouteCommand): Trip {
    const next = applyCommand(this.current, command, this.options);
    this.past.push(this.current);
    this.future.length = 0;
    this.current = next;
    return next;
  }

  /**
   * Step back one command. A no-op (returning the current trip) when there is
   * nothing to undo — callers should test `canUndo`, but an idle undo from a
   * keyboard handler must not throw.
   */
  undo(): Trip {
    const previous = this.past.pop();
    if (!previous) return this.current;
    this.future.push(this.current);
    this.current = previous;
    return previous;
  }

  /** Step forward again, undoing the undo. No-op at the top of the future stack. */
  redo(): Trip {
    const next = this.future.pop();
    if (!next) return this.current;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  /** Replace the whole trip (file load, import) and drop the history. */
  reset(trip: Trip): void {
    this.current = trip;
    this.past.length = 0;
    this.future.length = 0;
  }

  replaceCurrent(trip: Trip): void {
    this.current = trip;
  }
}

/**
 * Wrap a trip in an editor. The trip is neither cloned nor validated: it is the
 * document, and the editor only ever produces new ones.
 */
export function createEditor(trip: Trip, options: EditorOptions = {}): RouteEditorWithCommands {
  return new Editor(trip, options);
}
