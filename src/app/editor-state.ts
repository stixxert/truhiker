/**
 * Route-editing UI state → `EditCommand`.
 *
 * The map overlay knows pixels; the toolbar knows buttons. Neither is allowed to
 * build a command by hand, because "which leg, which vertex, is it valid" is
 * exactly the kind of detail that drifts. This module is pure: given the UI
 * state and the trip, it returns the command (or `null` when the action is not
 * available). The editor still has the final say — it can refuse a command —
 * but the toolbar's enabled/disabled states come from here.
 *
 * Nothing in this file holds a mutable trip: every command is data.
 */

import type { EditCommand, Leg, RoutePoint, Trip } from '../contracts';
import { findLeg, isPlaceholderLeg } from '../lib/trip-route';

export type InteractionMode = 'view' | 'draw' | 'edit';

/** A selected vertex, plus an optional second anchor for a span. */
export interface VertexSelection {
  readonly legId: string;
  /** Single index; with `to` set, the span runs from `from` to `to`. */
  readonly from: number;
  readonly to: number | null;
}

export interface EditorUiState {
  readonly mode: InteractionMode;
  readonly snapping: boolean;
  readonly radiusM: number;
  readonly selection: VertexSelection | null;
  /** The leg new points are appended to. Defaults to the last leg. */
  readonly activeLegId: string | null;
  /**
   * Points added in the current draw session, in order. Used to replace a
   * placeholder leg (`emptyLeg()`) instead of appending to its dummy points.
   */
  readonly drawPoints: readonly RoutePoint[];
  /** True when the draw session started on a placeholder leg. */
  readonly drawReplacesLeg: boolean;
}

export const DEFAULT_SNAP_RADIUS_M = 75;
const SNAP_RADIUS_LIMITS = { min: 20, max: 300 } as const;

/** Clamp a user-entered snap radius; junk falls back to the default. */
export function clampSnapRadius(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(numeric)) return DEFAULT_SNAP_RADIUS_M;
  return Math.min(SNAP_RADIUS_LIMITS.max, Math.max(SNAP_RADIUS_LIMITS.min, Math.round(numeric)));
}

/** Initial editing state for a trip: view mode, snapping on, last leg active. */
export function initialEditorState(trip: Trip | null, snapping = true): EditorUiState {
  const active = trip && trip.legs.length > 0 ? trip.legs[trip.legs.length - 1].id : null;
  return {
    mode: 'view',
    snapping,
    radiusM: DEFAULT_SNAP_RADIUS_M,
    selection: null,
    activeLegId: active,
    drawPoints: [],
    drawReplacesLeg: false,
  };
}

/** Switch mode. Leaving draw mode discards the in-progress point list. */
export function setMode(state: EditorUiState, mode: InteractionMode, trip: Trip | null): EditorUiState {
  if (mode === state.mode) return state;
  const activeLegId =
    findLeg(trip, state.activeLegId) !== undefined
      ? state.activeLegId
      : trip && trip.legs.length > 0
        ? trip.legs[trip.legs.length - 1].id
        : null;
  if (mode === 'draw') {
    return {
      ...state,
      mode,
      selection: null,
      activeLegId,
      drawPoints: [],
      drawReplacesLeg: isPlaceholderLeg(findLeg(trip, activeLegId)),
    };
  }
  return { ...state, mode, drawPoints: [], drawReplacesLeg: false };
}

export function setSnapping(state: EditorUiState, snapping: boolean): EditorUiState {
  return state.snapping === snapping ? state : { ...state, snapping };
}

export function setRadius(state: EditorUiState, radiusM: unknown): EditorUiState {
  const next = clampSnapRadius(radiusM);
  return next === state.radiusM ? state : { ...state, radiusM: next };
}

export function selectLeg(state: EditorUiState, legId: string | null): EditorUiState {
  return { ...state, activeLegId: legId, selection: null };
}

/** Select one vertex; `extend` makes it the far anchor of a span. */
export function selectVertex(
  state: EditorUiState,
  legId: string,
  index: number,
  extend: boolean,
): EditorUiState {
  const selection = state.selection;
  if (extend && selection && selection.legId === legId) {
    return {
      ...state,
      activeLegId: legId,
      selection: { legId, from: selection.from, to: index },
    };
  }
  return { ...state, activeLegId: legId, selection: { legId, from: index, to: null } };
}

export function clearSelection(state: EditorUiState): EditorUiState {
  return state.selection === null ? state : { ...state, selection: null };
}

/** Record a drawn point; the caller has already applied the command. */
export function noteDrawnPoint(state: EditorUiState, point: RoutePoint): EditorUiState {
  return { ...state, drawPoints: [...state.drawPoints, point] };
}

// ---------------------------------------------------------------------------
// Command generation
// ---------------------------------------------------------------------------

export interface CommandAvailability {
  readonly canDeleteVertex: boolean;
  readonly canSplit: boolean;
  readonly canTrim: boolean;
  readonly canReverse: boolean;
  readonly canRename: boolean;
  readonly canDeleteLeg: boolean;
  readonly canReroute: boolean;
  /** True when there is a leg whose geometry a route could replace. */
  readonly canRoute: boolean;
}

function selectedLeg(state: EditorUiState, trip: Trip | null): Leg | undefined {
  const legId = state.selection?.legId ?? state.activeLegId;
  return findLeg(trip, legId);
}

