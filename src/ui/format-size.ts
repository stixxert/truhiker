import type { I18n } from '../i18n';

/**
 * A payload size for a user-facing sentence: megabytes, one decimal below
 * 10 MB. D6 requires quota failures to name the size that failed; this is the
 * one formatter for that number (decimal comma handled by the locale).
 */
export function formatSize(bytes: number, i18n: Pick<I18n, 'format'>): string {
  const megabytes = bytes / 1_000_000;
  const value = i18n.format.number(megabytes, {
    maximumFractionDigits: megabytes < 10 ? 1 : 0,
  });
  return `${value} MB`;
}
