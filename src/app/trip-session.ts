/**
 * Trip session: the bridge between the route editor, the trip store and the UI.
 *
 * Everything that changes a trip goes through here, and every change follows
 * the same three steps:
 *
 *   1. the editor returns a **new** trip (never a mutated one);
 *   2. the session marks itself dirty and schedules an autosave (~1 s);
 *   3. a save either succeeds and stamps the time, or fails with a `StoreError`
 *      whose code becomes a specific, visible message.
 *
 * There is no silent failure path: a blocked `localStorage` is
 * `status.kind === 'unavailable'`, a full quota is `'error'` with
 * `code: 'quota-exceeded'`, and both are rendered by the status line.
 *
 * The class holds no DOM and no timers of its own — `schedule` is injected — so
 * the whole behaviour is unit-testable in Node.
 */

import {
  StoreError,
  type EditCommand,
  type RouteEditor,
  type StoreErrorCode,
  type Trip,
  type TripStore,
  type TripSummary,
} from '../contracts';
import { newTripId } from '../lib/ids';
import type { EngineSurface } from './engine-types';

/** Autosave delay after the last change, milliseconds. */
export const AUTOSAVE_DELAY_MS = 1000;

export type SaveStatusKind = 'idle' | 'dirty' | 'saved' | 'error' | 'unavailable';

export interface SaveStatus {
  readonly kind: SaveStatusKind;
  /** Epoch ms of the successful save that produced `kind: 'saved'`. */
  readonly at?: number;
  /** Plain-language message for `kind: 'error'`/`'unavailable'`. */
  readonly message?: string;
  /** `StoreError.code` when the store reported one. */
  readonly code?: StoreErrorCode;
}

export type ScheduleFn = (callback: () => void, delayMs: number) => () => void;

export interface TripSessionOptions {
  engines: EngineSurface;
  /** Storage to persist into; `null`/`undefined` means "use the default". */
  storage?: Storage | null;
  /** Inject a store (tests) instead of creating one from `storage`. */
  store?: TripStore | null;
  now?: () => Date;
  schedule?: ScheduleFn;
  onChange?: (session: TripSession) => void;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn any thrown value from the store into a renderable save status. */
export function saveStatusForError(error: unknown): SaveStatus {
  if (error instanceof StoreError) {
    return { kind: 'error', code: error.code, message: error.message };
  }
  return { kind: 'error', message: messageOf(error) };
}

export class TripSession {
  private readonly engines: EngineSurface;
  private readonly storage: Storage | null | undefined;
  private readonly now: () => Date;
  private readonly schedule: ScheduleFn;
  private readonly onChangeListener: ((session: TripSession) => void) | undefined;

  private store: TripStore | null = null;
  private storeError: string | null = null;
  private editorInstance: RouteEditor | null = null;
  private current: Trip | null = null;
  private status: SaveStatus = { kind: 'idle' };
  private cancelAutosave: (() => void) | null = null;
  private lastListError: SaveStatus | null = null;