/** Which of the selection-dependent actions are available right now. */
export function availableCommands(state: EditorUiState, trip: Trip | null): CommandAvailability {
  const leg = selectedLeg(state, trip);
  const selection = state.selection;
  if (!leg) {
    return {
      canDeleteVertex: false,
      canSplit: false,
      canTrim: false,
      canReverse: false,
      canRename: false,
      canDeleteLeg: false,
      canReroute: false,
      canRoute: false,
    };
  }
  const inLeg = selection !== null && selection.legId === leg.id;
  const from = inLeg ? selection.from : -1;
  const to = inLeg ? selection.to : null;
  const inRange = inLeg && from >= 0 && from < leg.points.length;
  const span =
    to !== null && Math.min(from, to) >= 0 && Math.max(from, to) < leg.points.length
      ? Math.max(from, to) - Math.min(from, to)
      : 0;
  return {
    canDeleteVertex: inRange && leg.points.length > 2,
    canSplit: inRange && from > 0 && from < leg.points.length - 1,
    canTrim: inRange && span >= 1,
    canReverse: leg.points.length >= 2,
    canRename: true,
    canDeleteLeg: (trip?.legs.length ?? 0) > 1,
    canReroute: inRange && span >= 1,
    canRoute: true,
  };
}

/** Delete the selected vertex. */
export function deleteVertexCommand(state: EditorUiState): EditCommand | null {
  const selection = state.selection;
  if (!selection) return null;
  return { type: 'delete-vertex', legId: selection.legId, index: selection.from };
}

/** Split the selected leg at the selected vertex. */
export function splitCommand(state: EditorUiState): EditCommand | null {
  const selection = state.selection;
  if (!selection) return null;
  return { type: 'split-leg', legId: selection.legId, index: selection.from };
}

/** Reverse the selected (or active) leg. */
export function reverseCommand(state: EditorUiState, trip: Trip | null): EditCommand | null {
  const leg = selectedLeg(state, trip);
  if (!leg) return null;
  return { type: 'reverse-leg', legId: leg.id };
}

/** Trim the leg to the selected span [from..to]; endpoints are inclusive. */
export function trimCommand(state: EditorUiState): EditCommand | null {
  const selection = state.selection;
  if (!selection || selection.to === null) return null;
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (from === to) return null;
  return { type: 'trim-leg', legId: selection.legId, from, to };
}

/** Rename the selected (or active) leg. Empty names are refused. */
export function renameCommand(state: EditorUiState, trip: Trip | null, name: string): EditCommand | null {
  const leg = selectedLeg(state, trip);
  const trimmed = name.trim();
  if (!leg || trimmed.length === 0 || trimmed === (leg.name ?? '')) return null;
  return { type: 'rename-leg', legId: leg.id, name: trimmed };
}

/** Delete the selected (or active) leg. */
export function deleteLegCommand(state: EditorUiState, trip: Trip | null): EditCommand | null {
  const leg = selectedLeg(state, trip);
  if (!leg) return null;
  return { type: 'delete-leg', legId: leg.id };
}

/** Move one vertex to a new position. */
export function moveVertexCommand(
  legId: string,
  index: number,
  point: RoutePoint,
): EditCommand {
  return { type: 'move', legId, index, point };
}

/**
 * Insert a vertex after the closest segment. `index` is the insertion index in
 * the leg's point array (i.e. the new point becomes `points[index]`).
 */
export function insertVertexCommand(legId: string, index: number, point: RoutePoint): EditCommand {
  return { type: 'insert', legId, index, point };
}

/**
 * One click in draw mode.
 *
 * A placeholder leg (`emptyLeg()`, created by "new trip") is *replaced* by the
 * drawn points; a real leg is extended. The first point is duplicated so the
 * leg keeps its "at least two points" invariant while the user is still
 * drawing; the duplicate disappears as soon as the second point arrives.
 */
export function drawPointCommand(
  state: EditorUiState,
  trip: Trip | null,
  point: RoutePoint,
  snapped = false,
): EditCommand | null {
  const leg = findLeg(trip, state.activeLegId);
  if (!leg) return null;
  if (state.drawReplacesLeg || isPlaceholderLeg(leg)) {
    const points = [...state.drawPoints, point];
    const padded = points.length === 1 ? [points[0], points[0]] : points;
    return {
      type: 'replace-span',
      legId: leg.id,
      from: 0,
      to: Math.max(0, leg.points.length - 1),
      points: padded,
      snapped,
    };
  }
  return { type: 'insert', legId: leg.id, index: leg.points.length, point };
}

/**
 * A vertex index near a clicked location, for "insert on segment click".
 * `points` are the leg vertices; returns the index the new point should take.
 */
export function insertionIndexForClick(
  points: readonly RoutePoint[],
  click: RoutePoint,
  project: (point: RoutePoint) => { x: number; y: number },
): number {
  if (points.length === 0) return 0;
  const target = project(click);
  let best = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = project(points[i]);
    const b = project(points[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
    }
    const projX = a.x + dx * t;
    const projY = a.y + dy * t;
    const distance = Math.hypot(target.x - projX, target.y - projY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i + 1;
    }
  }
  return best;
}

/** What a bare key does to the editor, if anything. Pure, so it is testable. */
export type EditorKeyAction = 'leave-mode' | 'undo' | 'delete-selection' | null;

export function editorKeyAction(
  mode: InteractionMode,
  key: string,
  options: { typing?: boolean; routePick?: boolean; panelOpen?: boolean } = {},
): EditorKeyAction {
  if (options.typing || options.panelOpen) return null;
  if (mode === 'view') return null;
  if (key === 'Escape') return options.routePick ? null : 'leave-mode';
  if (key === 'Backspace' && mode === 'draw') return 'undo';
  if (key === 'Delete' && mode === 'edit') return 'delete-selection';
  return null;
}
