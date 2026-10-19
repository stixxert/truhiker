/**
 * Load the engine bundle without taking the shell down with it.
 *
 * The map, the elevation profile and the GPX upload are Phase 2 features that
 * do not need any Phase 3 engine. If the engine chunk is missing (a partially
 * deployed build, a module still being written) the shell must still render and
 * say what is unavailable — a blank page is not a degradation state.
 */

import type { EngineSurface } from './engine-types';

interface EngineLoadResult {
  engines: EngineSurface | null;
  /** One line, technical, for a banner tooltip. */
  error: string | null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function loadEngines(): Promise<EngineLoadResult> {
  try {
    const module = await import('./engines');
    if (!module || typeof module.engines !== 'object' || module.engines === null) {
      return { engines: null, error: 'engine module has no `engines` export' };
    }
    return { engines: module.engines, error: null };
  } catch (error) {
    return { engines: null, error: messageOf(error) };
  }
}
