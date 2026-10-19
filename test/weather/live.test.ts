/**
 * One live test against MET Norway's Locationforecast 2.0.
 *
 * Skipped unless `NETWORK_TESTS=1`:
 *
 *     NETWORK_TESTS=1 npx vitest run test/weather/live.test.ts
 *
 * The unit tests never call out; this is the single real-world anchor that the
 * URL shape, the body parsing and the temperature units are still right.
 */

import { describe, expect, it } from 'vitest';

import { buildForecastUrl, parseForecast } from '../../src/weather';

const runNetworkTests = process.env.NETWORK_TESTS === '1';
const describeLive = runNetworkTests ? describe : describe.skip;

/** Galdhøpiggen (8.3124 E, 61.6363 N) — the summit this project uses as its anchor. */
const GALDHOPIGGEN = { lon: 8.3124, lat: 61.6363 } as const;

describeLive('MET Locationforecast 2.0 — live anchor', () => {
  it('answers 200 for Galdhøpiggen today with a plausible air temperature', async () => {
    const url = buildForecastUrl(GALDHOPIGGEN);
    // The browser supplies `Origin`; we deliberately set no headers at all.
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('expires')).not.toBeNull();

    const forecast = parseForecast(await response.json());
    expect(forecast.entries.length).toBeGreaterThan(40);

    const first = forecast.entries[0];
    expect(typeof first.tempC).toBe('number');
    // Broad on purpose: the assertion is "this is a temperature in °C", not
    // "the model agrees with today's weather". -60…40 excludes the classic
    // unit mistakes (Kelvin, Fahrenheit, millidegrees).
    expect(first.tempC).toBeGreaterThanOrEqual(-60);
    expect(first.tempC).toBeLessThanOrEqual(40);

    // The measured series reached ten days; MET promises roughly nine to ten.
    const spanDays =
      (forecast.entries[forecast.entries.length - 1].timeMs - first.timeMs) / 86_400_000;
    expect(spanDays).toBeGreaterThan(7);
    expect(spanDays).toBeLessThan(12);
  });
});
