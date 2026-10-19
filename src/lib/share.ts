/**
 * Shareable routes without a backend.
 *
 * The GPX text is base64url-encoded into the URL fragment. A fragment is never
 * sent to a server, so the route stays on the device even when the link is
 * opened. Very long routes cannot fit: the GPX is ~5–10× larger after base64,
 * and browsers and chat apps truncate long URLs well before they break. We cap
 * the fragment at 12,000 characters and refuse to write it, rather than
 * producing a link that silently loses half a route.
 */

const HASH_PREFIX = '#r=';
export const MAX_HASH_CHARS = 12_000;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64_LOOKUP = new Map<string, number>(
  [...BASE64_ALPHABET].map((character, index) => [character, index]),
);

/** URL-safe base64 without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += BASE64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += BASE64_ALPHABET[b2 & 63];
  }
  return out;
}

/** Inverse of `base64UrlEncode`; returns null for malformed input. */
export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  if (text.length % 4 === 1) return null;

  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const c0 = BASE64_LOOKUP.get(text[i]);
    const c1 = BASE64_LOOKUP.get(text[i + 1] ?? 'A');
    const c2 = BASE64_LOOKUP.get(text[i + 2] ?? 'A');
    const c3 = BASE64_LOOKUP.get(text[i + 3] ?? 'A');
    if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) return null;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < text.length) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (i + 3 < text.length) bytes.push(((c2 & 3) << 6) | c3);
  }
  return Uint8Array.from(bytes);
}

/**
 * Encode GPX text as a URL fragment, or return null when it would exceed the
 * cap. The returned string includes the `#r=` prefix.
 */
export function encodeRouteHash(gpxText: string, maxChars = MAX_HASH_CHARS): string | null {
  const bytes = new TextEncoder().encode(gpxText);
  const encoded = base64UrlEncode(bytes);
  const hash = `${HASH_PREFIX}${encoded}`;
  return hash.length > maxChars ? null : hash;
}

/** Decode a fragment (with or without the `#r=` prefix) back to GPX text. */
export function decodeRouteHash(hash: string): string | null {
  let payload = hash.startsWith('#') ? hash.slice(1) : hash;
  if (payload.startsWith('r=')) payload = payload.slice(2);
  if (payload.length === 0) return null;
  const bytes = base64UrlDecode(payload);
  if (bytes === null) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.trim().length > 0 ? text : null;
  } catch {
    // Invalid UTF-8 — not something we produced, so treat it as an invalid link.
    return null;
  }
}

/** Whether the fragment contains a route at all. */
export function hasRouteHash(hash: string): boolean {
  return /^#?r=/.test(hash);
}

/**
 * Route text suitable for the hash. Trailing whitespace and an XML declaration
 * are harmless to the parser but cost characters, so they are trimmed.
 */
export function compactGpx(text: string): string {
  return text.replace(/^﻿/, '').trim();
}
