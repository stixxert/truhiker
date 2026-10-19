import { describe, expect, it } from 'vitest';

import type { UserProfile, WeatherPlan, WeatherSample } from '../src/contracts';
import { createI18n } from '../src/i18n';
import {
  buildWeatherView,
  parseDateLabel,
  timeLabel,
  type WeatherPanelState,
} from '../src/ui/weather-view';

const PROFILE: UserProfile = {
  massKg: 75,
  heightCm: 178,
  ageYears: 35,
  sex: 'male',
  packBaseKg: 12,
  dailyKm: 15,
  dailyHours: 8,
  startDate: '2026-07-01',
  support: 'carry-all',
};

function sample(overrides: Partial<WeatherSample> = {}): WeatherSample {
  return {
    when: '2026-07-01T10:00:00.000Z',
    point: { lon: 8.3, lat: 61.5 },
    status: 'forecast',
    symbol: 'partlycloudy_day',
    tempC: 8.4,
    precipMm: 0,
    windMs: 3.2,
    issuedAt: '2026-06-30T21:00:00.000Z',
    ...overrides,
  };
}

function plan(): WeatherPlan {
  return {
    days: [
      {
        dayIndex: 0,
        date: '2026-07-01',
        distanceM: 15_000,
        point: { lon: 8.3, lat: 61.5 },
        sample: sample(),
      },
      {
        dayIndex: 1,
        date: '2026-07-02',
        distanceM: 30_000,
        point: { lon: 8.5, lat: 61.7 },
        sample: sample({ tempC: 0, symbol: 'clearsky_day', precipMm: 0 }),
      },
      {
        dayIndex: 29,
        date: '2026-07-30',
        distanceM: 435_000,
        point: { lon: 9.2, lat: 62.4 },
        // The engine must produce no numbers here. This is the shape it sends.
        sample: { when: '2026-07-30T10:00:00.000Z', point: { lon: 9.2, lat: 62.4 }, status: 'beyond-horizon' },
      },
      {
        dayIndex: 2,
        date: '2026-07-03',
        distanceM: 45_000,
        point: { lon: 9.9, lat: 63.9 },
        sample: {
          when: '2026-07-03T10:00:00.000Z',
          point: { lon: 9.9, lat: 63.9 },
          status: 'unavailable',
          reason: 'HTTP 404',
        },
      },
    ],
    warnings: [
      {
        id: 'w1',
        title: 'Kraftig regn',
        severity: 'severe',
        area: 'Jotunheimen',
        from: '2026-07-01T06:00:00.000Z',
        to: '2026-07-02T06:00:00.000Z',
        url: 'https://www.met.no/vaer-og-klima/varsler',
      },
      {
        id: 'w2',
        title: 'Uten lenke',
        severity: 'unknown',
        url: 'javascript:alert(1)',
      },
    ],
    assembledAt: '2026-06-30T21:10:00.000Z',
    hasForecast: true,
  };
}

function ready(): WeatherPanelState {
  return { kind: 'ready', plan: plan() };
}

