/**
 * Weather symbol drawing.
 *
 * Nine local families, drawn as inline SVG so nothing is fetched (CSP:
 * `img-src 'self' data:` but no new origins) and the icon inherits the current
 * text colour. The icon is always `aria-hidden`: the family's name is rendered
 * as text, so the meaning never depends on a shape.
 */

import type { WeatherSymbolFamily } from '../lib/weather-symbol';

type Shape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'path'; d: string };

const CLOUD = 'M6.2 15.2h10.6a3.4 3.4 0 0 0 .3-6.78A5 5 0 0 0 7.7 9.1a3.4 3.4 0 0 0-1.5 6.1z';

const SHAPES: Record<WeatherSymbolFamily, Shape[]> = {
  clear: [
    { kind: 'circle', cx: 12, cy: 12, r: 4.6 },
    {
      kind: 'path',
      d: 'M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5',
    },
  ],
  fair: [
    { kind: 'circle', cx: 9.2, cy: 8.6, r: 3.1 },
    { kind: 'path', d: 'M11.6 6.4a4.6 4.6 0 0 1 5.9 6.2' },
    { kind: 'path', d: CLOUD },
  ],
  'partly-cloudy': [
    { kind: 'circle', cx: 9.4, cy: 8.8, r: 3.2 },
    { kind: 'path', d: CLOUD },
  ],
  cloudy: [{ kind: 'path', d: CLOUD }],
  fog: [
    { kind: 'path', d: CLOUD },
    { kind: 'path', d: 'M5 18.4h6M13 18.4h6M7 21h10' },
  ],
  rain: [
    { kind: 'path', d: CLOUD },
    { kind: 'path', d: 'M8.4 17.4l-1 2.6M12.4 17.4l-1 2.6M16.4 17.4l-1 2.6' },
  ],
  sleet: [
    { kind: 'path', d: CLOUD },
    { kind: 'path', d: 'M9 17.6l-1 2.6M15 19.9h.01' },
  ],
  snow: [
    { kind: 'path', d: CLOUD },
    { kind: 'path', d: 'M8.5 19.6h.01M12 19.6h.01M15.5 19.6h.01' },
  ],
  thunder: [
    { kind: 'path', d: CLOUD },
    { kind: 'path', d: 'M12.8 14.8l-2.6 4.1h2.7l-1.2 3.5 3.9-5.1h-2.8z' },
  ],
  unknown: [
    { kind: 'circle', cx: 12, cy: 12, r: 7.4 },
    { kind: 'path', d: 'M9.7 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.7M12 16.9h.01' },
  ],
};

/**
 * Build an icon element. Uses `createElementNS` rather than markup so a future
 * family name cannot become an injection point.
 */
export function createWeatherIcon(
  doc: Document,
  family: WeatherSymbolFamily,
): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'wx-icon');
  svg.setAttribute('data-family', family);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const group = doc.createElementNS(ns, 'g');
  group.setAttribute('fill', 'none');
  group.setAttribute('stroke', 'currentColor');
  group.setAttribute('stroke-width', '1.5');
  group.setAttribute('stroke-linecap', 'round');
  group.setAttribute('stroke-linejoin', 'round');
  for (const shape of SHAPES[family]) {
    if (shape.kind === 'circle') {
      const circle = doc.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(shape.cx));
      circle.setAttribute('cy', String(shape.cy));
      circle.setAttribute('r', String(shape.r));
      group.append(circle);
    } else {
      const path = doc.createElementNS(ns, 'path');
      path.setAttribute('d', shape.d);
      group.append(path);
    }
  }
  svg.append(group);
  return svg;
}

