/**
 * The weather timeline panel.
 *
 * This class only renders the model from `weather-view.ts`; every honesty rule
 * (no numbers beyond the horizon, no zero for unknown) lives there. What is
 * added here: table semantics, an `aria-live` status line, a real action button
 * for the state that needs one, and a panel that stays closed until asked — no
 * polling, no timers.
 */

import type { UserProfile } from '../contracts';
import type { I18n } from '../i18n';
import { createWeatherIcon } from './weather-icon';
import {
  buildWeatherView,
  type WeatherPanelState,
  type WeatherRowView,
  type WeatherViewModel,
} from './weather-view';

interface WeatherPanelHandlers {
  onRefresh: () => void;
  onSettings: () => void;
  onOpenRoute: () => void;
  onClose: () => void;
  /** Escape closed the panel; the app returns focus to the trigger button. */
  onEscape?: () => void;
}

export class WeatherPanel {
  private readonly root: HTMLElement;
  private readonly i18n: I18n;
  private readonly handlers: WeatherPanelHandlers;
  private readonly status: HTMLElement;
  private readonly note: HTMLElement;
  private readonly alertsNote: HTMLElement;
  private readonly messageWrap: HTMLElement;
  private readonly messageText: HTMLElement;
  private readonly action: HTMLButtonElement;
  private readonly refresh: HTMLButtonElement;
  private readonly tableWrap: HTMLElement;
  private readonly tableBody: HTMLElement;
  private readonly warnings: HTMLElement;
  private readonly close: HTMLButtonElement;

  private last: { state: WeatherPanelState; profile: UserProfile | null; horizonDays: number } | null =
    null;
  private actionKind: WeatherViewModel['action'] = 'none';
  /** Where focus was when the panel opened, so `hide()` can put it back. */
  private returnFocus: HTMLElement | null = null;

  constructor(root: HTMLElement, i18n: I18n, handlers: WeatherPanelHandlers) {
    this.root = root;
    this.i18n = i18n;
    this.handlers = handlers;
    this.status = required(root, 'weather-status');
    this.note = required(root, 'weather-note');
    this.alertsNote = required(root, 'weather-alerts-note');
    this.messageWrap = required(root, 'weather-message');
    this.messageText = required(root, 'weather-message-text');
    this.action = required<HTMLButtonElement>(root, 'weather-action');
    this.refresh = required<HTMLButtonElement>(root, 'weather-refresh');
    this.tableWrap = required(root, 'weather-table-wrap');
    this.tableBody = required(root, 'weather-table-body');
    this.warnings = required(root, 'weather-warnings');
    this.close = required<HTMLButtonElement>(root, 'weather-close');

    this.refresh.addEventListener('click', () => this.handlers.onRefresh());
    this.close.addEventListener('click', () => this.handlers.onClose());
    this.action.addEventListener('click', () => {
      if (this.actionKind === 'settings') this.handlers.onSettings();
      else if (this.actionKind === 'refresh') this.handlers.onRefresh();
      else if (this.actionKind === 'open-route') this.handlers.onOpenRoute();
    });
    // The supply panel closes on Escape; this one must not be the exception.
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      this.handlers.onClose();
      this.handlers.onEscape?.();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    if (this.root.hidden) {
      const active = this.root.ownerDocument.activeElement;
      this.returnFocus = active instanceof HTMLElement ? active : null;
    }
    this.root.hidden = false;
    // Take the keyboard: the panel closes on Escape, and a keydown only reaches
    // it when focus is inside. `hide()` puts focus back where it came from.
    this.close.focus();
  }

  hide(): void {
    const wasOpen = !this.root.hidden;
    this.root.hidden = true;
    // A hidden panel must not keep the keyboard: return it to the trigger, or a
    // screen-reader user is left with focus on an invisible element.
    if (wasOpen) this.restoreFocus();
  }

