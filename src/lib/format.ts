/**
 * Formatting and the Naismith walking-time model.
 *
 * All display numbers go through `Intl.NumberFormat` so Norwegian gets comma
 * decimals and space-separated thousands, and English gets the opposite. The
 * functions here are pure and locale-explicit, which makes them testable and
 * keeps them out of the DOM.
 */

export type Lang = 'no' | 'en';

const LOCALE: Record<Lang, string> = { no: 'nb-NO', en: 'en-GB' };

interface Units {
  readonly metre: string;
  readonly metresAboveSea: string;
  readonly kilometre: string;
  readonly hour: string;
  readonly minute: string;
}

const UNITS: Record<Lang, Units> = {
  no: { metre: 'm', metresAboveSea: 'moh', kilometre: 'km', hour: 't', minute: 'min' },
  en: { metre: 'm', metresAboveSea: 'm a.s.l.', kilometre: 'km', hour: 'h', minute: 'min' },
};

/** BCP 47 locale for a UI language. */
export function localeFor(lang: Lang): string {
  return LOCALE[lang];
}

/** Unit strings for a UI language. */
export function unitsFor(lang: Lang): Units {
  return UNITS[lang];
}

/** Locale-aware number formatting. Non-finite input renders as an em dash. */
export function formatNumber(
  value: number,
  lang: Lang,
  options: Intl.NumberFormatOptions = {},
): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(LOCALE[lang], options).format(value);
}

/**
 * Distance, metres in and metres/kilometres out.
 *
 * Below 1 km it is metres; above it the precision shrinks as the number grows,
 * so a 4.21 km leg stays precise while a 2,700 km route is not cluttered with
 * decimals it cannot support.
 */
export function formatDistance(metres: number, lang: Lang): string {
  if (!Number.isFinite(metres) || metres < 0) return '—';
  const u = UNITS[lang];
  if (metres < 1000) {
    return `${formatNumber(Math.round(metres), lang, { maximumFractionDigits: 0 })} ${u.metre}`;
  }
  const km = metres / 1000;
  const decimals = km >= 100 ? 0 : km >= 10 ? 1 : 2;
  return `${formatNumber(km, lang, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ${u.kilometre}`;
}

/**
 * Compact distance for chart axes: no trailing zeros, so ticks read
 * "1 km", "2,5 km", "500 m" instead of "1,00 km".
 */
export function formatDistanceAxis(metres: number, lang: Lang): string {
  if (!Number.isFinite(metres) || metres < 0) return '—';
  const u = UNITS[lang];
  if (metres < 1000) {
    return `${formatNumber(Math.round(metres), lang, { maximumFractionDigits: 0 })} ${u.metre}`;
  }
  return `${formatNumber(metres / 1000, lang, { maximumFractionDigits: 2 })} ${u.kilometre}`;
}

/** Elevation in metres, with an optional "above sea level" marker. */
export function formatElevation(metres: number, lang: Lang, aboveSea = true): string {
  if (!Number.isFinite(metres)) return '—';
  const u = UNITS[lang];
  const value = formatNumber(Math.round(metres), lang, { maximumFractionDigits: 0 });
  return `${value} ${aboveSea ? u.metresAboveSea : u.metre}`;
}

/** Elevation range, e.g. "984–2 468 moh". */
export function formatElevationRange(min: number, max: number, lang: Lang): string {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '—';
  const u = UNITS[lang];
  const lo = formatNumber(Math.round(min), lang, { maximumFractionDigits: 0 });
  const hi = formatNumber(Math.round(max), lang, { maximumFractionDigits: 0 });
  return `${lo}–${hi} ${u.metresAboveSea}`;
}

/**
 * Duration in minutes → "4 t 35 min" / "4 h 35 min". Sub-hour durations are
 * minutes only; exact hours omit the minute part.
 */
export function formatDuration(minutes: number, lang: Lang): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  const u = UNITS[lang];
  const total = Math.round(minutes);
  if (total < 60) {
    return `${formatNumber(total, lang, { maximumFractionDigits: 0 })} ${u.minute}`;
  }
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hours = formatNumber(h, lang, { maximumFractionDigits: 0 });
  if (m === 0) return `${hours} ${u.hour}`;
  return `${hours} ${u.hour} ${formatNumber(m, lang, { maximumFractionDigits: 0 })} ${u.minute}`;
}

/**
 * Grade in percent → "+8,3 %" / "-4,1 %". One decimal is already beyond the
 * accuracy of a 10 m DEM averaged over 100 m, so more would be false precision.
 */
export function formatGrade(percent: number, lang: Lang): string {
  if (!Number.isFinite(percent)) return '—';
  return new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
    signDisplay: 'exceptZero',
  }).format(percent / 100);
}

/** A plain integer with locale grouping, e.g. "12 480". */
export function formatCount(value: number, lang: Lang): string {
  return formatNumber(Math.round(value), lang, { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// Naismith
// ---------------------------------------------------------------------------

/** Pace knobs for the Naismith estimate. */
export interface Pace {
  /** Speed on the flat, km/h. */
  speedKmh: number;
  /** Metres of ascent per hour of added time. */
  ascentMPerHour: number;
}

/**
 * Naismith's rule, as stated in the UI:
 *   time = distance / speed + ascent / ascentRate
 *
 * Defaults are the original rule (5 km/h, 600 m per hour). Descent is not
 * credited — Naismith's rule never has been — and a route that only descends
 * gets the flat time. Non-finite inputs return NaN so callers can disable the
 * number rather than render a silent zero.
 */
export const DEFAULT_PACE: Pace = { speedKmh: 5, ascentMPerHour: 600 };

export const PACE_LIMITS = {
  speedKmh: { min: 1, max: 15 },
  ascentMPerHour: { min: 100, max: 2000 },
} as const;

export function naismithMinutes(distanceM: number, ascentM: number, pace: Pace = DEFAULT_PACE): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(ascentM)) return Number.NaN;
  if (!(pace.speedKmh > 0) || !(pace.ascentMPerHour > 0)) return Number.NaN;
  const flat = distanceM / 1000 / pace.speedKmh;
  const climb = Math.max(0, ascentM) / pace.ascentMPerHour;
  return (flat + climb) * 60;
}

/** Clamp a pace to the supported range; non-numeric fields fall back to defaults. */
export function normalizePace(pace: Partial<Pace> | null | undefined): Pace {
  const speed = Number(pace?.speedKmh);
  const ascent = Number(pace?.ascentMPerHour);
  return {
    speedKmh: Number.isFinite(speed)
      ? Math.min(PACE_LIMITS.speedKmh.max, Math.max(PACE_LIMITS.speedKmh.min, speed))
      : DEFAULT_PACE.speedKmh,
    ascentMPerHour: Number.isFinite(ascent)
      ? Math.min(
          PACE_LIMITS.ascentMPerHour.max,
          Math.max(PACE_LIMITS.ascentMPerHour.min, ascent),
        )
      : DEFAULT_PACE.ascentMPerHour,
  };
}