  constructor(options: TripSessionOptions) {
    this.engines = options.engines;
    this.storage = options.storage;
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? defaultSchedule;
    this.onChangeListener = options.onChange;

    if (options.store !== undefined) {
      this.store = options.store;
      this.storeError = options.store === null ? 'no storage' : null;
      if (this.store === null) this.status = { kind: 'unavailable' };
    } else {
      try {
        this.store = this.engines.createTripStore(this.storage ?? undefined);
      } catch (error) {
        this.store = null;
        this.storeError = messageOf(error);
        this.status = { kind: 'unavailable', message: this.storeError };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reading state
  // -------------------------------------------------------------------------

  get trip(): Trip | null {
    return this.current;
  }

  get editor(): RouteEditor | null {
    return this.editorInstance;
  }

  get saveStatus(): SaveStatus {
    return this.status;
  }

  get canUndo(): boolean {
    return this.editorInstance?.canUndo ?? false;
  }

  get canRedo(): boolean {
    return this.editorInstance?.canRedo ?? false;
  }

  /** True when the session has a usable store (not blocked, not missing). */
  get persistent(): boolean {
    return this.store !== null;
  }

  /** Technical reason the store is unavailable, for a tooltip. */
  get storageProblem(): string | null {
    return this.storeError;
  }

  /** The error from the last `list()` call, if the index could not be read. */
  get listProblem(): SaveStatus | null {
    return this.lastListError;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Adopt a trip as the open trip. `save: 'now'` persists it immediately (used
   * for imports, where the user expects the file to be kept), otherwise the
   * debounced autosave picks it up.
   */
  adopt(
    trip: Trip,
    options: { save?: 'now' | 'deferred' | 'manual' } = {},
  ): Trip {
    this.cancelPending();
    this.editorInstance = this.engines.createEditor(trip);
    this.current = trip;
    this.setStatus({ kind: 'dirty' });
    if (options.save === 'now') this.saveNow();
    else if (options.save !== 'manual') this.scheduleAutosave();
    return trip;
  }

  /** Open a saved trip by id. Returns `null` when it is not there. */
  open(id: string): Trip | null {
    if (!this.store) return null;
    try {
      const trip = this.store.load(id);
      if (!trip) return null;
      this.cancelPending();
      this.editorInstance = this.engines.createEditor(trip);
      this.current = trip;
      this.setStatus({ kind: 'saved', at: this.now().getTime() });
      return trip;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  /** Forget the open trip without touching the store. */
  close(): void {
    this.cancelPending();
    this.editorInstance = null;
    this.current = null;
    this.setStatus({ kind: 'idle' });
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  /**
   * Apply one edit command through the editor. Returns the new trip, or `null`
   * when the editor refuses the command (an invalid split index, a delete that
   * would leave a one-point leg). The previous trip is kept in that case.
   */
  apply(command: EditCommand): Trip | null {
    if (!this.editorInstance) return null;
    let next: Trip;
    try {
      next = this.editorInstance.apply(command);
    } catch {
      return null;
    }
    return this.commit(next);
  }

  undo(): Trip | null {
    if (!this.editorInstance || !this.editorInstance.canUndo) return null;
    const next = this.editorInstance.undo();
    return this.commit(next);
  }

  redo(): Trip | null {
    if (!this.editorInstance || !this.editorInstance.canRedo) return null;
    const next = this.editorInstance.redo();
    return this.commit(next);
  }

  /**
   * Replace the trip wholesale for a change that is not an `EditCommand`
   * (profile, name, import, reroute result). History is cleared by
   * `editor.reset`, which is the documented path for a whole-trip replacement.
   */
  rewrite(trip: Trip): Trip {
    const next = this.touch(trip);
    if (this.editorInstance) {
      this.editorInstance.reset(next);
    } else {
      this.editorInstance = this.engines.createEditor(next);
    }
    return this.commit(next, { alreadyTouched: true });
  }

  /** Persist the current trip now, cancelling any pending autosave. */
  saveNow(): SaveStatus {
    this.cancelPending();
    if (!this.current) return this.status;
    if (!this.store) {
      this.setStatus({ kind: 'unavailable', message: this.storeError ?? undefined });
      return this.status;
    }
    try {
      this.store.save(this.current);
      this.setStatus({ kind: 'saved', at: this.now().getTime() });
    } catch (error) {
      this.setStatus(saveStatusForError(error));
    }
    return this.status;
  }

  // -------------------------------------------------------------------------
  // Library operations
  // -------------------------------------------------------------------------

  list(): TripSummary[] {
    if (!this.store) return [];
    try {
      const summaries = this.store.list();
      this.lastListError = null;
      return [...summaries].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    } catch (error) {
      this.lastListError = saveStatusForError(error);
      return [];
    }
  }

  remove(id: string): boolean {
    if (!this.store) return false;
    try {
      this.store.remove(id);
      if (this.current?.id === id) this.close();
      return true;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return false;
    }
  }

  /**
   * Rename a stored trip. When it is the open trip, the change goes through
   * `rewrite` so the editor and the autosave see it.
   */
  renameSaved(id: string, name: string): boolean {
    if (!this.store) return false;
    const trimmed = name.trim();
    if (trimmed.length === 0) return false;
    if (this.current?.id === id) {
      this.rewrite({ ...this.current, name: trimmed });
      this.saveNow();
      return true;
    }
    try {
      const trip = this.store.load(id);
      if (!trip) return false;
      this.store.save(this.touch({ ...trip, name: trimmed }));
      return true;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return false;
    }
  }

  /** Copy a stored trip under a new id and name. Returns the new id. */
  duplicate(id: string, nameSuffix: string): string | null {
    if (!this.store) return null;
    try {
      const trip = this.store.load(id);
      if (!trip) return null;
      const stamp = this.now().toISOString();
      const copy: Trip = {
        ...trip,
        id: newTripId(),
        name: `${trip.name} ${nameSuffix}`.trim(),
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.store.save(copy);
      return copy.id;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  /** Parse an uploaded file into a trip and adopt it, saving immediately. */
  importFile(text: string, filename: string): Trip {
    if (!this.store) {
      throw new StoreError('unsupported', this.storeError ?? 'storage unavailable');
    }
    const trip = this.store.fromFile(text, filename);
    this.adopt(trip, { save: 'now' });
    return trip;
  }

  exportGpx(options?: { legIds?: readonly string[]; includeElevation?: boolean }): string | null {
    if (!this.store || !this.current) return null;
    try {
      return this.store.toGpx(this.current, options);
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  exportGeoJson(): string | null {
    if (!this.store || !this.current) return null;
    try {
      return this.store.toGeoJson(this.current);
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  /** Export any stored trip without adopting it as the open trip. */
  exportGpxFor(id: string): string | null {
    if (!this.store) return null;
    try {
      const trip = this.current?.id === id ? this.current : this.store.load(id);
      return trip ? this.store.toGpx(trip) : null;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  exportGeoJsonFor(id: string): string | null {
    if (!this.store) return null;
    try {
      const trip = this.current?.id === id ? this.current : this.store.load(id);
      return trip ? this.store.toGeoJson(trip) : null;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private commit(next: Trip, options: { alreadyTouched?: boolean } = {}): Trip {
    this.current = options.alreadyTouched ? next : this.touch(next);
    this.setStatus({ kind: 'dirty' });
    this.scheduleAutosave();
    return this.current;
  }

  /** Stamp `updatedAt` on a new trip object; the input is never mutated. */
  private touch(trip: Trip): Trip {
    return { ...trip, updatedAt: this.now().toISOString() };
  }

  private scheduleAutosave(): void {
    this.cancelPending();
    this.cancelAutosave = this.schedule(() => {
      this.cancelAutosave = null;
      this.saveNow();
    }, AUTOSAVE_DELAY_MS);
  }

  private cancelPending(): void {
    if (this.cancelAutosave) {
      this.cancelAutosave();
      this.cancelAutosave = null;
    }
  }

  private setStatus(status: SaveStatus): void {
    this.status = status;
    this.onChangeListener?.(this);
  }
}
