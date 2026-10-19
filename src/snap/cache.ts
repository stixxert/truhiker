/**
 * IndexedDB cache for Turrutebasen boxes.
 *
 * - Keys are `<dataVersion>:<cellId>`. There is **no wall-clock TTL**: a cached
 *   box is valid for as long as the dataset version is unchanged. Bumping
 *   `dataVersion` makes every old entry unreachable without deleting anything.
 * - Payloads are gzip-compressed (via `CompressionStream`, available in every
 *   modern browser and Node ≥ 18). Where compression is unavailable the bytes
 *   are stored raw with a one-byte tag, so the format is self-describing.
 * - When IndexedDB is missing or fails to open (Node tests, Safari private
 *   mode, blocked storage), the same API transparently falls back to an
 *   in-memory store. Nothing is written to disk in that mode.
 * - `SnapCacheBackend` is the injection seam: tests and alternative clients can
 *   pass any `Map`-backed fake.
 */

/** Opaque byte store. Implement this to inject a fake cache. */
export interface SnapCacheBackend {
  /** Short label for diagnostics. */
  readonly name: string;
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

const TAG_RAW = 0;
const TAG_GZIP = 1;

function hasCompressionStream(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Compress a UTF-8 string to a self-describing byte payload:
 * `[TAG_RAW|TAG_GZIP, ...body]`.
 */
export async function compressString(text: string): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(text);
  if (!hasCompressionStream()) {
    const out = new Uint8Array(raw.length + 1);
    out[0] = TAG_RAW;
    out.set(raw, 1);
    return out;
  }
  const compressed = await streamToBytes(
    new Blob([toArrayBuffer(raw)]).stream().pipeThrough(new CompressionStream('gzip')),
  );
  const out = new Uint8Array(compressed.length + 1);
  out[0] = TAG_GZIP;
  out.set(compressed, 1);
  return out;
}

/** Inverse of `compressString`. */
export async function decompressString(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) throw new Error('Empty compressed payload');
  const tag = bytes[0];
  const body = bytes.subarray(1);
  if (tag === TAG_RAW) return new TextDecoder().decode(body);
  if (tag === TAG_GZIP) {
    if (!hasCompressionStream()) {
      throw new Error('Payload is gzip-compressed but DecompressionStream is unavailable');
    }
    const decompressed = await streamToBytes(
      new Blob([toArrayBuffer(body)]).stream().pipeThrough(new DecompressionStream('gzip')),
    );
    return new TextDecoder().decode(decompressed);
  }
  throw new Error(`Unknown compression tag ${tag} in cached payload`);
}

