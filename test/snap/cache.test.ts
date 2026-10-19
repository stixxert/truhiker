import { describe, expect, it } from 'vitest';

import {
  SnapCache,
  compressString,
  decompressString,
  indexedDbBackend,
  memoryBackend,
  snapCacheKey,
  type SnapCacheBackend,
} from '../../src/snap/cache';

interface FakeStore {
  backend: SnapCacheBackend;
  data: Map<string, Uint8Array>;
  gets: number;
  sets: number;
}

/** Small injectable fake, matching the interface the UI can supply. */
function fakeStore(): FakeStore {
  const data = new Map<string, Uint8Array>();
  const store: FakeStore = {
    data,
    gets: 0,
    sets: 0,
    backend: {
      name: 'fake',
      async get(key) {
        store.gets++;
        return data.get(key);
      },
      async set(key, value) {
        store.sets++;
        data.set(key, value);
      },
      async delete(key) {
        data.delete(key);
      },
      async clear() {
        data.clear();
      },
    },
  };
  return store;
}

const PAYLOAD = {
  lines: [
    {
      id: 'a',
      lokalId: 'a',
      attributes: { rutenummer: 'jot15', vedlikeholdsansvarlig: 'DNT' },
      coords: [{ lon: 8.3, lat: 61.5 }],
      srsName: 'urn:ogc:def:crs:EPSG::4258',
    },
  ],
};

describe('compression', () => {
  it('round-trips a string through the self-describing payload and rejects unknown or empty input', async () => {
    const text = JSON.stringify(PAYLOAD).repeat(20);
    const bytes = await compressString(text);
    expect(bytes.length).toBeGreaterThan(1);
    expect(bytes[0]).toBe(1); // gzip tag in Node/browsers with CompressionStream
    expect(Math.round(bytes.length / text.length)).toBeLessThan(1); // actually compressed
    expect(await decompressString(bytes)).toBe(text);

    await expect(decompressString(Uint8Array.from([99, 1, 2]))).rejects.toThrow(/Unknown compression/);
    await expect(decompressString(new Uint8Array(0))).rejects.toThrow(/Empty/);
  });
});

describe('SnapCache on an injected fake store', () => {
  it('round-trips a payload, counts a hit, and keys by dataVersion + cell', async () => {
    const store = fakeStore();
    const cache = new SnapCache({ dataVersion: 'v1', backend: store.backend });
    await cache.set('c:0.02:400:3075', PAYLOAD);
    expect(await cache.get('c:0.02:400:3075')).toEqual(PAYLOAD);
    expect(store.sets).toBe(1);
    expect(store.data.size).toBe(1);
    expect(cache.statsSnapshot.hits).toBe(1);

    await cache.set('cell-a', { value: 1 });
    expect(cache.keyFor('cell-a')).toBe('v1:cell-a');
    expect(store.data.has('v1:cell-a')).toBe(true);
    expect(snapCacheKey('v1', 'cell-a')).toBe('v1:cell-a');
  });

  it('invalidates everything when the data version changes and treats corrupt entries as misses', async () => {
    const store = fakeStore();
    const v1 = new SnapCache({ dataVersion: '2026-10', backend: store.backend });
    await v1.set('cell-a', PAYLOAD);
    expect(await v1.get('cell-a')).toEqual(PAYLOAD);

    const v2 = new SnapCache({ dataVersion: '2027-01', backend: store.backend });
    expect(await v2.get('cell-a')).toBeUndefined();
    // The old entry is still on disk but unreachable — no TTL involved.
    expect(store.data.has('2026-10:cell-a')).toBe(true);
    expect(v2.statsSnapshot.misses).toBe(1);

    // A corrupt entry is a miss, and is deleted rather than retried forever.
    store.data.set('2027-01:broken', Uint8Array.from([0, 0x7b, 0x7b])); // raw tag + "{"
    expect(await v2.get('broken')).toBeUndefined();
    expect(store.data.has('2027-01:broken')).toBe(false);
    expect(v2.statsSnapshot.errors).toBe(1);
  });

  it('stores compressed bytes by default and supports an uncompressed mode for debugging', async () => {
    const store = fakeStore();
    const cache = new SnapCache({ dataVersion: 'v1', backend: store.backend });
    await cache.set('cell-a', PAYLOAD);
    const stored = store.data.get('v1:cell-a') ?? new Uint8Array();
    expect(stored[0]).toBe(1); // gzip
    expect(new TextDecoder().decode(stored)).not.toContain('rutenummer'); // compressed, not plain JSON
    expect(await decompressString(stored)).toBe(JSON.stringify(PAYLOAD));

    const plainStore = fakeStore();
    const plain = new SnapCache({ dataVersion: 'v1', backend: plainStore.backend, compress: false });
    await plain.set('cell-a', PAYLOAD);
    const raw = plainStore.data.get('v1:cell-a') ?? new Uint8Array();
    expect(new TextDecoder().decode(raw)).toBe(JSON.stringify(PAYLOAD));
    expect(await plain.get('cell-a')).toEqual(PAYLOAD);
  });

  it('round-trips through memoryBackend and the IndexedDB fallback, and rejects invalid parameters', async () => {
    const backend = memoryBackend();
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(await backend.get('k')).toBeUndefined();
    await backend.set('k', bytes);
    expect(await backend.get('k')).toEqual(bytes);
    await backend.delete('k');
    expect(await backend.get('k')).toBeUndefined();
    await backend.set('k', bytes);
    await backend.clear();
    expect(await backend.get('k')).toBeUndefined();

    // Node has no global indexedDB by default; this must fall back to memory.
    const fallback = indexedDbBackend({ dbName: 'npl-snap-test', storeName: 'boxes' });
    const cache = new SnapCache({ dataVersion: 'v1', backend: fallback });
    await cache.set('cell-a', PAYLOAD);
    expect(await cache.get('cell-a')).toEqual(PAYLOAD);
    await cache.clear();
    expect(await cache.get('cell-a')).toBeUndefined();

    expect(() => new SnapCache({ dataVersion: '' })).toThrow(RangeError);
    expect(() => snapCacheKey('', 'cell')).toThrow(RangeError);
    expect(() => snapCacheKey('v1', '')).toThrow(RangeError);
  });
});
