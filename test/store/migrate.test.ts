import { describe, expect, it } from 'vitest';

import { StoreError } from '../../src/contracts';
import { CURRENT_SCHEMA_VERSION, migrate, validateTrip } from '../../src/store/trip';
import { syntheticTrip } from './helpers';

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('migrate', () => {
  it('passes a current body through untouched, keeps unknown fields and reads a missing version as v1', () => {
    const trip = syntheticTrip();
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(migrate(JSON.parse(JSON.stringify(trip)))).toStrictEqual(trip);

    const raw = { ...JSON.parse(JSON.stringify(trip)), future: { a: 1 } };
    expect((migrate(raw) as unknown as Record<string, unknown>).future).toEqual({ a: 1 });

    const { schemaVersion: _dropped, ...withoutVersion } = JSON.parse(JSON.stringify(trip));
    expect(migrate(withoutVersion).schemaVersion).toBe(1);
  });

  it('refuses a body from a newer build, and treats nonsense versions and shapes as corrupt', () => {
    const unsupported = codeOf(() => migrate({ ...syntheticTrip(), schemaVersion: 7 }));
    expect(unsupported).toBeInstanceOf(StoreError);
    expect((unsupported as StoreError).code).toBe('unsupported');
    expect((unsupported as StoreError).message).toContain('7');

    const corruptBodies: unknown[] = [
      null,
      [],
      'trip',
      { ...syntheticTrip(), schemaVersion: 0 },
      { ...syntheticTrip(), schemaVersion: 'v1' },
    ];
    for (const raw of corruptBodies) {
      const thrown = codeOf(() => migrate(raw));
      expect(thrown).toBeInstanceOf(StoreError);
      expect((thrown as StoreError).code).toBe('corrupt');
    }
  });
});

describe('validateTrip', () => {
  it('accepts a well-formed trip (null metrics included) and rejects a bad point or a non-numeric distance', () => {
    expect(() => validateTrip(syntheticTrip())).not.toThrow();

    const trip = syntheticTrip() as unknown as Record<string, unknown>;
    const errors = (legs: unknown[]): unknown => codeOf(() => validateTrip({ ...trip, legs }));

    expect(errors([{ id: 'leg', points: [{ lon: 8, lat: 'x' }], provenance: [], distanceM: null }])).toBeInstanceOf(
      StoreError,
    );
    expect(errors([{ id: 'leg', points: [], provenance: [], distanceM: 'far' }])).toBeInstanceOf(StoreError);
    expect(() =>
      validateTrip({
        ...trip,
        legs: [{ id: 'leg', points: [], provenance: [], distanceM: null, ascentM: null, descentM: null }],
      }),
    ).not.toThrow();
  });
});
