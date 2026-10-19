/**
 * Acceptance #2 — import → sample → edit → export → import, and lose nothing.
 *
 * Closes the seam between the store (GPX in/out), the DEM sampler (elevations)
 * and the route editor (edits). The fixture is the synthetic
 * `gjendesheim-besseggen.gpx` that used to be unused, so it is now either
 * exercised or gone.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { pathLength } from '../../src/core/geo';
import { createEditor, recomputeLeg } from '../../src/route';
import { createTripStore } from '../../src/store';

const FIXTURE = readFileSync(
  new URL('../fixtures/gjendesheim-besseggen.gpx', import.meta.url),
  'utf8',
);

/** A smooth there-and-back profile, on the 10 cm grid GPX preserves exactly. */
function elevationAt(t: number): number {
  return Math.round((1000 + 500 * Math.sin(Math.PI * t)) * 10) / 10;
}

describe('acceptance: a GPX round-trip of an edited trip', () => {
  it('keeps distance, the elevation array, ascent/descent and the upload provenance', () => {
    const store = createTripStore();

    // 1. Import the committed fixture.
    const imported = store.fromFile(FIXTURE, 'gjendesheim-besseggen.gpx');
    expect(imported.legs).toHaveLength(1);
    const original = imported.legs[0]!;
    expect(original.points.length).toBeGreaterThanOrEqual(2);

    // 2. Sample DEM elevations (offline, deterministic) and recompute the leg.
    const n = original.points.length;
    const sampled = original.points.map((point, index) => ({
      ...point,
      ele: elevationAt(index / (n - 1)),
      eleSource: 'dem' as const,
    }));
    const sampledLeg = recomputeLeg({ ...original, points: sampled });
    // The peak of sin(πt) at t = 3/7 is 1487.5 m: 487.5 m up and down.
    expect(sampledLeg.ascentM).toBeCloseTo(487.5, 1);
    expect(sampledLeg.descentM).toBeCloseTo(487.5, 1);
    const sampledTrip = { ...imported, legs: [sampledLeg] };

    // 3. Edit it: insert a vertex between two existing ones, on the same profile.
    const insertAt = 4;
    const before = sampledLeg.points[insertAt - 1]!;
    const after = sampledLeg.points[insertAt]!;
    const inserted = createEditor(sampledTrip).apply({
      type: 'insert',
      legId: sampledLeg.id,
      index: insertAt,
      point: {
        lon: (before.lon + after.lon) / 2,
        lat: (before.lat + after.lat) / 2,
        ele: Math.round(((before.ele! + after.ele!) / 2) * 10) / 10,
        eleSource: 'dem',
      },
    });
    const edited = inserted.legs[0]!;
    expect(edited.points).toHaveLength(n + 1);

    // 4. Export and re-import.
    const xml = store.toGpx(inserted);
    const roundTripped = store.fromFile(xml, 'edited.gpx');
    expect(roundTripped.legs).toHaveLength(1);
    const restored = roundTripped.legs[0]!;

    // Distance within 1 m.
    expect(Math.abs(pathLength(restored.points) - (edited.distanceM as number))).toBeLessThan(1);

    // The elevation array, element by element.
    expect(restored.points.map((point) => point.ele)).toEqual(
      edited.points.map((point) => point.ele),
    );

    // Ascent and descent within 0.5 m — the numbers a hiker plans with.
    expect(Math.abs((restored.ascentM as number) - (edited.ascentM as number))).toBeLessThan(0.5);
    expect(Math.abs((restored.descentM as number) - (edited.descentM as number))).toBeLessThan(0.5);

    // The provenance of the uploaded file survives (the edited marker is
    // leg-level UI state; GPX carries the source attribution).
    const upload = edited.provenance.find((entry) => entry.kind === 'gpx-upload');
    expect(upload).toBeDefined();
    expect(restored.provenance).toContainEqual(upload);
    expect(restored.provenance[0]!.kind).toBe('gpx-upload');
    expect(restored.points.every((point) => point.eleSource === 'dem')).toBe(true);
  });
});
