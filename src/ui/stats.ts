/**
 * The stats bar: distance, ascent, descent, Naismith walking time, elevation
 * range, and the elevation-source badge.
 *
 * Degradation rule: when the DEM is unavailable, DEM-derived numbers are
 * rendered as "—" with a visible explanation — never as zero. Distance comes
 * from the GPX geometry and stays meaningful, so it remains.
 *
 * Unit rule (D8): ascent and descent are **vertical metres**. They must not go
 * through the horizontal `distance()` formatter, which switches to kilometres
 * above 1,000 m and would print a 1,500 m climb as "1,50 km".
 *
 * Honesty rule (D10/B3): when the energy numbers come from the built-in default
 * body, the bar says so, in place, with a way to fix it.
 */

import type { I18n } from '../i18n';

export type SourceStatus = 'idle' | 'ready' | 'loading' | 'error';

export interface StatsValues {
  distanceM: number | null;
  ascentM: number | null;
  descentM: number | null;
  minutes: number | null;
  minEle: number | null;
  maxEle: number | null;
}

export interface StatsModel {
  values: StatsValues;
  source: SourceStatus;
  /** Why the DEM-derived values are disabled, shown as a tooltip. */
  disabledReason?: string;
  /** Naismith parameters, for the tooltip on the time cell. */
  paceHint?: string;
}

export interface StatsBarHandlers {
  /** The badge's button: open the trip settings so the user can enter a body. */
  onSetOwnNumbers?: () => void;
}

const ID = {
  distance: 'stat-distance',
  ascent: 'stat-ascent',
  descent: 'stat-descent',
  time: 'stat-time',
  elevation: 'stat-elevation',
} as const;

/**
 * Ascent as a vertical distance: `+1 500 m`, never `+1,50 km`.
 *
 * Exported so the unit rule can be asserted without a DOM; the sign is part of
 * the value, because a bare "1 500 m" in the ascent cell reads as an elevation.
 */
export function ascentLabel(metres: number, i18n: Pick<I18n, 'format'>): string {
  return `+${i18n.format.elevation(metres, false)}`;
}

/** Descent as a vertical distance: `−3 000 m` (U+2212, not a hyphen). */
export function descentLabel(metres: number, i18n: Pick<I18n, 'format'>): string {
  return `−${i18n.format.elevation(metres, false)}`;
}

export class StatsBar {
  private readonly root: HTMLElement;
  private readonly i18n: I18n;
  private readonly handlers: StatsBarHandlers;
  private readonly sourceBadge: HTMLElement;
  private readonly sourceLabel: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly noticeText: HTMLElement;
  private readonly noticeButton: HTMLButtonElement;
  private lastModel: StatsModel | null = null;
  private noticeMessage: string | null = null;

  constructor(root: HTMLElement, i18n: I18n, handlers: StatsBarHandlers = {}) {
    this.root = root;
    this.i18n = i18n;
    this.handlers = handlers;
    const badge = root.querySelector<HTMLElement>('#source-badge');
    const label = root.querySelector<HTMLElement>('#source-label');
    if (!badge || !label) throw new Error('stats bar is missing #source-badge/#source-label');
    this.sourceBadge = badge;
    this.sourceLabel = label;

    // Built here rather than in index.html: the bar is a model-driven component
    // and this row only exists while the numbers come from a placeholder body.
    const doc = root.ownerDocument;
    this.notice = doc.createElement('div');
    this.notice.className = 'stat stat-notice';
    this.notice.hidden = true;
    this.notice.setAttribute('role', 'status');
    this.noticeText = doc.createElement('span');
    this.noticeText.className = 'stat-notice-text';
    this.noticeButton = doc.createElement('button');
    this.noticeButton.type = 'button';
    this.noticeButton.className = 'btn btn-small';
    this.noticeButton.addEventListener('click', () => this.handlers.onSetOwnNumbers?.());
    this.notice.append(this.noticeText, this.noticeButton);
    root.append(this.notice);
  }

  /**
   * The badge for numbers computed from the default body, or `null` to hide it.
   * Shown, never hidden-and-implied: the panel stays usable, it is just labelled.
   */
  setProfileNotice(message: string | null): void {
    this.noticeMessage = message;
    this.renderNotice();
  }

  private renderNotice(): void {
    const message = this.noticeMessage;
    this.notice.hidden = message === null;
    this.noticeText.textContent = message ?? '';
    this.noticeButton.textContent = this.i18n.t('energy.setOwnNumbers');
  }

  render(model: StatsModel): void {
    this.lastModel = model;
    const { values, source, disabledReason, paceHint } = model;
    const demReady = source === 'ready' && disabledReason === undefined;

    const apply = (id: string, text: string, enabled: boolean, title?: string): void => {
      const element = this.root.querySelector<HTMLElement>(`#${id}`);
      if (!element) return;
      element.textContent = text;
      element.classList.toggle('is-disabled', !enabled);
      if (enabled) {
        element.removeAttribute('aria-label');
        if (title) element.title = title;
        else element.removeAttribute('title');
      } else {
        element.setAttribute('aria-label', this.i18n.t('stats.disabled'));
        if (disabledReason) element.title = disabledReason;
      }
    };

    apply(
      ID.distance,
      values.distanceM === null ? '—' : this.i18n.format.distance(values.distanceM),
      values.distanceM !== null,
    );
    apply(
      ID.ascent,
      demReady && values.ascentM !== null ? ascentLabel(values.ascentM, this.i18n) : '—',
      demReady && values.ascentM !== null,
    );
    apply(
      ID.descent,
      demReady && values.descentM !== null ? descentLabel(values.descentM, this.i18n) : '—',
      demReady && values.descentM !== null,
    );
    apply(
      ID.time,
      demReady && values.minutes !== null ? this.i18n.format.duration(values.minutes) : '—',
      demReady && values.minutes !== null,
      paceHint,
    );
    apply(
      ID.elevation,
      demReady && values.minEle !== null && values.maxEle !== null
        ? this.i18n.format.elevationRange(values.minEle, values.maxEle)
        : '—',
      demReady && values.minEle !== null && values.maxEle !== null,
    );

    this.sourceBadge.dataset.status = source;
    this.sourceLabel.textContent =
      source === 'ready'
        ? this.i18n.t('source.ready')
        : source === 'loading'
          ? this.i18n.t('source.loading')
          : source === 'error'
            ? this.i18n.t('source.error')
            : this.i18n.t('source.none');
    this.sourceBadge.title =
      source === 'ready'
        ? this.i18n.t('source.title')
        : (disabledReason ?? this.i18n.t('source.error'));
  }

  /** Re-render after a language change, using the last model. */
  refresh(): void {
    if (this.lastModel) this.render(this.lastModel);
    this.renderNotice();
  }
}
