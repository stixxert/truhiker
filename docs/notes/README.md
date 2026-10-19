# Engineering record

Working notes from building TruHiker. They are kept because the reasoning behind
the architecture is more useful than the architecture itself — and because the
mistakes are instructive.

Read in this order if you want the story:

| Note | What it covers |
| --- | --- |
| [`00-feasibility-spike`](00-feasibility-spike.md) | What was measured before any code: Kartverket DTM access, tile services, CORS |
| [`01-options-and-decisions`](01-options-and-decisions.md) | Route reality (there is no official NPL), DNT huts, resupply data, the calorie model |
| [`02-plan-v2`](02-plan-v2.md) | The pivot to a general GPX analyser |
| [`03-snapping-and-graph`](03-snapping-and-graph.md) | Snapping design, the route graph, where DEM matters |
| [`04-data-delivery`](04-data-delivery.md) | Live-first delivery, measured latencies, the Turrutebasen traps |
| [`05-phase2-notes`](05-phase2-notes.md) | The map shell |
| [`06-bundle-manifest`](06-bundle-manifest.md) | What to bundle and why, with licence obligations |
| [`07-bundle-and-hosting`](07-bundle-and-hosting.md) | Exact bundle bytes; Cloudflare limits; why not KV or R2 |
| [`08-corrections`](08-corrections.md) | **The mistakes made here, and the rules adopted because of them** |
| [`09-phase3-spec`](09-phase3-spec.md) | Contracts for weather, editing and storage |
| [`10-phase3-ui-notes`](10-phase3-ui-notes.md) | The weather timeline, trip library and edit toolbar |
| [`11-testing-strategy`](11-testing-strategy.md) | Why the suite is 246 cases and not 580 |
| [`12-storage`](12-storage.md) | IndexedDB schema, migration, durability caveats |
| [`13-phase4-resupply-ui`](13-phase4-resupply-ui.md) | The resupply and energy specification |
| [`14-phase4-notes`](14-phase4-notes.md) | What was built, and what was compromised |

Two documents stay out of this folder because they are living contracts rather
than history: [`../DECISIONS.md`](../DECISIONS.md) and
[`../LICENSES.md`](../LICENSES.md).
