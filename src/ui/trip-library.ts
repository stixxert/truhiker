/**
 * The saved-trip library dialog.
 *
 * One row per trip with the six actions the spec asks for. Rename and delete
 * happen inline (a native `<dialog>` with a `confirm()` inside it is a worse
 * experience and blocks the whole page); every other action is a callback, so
 * the session — not the dialog — decides how to open, duplicate or export.
 *
 * Import accepts a file picker and drag-and-drop. Failures are the caller's to
 * translate: `onImport` receives the `File` and the app surfaces the
 * `StoreError` in the banner.
 */

import type { I18n } from '../i18n';
import type { TripLibraryView, TripRowView } from './trip-library-view';

export interface TripLibraryHandlers {
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onExportGpx: (id: string) => void;
  onExportGeoJson: (id: string) => void;
  onImport: (file: File) => void;
  onSettings: () => void;
  onNewTrip: () => void;
}

type RowAction = 'open' | 'rename' | 'duplicate' | 'delete' | 'gpx' | 'geojson';

const ACTIONS: RowAction[] = ['open', 'rename', 'duplicate', 'delete', 'gpx', 'geojson'];

const ACTION_KEYS = {
  open: 'trips.openAction',
  rename: 'trips.rename',
  duplicate: 'trips.duplicate',
  delete: 'trips.delete',
  gpx: 'trips.exportGpx',
  geojson: 'trips.exportGeoJson',
} as const;

export class TripLibraryDialog {
  private readonly root: HTMLDialogElement;
  private readonly i18n: I18n;
  private readonly handlers: TripLibraryHandlers;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly problem: HTMLElement;
  private readonly importZone: HTMLElement;
  private readonly importButton: HTMLButtonElement;
  private readonly importInput: HTMLInputElement;

  private view: TripLibraryView | null = null;
  private renamingId: string | null = null;
  private pendingDeleteId: string | null = null;
  /** Created on first render: the dialog markup has no storage line of its own. */
  private storageLine: HTMLElement | null = null;
  private storageNote: HTMLElement | null = null;

  constructor(root: HTMLDialogElement, i18n: I18n, handlers: TripLibraryHandlers) {
    this.root = root;
    this.i18n = i18n;
    this.handlers = handlers;
    this.list = required(root, 'trip-list');
    this.empty = required(root, 'trips-empty');
    this.problem = required(root, 'trips-problem');
    this.importZone = required(root, 'trip-import');
    this.importButton = required<HTMLButtonElement>(root, 'trips-import-btn');
    this.importInput = required<HTMLInputElement>(root, 'trips-import-input');

    this.importButton.addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => {
      const file = this.importInput.files?.[0];
      this.importInput.value = '';
      if (file) this.handlers.onImport(file);
    });

    for (const event of ['dragenter', 'dragover'] as const) {
      this.importZone.addEventListener(event, (dragEvent) => {
        if (!dragEvent.dataTransfer?.types.includes('Files')) return;
        dragEvent.preventDefault();
        this.importZone.classList.add('is-over');
      });
    }
    this.importZone.addEventListener('dragleave', () => this.importZone.classList.remove('is-over'));
    this.importZone.addEventListener('drop', (dropEvent) => {
      dropEvent.preventDefault();
      this.importZone.classList.remove('is-over');
      const file = dropEvent.dataTransfer?.files?.[0];
      if (file) this.handlers.onImport(file);
    });

