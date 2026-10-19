/**
 * Trip settings dialog: body, pack, pace, start date, support model.
 *
 * The dialog states plainly that these are the user's numbers, not defaults
 * assumed about them (docs/09 §0–§4). Validation comes from `settings-view.ts`;
 * this file only moves values in and out of the form and renders the errors
 * next to a list labelled with the field name.
 */

import type { UserProfile } from '../contracts';
import type { I18n } from '../i18n';
import {
  parseSettingsForm,
  settingsFromProfile,
  type SettingsFieldError,
  type SettingsFormValues,
} from './settings-view';

export interface TripSettingsHandlers {
  onSave: (profile: UserProfile) => void;
}

const FIELD_KEYS = {
  massKg: 'settings.mass',
  heightCm: 'settings.height',
  ageYears: 'settings.age',
  sex: 'settings.sex',
  bodyFatPercent: 'settings.bodyFat',
  packBaseKg: 'settings.pack',
  dailyKm: 'settings.dailyKm',
  dailyHours: 'settings.dailyHours',
  startDate: 'settings.startDate',
  support: 'settings.support',
} as const;

export class TripSettingsDialog {
  private readonly root: HTMLDialogElement;
  private readonly i18n: I18n;
  private readonly handlers: TripSettingsHandlers;
  private readonly form: HTMLFormElement;
  private readonly errors: HTMLElement;
  private readonly unavailable: HTMLElement;
  private readonly fields: {
    massKg: HTMLInputElement;
    heightCm: HTMLInputElement;
    ageYears: HTMLInputElement;
    sex: HTMLSelectElement;
    bodyFatPercent: HTMLInputElement;
    packBaseKg: HTMLInputElement;
    dailyKm: HTMLInputElement;
    dailyHours: HTMLInputElement;
    startDate: HTMLInputElement;
    support: HTMLSelectElement;
  };
  private available = true;

  constructor(root: HTMLDialogElement, i18n: I18n, handlers: TripSettingsHandlers) {
    this.root = root;
    this.i18n = i18n;
    this.handlers = handlers;
    this.form = required<HTMLFormElement>(root, 'settings-form');
    this.errors = required(root, 'settings-errors');
    this.unavailable = required(root, 'settings-unavailable');
    this.fields = {
      massKg: required<HTMLInputElement>(root, 'settings-mass'),
      heightCm: required<HTMLInputElement>(root, 'settings-height'),
      ageYears: required<HTMLInputElement>(root, 'settings-age'),
      sex: required<HTMLSelectElement>(root, 'settings-sex'),
      bodyFatPercent: required<HTMLInputElement>(root, 'settings-bodyfat'),
      packBaseKg: required<HTMLInputElement>(root, 'settings-pack'),
      dailyKm: required<HTMLInputElement>(root, 'settings-daily-km'),
      dailyHours: required<HTMLInputElement>(root, 'settings-daily-hours'),
      startDate: required<HTMLInputElement>(root, 'settings-start-date'),
      support: required<HTMLSelectElement>(root, 'settings-support'),
    };
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
  }

  get isOpen(): boolean {
    return this.root.open;
  }

  open(profile: UserProfile | null, options: { available?: boolean } = {}): void {
    this.available = options.available ?? true;
    this.applyValues(profile);
    this.errors.hidden = true;
    this.errors.replaceChildren();
    this.unavailable.hidden = this.available;
    for (const field of Object.values(this.fields)) field.disabled = !this.available;
    required<HTMLButtonElement>(this.root, 'settings-submit').disabled = !this.available;
    if (typeof this.root.showModal === 'function') {
      if (!this.root.open) this.root.showModal();
    } else {
      this.root.setAttribute('open', '');
    }
    if (this.available) queueMicrotask(() => this.fields.massKg.focus());
  }

  close(): void {
    if (typeof this.root.close === 'function') this.root.close();
    else this.root.removeAttribute('open');
  }

  /** Focus the field the weather panel is missing (start date / daily km). */
  focusField(field: 'startDate' | 'dailyKm'): void {
    queueMicrotask(() => this.fields[field].focus());
  }

  private applyValues(profile: UserProfile | null): void {
    const values = settingsFromProfile(profile);
    this.fields.massKg.value = values.massKg;
    this.fields.heightCm.value = values.heightCm;
    this.fields.ageYears.value = values.ageYears;
    this.fields.sex.value = values.sex;
    this.fields.bodyFatPercent.value = values.bodyFatPercent;
    this.fields.packBaseKg.value = values.packBaseKg;
    this.fields.dailyKm.value = values.dailyKm;
    this.fields.dailyHours.value = values.dailyHours;
    this.fields.startDate.value = values.startDate;
    this.fields.support.value = values.support;
  }

  private readValues(): SettingsFormValues {
    return {
      massKg: this.fields.massKg.value,
      heightCm: this.fields.heightCm.value,
      ageYears: this.fields.ageYears.value,
      sex: this.fields.sex.value === 'female' ? 'female' : 'male',
      bodyFatPercent: this.fields.bodyFatPercent.value,
      packBaseKg: this.fields.packBaseKg.value,
      dailyKm: this.fields.dailyKm.value,
      dailyHours: this.fields.dailyHours.value,
      startDate: this.fields.startDate.value,
      support: this.fields.support.value === 'mail-drops' ? 'mail-drops' : 'carry-all',
    };
  }

  private submit(): void {
    if (!this.available) return;
    const result = parseSettingsForm(this.readValues(), this.i18n);
    if (!result.ok) {
      this.renderErrors(result.errors);
      return;
    }
    this.errors.hidden = true;
    this.handlers.onSave(result.profile);
  }

  private renderErrors(errors: readonly SettingsFieldError[]): void {
    this.errors.replaceChildren();
    const list = this.root.ownerDocument.createElement('ul');
    for (const error of errors) {
      const item = this.root.ownerDocument.createElement('li');
      item.textContent = `${this.i18n.t(FIELD_KEYS[error.field])}: ${error.message}`;
      list.append(item);
    }
    this.errors.append(list);
    this.errors.hidden = false;
    const first = errors[0];
    if (first) this.fields[first.field].focus();
  }
}

function required<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T {
  const element = root.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`trip settings is missing #${id}`);
  return element;
}
