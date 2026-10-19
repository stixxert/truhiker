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
  it('renders numbers for a day inside the horizon', () => {
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
  });

  it('renders zero as zero — it is a measurement, not an unknown', () => {
    const view = buildWeatherView(ready(), PROFILE, 9, createI18n('no'));
    expect(view.rows[1].tempLabel).toBe('0 °C');
  });

  it('renders no numeric fields at all beyond the horizon', () => {
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
  });

  it('marks a failed day unavailable with its reason and no numbers', () => {
    const view = buildWeatherView(ready(), PROFILE, 9, createI18n('no'));
    const unavailable = view.rows[3];
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.badge).toBe('ikke tilgjengelig');
    expect(unavailable.detail).toBe('HTTP 404');
    expect(unavailable.tempLabel).toBeNull();
  });

  it('states the horizon in words and counts the days', () => {
    const view = buildWeatherView(ready(), PROFILE, 9, createI18n('no'));
    expect(view.note).toContain('9');
    expect(view.note).toContain('horisont');
    expect(view.statusLine).toContain('2 dager med varsel');
    expect(view.statusLine).toContain('1 dag utenfor horisonten');
    expect(view.fetchedLabel).toContain('varsel hentet');
    expect(view.withoutForecast).toBe(false);
  });

  it('translates warnings, keeps severity and refuses a non-https link', () => {
    const view = buildWeatherView(ready(), PROFILE, 9, createI18n('no'));
    expect(view.warnings[0].severityLabel).toBe('alvorlig');
    expect(view.warnings[0].url).toBe('https://www.met.no/vaer-og-klima/varsler');
    expect(view.warnings[0].periodLabel).toContain('–');
    expect(view.warnings[1].severityLabel).toBe('ukjent alvorlighetsgrad');
    expect(view.warnings[1].url).toBeNull();
  });

  it('says exactly what is missing when the start date is absent', () => {
    const view = buildWeatherView(
      { kind: 'needs-start-date' },
      { ...PROFILE, startDate: undefined },
      9,
      createI18n('no'),
    );
    expect(view.state).toBe('message');
    expect(view.action).toBe('settings');
    expect(view.message).toContain('startdato');
    expect(view.rows).toEqual([]);
  });

  it('says exactly what is missing when the daily distance is absent', () => {
    const view = buildWeatherView(
      { kind: 'needs-daily-km' },
      { ...PROFILE, dailyKm: 0 },
      9,
      createI18n('en'),
    );
    expect(view.action).toBe('settings');
    expect(view.message).toContain('kilometres per day');
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

  it('uses the singular for a single day count', () => {
    const single: WeatherPlan = { ...plan(), days: [plan().days[0]] };
    const view = buildWeatherView({ kind: 'ready', plan: single }, PROFILE, 9, createI18n('no'));
    expect(view.statusLine).toBe('1 dag med varsel');
  });

  it('says no day is inside the horizon when every day is beyond it', () => {
    const beyondOnly: WeatherPlan = {
      ...plan(),
      days: [plan().days[2]],
      hasForecast: false,
    };
    const view = buildWeatherView({ kind: 'ready', plan: beyondOnly }, PROFILE, 9, createI18n('no'));
    expect(view.withoutForecast).toBe(true);
    expect(view.statusLine).toContain('Ingen dager ligger innenfor');
  });
});

describe('weather date helpers', () => {
  it('formats an ISO date without a timezone shift', () => {
    // Midnight UTC must stay on the same calendar day in every UI timezone.
    expect(parseDateLabel('2026-07-01', createI18n('en'))).toContain('1 Jul');
    expect(parseDateLabel('2026-07-01', createI18n('no'))).toContain('1. juli');
  });

  it('formats a time in the active locale and tolerates junk', () => {
    const time = timeLabel('2026-06-30T21:00:00.000Z', 'en-GB');
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(timeLabel(undefined, 'en-GB')).toBe('');
    expect(timeLabel('not-a-date', 'en-GB')).toBe('');
  });
});