    required<HTMLButtonElement>(root, 'trips-settings').addEventListener('click', () =>
      this.handlers.onSettings(),
    );
    required<HTMLButtonElement>(root, 'trips-new').addEventListener('click', () =>
      this.handlers.onNewTrip(),
    );
  }

  get isOpen(): boolean {
    return this.root.open;
  }

  open(): void {
    this.renamingId = null;
    this.pendingDeleteId = null;
    if (typeof this.root.showModal === 'function') {
      if (!this.root.open) this.root.showModal();
    } else {
      this.root.setAttribute('open', '');
    }
  }

  close(): void {
    this.renamingId = null;
    this.pendingDeleteId = null;
    if (typeof this.root.close === 'function') this.root.close();
    else this.root.removeAttribute('open');
  }

  render(view: TripLibraryView): void {
    this.view = view;
    this.empty.hidden = !view.empty;
    this.empty.textContent = view.emptyMessage ?? '';
    this.problem.hidden = view.problem === null;
    this.problem.textContent = view.problem ?? '';
    if (view.problemDetail) this.problem.title = view.problemDetail;
    else this.problem.removeAttribute('title');
    this.importButton.disabled = !view.importEnabled;
    this.renderStorage(view);

    this.list.replaceChildren();
    for (const row of view.rows) this.list.append(this.buildRow(row));
  }

  /**
   * "IndexedDB · 12.3 MB of ~8 GB used · persistent", plus a visible warning
   * when the browser fell back to localStorage. Built here rather than in
   * `index.html` so an existing document keeps working.
   */
  private renderStorage(view: TripLibraryView): void {
    if (!this.storageLine) {
      const doc = this.root.ownerDocument;
      const line = doc.createElement('p');
      line.className = 'trips-storage';
      line.id = 'trips-storage';
      const note = doc.createElement('p');
      note.className = 'trips-storage-note';
      note.id = 'trips-storage-note';
      note.hidden = true;
      this.list.after(line);
      line.after(note);
      this.storageLine = line;
      this.storageNote = note;
    }
    const line = this.storageLine;
    line.hidden = view.storageLabel.length === 0;
    line.textContent = view.storageLabel;
    line.dataset.kind = view.storageNote ? 'fallback' : 'durable';
    if (view.storageDetail) line.title = view.storageDetail;
    else line.removeAttribute('title');

    const note = this.storageNote;
    if (!note) return;
    note.hidden = view.storageNote === null;
    note.textContent = view.storageNote ?? '';
    note.dataset.kind = view.storageNote === null ? '' : 'warning';
    if (view.storageDetail) note.title = view.storageDetail;
    else note.removeAttribute('title');
  }

  /** Re-render after a language change with the last known data. */
  refreshLanguage(): void {
    if (this.view) this.render(this.view);
  }

  private buildRow(row: TripRowView): HTMLLIElement {
    const doc = this.root.ownerDocument;
    const item = doc.createElement('li');
    item.className = 'trip-row';
    item.dataset.id = row.id;
    if (row.isCurrent) item.dataset.current = 'true';

    const head = doc.createElement('div');
    head.className = 'trip-head';
    const name = doc.createElement('span');
    name.className = 'trip-name';
    name.textContent = row.name;
    head.append(name);
    if (row.isCurrent) {
      const badge = doc.createElement('span');
      badge.className = 'trip-badge';
      badge.textContent = this.i18n.t('trips.current');
      head.append(badge);
    }
    item.append(head);

    if (this.renamingId === row.id) {
      item.append(this.buildRenameForm(row));
      return item;
    }

    const meta = doc.createElement('span');
    meta.className = 'trip-meta';
    meta.textContent = [row.updatedLabel, row.distanceLabel, row.legCountLabel].join(' · ');
    item.append(meta);

    if (this.pendingDeleteId === row.id) {
      item.append(this.buildDeleteConfirm(row));
      return item;
    }

    const actions = doc.createElement('span');
    actions.className = 'trip-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', this.i18n.t('trips.actionsFor', { name: row.name }));
    for (const action of ACTIONS) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-small';
      button.dataset.action = action;
      button.textContent = this.i18n.t(ACTION_KEYS[action]);
      if (action === 'delete') button.classList.add('btn-danger');
      button.addEventListener('click', () => this.run(row.id, action));
      actions.append(button);
    }
    item.append(actions);
    return item;
  }

  private buildRenameForm(row: TripRowView): HTMLFormElement {
    const doc = this.root.ownerDocument;
    const form = doc.createElement('form');
    form.className = 'trip-rename';
    const input = doc.createElement('input');
    input.type = 'text';
    input.value = row.name;
    input.required = true;
    input.maxLength = 120;
    input.setAttribute('aria-label', this.i18n.t('trips.renameLabel'));
    const save = doc.createElement('button');
    save.type = 'submit';
    save.className = 'btn btn-small btn-primary';
    save.textContent = this.i18n.t('trips.renameSave');
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-small';
    cancel.textContent = this.i18n.t('trips.renameCancel');
    cancel.addEventListener('click', () => {
      this.renamingId = null;
      if (this.view) this.render(this.view);
    });
    form.append(input, save, cancel);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const next = input.value.trim();
      if (next.length === 0) {
        input.focus();
        return;
      }
      this.renamingId = null;
      this.handlers.onRename(row.id, next);
    });
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return form;
  }

  private buildDeleteConfirm(row: TripRowView): HTMLElement {
    const doc = this.root.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'trip-confirm';
    const question = doc.createElement('span');
    question.textContent = this.i18n.t('trips.deleteConfirm', { name: row.name });
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-small btn-danger';
    remove.textContent = this.i18n.t('trips.delete');
    remove.addEventListener('click', () => {
      this.pendingDeleteId = null;
      this.handlers.onDelete(row.id);
    });
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-small';
    cancel.textContent = this.i18n.t('trips.renameCancel');
    cancel.addEventListener('click', () => {
      this.pendingDeleteId = null;
      if (this.view) this.render(this.view);
    });
    wrap.append(question, remove, cancel);
    return wrap;
  }

  private run(id: string, action: RowAction): void {
    switch (action) {
      case 'open':
        this.handlers.onOpen(id);
        return;
      case 'rename':
        this.renamingId = id;
        if (this.view) this.render(this.view);
        return;
      case 'delete':
        this.pendingDeleteId = id;
        if (this.view) this.render(this.view);
        return;
      case 'duplicate':
        this.handlers.onDuplicate(id);
        return;
      case 'gpx':
        this.handlers.onExportGpx(id);
        return;
      case 'geojson':
        this.handlers.onExportGeoJson(id);
        return;
    }
  }
}

function required<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T {
  const element = root.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`trip library is missing #${id}`);
  return element;
}
