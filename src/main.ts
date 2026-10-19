/**
 * Application entry point.
 *
 * The shell is deliberately tiny: MapLibre (raster + DEM + GeoJSON layers), the
 * elevation core, and ~2,000 lines of UI. No framework, no bundled data, no
 * third-party fonts, no analytics.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

// MapLibre builds its worker URL dynamically (`new URL('./' + name,
// import.meta.url)`), which Vite cannot rewrite. Asking Vite for the asset URL
// instead makes the worker a first-class build artefact — required for the
// production bundle, and it also avoids the pre-bundled copy in dev.
import { setWorkerUrl } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

import { App } from './app/app';

setWorkerUrl(mapLibreWorkerUrl);

function showFatal(message: string): void {
  const host = document.getElementById('banners');
  if (!host) return;
  host.hidden = false;
  const banner = document.createElement('div');
  banner.className = 'banner banner--error';
  banner.setAttribute('role', 'alert');
  const dot = document.createElement('span');
  dot.className = 'banner-dot';
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('p');
  text.className = 'banner-text';
  text.textContent = message;
  banner.append(dot, text);
  host.append(banner);
}

try {
  const app = new App();
  void app.start().catch((error: unknown) => {
    showFatal(`Appen kunne ikke starte / the app could not start: ${error instanceof Error ? error.message : String(error)}`);
  });
} catch (error) {
  showFatal(`Appen kunne ikke starte / the app could not start: ${error instanceof Error ? error.message : String(error)}`);
}
