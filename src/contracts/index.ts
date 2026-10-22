/**
 * Shared contracts for Phase 3.
 *
 * Every engine (weather, route editing, trip store, UI) compiles against these
 * types. They are the interface, not a suggestion: if an implementation needs a
 * different shape, the contract changes here first, deliberately.
 */

export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

/** Where an elevation value came from. `none` means "unknown", never "zero". */
export type ElevationSource = 'gpx' | 'dem' | 'none';

export interface RoutePoint extends LonLat {
  /** Metres above sea level. Absent/undefined is distinct from 0. */
  readonly ele?: number;
  readonly eleSource?: ElevationSource;
  /**
   * This vertex landed on a mapped trail (D5).
   *
   * Per vertex, not per leg: a leg with one snapped corner and three invented ones
   * is not a snapped leg, and the leg-level `snapped` marker alone said it was.
   * Absent means "not known to be on a trail" — never "off trail".
   */
  readonly snapped?: boolean;
}

/** How a leg came to exist. Shown in the UI; never omitted. */
export type ProvenanceKind =
  | 'gpx-upload'
  | 'turrutebasen'
  | 'drawn'
  | 'snapped'
  | 'edited';

export interface Provenance {
  readonly kind: ProvenanceKind;
  /** Human label, e.g. "Memurubu–Glitterheim (jot21)". */
  readonly label?: string;
  /** Source URL, when there is one. */
  readonly url?: string;
  /** ISO timestamp of when we obtained the data. */
  readonly fetchedAt?: string;
  /** Licence string, e.g. "CC BY 4.0 ©Kartverket". */
  readonly licence?: string;
  /** True when the data was modified by us, as CC BY 4.0 requires us to state. */
  readonly modified?: boolean;
}

export interface Leg {
  readonly id: string;
  readonly name?: string;
  readonly points: readonly RoutePoint[];
  readonly provenance: readonly Provenance[];
  /** Metres. `null` when the geometry is too short to measure. */
  readonly distanceM: number | null;
  /** Cumulative ascent/descent. `null` when elevation is unavailable. */
  readonly ascentM: number | null;
  readonly descentM: number | null;
}

export type SupportModel = 'carry-all' | 'mail-drops';

export interface UserProfile {
  readonly massKg: number;
  readonly heightCm: number;
  readonly ageYears: number;
  readonly sex: 'male' | 'female';
  readonly bodyFatPercent?: number;
  readonly packBaseKg: number;
  readonly dailyKm: number;
  readonly dailyHours: number;
  readonly startDate?: string; // ISO date
  readonly support: SupportModel;
}

export interface Trip {
  /** Bumped when the persisted shape changes; the store migrates on read. */
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly legs: readonly Leg[];
  readonly profile: UserProfile;
  /** Optional notes the user wants kept with the trip. */
  readonly notes?: string;
}

export interface TripSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly legCount: number;
  readonly distanceM: number | null;
}

/* ------------------------------------------------------------------ */
/* Route editing                                                       */
/* ------------------------------------------------------------------ */

export type EditCommand =
  | {
      readonly type: 'insert';
      readonly legId: string;
      readonly index: number;
      readonly point: RoutePoint;
      /**
       * The point came from a trail snap, not from the raw pointer. Recorded as
       * provenance so the leg can say which of its points are on a mapped trail
       * (D5). Optional: an insert from a file or a test is simply not snapped.
       */
      readonly snapped?: boolean;
    }
  | {
      readonly type: 'move';
      readonly legId: string;
      readonly index: number;
      readonly point: RoutePoint;
      /** The vertex was dropped onto a trail (D5). */
      readonly snapped?: boolean;
    }
  | { readonly type: 'delete-vertex'; readonly legId: string; readonly index: number }
  | { readonly type: 'delete-leg'; readonly legId: string }
  | { readonly type: 'split-leg'; readonly legId: string; readonly index: number }
  | { readonly type: 'reverse-leg'; readonly legId: string }
  | { readonly type: 'trim-leg'; readonly legId: string; readonly from: number; readonly to: number }
  | { readonly type: 'rename-leg'; readonly legId: string; readonly name: string }
  /** Replace points[from..to] with `points`, after snapping. */
  | {
      readonly type: 'replace-span';
      readonly legId: string;
      readonly from: number;
      readonly to: number;
      readonly points: readonly RoutePoint[];
      readonly snapped: boolean;
      /** Source markers to record with the new geometry, e.g. a routed span. */
      readonly provenance?: readonly Provenance[];
    }
  /**
   * Merge `withLegId` into `legId` and remove it. It is what makes split→merge lossless (D21):
   * every documented edit must be a command, and split→merge must be lossless.
   */
  | { readonly type: 'merge-legs'; readonly legId: string; readonly withLegId: string };

