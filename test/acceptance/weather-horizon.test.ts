/**
 * Acceptance: the weather engine's real output must survive into the view.
 *
 * Until this test existed, the engine was tested with a hand-written forecast
 * and the view was tested with a hand-written plan — fakes on both sides of the
 * seam, so nothing proved that a beyond-horizon day arrives at the UI *without*
 * numbers. This is the exact place an "authoritative" tool could quietly show a
 * fabricated value.
 */
import { describe, expect, it } from 'vitest';

import { DOCUMENTED_HORIZON_DAYS } from '../../src/app/engine-types';
import type { LonLat, Trip, UserProfile } from '../../src/contracts';
import { createI18n } from '../../src/i18n';
import { buildWeatherView } from '../../src/ui/weather-view';
import { forecastHorizonDays, memoryWeatherCache, planTripWeather } from '../../src/weather';

const NOW = new Date('2026-10-19T09:00:00Z');

/** A 10-day hourly series, shaped like MET's compact response. */
function seriesResponse(): Response {
  const timeseries = [];
  for (let i = 0; i < 240; i += 6) {
    timeseries.push({
      time: new Date(NOW.getTime() + i * 3_600_000).toISOString().replace('.000Z', 'Z'),
      data: {
        instant: { details: { air_temperature: 3 + (i % 12), wind_speed: 4.2 } },
        next_1_hours: {
          summary: { symbol_code: 'cloudy' },
          details: { precipitation_amount: i % 12 === 0 ? 0 : 0.4 },
        },
      },
    });
  }
  // Real MET responses carry `properties.meta.updated_at`, which is the
  // "issued at" the UI shows. `units` is present in the real payload too.
  const meta = { updated_at: NOW.toISOString().replace('.000Z', 'Z'), units: { air_temperature: 'celsius' } };
  return new Response(JSON.stringify({ properties: { meta, timeseries } }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      expires: new Date(NOW.getTime() + 1_800_000).toUTCString(),
      // Real MET responses carry Last-Modified; the view surfaces it as "issued".
      'last-modified': new Date(NOW.getTime() - 60_000).toUTCString(),
    },
  });
}

const profile: UserProfile = {
  massKg: 75,
  heightCm: 178,
  ageYears: 35,
  sex: 'male',
  packBaseKg: 12,
  dailyKm: 2,
  dailyHours: 8,
  support: 'carry-all',
  startDate: '2026-10-19',
};

function longTrip(): Trip {
  const points: LonLat[] = [];
  for (let i = 0; i <= 100; i += 1) points.push({ lon: 8.31 + i * 0.02, lat: 61.63 - i * 0.01 });
  return {
    schemaVersion: 1,
    id: 'weather-acceptance',
    name: 'horizon journey',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    profile,
    legs: [{ id: 'L1', points, provenance: [{ kind: 'demo' }], distanceM: null, ascentM: null, descentM: null }],
  };
}

describe('acceptance: weather horizon survives engine → view', () => {
  it('keeps numbers for an in-horizon day and no numbers at all for a far day', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return seriesResponse();
    }) as unknown as typeof fetch;

    const plan = await planTripWeather(longTrip(), {
      fetch: fetchImpl,
      cache: memoryWeatherCache(),
      now: () => NOW,
    });

    const i18n = createI18n('no');
    const view = buildWeatherView({ kind: 'ready', plan }, profile, DOCUMENTED_HORIZON_DAYS, i18n);

    expect(view.rows.length).toBeGreaterThan(2);

    // --- inside the horizon: a real forecast with numbers -------------------
    const first = view.rows[0]!;
    expect(first.status).toBe('forecast');
    expect(first.badge).toBeNull();
    expect(first.tempLabel).not.toBeNull();
    expect(first.windLabel).not.toBeNull();
    expect(first.issuedLabel).not.toBeNull();

    // --- far outside it: a badge, and *nothing* else ------------------------
    const last = view.rows[view.rows.length - 1]!;
    expect(last.status).toBe('beyond-horizon');
    expect(last.tempLabel).toBeNull();
    expect(last.precipLabel).toBeNull();
    expect(last.windLabel).toBeNull();
    expect(last.symbolLabel).toBeNull();
    expect(last.badge).toBeTruthy();

    // The engine's sample itself must not carry the keys either.
    const lastSample = plan.days[plan.days.length - 1]!.sample;
    expect(Object.keys(lastSample).sort()).toEqual(['point', 'status', 'when']);

    // --- the wire format MET requires --------------------------------------
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/[?&]lat=-?\d+\.\d{1,4}(&|$)/);
      expect(url).toMatch(/[?&]lon=-?\d+\.\d{1,4}(&|$)/);
    }
  });

  it('has one horizon constant, not two', () => {
    // Regression: engine-types said 9 while the engine said 10, and a UI test
    // passing a literal hid it.
    expect(DOCUMENTED_HORIZON_DAYS).toBe(forecastHorizonDays());
  });
});
