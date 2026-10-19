/**
 * Elevation profile chart.
 *
 * Canvas, ~1 px per aggregated column, with a min/max envelope so a 3,000 km
 * route cannot alias away its climbs. The chart owns the cursor and emits it to
 * the app, which moves the marker on the map; the app can also push a cursor in
 * from the camera. Pointer, touch and keyboard all drive the same cursor.
 *
 * All maths lives in `src/lib/chart.ts`; this file only converts numbers into
 * canvas coordinates.
 */

import type { Profile } from '../core/profile';
import type { I18n } from '../i18n';
import {
  aggregateColumns,
  distanceAxis,
  elevationAtDistance,
  elevationAxis,
  gradeAtDistance,
  type ProfileColumn,
} from '../lib/chart';

export type CursorSource = 'hover' | 'map' | 'keyboard';

interface ProfileChartCallbacks {
  /** Cursor moved, or cleared (`null`) when the pointer leaves. */
  onCursor(distance: number | null, source: CursorSource): void;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Theme {
  accent: string;
  accentSoft: string;
  text: string;
  muted: string;
  grid: string;
  panel: string;
  line: string;
  axis: string;
}

const PADDING_WIDE = { left: 48, right: 16, top: 12, bottom: 22 };
const PADDING_NARROW = { left: 40, right: 10, top: 8, bottom: 18 };
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class ProfileChart {
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly i18n: I18n;
  private readonly callbacks: ProfileChartCallbacks;
  private readonly reducedMotion: boolean;
  private readonly resizeObserver: ResizeObserver | null;

  private profile: Profile | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private theme: Theme = {
    accent: '#4fae9c',
    accentSoft: 'rgba(58,217,196,0.22)',
    text: '#e8efef',
    muted: '#93a7aa',
    grid: 'rgba(255,255,255,0.07)',
    panel: '#101a1c',
    line: '#243234',
    axis: 'rgba(255,255,255,0.16)',
  };

  /** Cursor from the camera, kept separately so hover can override it. */
  private externalCursor: number | null = null;
  private hoverCursor: number | null = null;
  private keyboardCursor: number | null = null;
  private cursorSource: CursorSource = 'map';
  private pointerActive = false;
  private frame = 0;
  private revealStart = 0;

  constructor(
    host: HTMLElement,
    canvas: HTMLCanvasElement,
    i18n: I18n,
    callbacks: ProfileChartCallbacks,
  ) {
    this.host = host;
    this.canvas = canvas;
    this.i18n = i18n;
    this.callbacks = callbacks;
    this.ctx = canvas.getContext('2d');
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this.resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => this.layout())
        : null;
    this.resizeObserver?.observe(host);

    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.host.addEventListener('keydown', this.handleKeyDown);
    this.host.addEventListener('focus', this.handleFocus);
    this.host.addEventListener('blur', this.handleBlur);

    this.refreshTheme();
    this.layout();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setProfile(profile: Profile | null): void {
    const hadProfile = this.profile !== null;
    if (profile === null) this.host.setAttribute('aria-disabled', 'true');
    else this.host.removeAttribute('aria-disabled');
    this.profile = profile;
    this.externalCursor = null;
    this.hoverCursor = null;
    this.keyboardCursor = null;
    if (profile && (!hadProfile || this.revealStart === 0)) {
      this.revealStart = this.reducedMotion ? 0 : performance.now();
    } else if (!profile) {
      this.revealStart = 0;
    }
    this.updateAria();
    this.requestDraw();
  }

  /** Push the camera position in. Ignored while the pointer is inside the chart. */
  setExternalCursor(distance: number | null): void {
    this.externalCursor = distance;
    if (!this.pointerActive) {
      this.cursorSource = 'map';
      this.updateAria();
      this.requestDraw();
    }
  }

  setLanguage(): void {
    this.updateAria();
    this.requestDraw();
  }

  layout(): void {
    const width = Math.max(0, this.host.clientWidth);
    const height = Math.max(0, this.host.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (width === this.width && height === this.height && dpr === this.dpr) {
      this.requestDraw();
      return;
    }
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.refreshTheme();
    this.draw();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.host.removeEventListener('keydown', this.handleKeyDown);
    this.host.removeEventListener('focus', this.handleFocus);
    this.host.removeEventListener('blur', this.handleBlur);
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.profile) return;
    this.pointerActive = true;
    this.cursorSource = 'hover';
    this.hoverCursor = this.distanceForClientX(event.clientX);
    this.emitCursor(this.hoverCursor, 'hover');
    this.updateAria();
    this.requestDraw();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.profile) return;
    this.host.focus({ preventScroll: true });
    this.pointerActive = true;
    this.cursorSource = 'hover';
    this.hoverCursor = this.distanceForClientX(event.clientX);
    this.emitCursor(this.hoverCursor, 'hover');
    this.updateAria();
    this.requestDraw();
  };

