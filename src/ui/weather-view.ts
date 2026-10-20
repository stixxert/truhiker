/**
 * The weather timeline, as data.
 *
 * The honesty rules from `docs/DECISIONS.md` (D4, D7, D12) are enforced here, once:
 *
 *  - a day marked `beyond-horizon` gets a badge and **no numeric fields at all**
 *    (not `0 °C`, not an em dash next to a unit — nothing to misread);
 *  - a day whose forecast failed says "ikke tilgjengelig" with the reason;
 *  - an unknown temperature never renders as a number;
 *  - the panel states the ~9 day horizon in words, always.
 *
 * The DOM layer only formats what this module returns, so the rules cannot be
 * re-implemented differently in two places.
 */

import type { UserProfile, WeatherPlan, WeatherSample, WeatherWarning } from '../contracts';
import { formatClock, type I18n, type MessageKey } from '../i18n';
import { weatherSymbolFamily, type WeatherSymbolFamily } from '../lib/weather-symbol';

export type WeatherPanelState =
  | { kind: 'no-trip' }
  | { kind: 'engine-missing'; message: string }
  | { kind: 'needs-start-date' }
  | { kind: 'needs-daily-km' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string; detail?: string }
  | { kind: 'ready'; plan: WeatherPlan; from?: 'trip' | 'now' };

type WeatherPanelAction = 'none' | 'settings' | 'refresh' | 'open-route';

type WeatherRowStatus = 'forecast' | 'beyond-horizon' | 'unavailable' | 'loading';

export interface WeatherRowView {
  readonly dayIndex: number;
  readonly dayNumber: number;
  readonly dateLabel: string;
  readonly distanceLabel: string;
  readonly status: WeatherRowStatus;
  readonly symbolFamily: WeatherSymbolFamily;
  readonly symbolLabel: string | null;
  readonly symbolCode: string | null;
  readonly tempLabel: string | null;
  readonly precipLabel: string | null;
  readonly windLabel: string | null;
  readonly issuedLabel: string | null;
  /** Badge text for a non-forecast day; `null` for a real forecast. */
  readonly badge: string | null;
  /** Why a day is unavailable (off-grid, fetch failed). */
  readonly detail: string | null;
  readonly ariaLabel: string;
}

interface WeatherWarningView {
  readonly id: string;
  readonly title: string;
  readonly severityLabel: string;
  readonly area: string | null;
  readonly periodLabel: string | null;
  readonly url: string | null;
}

export interface WeatherViewModel {
  readonly state: 'message' | 'loading' | 'table';
  /** One line of status, e.g. "varsel hentet 14:32". */
  readonly statusLine: string;
  /** The main explanation when there is no table. */
  readonly message: string | null;
  /** Technical detail for a tooltip. */
  readonly detail: string | null;
  readonly action: WeatherPanelAction;
  /** Always shown: what the horizon covers and what the table cannot promise. */
  readonly note: string;
  /**
   * Always shown (D12): hazard alerts are not implemented in this version, and
   * silence must never read as safety. It is not conditional on the table.
   */
  readonly alertsNote: string;
  readonly rows: readonly WeatherRowView[];
  readonly warnings: readonly WeatherWarningView[];
  readonly fetchedLabel: string | null;
  readonly emptyMessage: string | null;
  /** True when no day has a forecast; the table is then all badges. */
  readonly withoutForecast: boolean;
}

type WeatherI18n = Pick<I18n, 't' | 'locale' | 'format'>;

const SEVERITY_KEYS: Record<WeatherWarning['severity'] | 'unknown', MessageKey> = {
  minor: 'weather.severity.minor',
  moderate: 'weather.severity.moderate',
  severe: 'weather.severity.severe',
  extreme: 'weather.severity.extreme',
  unknown: 'weather.severity.unknown',
};

const SYMBOL_KEYS: Record<WeatherSymbolFamily, MessageKey> = {
  clear: 'weather.sym.clear',
  fair: 'weather.sym.fair',
  'partly-cloudy': 'weather.sym.partlyCloudy',
  cloudy: 'weather.sym.cloudy',
  fog: 'weather.sym.fog',
  rain: 'weather.sym.rain',
  sleet: 'weather.sym.sleet',
  snow: 'weather.sym.snow',
  thunder: 'weather.sym.thunder',
  unknown: 'weather.sym.unknown',
};

/** Parse a `YYYY-MM-DD` (or ISO datetime) as UTC so no timezone shifts a day. */
export function parseDateLabel(date: string, i18n: WeatherI18n): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date;
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(i18n.locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(value);
}

/**
 * `HH:MM` in Europe/Oslo for an ISO timestamp; empty when it is unusable.
 * A MET issue time is a Norwegian forecast time, not the device's (D8).
 */
