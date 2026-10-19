/**
 * Minimal GPX reader.
 *
 * It only extracts coordinates (and optional `<ele>`) from `<trk>`, `<rte>` and
 * `<wpt>`. Everything else in a GPX file — extensions, metadata, Garmin
 * heart-rate streams — is ignored on purpose: the DEM is the elevation
 * authority, not the file.
 *
 * Track handling: **tracks are never merged.** A GPX with three `<trk>`
 * elements yields three entries, in document order. Track segments
 * (`<trkseg>`) inside one track *are* concatenated — that is what a track
 * means — but each track keeps its own point list.
 *
 * Namespace tolerance: a lot of real-world GPX is exported with a namespace
 * prefix but without the matching `xmlns:` declaration. xmldom treats that as a
 * fatal "prefix is non-null and namespace is null" error, so we retry once
 * after injecting the missing declarations. Elements are always matched by
 * local name, so files with or without namespaces behave identically.
 */

import { DOMParser, type Document, type Element, type Node } from '@xmldom/xmldom';

export interface GpxPoint {
  lon: number;
  lat: number;
  /** `<ele>` in metres, if the file has one. Never trusted over the DEM. */
  ele?: number;
}

export interface GpxTrack {
  /** `<name>` of the `<trk>`/`<rte>`, if present. */
  name?: string;
  points: GpxPoint[];
}

export interface GpxDocument {
  tracks: GpxTrack[];
  /** Routes (`<rte>`), kept separate from tracks. */
  routes: GpxTrack[];
  waypoints: GpxPoint[];
}

function localNameOf(node: Node): string {
  const local = node.localName || node.nodeName.replace(/^.*:/, '');
  return local.toLowerCase();
}

function childByName(element: Element, name: string): Element | undefined {
  for (const child of element.children) {
    if (localNameOf(child) === name) return child;
  }
  return undefined;
}

function textOf(element: Element | undefined): string | undefined {
  if (!element) return undefined;
  const text = element.textContent;
  return text === null || text === undefined ? undefined : text.trim();
}

function collectDescendants(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (localNameOf(child) === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function parsePoint(element: Element, index: number): GpxPoint {
  const latText = element.getAttribute('lat');
  const lonText = element.getAttribute('lon');
  if (latText === null || lonText === null) {
    throw new Error(`GPX: point #${index} is missing lat/lon attributes`);
  }
  const lat = Number.parseFloat(latText);
  const lon = Number.parseFloat(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error(`GPX: point #${index} has invalid coordinates lat="${latText}" lon="${lonText}"`);
  }

  const point: GpxPoint = { lon, lat };
  const eleText = textOf(childByName(element, 'ele'));
  if (eleText !== undefined && eleText !== '') {
    const ele = Number.parseFloat(eleText);
    if (Number.isFinite(ele)) point.ele = ele;
  }
  return point;
}

function collectPoints(root: Element, pointName: string): GpxPoint[] {
  return collectDescendants(root, pointName).map((element, i) => parsePoint(element, i));
}

function trackName(element: Element): string | undefined {
  const name = textOf(childByName(element, 'name'));
  return name ? name : undefined;
}

/** Inject missing `xmlns:<prefix>` declarations on the root element. */
function repairNamespaces(xml: string): string | null {
  const prefixes = new Set<string>();
  const prefixPattern = /<\s*([A-Za-z_][\w.-]*):[A-Za-z_]/g;
  let match: RegExpExecArray | null;
  while ((match = prefixPattern.exec(xml)) !== null) prefixes.add(match[1]);
  if (prefixes.size === 0) return null;

  const rootPattern = /<\s*([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)(?=[\s/>])/;
  const root = rootPattern.exec(xml);
  if (!root) return null;

  const declared = new Set<string>();
  const xmlnsPattern = /xmlns:([A-Za-z_][\w.-]*)\s*=/g;
  const headEnd = xml.indexOf('>');
  const opening = headEnd === -1 ? xml : xml.slice(0, headEnd);
  while ((match = xmlnsPattern.exec(opening)) !== null) declared.add(match[1]);

  const missing = [...prefixes].filter((p) => !declared.has(p));
  if (missing.length === 0) return null;

  const injection = missing.map((p) => ` xmlns:${p}="urn:x-gpx-undeclared:${p}"`).join('');
  const index = root.index + root[0].length;
  return xml.slice(0, index) + injection + xml.slice(index);
}

/**
 * Parse a GPX document. Throws on unparseable XML or missing coordinates;
 * incomplete points are never silently dropped.
 */
export function parseGpx(xml: string): GpxDocument {
  // Strip a UTF-8 BOM if present; xmldom would otherwise see it as content.
  const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level: string, message: string) => {
      if (level === 'error' || level === 'fatalError') errors.push(`${level}: ${message}`);
    },
  });

  const parse = (source: string): Document => parser.parseFromString(source, 'application/xml');

  let doc: Document;
  try {
    doc = parse(source);
    if (!doc.documentElement) throw new Error('no document element');
  } catch (firstError) {
    const repaired = repairNamespaces(source);
    if (repaired === null) {
      const detail = errors.length > 0 ? `: ${errors.join('; ')}` : '';
      throw new Error(
        `GPX: could not parse XML${detail}`,
        { cause: firstError instanceof Error ? firstError : undefined },
      );
    }
    try {
      doc = parse(repaired);
      if (!doc.documentElement) throw new Error('no document element after namespace repair');
    } catch (secondError) {
      throw new Error(
        `GPX: could not parse XML even after repairing undeclared namespace prefixes: ` +
          `${secondError instanceof Error ? secondError.message : String(secondError)}`,
        { cause: firstError instanceof Error ? firstError : undefined },
      );
    }
  }

  const root = doc.documentElement;
  if (localNameOf(root) !== 'gpx') {
    throw new Error(`GPX: root element is <${root.nodeName}>, expected <gpx>`);
  }

  const tracks: GpxTrack[] = collectDescendants(root, 'trk').map((element) => {
    const name = trackName(element);
    const points = collectPoints(element, 'trkpt');
    return name === undefined ? { points } : { name, points };
  });

  const routes: GpxTrack[] = collectDescendants(root, 'rte').map((element) => {
    const name = trackName(element);
    const points = collectPoints(element, 'rtept');
    return name === undefined ? { points } : { name, points };
  });

  const waypoints = collectDescendants(root, 'wpt').map((element, i) => parsePoint(element, i));

  if (tracks.length === 0 && routes.length === 0 && waypoints.length === 0) {
    throw new Error('GPX: file contains no tracks, routes or waypoints');
  }

  return { tracks, routes, waypoints };
}
