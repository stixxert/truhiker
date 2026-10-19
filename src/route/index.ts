/**
 * Route editing engine — the public surface.
 *
 * Pure TypeScript, no DOM, no network, no rendering. The UI imports only this
 * module (see `src/route/README.md` for the command set, the undo model, and
 * exactly what "reroute" does and does not do).
 */

export { applyCommand, createEditor } from './editor';
export type { EditorOptions, RouteEditorWithCommands } from './editor';
export { RouteEditError } from './errors';
export type { RouteEditErrorCode } from './errors';
export { PLACEHOLDER_POINT, emptyLeg, tripFromPoints } from './leg';
export type { TripFromPointsOptions } from './leg';
export { recomputeLeg, tripDistanceM } from './metrics';
export { DEFAULT_REROUTE_RADIUS_M, rerouteSpan } from './reroute';
export type { RerouteOptions } from './reroute';
export type { MergeLegsCommand, RouteCommand } from './commands';
