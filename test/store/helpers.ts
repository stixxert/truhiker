/**
 * Test doubles and synthetic trips for the store tests.
 *
 * `FakeStorage` is a real `Storage` (the same interface the browser gives us)
 * with an optional byte budget so the quota path can be exercised without a
 * browser. Its `limit` counts UTF-16 code units, like the browsers' accounting.
 */

import type { Leg, RoutePoint, Trip } from '../../src/contracts';
import { emptyTrip, defaultProfile } from '../../src/store';
import { pathLength } from '../../src/core/geo';

export class FakeStorage implements Storage {
  private readonly data = new Map<string, string>();

  constructor(readonly limit: number = Number.POSITIVE_INFINITY) {}

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    const previous = this.data.get(key)?.length ?? 0;
    let used = previous * -1;
    for (const entry of this.data.values()) used += entry.length;
    if (used + value.length > this.limit) throw quotaError();
    this.data.set(key, value);
  }

  /** Every key currently held, in insertion order. */
  keys(): string[] {
    return [...this.data.keys()];
  }

  /** Raw snapshot, for asserting the on-disk layout. */
  snapshot(): Map<string, string> {
    return new Map(this.data);
  }

  /** Simulate another tab/user clearing everything. */
  sabotage(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** A `QuotaExceededError` as browsers raise it (name, and usually code 22). */
export function quotaError(code?: number): Error {
  const error = new Error('The quota has been exceeded.') as Error & { code?: number };
  error.name = 'QuotaExceededError';
  if (code !== undefined) error.code = code;
  return error;
}

/** Same failure reported only by legacy `code` (22) or Firefox's 1014. */
export function quotaErrorByCode(code: 22 | 1014): Error {
  const error = new Error('operation failed') as Error & { code?: number };
  error.code = code;
  return error;
}

/** A `Storage` whose writes always fail with the given error. */
export class ThrowingStorage extends FakeStorage {
  constructor(private readonly make: () => unknown) {
    super();
  }

  override setItem(): void {
    throw this.make();
  }
}

/** A leg with a straight-ish line and elevations rounded to 1 decimal. */
export function syntheticPoints(
  count: number,
  options: { elevation?: boolean } = {},
): RoutePoint[] {
  const elevation = options.elevation ?? true;
  const points: RoutePoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = count === 1 ? 0 : index / (count - 1);
    const lon = 8.2513 + t * 0.1245 + Math.sin(t * 6) * 0.0041;
    const lat = 61.1072 + t * 0.0917 - Math.cos(t * 4) * 0.0023;
    if (!elevation) {
      points.push({ lon, lat, eleSource: 'none' });
      continue;
    }
    const ele = Number((812.4 + 340 * Math.sin(t * Math.PI) + index * 0.7).toFixed(1));
    points.push({ lon, lat, ele, eleSource: 'dem' });
  }
  return points;
}

function legOf(points: readonly RoutePoint[], overrides: Partial<Leg> = {}): Leg {
  return {
    id: 'leg-1',
    name: 'Memurubu–Bessheim',
    points,
    provenance: [
      { kind: 'turrutebasen', label: 'jot21', licence: 'CC BY 4.0 ©Kartverket', url: 'https://ut.no/jot21' },
    ],
    distanceM: pathLength(points),
    ascentM: null,
    descentM: null,
    ...overrides,
  };
}

/** The canonical 50-point test route: one leg, every point with elevation. */
export function syntheticTrip(points: readonly RoutePoint[] = syntheticPoints(50)): Trip {
  const base = emptyTrip('Besseggen over', defaultProfile());
  return { ...base, id: 'trip-1', createdAt: '2024-06-01T08:00:00.000Z', updatedAt: '2024-06-01T09:30:00.000Z', legs: [legOf(points)] };
}

/** A second, deliberately different trip. */
export function otherTrip(): Trip {
  const base = emptyTrip('Rondane weekend', defaultProfile());
  return {
    ...base,
    id: 'trip-2',
    createdAt: '2024-07-01T08:00:00.000Z',
    updatedAt: '2024-07-02T08:00:00.000Z',
    notes: 'Hut at Rondvassbu booked.',
    legs: [
      legOf(syntheticPoints(8), { id: 'leg-a', name: 'Spranget–Rondvassbu' }),
      legOf(syntheticPoints(6, { elevation: false }), {
        id: 'leg-b',
        name: 'Rondvassbu–Bjørnholia',
        provenance: [{ kind: 'drawn', label: 'drawn by hand' }],
      }),
    ],
  };
}
