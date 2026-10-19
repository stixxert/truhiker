/**
 * Identifier generation for legs and trips.
 *
 * Ids only have to be unique within a store, not globally secret. `randomUUID`
 * is used where the platform has it (all current browsers, Node 18+); the
 * fallback keeps the module usable in a bare test or worker context.
 */

let counter = 0;

export function newId(prefix: 'leg' | 'trip' = 'leg'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
