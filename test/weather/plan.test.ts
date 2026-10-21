/**
 * `planTripWeather` — the honesty rules, exercised with an injected fake fetch.
 *
 * No test in this file touches the network. A live smoke test against MET lives
 * in `live.test.ts` and is skipped unless `NETWORK_TESTS=1`.
 */

import { describe, expect, it } from 'vitest';

import type { LonLat, Trip, UserProfile } from '../../src/contracts';
import {
  forecastHorizonDays,
  memoryWeatherCache,
  planTripWeather,
  type CachedForecast,
  type WeatherCache,
  type WeatherPlanDetail,
} from '../../src/weather';

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** 2026-07-15T08:00Z = 10:00 Europe/Oslo (CEST). */
const NOW = Date.UTC(2026, 6, 15, 8, 0, 0);
const START_DATE = '2026-07-15';
const EXPIRES_AT = NOW + 30 * 60_000;

// ---------------------------------------------------------------------------
// A MET-shaped response
// ---------------------------------------------------------------------------

interface SeriesOptions {
  readonly startMs?: number;
  /** How far the series reaches, in days. Default 10 (the measured horizon). */
  readonly days?: number;
  readonly tempC?: number;
  readonly windMs?: number;
  /** `null` omits the precipitation block entirely. `0` is a real value. */
  readonly precipMm?: number | null;
  readonly symbol?: string;
  readonly updatedAt?: number;
  readonly expiresMs?: number;
  /** `false` omits the `Expires` header entirely (falls back to the 30 min TTL). */
  readonly withExpires?: boolean;
}

function seriesResponse(options: SeriesOptions = {}): Response {
  const startMs = options.startMs ?? NOW;
  const days = options.days ?? 10;
  const endMs = startMs + days * DAY;
  const tempC = options.tempC ?? 6.3;
  const windMs = options.windMs ?? 4.1;
  const precipMm = options.precipMm === undefined ? 0.4 : options.precipMm;
  const symbol = options.symbol ?? 'cloudy';

  // Mirror MET's compact spacing: hourly for 48 h, then 6-hourly.
  const times: number[] = [];
  for (let t = startMs; t <= startMs + 48 * HOUR; t += HOUR) times.push(t);
  for (let t = startMs + 54 * HOUR; t <= endMs; t += 6 * HOUR) times.push(t);

  const timeseries = times.map((time) => ({
    time: new Date(time).toISOString(),
    data: {
      instant: { details: { air_temperature: tempC, wind_speed: windMs } },
      next_1_hours: {
        summary: { symbol_code: symbol },
        ...(precipMm !== null ? { details: { precipitation_amount: precipMm } } : {}),
      },
    },
  }));

  const body = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [8.3124, 61.6363, 1492] },
    properties: {
      meta: { updated_at: new Date(options.updatedAt ?? startMs).toISOString(), units: {} },
      timeseries,
    },
  };
  const headers: Record<string, string> =
    options.withExpires === false
      ? {}
      : { expires: new Date(options.expiresMs ?? EXPIRES_AT).toUTCString() };
  return new Response(JSON.stringify(body), { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    massKg: 75,
    heightCm: 180,
    ageYears: 40,
    sex: 'male',
    packBaseKg: 10,
    dailyKm: 5,
    dailyHours: 8,
    support: 'carry-all',
    startDate: START_DATE,
    ...overrides,
  };
}

function tripFromPoints(points: readonly LonLat[], overrides: Partial<UserProfile> = {}): Trip {
  return {
    schemaVersion: 1,
    id: 'trip-weather-test',
    name: 'Weather test trip',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    legs: [
      {
        id: 'leg-1',
        name: 'leg',
        points: points.map((point) => ({ ...point })),
        provenance: [{ kind: 'drawn' }],
        distanceM: null,
        ascentM: null,
        descentM: null,
      },
    ],
    profile: profile(overrides),
  };
}

/** A ~11 km northward route past Galdhøpiggen: three distinct 4-decimal cells. */
const VALLEY: readonly LonLat[] = [
  { lon: 8.3124, lat: 61.6363 },
  { lon: 8.3124, lat: 61.7363 },
];

/** Six points ~1 km apart, so six days sample six distinct cells. */
function spacedRoute(count: number): LonLat[] {
  return Array.from({ length: count }, (_, index) => ({
    lon: 8.3124,
    lat: 61.6363 + index * 0.009,
  }));
}

function statuses(plan: WeatherPlanDetail): string[] {
  return plan.days.map((day) => day.sample.status);
}