  private handlePointerLeave = (): void => {
    if (!this.profile) return;
    this.pointerActive = false;
    this.hoverCursor = null;
    this.cursorSource = 'map';
    this.emitCursor(this.externalCursor, 'map');
    this.updateAria();
    this.requestDraw();
  };

  private handleFocus = (): void => {
    if (!this.profile) return;
    if (this.keyboardCursor === null) {
      this.keyboardCursor = this.externalCursor ?? 0;
    }
    this.cursorSource = 'keyboard';
    this.emitCursor(this.keyboardCursor, 'keyboard');
    this.updateAria();
    this.requestDraw();
  };

  private handleBlur = (): void => {
    if (!this.profile) return;
    this.keyboardCursor = null;
    if (!this.pointerActive) {
      this.cursorSource = 'map';
      this.emitCursor(this.externalCursor, 'map');
      this.updateAria();
      this.requestDraw();
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.profile) return;
    const total = this.totalDistance();
    if (!(total > 0)) return;
    const base = this.keyboardCursor ?? this.externalCursor ?? 0;
    const step = Math.max(1, total / 500);
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = base + step * (event.shiftKey ? 10 : 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = base - step * (event.shiftKey ? 10 : 1);
        break;
      case 'PageUp':
        next = base + total / 10;
        break;
      case 'PageDown':
        next = base - total / 10;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = total;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.keyboardCursor = clamp(next, 0, total);
    this.cursorSource = 'keyboard';
    this.pointerActive = false;
    this.hoverCursor = null;
    this.emitCursor(this.keyboardCursor, 'keyboard');
    this.updateAria();
    this.requestDraw();
  };

  private distanceForClientX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const plot = this.plotBox();
    const total = this.totalDistance();
    if (!(plot.width > 0)) return 0;
    const ratio = (clientX - rect.left - plot.x) / plot.width;
    return clamp(ratio, 0, 1) * total;
  }

  private emitCursor(distance: number | null, source: CursorSource): void {
    this.callbacks.onCursor(distance, source);
  }

  private currentCursor(): number | null {
    if (!this.profile) return null;
    const total = this.totalDistance();
    if (!(total > 0)) return 0;
    if (this.pointerActive && this.hoverCursor !== null) return clamp(this.hoverCursor, 0, total);
    if (this.keyboardCursor !== null) return clamp(this.keyboardCursor, 0, total);
    if (this.externalCursor !== null) return clamp(this.externalCursor, 0, total);
    return null;
  }

  // -------------------------------------------------------------------------
  // Aria
  // -------------------------------------------------------------------------

