/**
 * `src/weather/met` — URL shape, parsing and the horizon decision.
 *
 * Every test here is offline: the parser is fed recorded-shaped JSON built in
 * the test, and no `fetch` is involved.
 */

import { describe, expect, it } from 'vitest';

import {
  COORDINATE_DECIMALS,
  DEFAULT_CACHE_TTL_MS,
  FORECAST_HORIZON_DAYS,
  HORIZON_TOLERANCE_MS,
  MAX_SAMPLE_GAP_MS,
  MET_FORECAST_ENDPOINT,
  addDays,
  buildForecastUrl,
  forecastCacheKey,
  osloMidday,
  parseForecast,
  pickSample,
  roundedPoint,
  todayInOslo,
} from '../../src/weather/met';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// A Locationforecast 2.0 compact-shaped document
// ---------------------------------------------------------------------------

interface BodyOptions {
  readonly start: number;
  readonly hours: number;
  readonly updatedAt?: string;
  readonly tempC?: number | null;
  readonly windMs?: number | null;
  readonly precipMm?: number | null;
  readonly symbol?: string | null;
  /** Emit only `next_6_hours` (no `next_1_hours`) to test the fallback. */
  readonly sixHourly?: boolean;
}

function forecastBody(options: BodyOptions): unknown {
  const timeseries: unknown[] = [];
  for (let hour = 0; hour < options.hours; hour += 1) {
    const time = new Date(options.start + hour * HOUR).toISOString();
    const details: Record<string, unknown> = {};
    if (options.tempC !== null) details.air_temperature = options.tempC ?? 6.3;
    if (options.windMs !== null) details.wind_speed = options.windMs ?? 4.1;

    const data: Record<string, unknown> = { instant: { details } };
    const blockName = options.sixHourly ? 'next_6_hours' : 'next_1_hours';
    if (options.precipMm !== null || options.symbol !== null) {
      const block: Record<string, unknown> = {};
      if (options.symbol !== null) block.summary = { symbol_code: options.symbol ?? 'cloudy' };
      if (options.precipMm !== null) block.details = { precipitation_amount: options.precipMm ?? 0 };
      data[blockName] = block;
    }
    timeseries.push({ time, data });
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [8.3124, 61.6363, 1492] },
    properties: {
      meta: {
        updated_at: options.updatedAt ?? new Date(options.start).toISOString(),
        units: {},
      },
      timeseries,
    },
  };
}

/** MET-shaped body: hourly for 48 h, then 6-hourly, ending exactly at `endMs`. */
function realisticBody(startMs: number, endMs: number, precipMm: number | null = 0): unknown {
  const times: number[] = [];
  for (let t = startMs; t <= startMs + 48 * HOUR; t += HOUR) times.push(t);
  let cursor = startMs + 54 * HOUR;
  while (cursor <= endMs) {
    times.push(cursor);
    cursor += 6 * HOUR;
  }
  const timeseries = times.map((time) => ({
    time: new Date(time).toISOString(),
    data: {
      instant: { details: { air_temperature: 5.5, wind_speed: 3.2 } },
      next_1_hours: {
        summary: { symbol_code: 'partlycloudy_day' },
        ...(precipMm !== null ? { details: { precipitation_amount: precipMm } } : {}),
      },
    },
  }));
  return {
    properties: {
      meta: { updated_at: new Date(startMs).toISOString() },
      timeseries,
    },
  };
}

// ---------------------------------------------------------------------------
// URL and coordinates
// ---------------------------------------------------------------------------

