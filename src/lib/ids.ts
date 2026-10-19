/**
 * Id generation for trips.
 *
 * `crypto.randomUUID` is only available in secure contexts; a copied trip on an
 * `http://` development host must still get an id, so there is a time+counter
 * fallback. The prefix keeps ids recognisable in localStorage keys.
 */

let counter = 0;

export function newTripId(prefix = 'trip'): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    try {
      return `${prefix}-${cryptoObject.randomUUID()}`;
    } catch {
      // Insecure context — fall through to the counter.
    }
  }
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
