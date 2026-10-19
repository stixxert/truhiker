/**
 * The save-status line: "lagret 14:32", "ikke lagret", or the store's reason.
 *
 * Pure so the states can be tested without a DOM, and so the same text is used
 * in the header, the trip library and the toast.
 */

import type { SaveStatus } from '../app/trip-session';
import type { I18n } from '../i18n';

export function formatSaveTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(at),
  );
}

/** One line for the visible status region. Empty when there is nothing to say. */
export function saveStatusText(status: SaveStatus, i18n: Pick<I18n, 't' | 'locale'>): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'dirty':
      return i18n.t('save.dirty');
    case 'saved':
      return i18n.t('save.saved', {
        time: formatSaveTime(status.at ?? Date.now(), i18n.locale),
      });
    case 'unavailable':
      return i18n.t('save.unavailable');
    case 'error':
      if (status.code === 'quota-exceeded') return i18n.t('save.quota');
      return i18n.t('save.error', { message: briefMessage(status.message) });
    default:
      return '';
  }
}

/** The full technical detail, for a tooltip rather than the visible line. */
export function saveStatusDetail(status: SaveStatus): string | null {
  if (status.kind === 'error' || status.kind === 'unavailable') return status.message ?? null;
  return null;
}

/** Browsers sometimes return multi-line quota messages; one line is enough. */
function briefMessage(message: string | undefined): string {
  if (!message) return '';
  const line = message.split('\n')[0].trim();
  return line.length > 110 ? `${line.slice(0, 107)}…` : line;
}