  private restoreFocus(): void {
    const target = this.returnFocus;
    this.returnFocus = null;
    if (target && target.isConnected) target.focus();
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  /** Re-render after a language change with the last known state. */
  refreshLanguage(): void {
    if (this.last) this.render(this.last.state, this.last.profile, this.last.horizonDays);
  }

  render(state: WeatherPanelState, profile: UserProfile | null, horizonDays: number): void {
    this.last = { state, profile, horizonDays };
    const view = buildWeatherView(state, profile, horizonDays, this.i18n);
    this.renderStatus(view);
    // D12: an empty warning list is not a clearance, so the panel states that
    // hazard alerts are unsupported on every render.
    this.alertsNote.textContent = view.alertsNote;
    this.note.textContent = view.note;
    this.renderMessage(view);
    this.renderRows(view);
    this.renderWarnings(view);
    this.refresh.disabled = view.action !== 'refresh';
  }

  private renderStatus(view: WeatherViewModel): void {
    const parts = [view.fetchedLabel, view.statusLine].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    this.status.textContent = parts.join(' · ');
  }

  private renderMessage(view: WeatherViewModel): void {
    const hasMessage = view.message !== null && view.state !== 'table';
    this.messageWrap.hidden = !hasMessage;
    this.messageText.textContent = view.message ?? '';
    if (view.detail) this.messageWrap.title = view.detail;
    else this.messageWrap.removeAttribute('title');
    this.actionKind = view.action;
    this.action.hidden = view.action === 'none';
    if (view.action === 'settings') this.action.textContent = this.i18n.t('weather.openSettings');
    else if (view.action === 'refresh') this.action.textContent = this.i18n.t('action.retry');
    else if (view.action === 'open-route') this.action.textContent = this.i18n.t('action.openGpx');
  }

  private renderRows(view: WeatherViewModel): void {
    this.tableBody.replaceChildren();
    this.tableWrap.hidden = view.rows.length === 0;
    if (view.rows.length === 0) return;
    const doc = this.root.ownerDocument;
    for (const row of view.rows) {
      this.tableBody.append(this.buildRow(doc, row));
    }
  }

  private buildRow(doc: Document, row: WeatherRowView): HTMLTableRowElement {
    const tr = doc.createElement('tr');
    tr.dataset.status = row.status;

    const day = doc.createElement('th');
    day.scope = 'row';
    day.className = 'wx-day';
    day.textContent = String(row.dayNumber);
    tr.append(day);

    const date = doc.createElement('td');
    date.className = 'wx-date';
    date.textContent = row.dateLabel;
    tr.append(date);

    const distance = doc.createElement('td');
    distance.className = 'wx-distance';
    distance.textContent = row.distanceLabel;
    tr.append(distance);

    const conditions = doc.createElement('td');
    conditions.className = 'wx-conditions';
    if (row.status === 'forecast') {
      const values = doc.createElement('span');
      values.className = 'wx-values';
      const readable = [row.tempLabel, row.precipLabel, row.windLabel].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );
      values.setAttribute('aria-label', readable.join(', '));
      values.append(createWeatherIcon(doc, row.symbolFamily));
      if (row.tempLabel) values.append(this.valueSpan(doc, row.tempLabel, 'temp'));
      if (row.precipLabel) values.append(this.valueSpan(doc, row.precipLabel, 'precip'));
      if (row.windLabel) values.append(this.valueSpan(doc, row.windLabel, 'wind'));
      conditions.append(values);

      const sub = doc.createElement('span');
      sub.className = 'wx-sub';
      const parts = [row.symbolLabel, row.issuedLabel].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );
      sub.textContent = parts.join(' · ');
      if (row.symbolCode) sub.title = row.symbolCode;
      if (sub.textContent) conditions.append(sub);
    } else {
      const badge = doc.createElement('span');
      badge.className = 'wx-badge';
      badge.dataset.kind = row.status;
      badge.textContent = row.badge ?? '';
      conditions.append(badge);
      if (row.detail) {
        const detail = doc.createElement('span');
        detail.className = 'wx-sub';
        detail.textContent = row.detail;
        conditions.append(detail);
      }
    }
    tr.append(conditions);
    return tr;
  }

  private valueSpan(doc: Document, text: string, kind: string): HTMLSpanElement {
    const span = doc.createElement('span');
    span.className = 'wx-value';
    span.dataset.kind = kind;
    span.textContent = text;
    return span;
  }

  private renderWarnings(view: WeatherViewModel): void {
    this.warnings.replaceChildren();
    this.warnings.hidden = view.warnings.length === 0;
    if (view.warnings.length === 0) return;
    const doc = this.root.ownerDocument;
    const heading = doc.createElement('li');
    heading.className = 'wx-warning-heading';
    heading.textContent = this.i18n.t('weather.warnings');
    this.warnings.append(heading);
    for (const warning of view.warnings) {
      const item = doc.createElement('li');
      item.className = 'wx-warning';
      item.dataset.severity = warning.severityLabel;
      const severity = doc.createElement('span');
      severity.className = 'wx-severity';
      severity.textContent = warning.severityLabel;
      item.append(severity);
      const title = doc.createElement('span');
      title.className = 'wx-warning-title';
      title.textContent = warning.title;
      item.append(title);
      const meta = [warning.area, warning.periodLabel].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );
      if (meta.length > 0) {
        const metaEl = doc.createElement('span');
        metaEl.className = 'wx-sub';
        metaEl.textContent = meta.join(' · ');
        item.append(metaEl);
      }
      if (warning.url) {
        const link = doc.createElement('a');
        link.href = warning.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = this.i18n.t('weather.warningLink');
        item.append(link);
      }
      this.warnings.append(item);
    }
  }
}

function required<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T {
  const element = root.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`weather panel is missing #${id}`);
  return element;
}
