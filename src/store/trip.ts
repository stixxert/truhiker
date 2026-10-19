/**
 * Trip shape: defaults, validation and the migration hook.
 *
 * Everything here is deliberately small. The store writes what it is given; it
 * does not tidy a trip on the way in, because a save/load cycle must deep-equal
 * the trip the caller handed us. The only transformation is *validation* —
 * enough to know that the object is a trip, never enough to rewrite it.
 *
 * Unknown fields are preserved: the parsed JSON object is returned as-is (with
 * its own leg objects untouched), so a newer field survives a read/write cycle.
 */

import type { Trip, UserProfile } from '../contracts';
import { StoreError } from '../contracts';

/** The only schema version this build writes. */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * A migration takes a raw parsed body at `version` and returns the body at
 * `version + 1`. It must never drop a field it does not understand.
 *
 * There are no migrations yet — v1 is the first persisted shape — but the hook
 * exists so that bumping `schemaVersion` is a local change rather than a
 * redesign. Add `1: (raw) => ({ ...raw, schemaVersion: 2, /* new field *\/ })`
 * here and bump `CURRENT_SCHEMA_VERSION`.
 */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({});

let idCounter = 0;

/** Random id; falls back to a time+counter id where `crypto` is unavailable. */
export function newId(prefix = 'trip'): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    try {
      return cryptoObject.randomUUID();
    } catch {
      // insecure context — fall through
    }
  }
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * A sensible starting profile, so the first screen is not empty.
 *
 * These are **placeholders, not assumptions about the user**: 75 kg / 178 cm /
 * 35 years / male / 12 kg pack / 20 km and 8 h per day, carrying all food.
 * Every one of them is editable and none is derived from the route. See
 * `README.md` in this directory.
 */
export function defaultProfile(): UserProfile {
  return {
    massKg: 75,
    heightCm: 178,
    ageYears: 35,
    sex: 'male',
    packBaseKg: 12,
    dailyKm: 20,
    dailyHours: 8,
    support: 'carry-all',
  };
}

/** A trip with no legs. Valid, exportable, and ready for the first point. */
export function emptyTrip(name: string, profile: UserProfile): Trip {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    legs: [],
    profile,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function corrupt(detail: string): never {
  throw new StoreError('corrupt', `Trip is not a valid trip: ${detail}`);
}

function validatePoint(raw: unknown, legIndex: number, pointIndex: number): void {
  if (!isRecord(raw)) corrupt(`leg #${legIndex} point #${pointIndex} is not an object`);
  if (!isFiniteNumber(raw.lon) || Math.abs(raw.lon) > 180) {
    corrupt(`leg #${legIndex} point #${pointIndex} has no valid lon`);
  }
  if (!isFiniteNumber(raw.lat) || Math.abs(raw.lat) > 90) {
    corrupt(`leg #${legIndex} point #${pointIndex} has no valid lat`);
  }
  if (raw.ele !== undefined && !isFiniteNumber(raw.ele)) {
    corrupt(`leg #${legIndex} point #${pointIndex} has a non-numeric ele`);
  }
}

function validateLeg(raw: unknown, legIndex: number): void {
  if (!isRecord(raw)) corrupt(`leg #${legIndex} is not an object`);
  if (typeof raw.id !== 'string' || raw.id === '') corrupt(`leg #${legIndex} has no id`);
  if (!Array.isArray(raw.points)) corrupt(`leg #${legIndex} has no points array`);
  raw.points.forEach((point, pointIndex) => validatePoint(point, legIndex, pointIndex));
  if (raw.distanceM !== null && raw.distanceM !== undefined && !isFiniteNumber(raw.distanceM)) {
    corrupt(`leg #${legIndex} has a non-numeric distanceM`);
  }
  if (raw.provenance !== undefined && !Array.isArray(raw.provenance)) {
    corrupt(`leg #${legIndex} has a non-array provenance`);
  }
}

/**
 * Minimal shape check. Coordinates and the identifiers are checked; anything
 * else — new provenance kinds, new profile fields — is left exactly as found.
 */
export function validateTrip(raw: unknown): Trip {
  if (!isRecord(raw)) corrupt('not an object');
  if (typeof raw.id !== 'string' || raw.id === '') corrupt('no id');
  if (typeof raw.name !== 'string') corrupt('no name');
  if (typeof raw.createdAt !== 'string') corrupt('no createdAt');
  if (typeof raw.updatedAt !== 'string') corrupt('no updatedAt');
  if (!Array.isArray(raw.legs)) corrupt('no legs array');
  if (!isRecord(raw.profile)) corrupt('no profile');
  raw.legs.forEach((leg, index) => validateLeg(leg, index));
  return raw as unknown as Trip;
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read the `schemaVersion` of a parsed body and migrate it forward to the
 * current version.
 *
 * - A future version is an error, not a guess: `StoreError('unsupported')`.
 * - A missing version is treated as v1 — every body this build has ever written
 *   carried one, and refusing to read an otherwise valid trip would be worse.
 * - Each step runs through `MIGRATIONS`; a missing step is `unsupported`.
 */
export function migrate(raw: unknown): Trip {
  if (!isRecord(raw)) corrupt('not an object');

  const declared = raw.schemaVersion;
  let version: number;
  if (declared === undefined) {
    version = 1;
  } else if (isFiniteNumber(declared) && Number.isInteger(declared) && declared >= 1) {
    version = declared;
  } else {
    corrupt(`invalid schemaVersion ${String(declared)}`);
  }

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new StoreError(
      'unsupported',
      `Trip was saved with schemaVersion ${version}; this build understands ${CURRENT_SCHEMA_VERSION}. ` +
        `A newer version of the app is needed to open it.`,
    );
  }

  let body: Record<string, unknown> = raw;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new StoreError(
        'unsupported',
        `No migration from schemaVersion ${version} to ${version + 1}.`,
      );
    }
    body = step(body);
    version += 1;
  }
  body.schemaVersion = CURRENT_SCHEMA_VERSION;
  return validateTrip(body);
}