export function timeLabel(iso: string | undefined, locale: string): string {
  return formatClock(iso, locale);
}

/**
 * A failed day carries the engine's reason. Browser network errors arrive as
 * English ("Failed to fetch") and mean nothing to a user, so they are replaced
 * with a statement in the user's language; `HTTP 404` and similar stay as-is,
 * because they are the actionable part.
 */
function reasonLabel(reason: string | undefined, i18n: WeatherI18n): string | null {
  if (!reason) return null;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(reason)) {
    return i18n.t('weather.networkError');
  }
  return reason;
}

function temperatureLabel(tempC: number | undefined, i18n: WeatherI18n): string | null {
  if (tempC === undefined || !Number.isFinite(tempC)) return null;
  return `${i18n.format.number(tempC, { maximumFractionDigits: 0 })} °C`;
}

function precipLabel(mm: number | undefined, i18n: WeatherI18n): string | null {
  if (mm === undefined || !Number.isFinite(mm)) return null;
  return `${i18n.format.number(mm, { maximumFractionDigits: 1 })} mm`;
}

function windLabel(ms: number | undefined, i18n: WeatherI18n): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  return `${i18n.format.number(ms, { maximumFractionDigits: 1 })} m/s`;
}

function symbolLabel(sample: WeatherSample, i18n: WeatherI18n): string | null {
  const family = weatherSymbolFamily(sample.symbol);
  if (family === 'unknown') return null;
  return i18n.t(SYMBOL_KEYS[family]);
}

function buildRow(
  dayIndex: number,
  date: string,
  distanceM: number,
  sample: WeatherSample,
  i18n: WeatherI18n,
): WeatherRowView {
  const status: WeatherRowStatus =
    sample.status === 'forecast'
      ? 'forecast'
      : sample.status === 'beyond-horizon'
        ? 'beyond-horizon'
        : sample.status === 'loading'
          ? 'loading'
          : 'unavailable';
  const dayNumber = dayIndex + 1;
  const dateLabel = parseDateLabel(date, i18n);
  const distanceLabel = i18n.t('weather.fromDistance', {
    distance: i18n.format.distance(distanceM),
  });
  const base = { dayIndex, dayNumber, dateLabel, distanceLabel, status };

  if (status !== 'forecast') {
    const badge =
      status === 'beyond-horizon'
        ? i18n.t('weather.beyondHorizon')
        : status === 'loading'
          ? i18n.t('weather.loadingDay')
          : i18n.t('weather.dayUnavailable');
    const detail = status === 'unavailable' ? reasonLabel(sample.reason, i18n) : null;
    return {
      ...base,
      symbolFamily: 'unknown',
      symbolLabel: null,
      symbolCode: sample.symbol ?? null,
      tempLabel: null,
      precipLabel: null,
      windLabel: null,
      issuedLabel: null,
      badge,
      detail,
      ariaLabel: i18n.t('weather.rowAriaBadge', { day: dayNumber, date: dateLabel, badge }),
    };
  }

  const family = weatherSymbolFamily(sample.symbol);
  const temp = temperatureLabel(sample.tempC, i18n);
  const precip = precipLabel(sample.precipMm, i18n);
  const wind = windLabel(sample.windMs, i18n);
  const issuedTime = timeLabel(sample.issuedAt, i18n.locale);
  const issued = issuedTime ? i18n.t('weather.issued', { time: issuedTime }) : null;
  const values = [temp, precip, wind].filter((value): value is string => value !== null);
  const valuesLabel = values.length > 0 ? values.join(' · ') : i18n.t('weather.noValues');
  return {
    ...base,
    symbolFamily: family,
    symbolLabel: symbolLabel(sample, i18n),
    symbolCode: sample.symbol ?? null,
    tempLabel: temp,
    precipLabel: precip,
    windLabel: wind,
    issuedLabel: issued,
    badge: null,
    detail: null,
    ariaLabel: i18n.t('weather.rowAria', {
      day: dayNumber,
      date: dateLabel,
      values: valuesLabel,
    }),
  };
}

function buildWarning(warning: WeatherWarning, i18n: WeatherI18n): WeatherWarningView {
  const from = warning.from ? parseDateLabel(warning.from, i18n) : null;
  const to = warning.to ? parseDateLabel(warning.to, i18n) : null;
  const period = from && to && from !== to ? `${from}–${to}` : (from ?? to);
  return {
    id: warning.id,
    title: warning.title,
    severityLabel: i18n.t(SEVERITY_KEYS[warning.severity] ?? SEVERITY_KEYS.unknown),
    area: warning.area ?? null,
    periodLabel: period,
    url: warning.url && /^https:\/\//.test(warning.url) ? warning.url : null,
  };
}

