#!/usr/bin/env node
/**
 * Integration gate. Runs the full pipeline and reports the numbers that matter
 * for a free-tier static host:
 *   - typecheck / tests / build
 *   - dist size raw, gzip and brotli
 *   - file count (Cloudflare Pages free ceiling is 20,000)
 *   - largest single asset (Pages caps at 25 MiB)
 *   - any bundled data asset that is large enough to question
 *
 * Usage: node tools/verify/verify.mjs [--skip-tests]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const skipTests = process.argv.includes("--skip-tests");

const results = [];
let failed = false;

function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failed = true;
    results.push({ name, ok: false, ms: Date.now() - t0 });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    const out = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
    if (err.message && !out.includes(err.message)) console.log(`  ${err.message}`);
    console.log(out.split("\n").slice(-25).join("\n"));
  }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: "pipe" }).toString().trim();
}

console.log("\nverify — integration gate\n");

step("typecheck", () => {
  run("npx", ["tsc", "--noEmit"]);
  return "clean";
});

const TEST_BUDGET = 250;
const TEST_WALL_BUDGET_MS = 12_000;

if (!skipTests) {
  step("tests (hermetic)", () => {
    const t0 = Date.now();
    // Live tests are excluded by filename: `npm test` must never need the network.
    run("npx", [
      "vitest",
      "run",
      "--exclude",
      "**/*.live.test.ts",
      "--reporter=json",
      "--outputFile=.vitest-report.json",
    ]);
    const wall = Date.now() - t0;
    const report = JSON.parse(readFileSync(join(ROOT, ".vitest-report.json"), "utf8"));
    const total = report.numTotalTests ?? 0;
    const failed = report.numFailedTests ?? 0;
    if (failed > 0) throw new Error(`${failed} test(s) failed`);

    const problems = [];
    if (total > TEST_BUDGET) {
      problems.push(
        `${total} test cases exceeds the ${TEST_BUDGET} budget — group related assertions into one ` +
          `test (it.each rows still count separately) or delete duplication; see docs/11-testing-strategy.md`,
      );
    }
    if (wall > TEST_WALL_BUDGET_MS) {
      problems.push(`suite took ${(wall / 1000).toFixed(1)} s, over the ${TEST_WALL_BUDGET_MS / 1000} s budget`);
    }
    if (problems.length) throw new Error(problems.join("\n"));
    return `${total}/${TEST_BUDGET} tests, ${(wall / 1000).toFixed(1)} s, no network`;
  });
}

step("build", () => {
  run("npx", ["vite", "build"]);
  // Mirror `npm run build`: the data files and their licence must land in dist.
  run("node", ["tools/verify/copy-data.mjs"]);
  return "ok";
});

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

step("dist budget", () => {
  let files;
  try {
    files = walk(DIST);
  } catch {
    throw new Error("dist/ not found — build did not produce output");
  }
  if (files.length === 0) throw new Error("dist/ is empty");

  let raw = 0,
    gz = 0,
    br = 0;
  const rows = [];
  for (const f of files) {
    const buf = readFileSync(f);
    const b = brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
    const g = gzipSync(buf, { level: 9 }).length;
    raw += buf.length;
    gz += g;
    br += b;
    rows.push({ f: f.slice(DIST.length + 1), raw: buf.length, g, b });
  }
  rows.sort((a, b) => b.raw - a.raw);
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";

  console.log(`      files: ${files.length} / 20000   raw: ${mb(raw)}   gzip: ${mb(gz)}   brotli: ${mb(br)}`);
  console.log("      largest:");
  for (const r of rows.slice(0, 6)) {
    console.log(`        ${kb(r.raw).padStart(10)} raw  ${kb(r.b).padStart(9)} br   ${r.f}`);
  }

  const problems = [];
  if (files.length > 20000) problems.push(`${files.length} files exceeds the Pages free ceiling (20000)`);
  const biggest = rows[0];
  if (biggest && biggest.raw > 25 * 1024 * 1024) problems.push(`largest file ${mb(biggest.raw)} exceeds Pages' 25 MiB cap`);
  // Anything over 1 MB that is not JS/CSS/HTML is bundled data we should justify.
  const suspicious = rows.filter(
    (r) => r.raw > 1024 * 1024 && ![".js", ".css", ".html", ".map"].includes(extname(r.f)),
  );
  if (suspicious.length) {
    problems.push(
      `large non-code assets (${suspicious.map((r) => `${r.f} ${mb(r.raw)}`).join(", ")}) — bundled data needs justifying`,
    );
  }
  const jsBr = rows.filter((r) => r.f.endsWith('.js')).reduce((s, r) => s + r.b, 0);
  if (jsBr > 500 * 1024) problems.push(`JS brotli ${kb(jsBr)} exceeds the 500 KB budget`);
  if (br > 600 * 1024) problems.push(`total brotli ${kb(br)} exceeds the 600 KB bundle budget`);

  if (problems.length) throw new Error(problems.join("\n"));
  return `${files.length} files, ${mb(br)} brotli total`;
});

