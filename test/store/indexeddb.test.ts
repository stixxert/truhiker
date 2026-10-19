/**
 * The IndexedDB backend, over `fake-indexeddb` — a real `IDBFactory`
 * implementation, so the transactions, the object stores and the structured
 * clone are exercised rather than mocked.
 *
 * The two properties that justify the design are asserted on the transaction
 * itself: `list()` opens a transaction over `summaries` **only** (so a 10 MB
 * body is never read to draw a row), and `save`/`remove` open **one**
 * transaction over both stores (so a summary can never outlive its body).
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { StoreError } from '../../src/contracts';
import {
  BODIES,
  DB_NAME,
  INDEX_KEY,
  MAX_TRIP_BYTES,
  SUMMARIES,
  byteSize,
  createIndexedDbTripStore,
  createTripStorage,
  createTripStore,
  tripKey,
  type AsyncTripStore,
} from '../../src/store';
import { FakeStorage, syntheticTrip, otherTrip } from './helpers';

interface TransactionRecorder {
  stores: string[];
  mode: IDBTransactionMode;
}

interface Instrumented {
  factory: IDBFactory;
  inner: IDBFactory;
  transactions: TransactionRecorder[];
}

/**
 * A factory that records every transaction the store opens, and exposes the
 * inner factory so a test can tamper with the database directly.
 */
function instrumented(options: { refuseWrites?: boolean } = {}): Instrumented {
  const inner = new IDBFactory();
  const transactions: TransactionRecorder[] = [];
  const factory = {
    open(name: string, version?: number) {
      const opening = inner.open(name, version);
      opening.addEventListener('success', () => {
        const database = opening.result;
        const original = database.transaction.bind(database);
        (database as unknown as { transaction: unknown }).transaction = (
          stores: string | string[],
          mode?: IDBTransactionMode,
          transactionOptions?: IDBTransactionOptions,
        ) => {
          const names = Array.isArray(stores) ? stores : [stores];
          transactions.push({ stores: names, mode: mode ?? 'readonly' });
          if (options.refuseWrites && mode === 'readwrite') {
            throw new DOMException('the browser refused the write', 'QuotaExceededError');
          }
          return original(names, mode, transactionOptions);
        };
      });
      return opening;
    },
    deleteDatabase(name: string) {
      return inner.deleteDatabase(name);
    },
    cmp(a: IDBValidKey, b: IDBValidKey) {
      return inner.cmp(a, b);
    },
  } as unknown as IDBFactory;
  return { factory, inner, transactions };
}

/** Write straight into the database, bypassing the store's own validation. */
async function corruptBody(inner: IDBFactory, id: string): Promise<void> {
  const opening = inner.open(DB_NAME, 1);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction([BODIES], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(BODIES).put({ id, not: 'a trip' });
  });
  database.close();
}

async function storeWith(
  options: {
    maxBytes?: number;
    storage?: Storage;
    migrate?: boolean;
  } = {},
): Promise<{ store: AsyncTripStore; recorder: Instrumented }> {
  const recorder = instrumented();
  const store = await createTripStorage({
    factory: recorder.factory,
    storage: options.storage ?? new FakeStorage(),
    maxBytes: options.maxBytes,
    migrate: options.migrate,
    estimate: async () => ({ usage: 2_048, quota: 8_000_000_000 }),
  });
  return { store, recorder };
}

