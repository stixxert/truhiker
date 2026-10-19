# Corrections and planning fallacies

*Written after being called out, correctly, on the MET claim. Kept as a
guard against repeating these. Read this before adding infrastructure.*

---

## 1. Corrections of fact

### MET Norway does **not** require a server-side proxy
Earlier documents claimed it did. The terms say the opposite:

> "Low-volume websites and mobile apps **may use simple cross-origin Javascript
> requests** and direct image links, provided the site identifies itself as
> described above. If you start generating a lot of traffic against the API, you
> must set up a caching proxy gateway."

Browsers cannot set `User-Agent`, and MET explicitly accommodates that:

> "In cases where this is not possible (e.g. … simple cross-origin requests in
> Javascript), the website must instead identify itself using an `Origin`
> (Javascript) or `Referer` (for image links) header."

**Consequence:** weather is a client-side `fetch`, identified by `Origin`, with
`Expires`/`If-Modified-Since` respected and coordinates truncated to 4 decimals.
A Worker is justified only if traffic grows, which for a personal planning tool it
will not. `docs/07` §5 is corrected accordingly.

### DNT hut classification — unverified, not settled
`docs/06` states the betjent/selvbetjent/ubetjent status "is not machine-readable
anywhere". That is **not established**. Turrutebasen's `RuteInfoPunkt` carries a
`tilrettelegging` facility code (e.g. `42` at Fondsbu) whose codelist was never
decoded — the lookup 404'd and the claim was allowed to stand. Resolve this
before designing a curation workflow around a non-existent gap.

---

## 2. Planning fallacies in how this project has been run

**1. Inventing a requirement, then building for it.**
The Worker existed to satisfy a MET proxy that the terms do not require. It was
built, tested, documented — and deleted two turns later. Cost: a deploy surface,
a test suite, and a reversal. The mistake was not the deletion; it was asserting
the requirement instead of reading the terms first.

**2. Promoting a preference to a constraint.**
"We cannot serve large files, only small static assets" was a preference. It was
treated as a hard constraint and drove: 0.25°-vs-0.1° shard histograms for a
bundling path since abandoned, a KV/R2 analysis, and a CDN experiment. Meanwhile
the actual limits — 20,000 files, 25 MiB each, unlimited free static requests —
were never within two orders of magnitude of binding. **A constraint that cannot
bind should not shape design.**

**3. Decide, then verify.**
Worker → built → removed. PMTiles-on-R2 → designed → dropped. National trail
bundle → sized in detail → dropped. Live-only → bundled shops → still bundled but
re-argued. Each reversal was correct on new evidence, but they were *reversals*,
not iterations. Cheap checks (read the terms, measure first) would have prevented
half of them.

**4. Precision on irrelevant dimensions.**
Three separate Overpass latency runs producing the same conclusion (unusable).
Byte-exact shard tables for a design that was then discarded. Thoroughness
applied where the answer did not change a decision.

**5. Component quality mistaken for product progress.**
This is the big one. There are 334 passing tests, a verified elevation core, a
working snapping engine and a complete energy model. **And no user can plan a trip
with it.** The map renders a route and a profile; it does not show shops, does not
snap, does not compute calories, and does not produce a resupply plan in the UI.
"Phase 2 complete and golden" was true of the map shell and misleading about the
product. Bottom-up correctness is not a working journey.

**6. Invented budgets enforced as if they were requirements.**
The 500 KB JS and 600 KB total budgets in `scripts/verify.mjs` are numbers I
chose. They are useful as regression guards, but they are not requirements and
should never be cited as evidence of quality.

**7. No written acceptance test.**
`docs/02` lists phases. It never states what a user must be able to *do*. Without
that, "done" is always re-definable — which is how the project accumulated
infrastructure while the journey stayed unbuilt.

---

## 3. The acceptance scenario that should drive everything

> **A user can answer: "Can I walk this route, and what do I carry between shops?"**

Concretely, in one session, with no account:

1. Load a GPX (or pick the demo route).
2. See the route on the live map, with elevation profile and total ascent.
3. See every shop, fuel station, post point and hut **on the route**, with the
   distance between successive resupply points.
4. Enter body mass, pack weight and daily distance; get kcal/day **as a range**,
   the intake ceiling, and the projected body-mass change.
5. Get, per leg: days, food mass in kg, cost, and a "carry 7 days" warning where
   the gap demands it — with the mail-drop windows if that model is chosen.
6. Make every number traceable: source, and when it was verified.

Anything that does not serve that scenario is deferred. Anything that does serve
it is the priority — including, now, **wiring the three finished engines into the
UI**, which is where the actual risk lives.

---

## 4. Rules adopted from here

1. **Read the primary terms before asserting a requirement.** No exceptions for
   "obviously true" platform facts.
2. **Check whether a constraint can bind** before letting it shape design.
3. **Measure to decide, not to decorate.** If the number cannot change the
   decision, do not produce it.
4. **A phase is done when the acceptance step passes**, not when its tests pass.
5. **Label estimates as estimates and unverified claims as unverified**, in the
   document that makes the claim.