describe('buildWeatherView — honesty rules', () => {
  it('renders numbers for a day inside the horizon, and zero as zero', () => {
    const view = buildWeatherView(ready(), PROFILE, 9, createI18n('no'));
    expect(view.state).toBe('table');
    const row = view.rows[0];
    expect(row.status).toBe('forecast');
    expect(row.tempLabel).toBe('8 °C');
    expect(row.precipLabel).toBe('0 mm');
    expect(row.windLabel).toBe('3,2 m/s');
    expect(row.symbolLabel).toBe('delvis skyet');
    expect(row.issuedLabel).toContain('sendt');
    expect(row.dateLabel).toContain('1. juli');
    expect(row.distanceLabel).toBe('15,0 km fra start');
    // Zero is a measurement, not an unknown.
    expect(view.rows[1].tempLabel).toBe('0 °C');
  });

  it('renders no numeric fields at all beyond the horizon, and marks a failed day', () => {
    const view = buildWeatherView(ready(), PROFILE, 9, createI18n('no'));
    const beyond = view.rows[2];
    expect(beyond.status).toBe('beyond-horizon');
    expect(beyond.badge).toBe('utenfor varselhorisonten');
    expect(beyond.tempLabel).toBeNull();
    expect(beyond.precipLabel).toBeNull();
    expect(beyond.windLabel).toBeNull();
    expect(beyond.issuedLabel).toBeNull();
    expect(beyond.symbolLabel).toBeNull();
    const serialised = JSON.stringify({
      temp: beyond.tempLabel,
      precip: beyond.precipLabel,
      wind: beyond.windLabel,
    });
    expect(serialised).not.toContain('0');
    expect(beyond.ariaLabel).toContain('utenfor varselhorisonten');

    const unavailable = view.rows[3];
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.badge).toBe('ikke tilgjengelig');
    expect(unavailable.detail).toBe('HTTP 404');
    expect(unavailable.tempLabel).toBeNull();
  });

  it('states the horizon in words, counts the days and translates warnings', () => {
    const view = buildWeatherView(ready(), PROFILE, 9, createI18n('no'));
    expect(view.note).toContain('9');
    expect(view.note).toContain('horisont');
    expect(view.statusLine).toContain('2 dager med varsel');
    expect(view.statusLine).toContain('1 dag utenfor horisonten');
    expect(view.fetchedLabel).toContain('varsel hentet');
    expect(view.withoutForecast).toBe(false);
    expect(view.warnings[0].severityLabel).toBe('alvorlig');
    expect(view.warnings[0].url).toBe('https://www.met.no/vaer-og-klima/varsler');
    expect(view.warnings[0].periodLabel).toContain('–');
    expect(view.warnings[1].severityLabel).toBe('ukjent alvorlighetsgrad');
    expect(view.warnings[1].url).toBeNull();
  });

  it('says exactly what is missing when the start date or the daily distance is absent', () => {
    const noDate = buildWeatherView(
      { kind: 'needs-start-date' },
      { ...PROFILE, startDate: undefined },
      9,
      createI18n('no'),
    );
    expect(noDate.state).toBe('message');
    expect(noDate.action).toBe('settings');
    expect(noDate.message).toContain('startdato');
    expect(noDate.rows).toEqual([]);

    const noDaily = buildWeatherView(
      { kind: 'needs-daily-km' },
      { ...PROFILE, dailyKm: 0 },
      9,
      createI18n('en'),
    );
    expect(noDaily.action).toBe('settings');
    expect(noDaily.message).toContain('kilometres per day');
  });

  it('renders a visible state for a missing engine, no trip, loading and failure', () => {
    const no: ReturnType<typeof buildWeatherView>[] = [
      buildWeatherView({ kind: 'engine-missing', message: 'boom' }, null, 9, createI18n('no')),
      buildWeatherView({ kind: 'no-trip' }, null, 9, createI18n('no')),
      buildWeatherView({ kind: 'loading' }, PROFILE, 9, createI18n('no')),
      buildWeatherView({ kind: 'error', message: 'HTTP 503\nextra' }, PROFILE, 9, createI18n('no')),
    ];
    for (const view of no) {
      expect(view.state).not.toBe('table');
      expect(view.message?.length ?? 0).toBeGreaterThan(0);
    }
    expect(no[0].message).toContain('Værmodulen');
    expect(no[0].detail).toBe('boom');
    expect(no[1].action).toBe('open-route');
    expect(no[2].state).toBe('loading');
    expect(no[3].message).toContain('HTTP 503');
    expect(no[3].message).not.toContain('\n');
    expect(no[3].action).toBe('refresh');
  });

  it('counts days in the singular, says when none is in the horizon, and dates them in Oslo', () => {
    const single: WeatherPlan = { ...plan(), days: [plan().days[0]] };
    const one = buildWeatherView({ kind: 'ready', plan: single }, PROFILE, 9, createI18n('no'));
    expect(one.statusLine).toBe('1 dag med varsel');

    const beyondOnly: WeatherPlan = {
      ...plan(),
      days: [plan().days[2]],
      hasForecast: false,
    };
    const none = buildWeatherView(
      { kind: 'ready', plan: beyondOnly },
      PROFILE,
      9,
      createI18n('no'),
    );
    expect(none.withoutForecast).toBe(true);
    expect(none.statusLine).toContain('Ingen dager ligger innenfor');

    // A failed fetch is not an empty horizon: the panel must say which one it is,
    // must not claim a forecast was fetched, and must not print "Failed to fetch".
    const failedOnly: WeatherPlan = {
      ...plan(),
      days: plan().days.map((day) => ({
        dayIndex: day.dayIndex,
        date: day.date,
        distanceM: day.distanceM,
        point: day.point,
        sample: {
          when: day.sample.when,
          point: day.sample.point,
          status: 'unavailable' as const,
          reason: 'Failed to fetch',
        },
      })),
      hasForecast: false,
    };
    const failed = buildWeatherView({ kind: 'ready', plan: failedOnly }, PROFILE, 9, createI18n('no'));
    expect(failed.statusLine).toContain('ikke tilgjengelig');
    expect(failed.statusLine).not.toContain('horisonten');
    expect(failed.fetchedLabel).toBeNull();
    expect(failed.rows[0].detail).toBe('nettverket svarte ikke');

    // Dates carry no timezone shift and times are Oslo times (D8); junk is
    // refused rather than rendered as "Invalid Date".
    // Midnight UTC must stay on the same calendar day in every UI timezone.
    expect(parseDateLabel('2026-07-01', createI18n('en'))).toContain('1 Jul');
    expect(parseDateLabel('2026-07-01', createI18n('no'))).toContain('1. juli');

    // D8: a timestamp is shown in Europe/Oslo, never in the device's zone.
    // 21:00 UTC on 30 June is 23:00 in Oslo (CEST), and the device may be UTC.
    expect(timeLabel('2026-06-30T21:00:00.000Z', 'en-GB')).toBe('23:00');
    // Winter time is +01:00: the same wall clock needs a different instant.
    expect(timeLabel('2026-01-15T09:05:00.000Z', 'en-GB')).toBe('10:05');
    expect(timeLabel(undefined, 'en-GB')).toBe('');
    expect(timeLabel('not-a-date', 'en-GB')).toBe('');
  });
});