describe('IndexedDB store', () => {
  it('round-trips a trip as a structured clone, keeps a summary beside it, and lists from summaries only', async () => {
    const { store, recorder } = await storeWith();
    const first = syntheticTrip();
    const second = otherTrip();
    await store.save(first);
    await store.save(second);

    // A save is one transaction over both stores.
    expect(recorder.transactions.at(-1)).toEqual({ stores: [BODIES, SUMMARIES], mode: 'readwrite' });
    // The body is the trip object itself, so unknown fields survive untouched.
    expect(await store.load(first.id)).toStrictEqual(first);

    const summaries = await store.list();
    expect(summaries.map((row) => row.id)).toEqual(['trip-2', 'trip-1']);
    expect(summaries[1]).toMatchObject({
      id: 'trip-1',
      name: 'Besseggen over',
      updatedAt: '2024-06-01T09:30:00.000Z',
      legCount: 1,
    });
    expect(summaries[1]!.byteSize).toBeGreaterThan(1_000);

    // `list` never opens the body store: that is why it can draw a row for a
    // 10 MB trip without deserialising it.
    expect(recorder.transactions.at(-1)).toEqual({ stores: [SUMMARIES], mode: 'readonly' });

    // Even a body that is not a trip cannot hide its row — and does not throw.
    await corruptBody(recorder.inner, first.id);
    expect((await store.list()).map((row) => row.id)).toEqual(['trip-2', 'trip-1']);
    expect(await store.load(first.id)).toBeNull();
  });

  it('deletes body and summary in one transaction and refuses a trip over the per-trip ceiling with its size', async () => {
    const { store, recorder } = await storeWith();
    await store.save(syntheticTrip());
    await store.remove(syntheticTrip().id);
    expect(recorder.transactions.at(-1)).toEqual({ stores: [BODIES, SUMMARIES], mode: 'readwrite' });
    expect(await store.list()).toEqual([]);
    expect(await store.load(syntheticTrip().id)).toBeNull();
    // An unknown id is a no-op, not an error.
    await expect(store.remove('missing')).resolves.toBeUndefined();

    const trip = syntheticTrip();
    const bytes = byteSize(JSON.stringify(trip));
    const tiny = await storeWith({ maxBytes: 500 });
    const error = await tiny.store.save(trip).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe('quota-exceeded');
    expect((error as StoreError).message).toContain(String(bytes));
    expect((error as StoreError).message).toMatch(/per-trip storage limit/);
    expect(await tiny.store.list()).toEqual([]);

    // And the deprecated 1.5 MB localStorage cap does not apply here.
    expect(bytes).toBeLessThan(MAX_TRIP_BYTES);
  });

  it('maps a browser quota refusal to StoreError("quota-exceeded") naming the size', async () => {
    const recorder = instrumented({ refuseWrites: true });
    const store = await createTripStorage({ factory: recorder.factory, storage: new FakeStorage() });
    const trip = syntheticTrip();
    const error = await store.save(trip).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe('quota-exceeded');
    expect((error as StoreError).message).toContain('storage is full');
    expect((error as StoreError).message).toMatch(/\d+ bytes/);
    expect((error as StoreError).message).toMatch(/download/i);
    expect(await store.load(trip.id)).toBeNull();
  });

  it('migrates the localStorage trips in one transaction, removes the old keys after it commits, and is idempotent', async () => {
    const storage = new FakeStorage();
    const legacy = createTripStore(storage);
    legacy.save(syntheticTrip());
    legacy.save(otherTrip());
    // A body this build cannot read must be kept, not deleted.
    storage.sabotage(tripKey('broken'), 'surely not json');
    storage.sabotage(INDEX_KEY, JSON.stringify([syntheticTrip().id, otherTrip().id, 'broken']));

    const { store, recorder } = await storeWith({ storage });
    expect(store.migration).toEqual({ imported: 2, removed: 2, skipped: 1 });
    expect(await store.load(syntheticTrip().id)).toStrictEqual(syntheticTrip());
    expect(await store.load(otherTrip().id)).toStrictEqual(otherTrip());
    // The migration write is one transaction over both stores.
    expect(
      recorder.transactions.some(
        (tx) => tx.mode === 'readwrite' && tx.stores.includes(BODIES) && tx.stores.includes(SUMMARIES),
      ),
    ).toBe(true);

    // Old keys gone, except the unreadable one.
    expect(storage.getItem(tripKey(syntheticTrip().id))).toBeNull();
    expect(storage.getItem(tripKey(otherTrip().id))).toBeNull();
    expect(storage.getItem(tripKey('broken'))).not.toBeNull();
    expect(storage.getItem(INDEX_KEY)).toBe(JSON.stringify(['broken']));

    // Running it again imports nothing and destroys nothing.
    expect(await store.migrateLegacy?.(storage)).toEqual({ imported: 0, removed: 0, skipped: 1 });
    expect((await store.list()).length).toBe(2);
  });

  it('leaves the localStorage copy untouched when the import transaction fails', async () => {
    const storage = new FakeStorage();
    createTripStore(storage).save(syntheticTrip());

    const recorder = instrumented({ refuseWrites: true });
    const store = await createTripStorage({ factory: recorder.factory, storage });

    expect(store.backend).toBe('indexeddb');
    expect(store.migration?.imported).toBe(0);
    expect(store.migration?.error).toMatch(/refused/i);
    expect(await store.load(syntheticTrip().id)).toBeNull();
    // The only copy is still on disk, unchanged.
    expect(storage.getItem(tripKey(syntheticTrip().id))).not.toBeNull();
    expect(storage.getItem(INDEX_KEY)).toBe(JSON.stringify([syntheticTrip().id]));
  });

  it('falls back to the localStorage store with a stated reason, and reports the usage it can measure', async () => {
    const storage = new FakeStorage();
    const store = await createTripStorage({ factory: null, storage });
    expect(store.backend).toBe('localstorage');
    expect(store.problem).toContain('IndexedDB is not available');
    expect(store.problem).toContain('localStorage');

    await store.save(syntheticTrip());
    expect(await store.load(syntheticTrip().id)).toStrictEqual(syntheticTrip());
    const usage = await store.usage();
    expect(usage?.source).toBe('localstorage-estimate');
    expect(usage!.usedBytes).toBeGreaterThan(0);
    expect(usage!.quotaBytes).toBe(5_000_000);

    // An IndexedDB that cannot be opened is the same story, with the reason.
    const refuses = {
      open() {
        throw new DOMException('blocked by policy', 'InvalidStateError');
      },
    } as unknown as IDBFactory;
    const fallback = await createTripStorage({ factory: refuses, storage: new FakeStorage() });
    expect(fallback.backend).toBe('localstorage');
    expect(fallback.problem).toContain('IndexedDB could not be opened');
    expect(fallback.problem).toContain('blocked by policy');

    // On IndexedDB, usage and persistence come from the browser itself.
    const reported = instrumented();
    const measured = createIndexedDbTripStore({
      factory: reported.factory,
      estimate: async () => ({ usage: 12_300_000, quota: 8_000_000_000 }),
      persist: async () => true,
    });
    await measured.ready();
    expect(await measured.requestPersistence()).toBe(true);
    expect(measured.persistent).toBe(true);
    expect(await measured.usage()).toEqual({
      usedBytes: 12_300_000,
      quotaBytes: 8_000_000_000,
      source: 'indexeddb',
    });

    // A browser with no `StorageManager` at all reports nothing rather than 0.
    const bare = createIndexedDbTripStore({ factory: reported.factory, estimate: async () => null });
    expect(await bare.usage()).toBeNull();
    // `persist()` failing is not an error, it is a state.
    expect(await bare.requestPersistence()).toBe(false);
  });
});