export interface RouteEditor {
  readonly trip: Trip;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  apply(command: EditCommand): Trip;
  undo(): Trip;
  redo(): Trip;
  /** Replace the whole trip (e.g. after loading a file) and clear history. */
  reset(trip: Trip): void;
  /**
   * Replace the document but **keep** undo/redo.
   *
   * For a change that does not touch the geometry — the trip's name, the body
   * profile, the day's assumptions. Renaming a trip used to clear the whole undo
   * stack, so the next Undo was a no-op with the button already greyed out.
   */
  replaceCurrent(trip: Trip): void;
}

/* ------------------------------------------------------------------ */
/* Weather                                                             */
/* ------------------------------------------------------------------ */

/**
 * The honesty model. A planning tool must never present an invented number as a
 * forecast.
 *
 * - `forecast`        — a real MET forecast for that place and time.
 * - `beyond-horizon`  — the time is outside MET's ~9 day window. No number is
 *                       shown. This is not a failure; it is the truth.
 * - `unavailable`     — we tried and failed, or the point is outside coverage.
 * - `loading`         — in flight.
 */
type WeatherStatus = 'forecast' | 'beyond-horizon' | 'unavailable' | 'loading';

export interface WeatherSample {
  /** ISO timestamp the sample describes (local midday of that trip day). */
  readonly when: string;
  readonly point: LonLat;
  readonly status: WeatherStatus;
  /** MET symbol code, e.g. "clearsky_day". */
  readonly symbol?: string;
  readonly tempC?: number;
  readonly precipMm?: number;
  readonly windMs?: number;
  /** When MET published this forecast. */
  readonly issuedAt?: string;
  /** When we should re-check (MET's `Expires`). */
  readonly expiresAt?: string;
  /** Set when status is `unavailable`. */
  readonly reason?: string;
}

export interface WeatherWarning {
  readonly id: string;
  readonly title: string;
  readonly severity: 'minor' | 'moderate' | 'severe' | 'extreme' | 'unknown';
  readonly area?: string;
  readonly from?: string;
  readonly to?: string;
  readonly url?: string;
}

export interface WeatherDay {
  readonly dayIndex: number;
  readonly date: string; // ISO date
  readonly distanceM: number;
  readonly point: LonLat;
  readonly sample: WeatherSample;
  /** Winds and precipitation are what actually change a plan. */
  readonly headline?: string;
}

export interface WeatherPlan {
  readonly days: readonly WeatherDay[];
  readonly warnings: readonly WeatherWarning[];
  /** ISO timestamp of when this plan was assembled. */
  readonly assembledAt: string;
  /** True when any day has status `forecast`. False means nothing is known. */
  readonly hasForecast: boolean;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export type StoreErrorCode = 'quota-exceeded' | 'corrupt' | 'unsupported' | 'not-found';

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    /** Size of the payload that failed, when the failure was about size. */
    readonly bytes?: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface TripStore {
  list(): TripSummary[];
  load(id: string): Trip | null;
  save(trip: Trip): void;
  remove(id: string): void;
  /** Serialise a trip for download. Includes provenance in GPX metadata. */
  toGpx(trip: Trip, options?: { legIds?: readonly string[]; includeElevation?: boolean }): string;
  toGeoJson(trip: Trip): string;
  /** Parse an uploaded file into a Trip. Throws StoreError on malformed input. */
  fromFile(text: string, filename: string, options?: { maxPoints?: number }): Trip;
}