/**
 * Build the panel model.
 *
 * `profile` decides whether the timeline can exist at all: without a start date
 * and a daily distance there is no trip day to sample, and saying so is more
 * useful than an empty table.
 */
export function buildWeatherView(
  state: WeatherPanelState,
  profile: UserProfile | null,
  horizonDays: number,
  i18n: WeatherI18n,
): WeatherViewModel {
  const note = i18n.t('weather.horizonNote', { days: horizonDays });
  // D12: "state the unknown". Alerts are unsupported by design, so the panel says
  // so on every render — an empty warning list is not a clearance.
  const alertsNote = i18n.t('weather.alertsUnsupported');
  const empty = (message: string, action: WeatherPanelAction, detail: string | null = null): WeatherViewModel => ({
    state: 'message',
    statusLine: '',
    message,
    detail,
    action,
    note,
    alertsNote,
    rows: [],
    warnings: [],
    fetchedLabel: null,
    emptyMessage: null,
    withoutForecast: false,
  });

  if (state.kind === 'no-trip') {
    return empty(i18n.t('weather.noTrip'), 'open-route');
  }
  if (state.kind === 'engine-missing') {
    return empty(i18n.t('weather.engineMissing'), 'none', state.message);
  }
  if (state.kind === 'needs-start-date') {
    return empty(i18n.t('weather.needsStartDate'), 'settings');
  }
  if (state.kind === 'needs-daily-km') {
    return empty(i18n.t('weather.needsDailyKm'), 'settings');
  }
  if (state.kind === 'loading') {
    const view = empty(i18n.t('weather.loading'), 'none');
    return { ...view, state: 'loading', statusLine: i18n.t('weather.loading') };
  }
  if (state.kind === 'error') {
    // `message` is already localised product copy (see weatherFailure in app.ts).
    // The raw upstream reason rides along as the tooltip, where a machine string
    // is acceptable and a 150-character one is not body text.
    // One line in the body whatever arrives: a state message is a sentence, not a
    // stack trace, and the full text stays in the tooltip.
    return empty(state.message.replace(/\s+/g, ' ').trim(), 'refresh', state.detail ?? state.message);
  }

  // A plan only reaches here when the profile had both fields.
  if (!profile || !profile.startDate || !(profile.dailyKm > 0)) {
    return empty(
      !profile?.startDate ? i18n.t('weather.needsStartDate') : i18n.t('weather.needsDailyKm'),
      'settings',
    );
  }

  const { plan } = state;
  const rows = plan.days.map((day) =>
    buildRow(day.dayIndex, day.date, day.distanceM, day.sample, i18n),
  );
  const forecastCount = rows.filter((row) => row.status === 'forecast').length;
  const beyondCount = rows.filter((row) => row.status === 'beyond-horizon').length;
  const failedCount = rows.filter((row) => row.status === 'unavailable').length;
  // Saying "varsel hentet" over a table of failures is a claim the data does not
  // support; the label is only shown when at least one day has a forecast.
  const fetchedLabel =
    forecastCount > 0
      ? i18n.t('weather.fetched', { time: timeLabel(plan.assembledAt, i18n.locale) || '—' })
      : null;
  const dayUnit = (count: number): string =>
    i18n.t(count === 1 ? 'weather.unitDayOne' : 'weather.unitDayMany');
  const forecastUnit = dayUnit(forecastCount);
  const beyondUnit = dayUnit(beyondCount);
  // "None inside the horizon" is a statement about the horizon. When the fetch
  // itself failed, say that instead — the two causes need different actions.
  const noForecast = forecastCount === 0 && failedCount > 0;
  const statusLine =
    rows.length === 0
      ? i18n.t('weather.empty')
      : noForecast
        ? i18n.t('weather.noForecast')
        : forecastCount === 0
          ? i18n.t('weather.noneInHorizon')
          : i18n.t(
              beyondCount === 0 ? 'weather.summaryAll' : 'weather.summary',
              {
                forecast: forecastCount,
                beyond: beyondCount,
                forecastUnit,
                beyondUnit,
              },
            );

  return {
    state: rows.length === 0 ? 'message' : 'table',
    statusLine,
    message:
      rows.length === 0
        ? i18n.t('weather.empty')
        : noForecast
          ? i18n.t('weather.noForecast')
          : null,
    detail: null,
    action: 'refresh',
    note:
      state.from === 'now' ? `${i18n.t('weather.nowNote')} ${note}` : note,
    alertsNote,
    rows,
    warnings: plan.warnings.map((warning) => buildWarning(warning, i18n)),
    fetchedLabel,
    emptyMessage: rows.length === 0 ? i18n.t('weather.empty') : null,
    withoutForecast: forecastCount === 0 && rows.length > 0,
  };
}