  private updateAria(): void {
    if (!this.profile) {
      this.host.removeAttribute('aria-valuenow');
      this.host.removeAttribute('aria-valuetext');
      return;
    }
    const total = this.totalDistance();
    this.host.setAttribute('aria-valuemin', '0');
    this.host.setAttribute('aria-valuemax', String(Math.round(total)));
    const cursor = this.currentCursor();
    if (cursor === null) {
      this.host.removeAttribute('aria-valuenow');
      this.host.removeAttribute('aria-valuetext');
      return;
    }
    const elevation = elevationAtDistance(this.profile.samples, cursor);
    const grade = gradeAtDistance(this.profile.samples, cursor);
    this.host.setAttribute('aria-valuenow', String(Math.round(cursor)));
    // `profile.ariaValue` already says "over havet" / "above sea level", so the
    // unit is added by the template, not by the formatter (as in `stats.ts`).
    this.host.setAttribute('aria-valuetext',
      this.i18n.t('profile.ariaValue', {
        distance: this.i18n.format.distance(cursor),
        ele: this.i18n.format.elevation(elevation, false),
        grade: this.i18n.format.grade(grade),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private requestDraw(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private refreshTheme(): void {
    if (typeof getComputedStyle !== 'function') return;
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string => {
      const value = style.getPropertyValue(name).trim();
      return value.length > 0 ? value : fallback;
    };
    this.theme = {
      accent: read('--data', '#4fae9c'),
      accentSoft: read('--accent-soft', 'rgba(58,217,196,0.22)'),
      text: read('--text', '#e8efef'),
      muted: read('--muted', '#93a7aa'),
      grid: read('--grid', 'rgba(255,255,255,0.07)'),
      panel: read('--panel', '#101a1c'),
      line: read('--line', '#243234'),
      axis: read('--axis', 'rgba(255,255,255,0.16)'),
    };
  }

  private padding(): { left: number; right: number; top: number; bottom: number } {
    return this.width < 520 ? PADDING_NARROW : PADDING_WIDE;
  }

  private plotBox(): Box {
    const padding = this.padding();
    return {
      x: padding.left,
      y: padding.top,
      width: Math.max(0, this.width - padding.left - padding.right),
      height: Math.max(0, this.height - padding.top - padding.bottom),
    };
  }

  private totalDistance(): number {
    const samples = this.profile?.samples ?? [];
    return samples.length > 0 ? samples[samples.length - 1].d : 0;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.width === 0 || this.height === 0) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const profile = this.profile;
    if (!profile || profile.samples.length === 0) return;

    const plot = this.plotBox();
    if (plot.width < 8 || plot.height < 8) return;

    const total = this.totalDistance();
    if (!(total > 0)) return;
    const axis = elevationAxis(profile.samples, 5);
    const span = Math.max(1e-6, axis.max - axis.min);
    const xFor = (d: number): number => plot.x + (d / total) * plot.width;
    const yFor = (e: number): number => plot.y + ((axis.max - e) / span) * plot.height;

    // Reveal animation (disabled under prefers-reduced-motion).
    let reveal = 1;
    if (this.revealStart > 0 && !this.reducedMotion) {
      const elapsed = performance.now() - this.revealStart;
      const progress = Math.min(1, elapsed / 650);
      reveal = 1 - (1 - progress) ** 3;
      if (progress < 1) this.requestDraw();
    }

    this.drawGrid(ctx, plot, axis.ticks, yFor);

    const columns = aggregateColumns(
      profile.samples,
      profile.samples[0].d,
      total,
      Math.max(2, Math.round(plot.width)),
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.width * reveal, plot.height);
    ctx.clip();
    this.drawArea(ctx, plot, columns, xFor, yFor);
    this.drawMeanLine(ctx, columns, xFor, yFor);
    ctx.restore();

    this.drawAxes(ctx, plot, total);
    this.drawCursor(ctx, plot, xFor, yFor);
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    plot: Box,
    ticks: number[],
    yFor: (e: number) => number,
  ): void {
    ctx.save();
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.font = `10px ${FONT_STACK}`;
    ctx.fillStyle = this.theme.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of ticks) {
      const y = Math.round(yFor(tick)) + 0.5;
      if (y < plot.y - 1 || y > plot.y + plot.height + 1) continue;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
      ctx.stroke();
      ctx.fillText(this.i18n.format.number(tick, { maximumFractionDigits: 0 }), plot.x - 7, y);
    }
    ctx.restore();
  }

  private drawArea(
    ctx: CanvasRenderingContext2D,
    plot: Box,
    columns: ProfileColumn[],
    xFor: (d: number) => number,
    yFor: (e: number) => number,
  ): void {
    if (columns.length === 0) return;
    const baseline = plot.y + plot.height;
    const gradient = ctx.createLinearGradient(0, plot.y, 0, baseline);
    gradient.addColorStop(0, this.theme.accentSoft);
    gradient.addColorStop(1, 'rgba(58,217,196,0.02)');

    ctx.beginPath();
    ctx.moveTo(xFor(columns[0].d0), baseline);
    for (const column of columns) {
      ctx.lineTo(xFor((column.d0 + column.d1) / 2), yFor(column.mean));
    }
    const last = columns[columns.length - 1];
    ctx.lineTo(xFor(last.d1), baseline);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  private drawMeanLine(
    ctx: CanvasRenderingContext2D,
    columns: ProfileColumn[],
    xFor: (d: number) => number,
    yFor: (e: number) => number,
  ): void {
    if (columns.length === 0) return;
    const path = new Path2D();
    columns.forEach((column, index) => {
      const x = xFor((column.d0 + column.d1) / 2);
      const y = yFor(column.mean);
      if (index === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });

    // Soft under-glow then the crisp line: cheaper than a canvas shadow.
    ctx.save();
    ctx.strokeStyle = this.theme.accent;
    ctx.globalAlpha = 0.14;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = this.theme.accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();

  }

  private drawAxes(ctx: CanvasRenderingContext2D, plot: Box, total: number): void {
    ctx.save();
    ctx.strokeStyle = this.theme.axis;
    ctx.lineWidth = 1;
    const baseY = Math.round(plot.y + plot.height) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plot.x, baseY);
    ctx.lineTo(plot.x + plot.width, baseY);
    ctx.stroke();

    const { ticks } = distanceAxis(total, this.width < 520 ? 4 : 7);
    ctx.font = `10px ${FONT_STACK}`;
    ctx.fillStyle = this.theme.muted;
    ctx.textBaseline = 'top';
    for (let index = 0; index < ticks.length; index++) {
      const d = ticks[index];
      const x = plot.x + (d / total) * plot.width;
      if (index > 0 && x - plot.x < 30) continue;
      ctx.strokeStyle = this.theme.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.y);
      ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.height);
      ctx.stroke();

      ctx.fillStyle = this.theme.muted;
      ctx.textAlign = index === 0 ? 'left' : 'center';
      const label = d === 0 ? '0' : this.i18n.format.distanceAxis(d);
      if (x > plot.x + plot.width - 18) continue;
      ctx.fillText(label, x, baseY + 5);
    }
    // The last tick can be cut off by the right edge; the route total is shown
    // in the header, so only draw it when there is room.
    ctx.restore();
  }

  private drawCursor(
    ctx: CanvasRenderingContext2D,
    plot: Box,
    xFor: (d: number) => number,
    yFor: (e: number) => number,
  ): void {
    const current = this.currentCursor();
    if (current === null || this.profile === null) return;
    const x = xFor(current);
    const elevation = elevationAtDistance(this.profile.samples, current);
    const y = yFor(elevation);
    const keyboard = this.cursorSource === 'keyboard';

    ctx.save();
    ctx.strokeStyle = keyboard ? this.theme.accent : 'rgba(232,239,239,0.38)';
    ctx.lineWidth = 1;
    if (!keyboard) ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, plot.y);
    ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dot: white core with an accent ring, readable on any background.
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f2fffc';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.theme.accent;
    ctx.stroke();

    if (this.cursorSource !== 'map') {
      const grade = gradeAtDistance(this.profile.samples, current);
      this.drawBubble(ctx, plot, x, y, current, elevation, grade);
    }
    ctx.restore();
  }

  private drawBubble(
    ctx: CanvasRenderingContext2D,
    plot: Box,
    x: number,
    y: number,
    distance: number,
    elevation: number,
    grade: number,
  ): void {
    const text = [
      this.i18n.format.distance(distance),
      this.i18n.format.elevation(elevation),
      this.i18n.format.grade(grade),
    ].join('  ·  ');

    ctx.save();
    ctx.font = `600 11px ${FONT_STACK}`;
    const textWidth = ctx.measureText(text).width;
    const paddingX = 9;
    const height = 24;
    const width = Math.ceil(textWidth + paddingX * 2);
    let boxX = x + 12;
    if (boxX + width > plot.x + plot.width) boxX = x - width - 12;
    if (boxX < plot.x) boxX = plot.x;
    let boxY = y - height - 14;
    if (boxY < plot.y) boxY = y + 14;
    if (boxY + height > plot.y + plot.height) boxY = plot.y + plot.height - height;

    const radius = 6;
    ctx.beginPath();
    ctx.moveTo(boxX + radius, boxY);
    ctx.lineTo(boxX + width - radius, boxY);
    ctx.quadraticCurveTo(boxX + width, boxY, boxX + width, boxY + radius);
    ctx.lineTo(boxX + width, boxY + height - radius);
    ctx.quadraticCurveTo(boxX + width, boxY + height, boxX + width - radius, boxY + height);
    ctx.lineTo(boxX + radius, boxY + height);
    ctx.quadraticCurveTo(boxX, boxY + height, boxX, boxY + height - radius);
    ctx.lineTo(boxX, boxY + radius);
    ctx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8,17,19,0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(58,217,196,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = this.theme.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, boxX + paddingX, boxY + height / 2 + 0.5);
    ctx.restore();
  }
}
