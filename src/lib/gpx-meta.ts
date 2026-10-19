/**
 * GPX metadata for the provenance line (Sprint 2 demo route).
 *
 * The core GPX reader deliberately only extracts coordinates. The demo route
 * does carry provenance in its `<metadata>` block — route number, maintainer,
 * marking, licence — and the product must show it rather than implying the
 * route is ours. This module is a small, namespace-tolerant reader for exactly
 * that block.
 */

import { DOMParser, type Element } from '@xmldom/xmldom';

export interface GpxMetadata {
  /** `<metadata><name>`, falling back to the first track name. */
  name?: string;
  description?: string;
  author?: string;
  /** Copyright holder, e.g. "Kartverket". */
  copyright?: string;
  /** Licence name, e.g. "CC BY 4.0". */
  licence?: string;
  /** Turrutebasen route id, e.g. "jot21". */
  routeNumber?: string;
  /** Who maintains the trail, from the Turrutebasen description. */
  maintainer?: string;
  /** Whether the route is marked on the ground (Turrutebasen `merking`). */
  marked?: boolean;
}

function localName(element: Element): string {
  return (element.localName || element.nodeName.replace(/^.*:/, '')).toLowerCase();
}

function child(element: Element | null, name: string): Element | null {
  if (!element) return null;
  for (const candidate of element.children) {
    if (localName(candidate) === name) return candidate;
  }
  return null;
}

function text(element: Element | null): string | undefined {
  const value = element?.textContent?.trim();
  return value ? value : undefined;
}

function findDescendant(root: Element, name: string): Element | null {
  if (localName(root) === name) return root;
  for (const candidate of root.children) {
    const found = findDescendant(candidate, name);
    if (found) return found;
  }
  return null;
}

/**
 * Parse the descriptive half of a Turrutebasen export:
 *
 *   "Turrutebasen route jot21 - DNT | DNT Oslo og omegn. Marked trail. Data: …"
 *
 * Anything that does not match is simply left out — a route without provenance
 * should show less, never made-up values.
 */
export function parseTurrutebasenDescription(description: string): {
  routeNumber?: string;
  maintainer?: string;
  marked?: boolean;
} {
  const result: { routeNumber?: string; maintainer?: string; marked?: boolean } = {};
  // Route ids in the WFS look like "jot21", "f_2018" or "F_20180315_1".
  const id = '[A-Za-z][A-Za-z0-9_-]*\\d[A-Za-z0-9_-]*';
  const route = new RegExp(`\\broute\\s+(${id})\\b`, 'i').exec(description);
  if (route) result.routeNumber = route[1];
  const maintainer = new RegExp(`\\broute\\s+${id}\\s*[-–]\\s*([^.]+)\\.`).exec(description);
  if (maintainer) result.maintainer = maintainer[1].trim();
  if (/marked trail/i.test(description)) result.marked = true;
  return result;
}

/**
 * Read `<metadata>` (plus the first `<trk><name>` as a fallback). Never throws:
 * metadata is decoration, and a malformed document is already rejected by the
 * real parser before this is called.
 */
export function parseGpxMetadata(xml: string): GpxMetadata {
  const result: GpxMetadata = {};
  let documentNode;
  try {
    documentNode = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return result;
  }
  const root = documentNode.documentElement;
  if (!root) return result;

  const metadata = findDescendant(root, 'metadata');
  result.name = text(child(metadata, 'name'));
  result.description = text(child(metadata, 'desc'));
  result.author = text(child(child(metadata, 'author'), 'name'));

  const copyright = child(metadata, 'copyright');
  if (copyright) {
    result.copyright = copyright.getAttribute('author')?.trim() || undefined;
    result.licence = text(child(copyright, 'license'));
  }

  if (result.description) {
    Object.assign(result, parseTurrutebasenDescription(result.description));
  }

  if (!result.name) {
    const track = findDescendant(root, 'trk');
    result.name = text(child(track, 'name'));
  }

  return result;
}
