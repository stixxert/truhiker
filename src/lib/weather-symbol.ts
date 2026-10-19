/**
 * MET symbol codes → a small, localised icon family.
 *
 * MET publishes ~40 `symbol_code` values (`clearsky_day`, `lightrainandthunder`,
 * …). We do not render a distinct glyph for each: the timeline already shows
 * precipitation in millimetres and wind in m/s, so the symbol only has to answer
 * "what does the sky look like". Nine families do that, and every one of them is
 * translated in both dictionaries.
 *
 * Unknown codes return `unknown` — never a guess. The UI shows the raw code in
 * the tooltip so a new MET code is visible rather than silently replaced.
 */

export type WeatherSymbolFamily =
  | 'clear'
  | 'fair'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'sleet'
  | 'snow'
  | 'thunder'
  | 'unknown';

/** Strip `_day`, `_night`, `_polartwilight` and lowercase the code. */
export function normalizeSymbolCode(code: string): string {
  return code.trim().toLowerCase().replace(/_(day|night|polartwilight)$/, '');
}

/**
 * Classify a MET symbol code. Thunder wins over precipitation because a
 * thunderstorm is the fact that changes a plan; the precipitation it carries is
 * in the numeric columns.
 */
export function weatherSymbolFamily(code: string | undefined): WeatherSymbolFamily {
  if (!code) return 'unknown';
  const base = normalizeSymbolCode(code);
  if (base.length === 0) return 'unknown';
  if (base.includes('thunder')) return 'thunder';
  if (base.includes('snow')) return 'snow';
  if (base.includes('sleet')) return 'sleet';
  if (base.includes('rain')) return 'rain';
  if (base === 'fog') return 'fog';
  if (base === 'clearsky') return 'clear';
  if (base === 'fair') return 'fair';
  if (base === 'partlycloudy') return 'partly-cloudy';
  if (base === 'cloudy') return 'cloudy';
  return 'unknown';
}
