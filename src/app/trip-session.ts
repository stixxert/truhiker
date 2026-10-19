/**
 * Trip session: the bridge between the route editor, the trip store and the UI.
 *
 * Everything that changes a trip goes through here, and every change follows the
 * same three steps:
 *
 *   1. the editor returns a **new** trip (never a mutated one);
 *   2. the session marks itself dirty and schedules an autosave (~1 s);
 *   3. a save either succeeds and stamps the time, or fails with a `StoreError`
 *      whose code becomes a specific, visible message.
 *
 * Storage is asynchronous (IndexedDB is the durable backend), so every method
 * that touches it returns a promise. The status line has a `'saving'` state
 * between `'dirty'` and `'saved'`: a trip that has been handed to the store but
 * not yet committed is **not** shown as saved.
 *
 * There is no silent failure path: a blocked `localStorage` is
 * `status.kind === 'unavailable'`, a full quota is `'error'` with
 * `code: 'quota-exceeded'`, a rejected write is `'error'` with the message, and
 * all of them are rendered by the status line.
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
  type TripSummary,
} from '../contracts';
import type {
  AsyncTripStore,
  MigrationResult,
  StorageUsage,
  TripStorageInfo,
  TripStoreLike,
} from '../store/types';
import { newTripId } from '../lib/ids';
import type { EngineSurface } from './engine-types';

/** Autosave delay after the last change, milliseconds. */
export const AUTOSAVE_DELAY_MS = 1000;

export type SaveStatusKind = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'unavailable';

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
  store?: TripStoreLike | null;
  /** Inject the async store factory (tests) instead of `engines.createTripStorage`. */
  createStorage?: (options: { storage?: Storage | null }) => Promise<TripStoreLike>;
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

