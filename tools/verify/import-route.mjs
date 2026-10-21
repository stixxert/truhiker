/**
 * Give a gate a route to look at.
 *
 * The app ships no sample route (D26), so every gate that needs a loaded trip
 * imports the same fixture through the same `<input type="file">` a user uses.
 * That is deliberately the real path: it means the gates exercise import, not a
 * file the app quietly preloaded for them.
 *
 * The fixture is *Memurubu–Glitterheim* (jot21), Kartverket Turrutebasen, CC BY
 * 4.0 — test material, never served (see docs/LICENSES.md).
 */
import { fileURLToPath } from 'node:url';

export const ROUTE_FIXTURE = fileURLToPath(
  new URL('../../test/fixtures/memurubu-glitterheim-jot21.gpx', import.meta.url),
);

/**
 * Import the fixture and wait until the route is on the map.
 *
 * Resolves once `.route-name` has text, which the app sets only after the GPX has
 * parsed and the route object exists.
 */
export async function importRoute(page, timeoutMs = 25_000) {
  await page.waitForSelector('#file-input', { state: 'attached' });
  await page.setInputFiles('#file-input', ROUTE_FIXTURE);
  await page.waitForFunction(
    () => (document.querySelector('.route-name')?.textContent ?? '').trim().length > 0,
    undefined,
    { timeout: timeoutMs },
  );
}