describe('buildForecastUrl — truncated to four decimals', () => {
  it('carries exactly the documented parameters at no more than four decimals, truncating', () => {
    const url = new URL(buildForecastUrl({ lat: 61.6363, lon: 8.3124 }));
    expect(url.origin + url.pathname).toBe(MET_FORECAST_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({ lat: '61.6363', lon: '8.3124' });

    for (const point of [
      { lat: 61.636349876, lon: 8.312499123 },
      // 61.63639 would round to 61.6364; truncation keeps 61.6363.
      { lat: 61.63639, lon: 8.31249 },
      { lat: 61.6, lon: 8 },
    ]) {
      const built = new URL(buildForecastUrl(point));
      for (const name of ['lat', 'lon']) {
        const text = built.searchParams.get(name)!;
        expect((text.split('.')[1] ?? '').length, `${name}=${text}`).toBeLessThanOrEqual(
          COORDINATE_DECIMALS,
        );
      }
    }
    expect(buildForecastUrl({ lat: 61.63639, lon: 8.31249 })).toBe(
      `${MET_FORECAST_ENDPOINT}?lat=61.6363&lon=8.3124`,
    );
    // Trailing zeros are dropped rather than padded.
    expect(roundedPoint({ lat: 61.6, lon: 8 }).latText).toBe('61.6');
    expect(roundedPoint({ lat: 61.6, lon: 8 }).lonText).toBe('8');
  });

  it('gives every point in a 4-decimal cell the same cache key, and refuses off-Earth coordinates', () => {
    const a = forecastCacheKey({ lat: 61.6363, lon: 8.3124 });
    expect(a).toBe('met:61.6363:8.3124');
    expect(forecastCacheKey({ lat: 61.636349, lon: 8.312449 })).toBe(a);

    for (const point of [
      { lat: 91, lon: 8 },
      { lat: 61, lon: 181 },
      { lat: Number.NaN, lon: 8 },
    ]) {
      expect(() => buildForecastUrl(point)).toThrow(RangeError);
    }
  });

  it('documents the fallback horizon, the sample-gap window and the cache TTL', () => {
    // Measured 2026-10-19: 85 entries, 2026-10-19T13:00Z … 2026-10-29T12:00Z.
    expect(FORECAST_HORIZON_DAYS).toBe(10);
    expect(MAX_SAMPLE_GAP_MS).toBe(7 * HOUR);
    expect(DEFAULT_CACHE_TTL_MS).toBe(30 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseForecast', () => {
  const start = Date.UTC(2026, 6, 15, 8, 0, 0);

  it('reads every field, keeps a measured 0 mm, leaves absent precipitation undefined and falls back to 6-hourly', () => {
    const forecast = parseForecast(
      forecastBody({ start, hours: 3, tempC: 6.3, windMs: 4.1, precipMm: 0.4, symbol: 'rain' }),
    );
    expect(forecast.entries).toHaveLength(3);
    expect(forecast.issuedAt).toBe(new Date(start).toISOString());
    expect(forecast.entries[0]).toMatchObject({
      tempC: 6.3,
      windMs: 4.1,
      precipMm: 0.4,
      precipPeriod: '1h',
      symbol: 'rain',
    });

    const zero = parseForecast(forecastBody({ start, hours: 1, precipMm: 0 })).entries[0];
    expect(zero.precipMm).toBe(0);
    expect('precipMm' in zero).toBe(true);

    const absent = parseForecast(
      forecastBody({ start, hours: 1, precipMm: null, symbol: null }),
    ).entries[0];
    expect(absent.precipMm).toBeUndefined();
    expect('precipMm' in absent).toBe(false);
    expect(absent.symbol).toBeUndefined();

    const sixHourly = parseForecast(
      forecastBody({ start, hours: 1, precipMm: 1.2, symbol: 'rain', sixHourly: true }),
    ).entries[0];
    expect(sixHourly.precipMm).toBe(1.2);
    expect(sixHourly.precipPeriod).toBe('6h');
    expect(sixHourly.symbol).toBe('rain');

    const unordered = forecastBody({ start, hours: 3 }) as {
      properties: { timeseries: unknown[] };
    };
    unordered.properties.timeseries.reverse();
    const times = parseForecast(unordered).entries.map((entry) => entry.timeMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('rejects a document that is not a forecast', () => {
    expect(() => parseForecast(null)).toThrow(/JSON object/);
    expect(() => parseForecast({})).toThrow(/properties/);
    expect(() => parseForecast({ properties: {} })).toThrow(/timeseries/);
    expect(() => parseForecast({ properties: { timeseries: [] } })).toThrow(/no usable entries/);
  });
});

// ---------------------------------------------------------------------------
// Horizon: derived from the last timeseries entry
// ---------------------------------------------------------------------------

describe('pickSample — the horizon is the response, not a constant', () => {
  const start = Date.UTC(2026, 6, 15, 8, 0, 0);
  const forecast = parseForecast(realisticBody(start, start + 10 * DAY));

  it('returns the closest entry inside the series, tolerates the end of it and refuses far beyond it', () => {
    const target = start + 2 * DAY; // 48 h in: hourly, so an exact entry exists
    const sample = pickSample(forecast, target);
    expect(sample.status).toBe('forecast');
    if (sample.status !== 'forecast') throw new Error('expected a forecast');
    expect(sample.entry.timeMs).toBe(target);
    expect(sample.entry.tempC).toBe(5.5);

    const last = forecast.entries[forecast.entries.length - 1].timeMs;
    expect(pickSample(forecast, last - HORIZON_TOLERANCE_MS).status).toBe('forecast');
    expect(pickSample(forecast, last + HORIZON_TOLERANCE_MS / 2).status).toBe('forecast');
    expect(pickSample(forecast, last + 30 * DAY).status).toBe('beyond-horizon');
  });

  it('refuses a target before the series, a target past the gap window, and an entry with no temperature', () => {
    const before = pickSample(forecast, start - 2 * DAY);
    expect(before.status).toBe('unavailable');
    if (before.status !== 'unavailable') throw new Error('expected unavailable');
    expect(before.reason).toMatch(/precedes/);

    // A series with a hole: 20 h between entries, target halfway (10 h from
    // either), which is beyond MAX_SAMPLE_GAP_MS.
    const first = forecastBody({ start, hours: 1 }) as { properties: { timeseries: unknown[] } };
    const second = forecastBody({ start: start + 20 * HOUR, hours: 1 }) as {
      properties: { timeseries: unknown[] };
    };
    first.properties.timeseries.push(...second.properties.timeseries);
    const gapped = pickSample(parseForecast(first), start + 10 * HOUR);
    expect(gapped.status).toBe('unavailable');
    if (gapped.status !== 'unavailable') throw new Error('expected unavailable');
    expect(gapped.reason).toMatch(/no MET entry/);

    // A missing temperature is unavailable, never 0 °C.
    const noTemperature = parseForecast(forecastBody({ start, hours: 2, tempC: null, precipMm: 0 }));
    const sample = pickSample(noTemperature, start + HOUR);
    expect(sample.status).toBe('unavailable');
    if (sample.status !== 'unavailable') throw new Error('expected unavailable');
    expect(sample.reason).toMatch(/air_temperature/);
  });
});

// ---------------------------------------------------------------------------
// Local midday, Europe/Oslo
// ---------------------------------------------------------------------------

describe('osloMidday — 12:00 local, whatever the season', () => {
  it('is 10:00 UTC in summer, 11:00 in winter, and follows the DST switch', () => {
    expect(osloMidday('2026-07-15').toISOString()).toBe('2026-07-15T10:00:00.000Z');
    expect(osloMidday('2026-01-15').toISOString()).toBe('2026-01-15T11:00:00.000Z');
    // 2026: DST starts 29 March, ends 25 October (both at 01:00 UTC).
    expect(osloMidday('2026-03-28').toISOString()).toBe('2026-03-28T11:00:00.000Z');
    expect(osloMidday('2026-03-29').toISOString()).toBe('2026-03-29T10:00:00.000Z');
    expect(osloMidday('2026-10-24').toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(osloMidday('2026-10-25').toISOString()).toBe('2026-10-25T11:00:00.000Z');
  });

  it('adds days in the calendar, not in 24-hour steps, and rejects impossible dates', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-07-15', 30)).toBe('2026-08-14');
    expect(() => osloMidday('15.07.2026')).toThrow(RangeError);
    expect(() => osloMidday('2026-02-31')).toThrow(RangeError);
  });
});

describe('todayInOslo — the calendar date the quick look starts from', () => {
  it('uses the Oslo date, not UTC and not the host timezone', () => {
    // 23:30 UTC in winter is already the next day in Oslo (UTC+1).
    expect(todayInOslo(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16');
    expect(todayInOslo(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-15');
    // 23:30 UTC in summer is 01:30 the next day in Oslo (UTC+2).
    expect(todayInOslo(new Date('2026-07-15T23:30:00Z'))).toBe('2026-07-16');
    expect(todayInOslo(new Date('2026-07-15T21:30:00Z'))).toBe('2026-07-15');
  });
});