function newestFirst(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

function isAsyncStore(store: TripStoreLike): store is AsyncTripStore {
  return typeof (store as Partial<AsyncTripStore>).usage === 'function';
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
  private readonly createStorage: ((options: { storage?: Storage | null }) => Promise<TripStoreLike>) | null;
  private readonly now: () => Date;
  private readonly schedule: ScheduleFn;
  private readonly onChangeListener: ((session: TripSession) => void) | undefined;

  private store: TripStoreLike | null = null;
  private storeError: string | null = null;
  private editorInstance: RouteEditor | null = null;
  private current: Trip | null = null;
  private status: SaveStatus = { kind: 'idle' };
  private cancelAutosave: (() => void) | null = null;
  private lastListError: SaveStatus | null = null;

  /** Resolves once the storage backend has been chosen (or refused). */
  private readonly ready: Promise<void>;
  /** Bumped on every change, so a slow save cannot claim a newer trip. */
  private sequence = 0;
  /** Saves run one at a time, in the order they were requested. */
  private saveChain: Promise<unknown> = Promise.resolve();

  constructor(options: TripSessionOptions) {
    this.engines = options.engines;
    this.storage = options.storage;
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? defaultSchedule;
    this.onChangeListener = options.onChange;
    this.createStorage = options.createStorage ?? null;

    if (options.store !== undefined) {
      this.store = options.store;
      this.storeError = options.store === null ? 'no storage' : null;
      if (this.store === null) this.status = { kind: 'unavailable' };
      this.ready = Promise.resolve();
    } else {
      this.ready = this.openStore();
    }
  }

  /** Choose (and possibly open) the storage backend. Never throws. */
  private async openStore(): Promise<void> {
    try {
      const factory = this.createStorage ?? this.engines.createTripStorage;
      if (factory) {
        this.store = await factory({ storage: this.storage });
      } else {
        // A surface with no async factory (old tests): use its sync store.
        this.store = this.engines.createTripStore(this.storage ?? undefined);
      }
      if (!this.store) {
        this.storeError = 'no storage';
        this.setStatus({ kind: 'unavailable' });
      }
    } catch (error) {
      this.store = null;
      this.storeError = messageOf(error);
      this.setStatus({ kind: 'unavailable', message: this.storeError });
    }
  }

  // -------------------------------------------------------------------------
  // Reading state
  // -------------------------------------------------------------------------

  /** Resolves when the store is ready; the UI awaits this before its first list. */
  whenReady(): Promise<void> {
    return this.ready;
  }

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

  /** `indexeddb`, `localstorage`, or `null` when no store could be created. */
  get backend(): 'indexeddb' | 'localstorage' | null {
    const store = this.store;
    if (!store || !isAsyncStore(store)) return null;
    return store.backend;
  }

  /** Which backend, whether it is durable, and why not — for the library dialog. */
  get storageInfo(): TripStorageInfo | null {
    const store = this.store;
    if (!store || !isAsyncStore(store)) return null;
    return { backend: store.backend, persistent: store.persistent, problem: store.problem };
  }

  /** What the legacy localStorage import did, when the store performed one. */
  get migration(): MigrationResult | null {
    const store = this.store;
    if (!store || !isAsyncStore(store)) return null;
    return store.migration;
  }

  /** "x MB of ~y MB used". `null` when the browser reports nothing. */
  async usage(): Promise<StorageUsage | null> {
    await this.ready;
    const store = this.store;
    if (!store || !isAsyncStore(store)) return null;
    try {
      return await store.usage();
    } catch {
      return null;
    }
  }

  /** The error from the last `list()` call, if the store could not be read. */
  get listProblem(): SaveStatus | null {
    return this.lastListError;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Adopt a trip as the open trip. `save: 'now'` hands it to the store
   * immediately (used for imports, where the user expects the file to be kept)
   * — the status goes to `'saving'` and only becomes `'saved'` when the write
   * commits. Otherwise the debounced autosave picks it up.
   */
  adopt(trip: Trip, options: { save?: 'now' | 'deferred' | 'manual' } = {}): Trip {
    this.cancelPending();
    this.editorInstance = this.engines.createEditor(trip);
    this.current = trip;
    this.sequence += 1;
    this.setStatus({ kind: 'dirty' });
    if (options.save === 'now') void this.saveNow();
    else if (options.save !== 'manual') this.scheduleAutosave();
    return trip;
  }

  /** Open a saved trip by id. Returns `null` when it is not there. */
  async open(id: string): Promise<Trip | null> {
    await this.ready;
    if (!this.store) return null;
    try {
      const trip = await this.store.load(id);
      if (!trip) return null;
      this.cancelPending();
      this.editorInstance = this.engines.createEditor(trip);
      this.current = trip;
      this.sequence += 1;
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

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  /**
   * Persist the current trip now and resolve once the write has committed (or
   * failed). The status is `'saving'` from the moment this is called until the
   * store answers — never `'saved'` for a write that has not landed.
   */
  saveNow(): Promise<SaveStatus> {
    this.cancelPending();
    const trip = this.current;
    if (!trip) return Promise.resolve(this.status);
    const sequence = this.sequence;
    this.setStatus({ kind: 'saving' });
    const run = this.saveChain.then(() => this.write(trip, sequence));
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Flush a pending autosave. Called on `pagehide`/`visibilitychange`: the
   * browser may not give an async write time to finish, which is why
   * `docs/12-storage.md` still lists "an edit in the last second" as a loss.
   */
  async flush(): Promise<void> {
    await this.ready;
    const pending = this.cancelAutosave !== null;
    this.cancelPending();
    if (!this.current) {
      await this.saveChain;
      return;
    }
    if (!pending && this.status.kind !== 'dirty') {
      // Nothing changed, but a write may still be committing: wait for it so
      // the status the caller reads afterwards is the final one.
      await this.saveChain;
      return;
    }
    await this.saveNow();
  }

  private async write(trip: Trip, sequence: number): Promise<SaveStatus> {
    await this.ready;
    const store = this.store;
    if (!store) {
      this.setStatus({ kind: 'unavailable', message: this.storeError ?? undefined });
      return this.status;
    }
    try {
      await store.save(trip);
      // A write for a trip that is no longer open must not touch the status of
      // the current one: opening B while A's write was queued used to stamp a
      // freshly-opened, saved B as "not saved" (or as an error).
      if (this.current?.id !== trip.id) return this.status;
      // A newer edit landed while this write was in flight: the stored trip is
      // the old one, so the status must not claim it is saved.
      if (sequence === this.sequence) this.setStatus({ kind: 'saved', at: this.now().getTime() });
      else if (this.status.kind !== 'saving') this.setStatus({ kind: 'dirty' });
    } catch (error) {
      if (this.current?.id !== trip.id) return this.status;
      this.setStatus(saveStatusForError(error));
    }
    return this.status;
  }

  // -------------------------------------------------------------------------
  // Library operations
  // -------------------------------------------------------------------------

  async list(): Promise<TripSummary[]> {
    await this.ready;
    if (!this.store) return [];
    try {
      const summaries = await this.store.list();
      this.lastListError = null;
      return [...summaries].sort(newestFirst);
    } catch (error) {
      this.lastListError = saveStatusForError(error);
      return [];
    }
  }

  async remove(id: string): Promise<boolean> {
    await this.ready;
    if (!this.store) return false;
    try {
      await this.store.remove(id);
      if (this.current?.id === id) this.close();
      return true;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return false;
    }
  }

  /**
   * Rename a stored trip. When it is the open trip, the change goes through
   * `rewrite` so the editor and the autosave see it, and the save is awaited
   * before this resolves.
   */
  async renameSaved(id: string, name: string): Promise<boolean> {
    await this.ready;
    if (!this.store) return false;
    const trimmed = name.trim();
    if (trimmed.length === 0) return false;
    if (this.current?.id === id) {
      this.rewrite({ ...this.current, name: trimmed });
      const status = await this.saveNow();
      return status.kind !== 'error';
    }
    try {
      const trip = await this.store.load(id);
      if (!trip) return false;
      await this.store.save(this.touch({ ...trip, name: trimmed }));
      return true;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return false;
    }
  }

  /** Copy a stored trip under a new id and name. Returns the new id. */
  async duplicate(id: string, nameSuffix: string): Promise<string | null> {
    await this.ready;
    if (!this.store) return null;
    try {
      const trip = await this.store.load(id);
      if (!trip) return null;
      const stamp = this.now().toISOString();
      const copy: Trip = {
        ...trip,
        id: newTripId(),
        name: `${trip.name} ${nameSuffix}`.trim(),
        createdAt: stamp,
        updatedAt: stamp,
      };
      await this.store.save(copy);
      return copy.id;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  /** Parse an uploaded file into a trip, adopt it and save it before resolving. */
  async importFile(text: string, filename: string): Promise<Trip> {
    await this.ready;
    if (!this.store) {
      throw new StoreError('unsupported', this.storeError ?? 'storage unavailable');
    }
    const trip = this.store.fromFile(text, filename);
    this.adopt(trip, { save: 'manual' });
    // Awaited so the caller (and the library list) sees the saved row; a failed
    // write is reported through the status line, not thrown at the importer.
    await this.saveNow();
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
  async exportGpxFor(id: string): Promise<string | null> {
    const trip = await this.loadForExport(id);
    if (!trip) return null;
    try {
      return this.store ? this.store.toGpx(trip) : null;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  async exportGeoJsonFor(id: string): Promise<string | null> {
    const trip = await this.loadForExport(id);
    if (!trip) return null;
    try {
      return this.store ? this.store.toGeoJson(trip) : null;
    } catch (error) {
      this.setStatus(saveStatusForError(error));
      return null;
    }
  }

  private async loadForExport(id: string): Promise<Trip | null> {
    await this.ready;
    if (this.current?.id === id) return this.current;
    if (!this.store) return null;
    try {
      return await this.store.load(id);
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
    this.sequence += 1;
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
      void this.saveNow();
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