/** A cache that records what the planner stored. */
function recordingCache(): { cache: WeatherCache; stored: CachedForecast[]; keys: string[] } {
  const entries = new Map<string, CachedForecast>();
  const stored: CachedForecast[] = [];
  const keys: string[] = [];
  return {
    stored,
    keys,
    cache: {
      async get(key) {
        keys.push(key);
        return entries.get(key) ?? null;
      },
      async set(key, value) {
        keys.push(key);
        stored.push(value);
        entries.set(key, value);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Inside the horizon
// ---------------------------------------------------------------------------

describe('planTripWeather — a day inside the horizon', () => {
  it('returns an honest forecast per trip day: every number, both timestamps, one request per day', async () => {
    const fake = fakeFetch(() => seriesResponse());
    const plan = await planTripWeather(tripFromPoints(VALLEY, { dailyKm: 5 }), {
      fetch: fake.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });

    expect(plan.days.length).toBe(3);
    expect(statuses(plan)).toEqual(['forecast', 'forecast', 'forecast']);
    expect(plan.hasForecast).toBe(true);
    expect(plan.assembledAt).toBe(new Date(NOW).toISOString());
    expect(plan.warnings).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.sampledEveryNDays).toBe(1);
    expect(fake.calls).toHaveLength(3);

    const first = plan.days[0];
    expect(first.date).toBe(START_DATE);
    // Local midday in Europe/Oslo on 15 July is 10:00 UTC.
    expect(first.sample.when).toBe('2026-07-15T10:00:00.000Z');
    expect(first.sample.tempC).toBe(6.3);
    expect(first.sample.windMs).toBe(4.1);
    expect(first.sample.precipMm).toBe(0.4);
    expect(first.sample.symbol).toBe('cloudy');
    expect(first.sample.issuedAt).toBe(new Date(NOW).toISOString());
    expect(first.sample.expiresAt).toBe(new Date(EXPIRES_AT).toISOString());
    expect(first.headline).toContain('°C');
    expect(first.headline).toContain('m/s');

    // The route is walked at dayIndex × dailyKm, one calendar day per day.
    expect(plan.days.map((day) => day.dayIndex)).toEqual([0, 1, 2]);
    expect(plan.days[0].distanceM).toBe(0);
    expect(plan.days[1].distanceM).toBeGreaterThan(4990);
    expect(plan.days[1].distanceM).toBeLessThan(5010);
    expect(plan.days[1].sample.when).toBe('2026-07-16T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Beyond the horizon
// ---------------------------------------------------------------------------

describe('planTripWeather — beyond the horizon', () => {
  it('marks a day 30 days out beyond-horizon with no numeric field at all', async () => {
    const fake = fakeFetch(() => seriesResponse());
    const plan = await planTripWeather(tripFromPoints(VALLEY, { dailyKm: 5, startDate: '2026-08-14' }), {
      fetch: fake.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });

    // The decision comes from the response, so the request is made even though
    // the target is far outside any forecast window.
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(statuses(plan)).toEqual(['beyond-horizon', 'beyond-horizon', 'beyond-horizon']);
    expect(plan.hasForecast).toBe(false);

    for (const day of plan.days) {
      const sample = day.sample;
      expect(sample.tempC).toBeUndefined();
      expect(sample.precipMm).toBeUndefined();
      expect(sample.windMs).toBeUndefined();
      expect(sample.symbol).toBeUndefined();
      expect(sample.issuedAt).toBeUndefined();
      expect(sample.expiresAt).toBeUndefined();
      // Not merely undefined: the keys do not exist.
      expect(Object.keys(sample).sort()).toEqual(['point', 'status', 'when']);
    }
    expect(plan.notes.join(' ')).toMatch(/beyond-horizon/);
  });

  it('uses the response length, not the 10-day constant, and exports the constant for UI copy', async () => {
    // 8 days out is inside the documented ~10-day horizon, but this response
    // only reaches 5 days. The honest answer is beyond-horizon.
    const fake = fakeFetch(() => seriesResponse({ days: 5 }));
    const plan = await planTripWeather(
      tripFromPoints(VALLEY, { dailyKm: 5, startDate: '2026-07-23' }),
      { fetch: fake.fetch, cache: memoryWeatherCache(), now: () => new Date(NOW) },
    );
    expect(statuses(plan)[0]).toBe('beyond-horizon');
    expect(plan.days[0].sample.tempC).toBeUndefined();

    expect(forecastHorizonDays()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Dedupe and URL shape
// ---------------------------------------------------------------------------

describe('planTripWeather — one request per unique rounded point', () => {
  it('makes one request for three days in the same cell, at four truncated decimals and with no headers', async () => {
    // 2.3 m of route walked at 1 m/day: three days, one rounded point.
    const rounded = tripFromPoints(
      [
        { lon: 8.3124, lat: 61.6363 },
        { lon: 8.31241, lat: 61.63632 },
      ],
      { dailyKm: 0.001 },
    );
    const fake = fakeFetch(() => seriesResponse());
    const plan = await planTripWeather(rounded, {
      fetch: fake.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });

    expect(plan.days.length).toBe(3);
    expect(statuses(plan)).toEqual(['forecast', 'forecast', 'forecast']);
    expect(fake.calls).toHaveLength(1);

    const { url, init } = fake.calls[0];
    expect(url).toBe(
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=61.6363&lon=8.3124',
    );
    const match = /^lat=(-?\d+(?:\.\d+)?)&lon=(-?\d+(?:\.\d+)?)$/.exec(url.split('?')[1]!);
    expect(match).not.toBeNull();
    const decimals = (text: string): number => (text.split('.')[1] ?? '').length;
    expect(decimals(match![1]!)).toBeLessThanOrEqual(4);
    expect(decimals(match![2]!)).toBeLessThanOrEqual(4);

    // No headers at all: no User-Agent (browsers cannot set it), no
    // If-Modified-Since (it would trigger a preflight MET does not support).
    // The only option is the timeout — a MET that accepts and never answers used
    // to hang the plan until the browser's own timeout.
    expect(init).toBeDefined();
    expect(init?.headers).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    // Truncation, not rounding: 61.636399 must not become 61.6364.
    const rounding = fakeFetch(() => seriesResponse());
    await planTripWeather(
      tripFromPoints(
        [
          { lon: 8.312499, lat: 61.636399 },
          { lon: 8.3125, lat: 61.6365 },
        ],
        { dailyKm: 100 },
      ),
      { fetch: rounding.fetch, cache: memoryWeatherCache(), now: () => new Date(NOW) },
    );
    expect(rounding.calls).toHaveLength(1);
    expect(rounding.calls[0].url).toBe(
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=61.6363&lon=8.3124',
    );

    // The cache is keyed by the truncated point, so both ends share one entry.
    const recorder = recordingCache();
    await planTripWeather(
      tripFromPoints(
        [
          { lon: 8.31244, lat: 61.63634 },
          { lon: 8.31246, lat: 61.63636 },
        ],
        { dailyKm: 100 },
      ),
      { fetch: fakeFetch(() => seriesResponse()).fetch, cache: recorder.cache, now: () => new Date(NOW) },
    );
    expect(recorder.keys).toEqual(['met:61.6363:8.3124', 'met:61.6363:8.3124']);
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('planTripWeather — cache', () => {
  it('reuses a live entry, refetches an expired one, honours a long Expires and treats a corrupt entry as a miss', async () => {
    const cache = memoryWeatherCache();
    const fake = fakeFetch(() => seriesResponse());
    const trip = tripFromPoints(VALLEY, { dailyKm: 100 }); // one point, one day

    const first = await planTripWeather(trip, { fetch: fake.fetch, cache, now: () => new Date(NOW) });
    expect(statuses(first)).toEqual(['forecast']);
    expect(fake.calls).toHaveLength(1);

    // Same instant: the entry is fresh, so no request.
    await planTripWeather(trip, { fetch: fake.fetch, cache, now: () => new Date(NOW) });
    expect(fake.calls).toHaveLength(1);

    // Past MET's Expires (30 min measured): refetch.
    await planTripWeather(trip, { fetch: fake.fetch, cache, now: () => new Date(EXPIRES_AT + 60_000) });
    expect(fake.calls).toHaveLength(2);

    // The Expires header is honoured rather than replaced by an invented TTL.
    const longExpiry = NOW + 6 * HOUR;
    const longAfter = await planTripWeather(trip, {
      fetch: fakeFetch(() => seriesResponse({ expiresMs: longExpiry })).fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });
    expect(longAfter.days[0]!.sample.expiresAt).toBe(new Date(longExpiry).toISOString());

    // A corrupt cache entry is a miss, never a failure.
    const corrupt: WeatherCache = {
      async get() {
        return { body: { nonsense: true }, expiresAt: new Date(NOW + DAY).toISOString() };
      },
      async set() {
        /* ignore */
      },
    };
    const recovered = await planTripWeather(trip, {
      fetch: fake.fetch,
      cache: corrupt,
      now: () => new Date(NOW),
    });
    expect(statuses(recovered)).toEqual(['forecast']);
    expect(fake.calls).toHaveLength(3);
  });

  it('falls back to the documented 30-minute TTL when the response has no Expires header', async () => {
    const recorder = recordingCache();
    const fake = fakeFetch(() => seriesResponse({ withExpires: false }));
    const plan = await planTripWeather(tripFromPoints(VALLEY, { dailyKm: 100 }), {
      fetch: fake.fetch,
      cache: recorder.cache,
      now: () => new Date(NOW),
    });

    expect(statuses(plan)).toEqual(['forecast']);
    expect(plan.days[0]!.sample.expiresAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
    expect(recorder.stored).toHaveLength(1);
    expect(recorder.stored[0]!.expiresAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
  });

  it('keeps working when the cache throws: it says so in the notes instead of failing the plan', async () => {
    const throwing: WeatherCache = {
      async get() {
        throw new Error('cache read failed');
      },
      async set() {
        throw new Error('cache write failed');
      },
    };
    const fake = fakeFetch(() => seriesResponse());
    const plan = await planTripWeather(tripFromPoints(spacedRoute(3), { dailyKm: 1 }), {
      fetch: fake.fetch,
      cache: throwing,
      now: () => new Date(NOW),
    });

    expect(statuses(plan)).toEqual(['forecast', 'forecast', 'forecast']);
    expect(plan.notes.join(' ')).toMatch(/cache could not be read/);
    expect(plan.notes.join(' ')).toMatch(/cache could not be written/);
  });

  it('probes the horizon once and skips points that only serve days beyond it', async () => {
    // Six days, six distinct cells, all 30+ days out: after one probe response
    // the planner knows every remaining point is beyond the horizon.
    const fake = fakeFetch(() => seriesResponse());
    const plan = await planTripWeather(
      tripFromPoints(spacedRoute(6), { dailyKm: 1, startDate: '2026-08-14' }),
      { fetch: fake.fetch, cache: memoryWeatherCache(), now: () => new Date(NOW) },
    );

    expect(statuses(plan)).toEqual(Array.from({ length: 6 }, () => 'beyond-horizon'));
    expect(fake.calls).toHaveLength(1);
    expect(plan.notes.join(' ')).toMatch(/served only days beyond the forecast horizon/);
    expect(plan.notes.join(' ')).toMatch(/not requested/);
  });
});

// ---------------------------------------------------------------------------
// Failures and degradation
// ---------------------------------------------------------------------------

describe('planTripWeather — failure is per point', () => {
  it('marks one failing point unavailable, and turns a rejection or a bad body into an unavailable day', async () => {
    const route = spacedRoute(3); // three days, three distinct cells
    const partial = fakeFetch((url) => {
      if (url.includes('lat=61.6452')) return new Response('server error', { status: 500 });
      return seriesResponse();
    });
    const plan = await planTripWeather(tripFromPoints(route, { dailyKm: 1 }), {
      fetch: partial.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });

    expect(statuses(plan)).toEqual(['forecast', 'unavailable', 'forecast']);
    expect(plan.hasForecast).toBe(true);
    expect(plan.days[1]!.sample.reason).toMatch(/HTTP 500/);
    expect(plan.days[1]!.sample.tempC).toBeUndefined();
    expect(plan.days[1]!.sample.precipMm).toBeUndefined();
    expect(plan.days[1]!.sample.windMs).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/could not be retrieved/);

    const rejected = fakeFetch(() => {
      throw new Error('network down');
    });
    const down = await planTripWeather(tripFromPoints(VALLEY, { dailyKm: 100 }), {
      fetch: rejected.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });
    expect(statuses(down)).toEqual(['unavailable']);
    expect(down.days[0]!.sample.reason).toMatch(/network down/);
    expect(down.hasForecast).toBe(false);

    const nonsense = fakeFetch(() => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    const unparseable = await planTripWeather(tripFromPoints(VALLEY, { dailyKm: 100 }), {
      fetch: nonsense.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });
    expect(statuses(unparseable)).toEqual(['unavailable']);
    expect(unparseable.days[0]!.sample.reason).toMatch(/properties/);
  });
});

// ---------------------------------------------------------------------------
// Empty plans, with a documented reason
// ---------------------------------------------------------------------------

describe('planTripWeather — empty plans', () => {
  it('returns an empty, explained plan for every case where there is nothing honest to say', async () => {
    const cases: ReadonlyArray<readonly [string, Trip, RegExp]> = [
      [
        'dailyKm = 0',
        tripFromPoints(VALLEY, { dailyKm: 0 }),
        /dailyKm/,
      ],
      [
        'a negative dailyKm',
        tripFromPoints(VALLEY, { dailyKm: -3 }),
        /dailyKm/,
      ],
      [
        'zero-length geometry',
        tripFromPoints([{ lon: 8.3124, lat: 61.6363 }], { dailyKm: 5 }),
        /no measurable distance/,
      ],
      [
        'no startDate',
        {
          ...tripFromPoints(VALLEY, { dailyKm: 5 }),
          profile: { ...tripFromPoints(VALLEY, { dailyKm: 5 }).profile, startDate: undefined },
        },
        /startDate/,
      ],
      [
        'a startDate that is not a real date',
        tripFromPoints(VALLEY, { dailyKm: 5, startDate: '2026-02-31' }),
        /startDate/,
      ],
    ];

    for (const [label, trip, reason] of cases) {
      const fake = fakeFetch(() => seriesResponse());
      const plan = await planTripWeather(trip, {
        fetch: fake.fetch,
        cache: memoryWeatherCache(),
        now: () => new Date(NOW),
      });
      expect(plan.days, label).toEqual([]);
      expect(plan.hasForecast, label).toBe(false);
      expect(plan.notes.join(' '), label).toMatch(reason);
      expect(fake.calls, label).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Precipitation: 0 is a fact, absent is ignorance
// ---------------------------------------------------------------------------

describe('planTripWeather — precipitation', () => {
  it('preserves a measured 0.0 mm as 0 and leaves precipitation undefined when MET sent none', async () => {
    const zero = fakeFetch(() => seriesResponse({ precipMm: 0 }));
    const withZero = await planTripWeather(tripFromPoints(VALLEY, { dailyKm: 100 }), {
      fetch: zero.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });
    expect(withZero.days[0]!.sample.precipMm).toBe(0);
    expect('precipMm' in withZero.days[0]!.sample).toBe(true);
    expect(withZero.days[0]!.headline).toContain('0.0 mm');

    const absent = fakeFetch(() => seriesResponse({ precipMm: null }));
    const withoutPrecip = await planTripWeather(tripFromPoints(VALLEY, { dailyKm: 100 }), {
      fetch: absent.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });
    expect(withoutPrecip.days[0]!.sample.precipMm).toBeUndefined();
    expect('precipMm' in withoutPrecip.days[0]!.sample).toBe(false);
    expect(withoutPrecip.days[0]!.sample.status).toBe('forecast');
    expect(typeof withoutPrecip.days[0]!.sample.tempC).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Caps: concurrency and point count
// ---------------------------------------------------------------------------

describe('planTripWeather — caps', () => {
  it('never has more than two requests in flight, honours a lower cap, and samples sparsely past maxPoints', async () => {
    let inFlight = 0;
    let peak = 0;
    const fake = fakeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return seriesResponse();
    });
    const plan = await planTripWeather(tripFromPoints(spacedRoute(6), { dailyKm: 1 }), {
      fetch: fake.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
    });
    expect(plan.days.length).toBe(6);
    expect(fake.calls).toHaveLength(6);
    expect(peak).toBeGreaterThan(1); // the test would pass trivially otherwise
    expect(peak).toBeLessThanOrEqual(2);

    let active = 0;
    let cappedPeak = 0;
    const serial = fakeFetch(async () => {
      active += 1;
      cappedPeak = Math.max(cappedPeak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return seriesResponse();
    });
    await planTripWeather(tripFromPoints(spacedRoute(4), { dailyKm: 1 }), {
      fetch: serial.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
      concurrency: 1,
    });
    expect(cappedPeak).toBe(1);

    // 100 km at 1 km/day = 100 days; cap at 5 points → every 20th day.
    const long: LonLat[] = [
      { lon: 8.3124, lat: 61.6363 },
      { lon: 8.3124, lat: 62.5363 }, // ~100 km north
    ];
    const sparse = fakeFetch(() => seriesResponse());
    const sampled = await planTripWeather(tripFromPoints(long, { dailyKm: 1 }), {
      fetch: sparse.fetch,
      cache: memoryWeatherCache(),
      now: () => new Date(NOW),
      maxPoints: 5,
    });
    expect(sampled.daysTotal).toBeGreaterThanOrEqual(100);
    expect(sampled.days.length).toBeLessThanOrEqual(5);
    expect(sampled.days.length).toBe(Math.ceil(sampled.daysTotal / sampled.sampledEveryNDays));
    expect(sampled.sampledEveryNDays).toBeGreaterThan(1);
    expect(sampled.days.map((day) => day.dayIndex)).toEqual(
      sampled.days.map((_, index) => index * sampled.sampledEveryNDays),
    );
    expect(sampled.notes.join(' ')).toMatch(/sampled every \d+ days/);
    expect(sparse.calls.length).toBeLessThanOrEqual(5);
  });
});