/** In-memory backend: tests, and the fallback when IndexedDB is unavailable. */
export function memoryBackend(): SnapCacheBackend {
  const store = new Map<string, Uint8Array>();
  return {
    name: 'memory',
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async clear() {
      store.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB backend
// ---------------------------------------------------------------------------

export interface IndexedDbBackendOptions {
  /** Database name. Default "npl-snap". */
  dbName?: string;
  /** Object store name. Default "boxes". */
  storeName?: string;
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return undefined;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * IndexedDB-backed store with an automatic in-memory fallback.
 *
 * The database is opened lazily on first use; if `indexedDB` is missing
 * (Node) or opening fails (private mode / blocked), all operations go to the
 * in-memory store instead of throwing.
 */
export function indexedDbBackend(options: IndexedDbBackendOptions = {}): SnapCacheBackend {
  const dbName = options.dbName ?? 'npl-snap';
  const storeName = options.storeName ?? 'boxes';
  const fallback = memoryBackend();
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  const open = (): Promise<IDBDatabase | null> => {
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      if (typeof indexedDB === 'undefined' || indexedDB === null) return null;
      try {
        return await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(dbName, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
          request.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });
      } catch {
        return null;
      }
    })();
    return dbPromise;
  };

  const withStore = async <T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T | null> => {
    const db = await open();
    if (!db) return null;
    try {
      const tx = db.transaction(storeName, mode);
      const result = await fn(tx.objectStore(storeName));
      await transactionDone(tx);
      return result;
    } catch {
      return null;
    }
  };

  return {
    name: 'indexeddb',
    async get(key) {
      const cached = await withStore('readonly', (store) => requestResult(store.get(key)));
      if (cached === null) return fallback.get(key);
      return toBytes(cached);
    },
    async set(key, value) {
      const ok = await withStore('readwrite', async (store) => {
        store.put(value, key);
        return true;
      });
      if (!ok) await fallback.set(key, value);
    },
    async delete(key) {
      const ok = await withStore('readwrite', async (store) => {
        store.delete(key);
        return true;
      });
      if (!ok) await fallback.delete(key);
    },
    async clear() {
      await withStore('readwrite', async (store) => {
        store.clear();
        return true;
      });
      await fallback.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Cache facade
// ---------------------------------------------------------------------------

/** Compose the versioned key. Cell ids are opaque strings (see prefetch.ts). */
export function snapCacheKey(dataVersion: string, cellId: string): string {
  if (!dataVersion) throw new RangeError('snapCacheKey: dataVersion must be non-empty');
  if (!cellId) throw new RangeError('snapCacheKey: cellId must be non-empty');
  return `${dataVersion}:${cellId}`;
}

export interface SnapCacheOptions {
  /** Dataset version; the only invalidation mechanism. Required. */
  dataVersion: string;
  /** Store to use. Default: IndexedDB with in-memory fallback. */
  backend?: SnapCacheBackend;
  /** Compress payloads. Default true. */
  compress?: boolean;
}

export interface SnapCacheStats {
  hits: number;
  misses: number;
  writes: number;
  errors: number;
}

/**
 * Typed JSON cache for parsed Turrutebasen boxes, keyed by cell.
 *
 * `get` treats a corrupt/undecodable entry as a miss and deletes it; a broken
 * cache must never break snapping.
 */
export class SnapCache {
  readonly dataVersion: string;
  readonly backend: SnapCacheBackend;
  private readonly compressEnabled: boolean;
  private readonly stats: SnapCacheStats = { hits: 0, misses: 0, writes: 0, errors: 0 };

  constructor(options: SnapCacheOptions) {
    if (!options.dataVersion) {
      throw new RangeError('SnapCache: dataVersion must be non-empty');
    }
    this.dataVersion = options.dataVersion;
    this.backend = options.backend ?? indexedDbBackend();
    this.compressEnabled = options.compress ?? true;
  }

  get statsSnapshot(): SnapCacheStats {
    return { ...this.stats };
  }

  /** Versioned key for a cell id. Exposed for tests and diagnostics. */
  keyFor(cellId: string): string {
    return snapCacheKey(this.dataVersion, cellId);
  }

  async get<T = unknown>(cellId: string): Promise<T | undefined> {
    const key = this.keyFor(cellId);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.backend.get(key);
    } catch {
      this.stats.errors++;
      return undefined;
    }
    if (!bytes) {
      this.stats.misses++;
      return undefined;
    }
    try {
      const text = this.compressEnabled
        ? await decompressString(bytes)
        : new TextDecoder().decode(bytes);
      const value = JSON.parse(text) as T;
      this.stats.hits++;
      return value;
    } catch {
      this.stats.errors++;
      await this.backend.delete(key).catch(() => undefined);
      return undefined;
    }
  }

  async set<T>(cellId: string, value: T): Promise<void> {
    const key = this.keyFor(cellId);
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError(`SnapCache.set: value for ${cellId} is not JSON-serialisable`);
    }
    try {
      const bytes = this.compressEnabled ? await compressString(text) : new TextEncoder().encode(text);
      await this.backend.set(key, bytes);
      this.stats.writes++;
    } catch {
      this.stats.errors++;
    }
  }

  async delete(cellId: string): Promise<void> {
    await this.backend.delete(this.keyFor(cellId)).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await this.backend.clear().catch(() => undefined);
  }
}
