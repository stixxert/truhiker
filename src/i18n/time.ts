/**
 * Times and dates in `Europe/Oslo` — D8: "times in `Europe/Oslo`, dates as
 * `nb-NO`/`en-GB` via `Intl`".
 *
 * The device timezone is the wrong answer for every timestamp this app prints:
 * a MET forecast issued at 21:00 UTC is 23:00 in Oslo and 16:00 in New York, and
 * a trip saved at 23:30 UTC on the 30th is "1. juli" in Oslo. Relabelling a
 * source's timestamp into the device's zone is a silent error the user cannot
 * see, so every formatter here pins the zone.
 *
 * A missing or unparseable timestamp returns an empty string (or the input, for
 * the date form): the caller shows nothing rather than "Invalid Date".
 */

export const OSLO_TIME_ZONE = 'Europe/Oslo';

function oslo(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: OSLO_TIME_ZONE });
  } catch {
    // A runtime without timezone data must not crash a render; the caller gets
    // nothing rather than a device-local time pretending to be Oslo.
    return null;
  }
}

/** `HH:MM` in Europe/Oslo for an epoch timestamp; empty when unusable. */
export function formatClockAt(epochMs: number, locale: string): string {
  if (!Number.isFinite(epochMs)) return '';
  const formatter = oslo(locale, { hour: '2-digit', minute: '2-digit' });
  return formatter ? formatter.format(new Date(epochMs)) : '';
}

/** `HH:MM` in Europe/Oslo for an ISO timestamp; empty when unusable. */
export function formatClock(iso: string | undefined, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return formatClockAt(date.getTime(), locale);
}

/**
 * A calendar date in Europe/Oslo ("1. juli 2026"). The zone matters: an ISO
 * timestamp late in the UTC day belongs to the next Norwegian day.
 */
export function formatDay(
  iso: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const formatter = oslo(locale, options);
  return formatter ? formatter.format(date) : iso;
}