step("licence audit", () => {
  // Every shipped file must have a licence, and the notices we are obliged to
  // redistribute must be in the build.
  const out = run("node", ["tools/verify/licence-audit.mjs"]);
  return out.trim().split("\n").pop();
});

step("decisions", () => {
  // No ambiguity may be left for a user to discover in production.
  const out = run("node", ["tools/verify/check-decisions.mjs"]);
  return out.trim().split("\n").pop();
});

step("hosting contract", () => {
  const problems = [];

  // 1. The licence-bearing data file and its notices must actually ship.
  const required = ["data/shops.osm.bin", "data/shops.osm.meta.json", "data/shops.osm.LICENSE", "404.html"];
  const missing = required.filter((f) => {
    try {
      return statSync(join(DIST, f)).size === 0;
    } catch {
      return true;
    }
  });
  if (missing.length) problems.push(`missing from dist: ${missing.join(", ")}`);

  // 2. Static-only: a Worker script would add a runtime and a dynamic-request
  //    budget for no benefit. Fail if one is reintroduced without updating the docs.
  const wrangler = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  if (/"main"\s*:/.test(wrangler)) {
    problems.push("wrangler.jsonc declares a Worker `main` — the app is static-only; justify it in docs/07 first");
  }
  if (!/"directory"\s*:\s*"\.\/dist"/.test(wrangler)) problems.push("wrangler.jsonc assets.directory is not ./dist");

  // 3. The CSP must stay strict.
  const headers = readFileSync(join(ROOT, "public/_headers"), "utf8");
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1]?.trim() ?? "";
  if (!csp) problems.push("_headers has no Content-Security-Policy");
  if (csp.includes("unsafe-eval")) problems.push("CSP allows unsafe-eval");
  // The weather engine calls MET directly from the browser; the origin must be allowed.
  if (!/connect-src[^;]*https:\/\/api\.met\.no/.test(csp)) problems.push("CSP connect-src is missing https://api.met.no");
  if (csp.includes("*")) problems.push("CSP contains a wildcard");
  if (/(?<![\w-])script-src[^;]*unsafe-inline/.test(csp)) problems.push("CSP allows inline scripts");

  // 4. Workers free allows 100 _headers rules. Count pattern lines (unindented).
  const rules = headers.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !/^\s/.test(l)).length;
  if (rules > 100) problems.push(`_headers has ${rules} rules, Workers free allows 100`);

  if (problems.length) throw new Error(problems.join("\n"));
  return `${rules} header rules, static-only, strict CSP, data + licence present`;
});

console.log(
  `\n${failed ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m"}  ${results.filter((r) => r.ok).length}/${results.length} checks\n`,
);
process.exit(failed ? 1 : 0);
