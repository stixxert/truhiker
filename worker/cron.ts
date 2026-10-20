/**
 * truhiker-refresh — the monthly resupply-data refresh trigger.
 *
 * A Worker cannot build the artefact: the source is a 1.38 GB PBF, the build
 * makes two passes over it and needs ~1.4 GB of heap, while a Worker gets 128 MB
 * and 10 ms of CPU on the free plan. What a Worker can do is POST a Deploy Hook,
 * which starts a Workers Builds job — a build container with 2 vCPU, 8 GB of RAM
 * and a 20-minute timeout. That is where `tools/refresh-shops.sh` runs, and the
 * deploy that follows ships the freshly built `data/shops.osm.bin`.
 *
 * This Worker is deliberately separate from the site: `wrangler.jsonc` stays
 * static-only (the hosting contract asserts it), and this one has no assets, no
 * routes and no bindings beyond the hook URL secret.
 */

interface Env {
  /** https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<id> */
  DEPLOY_HOOK_URL: string;
  /** A shared secret for manual triggers, so the workers.dev URL cannot burn builds. */
  TRIGGER_KEY?: string;
}

interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const MONTHLY = '0 4 1 * *';

async function trigger(env: Env, reason: string): Promise<Response> {
  if (!env.DEPLOY_HOOK_URL) {
    console.error('truhiker-refresh: DEPLOY_HOOK_URL is not set');
    return new Response('deploy hook not configured\n', { status: 500 });
  }

  // The hook URL is its own credential; a POST with no body starts the build.
  const started = Date.now();
  const response = await fetch(env.DEPLOY_HOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: reason }),
  });

  const text = await response.text();
  console.log(
    `truhiker-refresh: ${reason} -> ${response.status} in ${Date.now() - started} ms ${text.slice(0, 300)}`,
  );

  // A rejected hook must be visible: a silent 200 here would look like a refresh
  // that happened. Workers Logs keeps this line for a month.
  return new Response(text, {
    status: response.ok ? 202 : 502,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const reason =
      controller.cron === MONTHLY
        ? 'monthly'
        : `retry:${controller.cron}`;
    ctx.waitUntil(trigger(env, reason));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // A manual pull is useful after a Geofabrik outage; it needs the secret, so
    // the URL alone cannot burn build minutes.
    if (url.pathname === '/trigger' && request.method === 'POST') {
      if (!env.TRIGGER_KEY || request.headers.get('x-trigger-key') !== env.TRIGGER_KEY) {
        return new Response('forbidden\n', { status: 403 });
      }
      return trigger(env, 'manual');
    }
    return new Response(
      'truhiker-refresh: POST /trigger to rebuild, or wait for the monthly cron\n',
      { status: request.method === 'GET' ? 200 : 405 },
    );
  },
};
