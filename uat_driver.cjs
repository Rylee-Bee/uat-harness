// UAT driver (Node/Playwright). Called by uat.py — see that file for usage and the "why" discipline.
// Runs against ONE url. Prints one JSON blob on stdout as its last line; everything else goes to
// stderr or into files under outDir. Never throws away a real interaction for a synthetic shortcut:
// every click is a real mouse move+down+up at the element's own rendered coordinates, every tap is
// a real page.touchscreen.tap on a real mobile emulation, every form field is really typed into with
// page.keyboard, and axe-core checks real WCAG rules, mapped to contract clauses via
// contract-map.json (or $UAT_CONTRACT_MAP).
//
// Safety: read-only is ON by default (UAT_READONLY unset or 1). Every non-GET
// HTTP request is aborted at the network layer and recorded as a finding
// ("would have sent: POST /api/thing"). Service workers are blocked and, in
// read-only mode, WebSocket messages are captured and never forwarded. This
// blocks HTTP *methods* (plus SW/WS channels); it does NOT prove the server
// was protected from every mutation -- a GET endpoint with side effects still
// runs. Set UAT_READONLY=0 to allow real writes.
"use strict";
const fs = require("fs");
const path = require("path");
const { buildAuthAllowlist, isApprovedOrigin, decideRequest, normalizeOrigin, safePath } = require("./lib/policy.cjs");
const { installRequestPolicy, installWebSocketPolicy } = require("./lib/netpolicy.cjs");
const { finalizeArtifacts, stageDirFor } = require("./lib/artifacts.cjs");

// ---- Dependency resolution -------------------------------------------------------------------
// This repo is standalone: no hardcoded sibling project's node_modules. Resolution order:
//   (a) $UAT_NODE_MODULES  — an existing node_modules dir (reuse an install, no second download)
//   (b) ./node_modules     — this repo's own install (npm install)
//   (c) bare require       — whatever node's normal resolution finds from this file upward
function bail(msg) {
  console.error(msg);
  console.log(JSON.stringify({ ok: false, reason: msg, findings: [], counts: {} }));
  process.exit(1);
}
const firstLine = (e) => String((e && e.message) || e).split("\n")[0];

function resolvePlaywright() {
  const tried = [];
  const roots = [];
  if (process.env.UAT_NODE_MODULES) roots.push({ src: "UAT_NODE_MODULES", dir: process.env.UAT_NODE_MODULES });
  roots.push({ src: "repo ./node_modules", dir: path.join(__dirname, "node_modules") });
  for (const r of roots) {
    const p = path.join(r.dir, "@playwright", "test");
    if (fs.existsSync(p)) {
      try { return require(p); } catch (e) { tried.push(`${p} (exists but failed to load: ${firstLine(e)})`); }
    } else {
      tried.push(`${p} (${r.src}: not there)`);
    }
  }
  try { return require("@playwright/test"); } catch (e) { tried.push(`require("@playwright/test") (${firstLine(e)})`); }
  bail(
    "uat: could not resolve @playwright/test.\n" +
    "  Tried:\n" + tried.map((t) => `    - ${t}`).join("\n") + "\n" +
    "  Fix one of:\n" +
    "    - set UAT_NODE_MODULES=/path/to/node_modules  (an existing install that contains @playwright/test), or\n" +
    "    - run `npm install` (this package declares @playwright/test and axe-core as dependencies,\n" +
    "      so installing uat-harness brings them along).\n" +
    "  Note: they are dependencies, not devDependencies, on purpose — npm does not install a\n" +
    "  dependency's devDependencies, which is exactly how this fails."
  );
}
const { chromium, devices } = resolvePlaywright();

function resolveAxePath() {
  const cands = [];
  if (process.env.UAT_NODE_MODULES) cands.push(path.join(process.env.UAT_NODE_MODULES, "axe-core", "axe.min.js"));
  cands.push(path.join(__dirname, "node_modules", "axe-core", "axe.min.js"));
  for (const c of cands) if (fs.existsSync(c)) return c;
  try {
    const p = path.join(path.dirname(require.resolve("axe-core")), "axe.min.js");
    if (fs.existsSync(p)) return p;
  } catch (_) { /* fall through */ }
  return null;
}
const AXE_PATH = resolveAxePath();

// ---- Contract mapping -----------------------------------------------------------------------
// axe rule id -> a plain-words contract clause. Configurable so this driver doesn't belong to any
// one repo's document: load $UAT_CONTRACT_MAP (a JSON file) if set, else ./contract-map.json next
// to this driver. An explicitly-set-but-unreadable map is a config error (stop); a missing default
// file just degrades to the generic wording below.
function loadContractMap() {
  const explicit = process.env.UAT_CONTRACT_MAP;
  const p = explicit || path.join(__dirname, "contract-map.json");
  const fail = (why) => {
    if (explicit) bail(`uat: UAT_CONTRACT_MAP points at ${explicit} but it could not be used: ${why}\n  Fix the path/content, or unset UAT_CONTRACT_MAP to use ./contract-map.json.`);
    process.stderr.write(`uat: contract map unusable (${why}) -- axe violations will fall back to "general accessibility".\n`);
    return {};
  };
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) { return fail(e.code || e.message); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return fail(`invalid JSON: ${firstLine(e)}`); }
  if (!parsed || typeof parsed !== "object") return fail("top level is not a JSON object");
  const rules = parsed.rules && typeof parsed.rules === "object" ? parsed.rules : parsed;
  const out = {};
  for (const [k, v] of Object.entries(rules)) if (typeof v === "string") out[k] = v;
  return out;
}
const CONTRACT = loadContractMap();
const contractFor = (id) => CONTRACT[id] || "general accessibility (no contract clause mapped for this rule)";

// ---- Run configuration ----------------------------------------------------------------------
const readOnly = (process.env.UAT_READONLY || "1") !== "0";
if (process.env.UAT_READONLY && !["0", "1"].includes(process.env.UAT_READONLY)) {
  process.stderr.write(`uat: UAT_READONLY="${process.env.UAT_READONLY}" is not 0 or 1 -- treating as ${readOnly ? "read-only ON" : "read-only OFF"}\n`);
}
const MAX_ELEMENTS = (() => {
  const v = parseInt(process.env.UAT_MAX_ELEMENTS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 20; // per pass, per viewport — enough to catch real problems without a runaway walk
})();

const SETTLE_MS = 400;

// Optional bearer token for a walkthrough of a live, authenticated app.
// Deliberately environment-only at rest. E01: it is NEVER put into context-wide
// `extraHTTPHeaders` -- that applies to every request a page makes, so an
// off-origin image, link, popup or redirect hop would receive it. Instead the
// request policy (lib/netpolicy.cjs) attaches it per-request, and only for a
// scheme/host/port in AUTH_ALLOWLIST. E03: Playwright traces DO record request
// headers, so the driver redacts the token from every artifact -- inside trace
// ZIPs too -- during finalization (lib/redact.cjs) BEFORE promotion into the
// output directory; a scrub failure withholds the artifacts (fail closed).
const AUTH_TOKEN = process.env.UAT_TOKEN || "";
// The target origin plus any UAT_AUTH_ORIGINS entries. Empty when no token.
let AUTH_ALLOWLIST = [];
// E03: all artifacts are written to a hidden staging dir first and only
// promoted into OUT_DIR after redaction by finalizeArtifacts().
let OUT_DIR = null;
let STAGE_DIR = null;
const CLICK_SEL = "button, a[href], input[type=submit], input[type=button], [role=button]";

// Blocked non-GET requests, in order. Each interaction snapshots the tail of this list so a blocked
// write is attributed to the click/submit that caused it, never reported as a dead button.
const blocked = [];
let blockedAttributed = 0;
const consumeBlocked = () => {
  const delta = blocked.slice(blockedAttributed);
  blockedAttributed = blocked.length;
  return delta;
};
const fmtBlocks = (ds) => ds.map((b) => b.kind === "websocket"
  ? `WebSocket message (${b.bytes} bytes) to ${b.path}`
  : `${b.method} ${b.path}${b.reason && !/read-only/.test(b.reason) ? ` [${b.reason}]` : ""}`).join(", ");

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "el";
}

function recordBlock(b) {
  blocked.push(b);
  if (b.kind === "websocket") {
    process.stderr.write(`uat: READ-ONLY blocked: WebSocket message (${b.bytes} bytes) to ${b.path} -- never forwarded\n`);
    return;
  }
  const why = b.reason && !/read-only/.test(b.reason) ? ` [${b.reason}]` : "";
  process.stderr.write(`uat: READ-ONLY blocked: ${b.method} ${b.path}${why}\n`);
}

// E01/E02: one context-level policy that (a) aborts non-GET methods in
// read-only mode and (b) attaches the bearer token only to approved origins.
// Replaces the old context-wide `extraHTTPHeaders` token and the old
// non-GET-only route.
async function installNetworkPolicy(ctx) {
  await installRequestPolicy(ctx, {
    allowlist: AUTH_ALLOWLIST,
    token: AUTH_TOKEN,
    readOnly,
    onBlock: recordBlock,
  });
  // E02: context routing does not see WebSocket traffic. In read-only mode the
  // handshake is intercepted and never connected to the server, so page->server
  // messages are recorded and dropped -- a write can never be forwarded.
  await installWebSocketPolicy(ctx, { readOnly, onBlock: recordBlock });
}

// E03: redact staging, then promote into OUT_DIR. Throws (after deleting
// staging) on any failure so the caller can withhold everything.
function finalize() {
  if (!STAGE_DIR) return { scanned: 0, changed: 0 };
  const stats = finalizeArtifacts(OUT_DIR, AUTH_TOKEN, { stageDir: STAGE_DIR });
  STAGE_DIR = null;
  return stats;
}

// The single exit point for every run. Finalizes artifacts (fail closed),
// records the redaction result, and prints the machine-readable report.
function emit(report, exitCode) {
  let code = exitCode || 0;
  try {
    const stats = finalize();
    if (report) report.redaction = Object.assign({ ok: true }, stats);
  } catch (e) {
    process.stderr.write(`uat: FINALIZATION FAILED -- artifacts withheld, nothing publishable was produced: ${firstLine(e)}\n`);
    if (report) report.redaction = { ok: false, error: firstLine(e) };
    code = 1;
  }
  if (report) {
    // findings.json was staged and (on success) promoted; refresh it with the
    // redaction record. If finalization failed, nothing was promoted.
    try {
      const p = path.join(OUT_DIR, "findings.json");
      if (fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(report, null, 2));
    } catch (_) { /* reporting best effort; never mask the run result */ }
    console.log(JSON.stringify(report));
  }
  process.exitCode = code;
}

// Map a video's staging path to the name it will have after promotion.
function reportVideoPath(pass, rawPath) {
  if (!rawPath) return null;
  return path.join(OUT_DIR, `video-${pass}`, path.basename(rawPath));
}

async function inventory(page, sel) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el, i) => {
      el.setAttribute("data-uat-id", String(i));
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      return {
        id: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("href") || "").trim().slice(0, 60),
        href: el.getAttribute("href") || null,
        visible,
        x: r.x, y: r.y, width: r.width, height: r.height,
      };
    });
  }, sel);
}

async function domSignature(page) {
  return page.evaluate(() => ({ url: location.href, bodyLen: document.body ? document.body.innerHTML.length : 0 }));
}

function writeMarkdownReport(outDir, report) {
  const ro = report.readOnly || { on: false, blockedWrites: 0 };
  const wsBlocked = (report.networkPolicy && report.networkPolicy.blockedWebSocketMessages) || 0;
  const cov = report.coverage || {};
  const problems = report.findings.filter((f) => f.level === "problem");
  const notes = report.findings.filter((f) => f.level === "note");
  const line = (f) => `- **${f.where}** — ${f.what}${f.contract ? `  _(${f.contract})_` : ""}`;
  const partial = cov.partial
    ? `**PARTIAL** — ${cov.found} visible interactive elements found, only the first ${cov.exercised} exercised per pass (raise UAT_MAX_ELEMENTS)`
    : `full — ${cov.exercised} of ${cov.found} visible interactive elements exercised per pass`;
  const L = [];
  L.push(`# UAT report: ${report.url}`, "");
  L.push("| | |", "| --- | --- |");
  L.push(`| URL | ${report.url} |`);
  L.push(`| Run at | ${report.at} |`);
  L.push(ro.on
    ? `| Read-only mode | **ON — blocked HTTP methods: ${ro.blockedWrites} non-GET request(s) aborted in the browser; service workers blocked; WebSocket messages dropped: ${wsBlocked}. This blocks the listed HTTP methods and channels — it does NOT prove the server was protected from mutation (a GET endpoint with side effects still runs).** |`
    : `| Read-only mode | **OFF (UAT_READONLY=0) — real writes were allowed and may have reached the target.** |`);
  L.push(`| Findings | ${problems.length} PROBLEM, ${notes.length} note |`);
  L.push(`| Real interactions | ${report.counts.mouseClicksTried} mouse clicks, ${report.counts.touchTapsTried} touch taps, ${report.counts.formsFilled} form(s) filled, ${report.counts.undersizedTargets} undersized (<44px) target(s) |`);
  L.push(`| Coverage | ${partial} |`);
  L.push("| Artifacts | desktop.png, mobile.png, trace-desktop.zip, trace-mobile.zip (open: `npx playwright show-trace <file>`), videos under video-desktop/ + video-mobile/, axe-desktop.json, axe-mobile.json |");
  L.push("");
  L.push(`## PROBLEM findings (${problems.length})`, "");
  if (problems.length) problems.forEach((f) => L.push(line(f)));
  else L.push("_none_");
  L.push("", `## note findings (${notes.length})`, "");
  if (notes.length) notes.forEach((f) => L.push(line(f)));
  else L.push("_none_");
  L.push("", "## What this check does NOT prove", "");
  L.push("- **Not pass/fail.** Findings are never turned into a verdict; only an unreachable page makes the run exit non-zero. Read the findings, don't read the exit code.");
  L.push("- **State-change detection is a heuristic.** \"Did clicking this do anything\" compares the page URL and `document.body.innerHTML.length` before/after. It can false-positive \"did nothing\" on a same-page link that is *supposed* to do nothing, and it can miss a style-only change, an equal-length string change, or anything rendered in a canvas/shadow DOM.");
  L.push("- **Bounded coverage.** Only the first `UAT_MAX_ELEMENTS` visible interactive elements per pass, two viewports, and two axe scans. A clean run is not proof there is nothing left to find — open a trace or a screenshot before calling a page done.");
  if (ro.on) L.push("- **Read-only mode blocks HTTP methods and channels, not mutations.** \"would have sent\" means the browser was stopped before the request left; a `GET` endpoint with side effects still runs, service workers are blocked (so their requests never happen), and WebSocket messages are dropped. No write path was exercised and no server response was validated.");
  L.push("- **Form results are not validated for correctness** — only whether something visibly changed after a real submit click.");
  L.push("");
  fs.writeFileSync(path.join(outDir, "report.md"), L.join("\n"));
}

async function main() {
  const [, , url, outDir] = process.argv;
  if (!url || !outDir) {
    console.error("usage: node uat_driver.cjs <url> <outDir>");
    process.exit(2);
  }
  // E01: bind the token to an explicit origin allowlist before any request is
  // made. A bad UAT_AUTH_ORIGINS value is a hard stop -- never guess.
  if (AUTH_TOKEN) {
    try {
      AUTH_ALLOWLIST = buildAuthAllowlist(url, process.env.UAT_AUTH_ORIGINS);
    } catch (e) {
      bail(`uat: ${firstLine(e)}`);
    }
  }
  OUT_DIR = path.resolve(outDir);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  STAGE_DIR = stageDirFor(OUT_DIR);
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  process.stderr.write(
    readOnly
      ? "uat: READ-ONLY MODE ON (UAT_READONLY unset/1) -- every non-GET HTTP method will be blocked, service workers blocked, WebSocket messages dropped\n"
      : "uat: READ-ONLY MODE OFF (UAT_READONLY=0) -- real writes WILL be sent to the target\n",
  );
  if (!AXE_PATH) {
    process.stderr.write("uat: axe-core (axe.min.js) not found -- accessibility scan will be skipped. Set UAT_NODE_MODULES or run `npm install`.\n");
  }
  const findings = [];
  const add = (level, where, what, contract) => findings.push({ level, where, what, contract: contract || null });
  const counts = { mouseClicksTried: 0, touchTapsTried: 0, formsFilled: 0, undersizedTargets: 0 };
  const coverage = { found: 0, exercised: 0, partial: false };

  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    return emit({ url, ok: false, reason: `Could not launch Chromium: ${e.message}`, findings, counts }, 1);
  }

  // ---------------- Desktop pass: load, console/network, images, real mouse clicks, forms, axe --
  const desktopVideoDir = path.join(STAGE_DIR, "video-desktop");
  fs.mkdirSync(desktopVideoDir, { recursive: true });
  const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: desktopVideoDir }, serviceWorkers: "block" });
  await installNetworkPolicy(desktopCtx);
  await desktopCtx.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await desktopCtx.newPage();
  let where = "load";
  page.on("console", (m) => { if (m.type() === "error") add("problem", where, `Console error: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => add("problem", where, `Page crashed: ${e.message.slice(0, 300)}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText || "";
    if (/ERR_ABORTED/.test(f)) return; // includes our own read-only blocks — see installNetworkPolicy()
    add("problem", where, `Request failed: ${r.method()} ${r.url()} (${f})`);
  });

  let resp;
  try {
    resp = await page.goto(url, { waitUntil: "load", timeout: 20000 });
  } catch (e) {
    add("problem", "load", `Could not load ${url} at all: ${e.message.slice(0, 300)}`);
    await desktopCtx.tracing.stop({ path: path.join(STAGE_DIR, "trace-desktop.zip") }).catch(() => {});
    await desktopCtx.close();
    await browser.close();
    return emit({ url, ok: false, reason: "page did not load", findings, counts }, 1);
  }
  if (resp && !resp.ok()) add("problem", "load", `${url} answered HTTP ${resp.status()}`);
  await page.waitForTimeout(1000);

  // Broken images
  const brokenImgs = await page.evaluate(() =>
    Array.from(document.images).filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src") || "(no src)"),
  );
  for (const src of brokenImgs) add("problem", "images", `Image failed to load: ${src}`);

  await page.screenshot({ path: path.join(STAGE_DIR, "desktop.png"), fullPage: true }).catch(() => {});
  process.stderr.write(`uat: loaded, screenshot taken\n`);

  // ---- Real mouse pass over buttons/links ----
  // IMPORTANT, two lessons learned the hard way while building this:
  //  1. page.mouse coordinates are viewport-relative, and Playwright does not auto-scroll
  //     for the raw mouse API the way locator.click() does -- every element needs
  //     scrollIntoViewIfNeeded() + a FRESH boundingBox() right before ITS OWN click, or a
  //     below-the-fold element silently gets "clicked" at the wrong point and looks like a
  //     dead button when the real bug is in this driver, not the site.
  //  2. A real click on a real <a href> can trigger a REAL cross-page navigation (that's
  //     the point). Once that happens the data-uat-id markers from the original page load
  //     are gone -- a fresh DOM has no attributes on it -- so every locator for a LATER
  //     element in a stale, pre-navigation list is permanently dangling. Without an explicit
  //     timeout that dangling wait silently eats Playwright's default 30s per element,
  //     compounding across every element after the first navigation. Fix: re-run the
  //     inventory FRESH every iteration (matched by index -- the same static page reloads with
  //     the same element order) and give every action a short explicit timeout so a genuine
  //     miss fails fast instead of stalling the whole run.
  where = "interactive elements (mouse)";
  const firstPassCount = (await inventory(page, CLICK_SEL)).filter((e) => e.visible).length;
  const N = Math.min(firstPassCount, MAX_ELEMENTS);
  coverage.found = Math.max(coverage.found, firstPassCount);
  coverage.exercised = Math.max(coverage.exercised, N);
  if (firstPassCount > N) {
    coverage.partial = true;
    add("note", "coverage", `PARTIAL coverage: ${firstPassCount} visible interactive elements found, only the first ${N} exercised in this pass (raise UAT_MAX_ELEMENTS to widen).`);
  }
  process.stderr.write(`uat: mouse pass, ${N} elements\n`);
  for (let mi = 0; mi < N; mi++) {
    // Re-inventoried fresh every iteration -- see fix #2 above; do not "optimise" this away.
    const fresh = (await inventory(page, CLICK_SEL)).filter((e) => e.visible);
    const el = fresh[mi];
    if (!el) { add("note", "interactive elements (mouse)", `The element list changed after a navigation -- stopped this pass at ${mi}/${N}.`); break; }
    const label = `${el.tag}${el.type ? `[${el.type}]` : ""} "${el.text || el.href || "(no accessible label)"}"`;
    process.stderr.write(`uat: mouse ${mi + 1}/${N} ${label}\n`);
    const locator = page.locator(`[data-uat-id="${el.id}"]`);
    // Fix #1: scroll first, then a FRESH box for THIS element's own click.
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox({ timeout: 5000 }).catch(() => null);
    if (!box || box.width === 0 || box.height === 0) {
      add("note", label, "Could not get on-screen coordinates for this element (0-size or detached) -- skipped.");
      continue;
    }
    if (box.width < 44 || box.height < 44) {
      counts.undersizedTargets++;
      add("problem", label, `Hit area is ${Math.round(box.width)}x${Math.round(box.height)}px — under the 44x44px minimum.`, contractFor("target-size"));
    }
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const before = await domSignature(page);
    counts.mouseClicksTried++;
    try {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
      await page.waitForTimeout(SETTLE_MS);
    } catch (e) {
      add("problem", label, `A real mouse click at its own rendered coordinates (${Math.round(cx)},${Math.round(cy)}) threw: ${e.message.split("\n")[0]}`);
      continue;
    }
    const after = await domSignature(page).catch(() => before);
    const changed = before.url !== after.url || before.bodyLen !== after.bodyLen;
    const ds = consumeBlocked();
    if (ds.length) {
      // Read-only blocked something this click caused: say so, and do NOT call it a dead button.
      add("note", label, `clicked — request blocked by read-only mode, would have sent: ${fmtBlocks(ds)} (not a dead button: the write never left the browser).`);
    } else if (!changed) {
      // A plain <a href="#..."> anchor or an already-expanded control legitimately does nothing visible.
      if (!(el.tag === "a" && (el.href === "#" || el.href === null)))
        add("note", label, "Clicking it with a real mouse caused no visible change (no navigation, no DOM change). Might be dead, or its effect isn't reflected in the DOM.");
    }
    if (after.url !== url && after.url !== before.url) {
      // NOT page.goBack(): a bfcache-restored back navigation often never fires a fresh
      // 'load' event, so waitUntil:"load" here hung ~30s per link during testing. A plain
      // re-goto of the original url with "domcontentloaded" is fast and reliable instead.
      // Fix #2 -- see the header comment above; removing this reintroduces the hang.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // ---- Forms: real typing, real selects, real submit ----
  where = "forms";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const forms = await page.evaluate(() => Array.from(document.forms).map((f, i) => { f.setAttribute("data-uat-form", String(i)); return i; }));
  process.stderr.write(`uat: forms pass, ${forms.length} forms\n`);
  for (const fi of forms) {
    const form = page.locator(`[data-uat-form="${fi}"]`);
    const formWhere = `form #${fi}`;
    const fields = await form.evaluate((f) =>
      Array.from(f.elements).map((el, i) => {
        el.setAttribute("data-uat-field", String(i));
        const type = (el.getAttribute("type") || el.tagName).toLowerCase();
        return { i, tag: el.tagName.toLowerCase(), type, name: el.getAttribute("name") || el.getAttribute("aria-label") || "" };
      }),
    );
    let typed = 0;
    for (const f of fields) {
      const locator = form.locator(`[data-uat-field="${f.i}"]`);
      try {
        if (f.tag === "textarea" || (f.tag === "input" && ["text", "email", "search", "tel", "url", "password", ""].includes(f.type))) {
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          const box = await locator.boundingBox();
          if (!box) continue;
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          const sample = f.type === "email" ? "uat@example.com" : f.type === "tel" ? "5555550100" : f.type === "url" ? "https://example.com" : "UAT test input";
          await page.keyboard.type(sample, { delay: 10 });
          typed++;
        } else if (f.tag === "select") {
          const options = await locator.evaluate((s) => Array.from(s.options).map((o) => o.value).filter((v) => v !== ""));
          if (options.length) { await locator.selectOption(options[0]); typed++; }
        } else if (f.tag === "input" && (f.type === "checkbox" || f.type === "radio")) {
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          const box = await locator.boundingBox();
          if (!box) continue;
          if (box.width < 44 || box.height < 44) {
            counts.undersizedTargets++;
            add("problem", `${formWhere} ${f.tag}[${f.type}] "${f.name}"`, `Hit area is ${Math.round(box.width)}x${Math.round(box.height)}px — under the 44x44px minimum.`, contractFor("target-size"));
          }
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.waitForTimeout(40);
          await page.mouse.up();
          typed++;
        }
      } catch (e) {
        add("note", `${formWhere} field "${f.name || f.tag}"`, `Could not fill this field: ${e.message.split("\n")[0]}`);
      }
    }
    if (typed > 0) counts.formsFilled++;
    // Real submit: a real mouse click on the submit control, not form.submit()/dispatchEvent.
    const submitControl = form.locator('button[type=submit], input[type=submit], button:not([type])').first();
    await submitControl.scrollIntoViewIfNeeded().catch(() => {});
    const submitBox = await submitControl.boundingBox().catch(() => null);
    if (submitBox) {
      const before = await domSignature(page);
      await page.mouse.move(submitBox.x + submitBox.width / 2, submitBox.y + submitBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
      await page.waitForTimeout(SETTLE_MS + 400);
      const after = await domSignature(page).catch(() => before);
      const ds = consumeBlocked();
      if (ds.length) {
        // The form really was submitted with a real click; read-only stopped the request. This is
        // a successful interaction, not a broken submit button.
        add("note", formWhere, `submitted, request blocked by read-only mode — would have sent: ${fmtBlocks(ds)} (a real click hit the submit control; the request never left the browser).`);
      } else if (before.url === after.url && before.bodyLen === after.bodyLen) {
        add("note", formWhere, "Submitting it with a real click caused no visible change (no navigation, no DOM change, no error message shown).");
      }
      if (after.url !== url) { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {}); await page.waitForTimeout(300); }
    } else if (fields.length > 0) {
      add("note", formWhere, "Has fields but no submit button/input was found to click.");
    }
  }

  // ---- axe-core scan (desktop) ----
  where = "accessibility (desktop)";
  process.stderr.write(`uat: axe desktop scan\n`);
  if (AXE_PATH) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.addScriptTag({ path: AXE_PATH });
      const results = await page.evaluate(async () => await window.axe.run());
      fs.writeFileSync(path.join(STAGE_DIR, "axe-desktop.json"), JSON.stringify(results, null, 2));
      for (const v of results.violations) {
        add(v.impact === "critical" || v.impact === "serious" ? "problem" : "note",
          `accessibility: ${v.id}`,
          `${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}). WCAG: ${(v.tags || []).filter((t) => /^wcag/.test(t)).join(", ") || "n/a"}.`,
          contractFor(v.id));
      }
    } catch (e) {
      add("note", where, `axe-core scan failed to run: ${e.message.split("\n")[0]}`);
    }
  } else {
    add("note", where, "axe-core (axe.min.js) not resolvable -- accessibility scan skipped. Set UAT_NODE_MODULES or run `npm install`.");
  }

  await desktopCtx.tracing.stop({ path: path.join(STAGE_DIR, "trace-desktop.zip") }).catch(() => {});
  const desktopVideoPath = reportVideoPath("desktop", await page.video()?.path().catch(() => null));
  await desktopCtx.close();
  process.stderr.write(`uat: desktop pass done, starting mobile\n`);

  // ---------------- Mobile/touch pass -----------------------------------------------------------
  where = "interactive elements (touch)";
  const mobileVideoDir = path.join(STAGE_DIR, "video-mobile");
  fs.mkdirSync(mobileVideoDir, { recursive: true });
  const mobileCtx = await browser.newContext({ ...devices["iPhone 13"], recordVideo: { dir: mobileVideoDir }, serviceWorkers: "block" });
  await installNetworkPolicy(mobileCtx);
  await mobileCtx.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const mpage = await mobileCtx.newPage();
  mpage.on("console", (m) => { if (m.type() === "error") add("problem", where, `Console error (mobile): ${m.text().slice(0, 300)}`); });
  try {
    await mpage.goto(url, { waitUntil: "load", timeout: 20000 });
    await mpage.waitForTimeout(800);
    await mpage.screenshot({ path: path.join(STAGE_DIR, "mobile.png"), fullPage: true }).catch(() => {});
    const firstMobileCount = (await inventory(mpage, CLICK_SEL)).filter((e) => e.visible).length;
    const NM = Math.min(firstMobileCount, MAX_ELEMENTS);
    coverage.found = Math.max(coverage.found, firstMobileCount);
    coverage.exercised = Math.max(coverage.exercised, NM);
    if (firstMobileCount > NM) {
      coverage.partial = true;
      add("note", "coverage", `PARTIAL coverage: ${firstMobileCount} visible interactive elements found, only the first ${NM} exercised in this pass (raise UAT_MAX_ELEMENTS to widen).`);
    }
    process.stderr.write(`uat: touch pass, ${NM} elements\n`);
    for (let ti = 0; ti < NM; ti++) {
      // Re-inventoried fresh every iteration for the same reason as the desktop pass above:
      // a real tap on a real link can navigate away, and a stale data-uat-id after that
      // navigation would otherwise dangle for a full default actionability timeout.
      const freshM = (await inventory(mpage, CLICK_SEL)).filter((e) => e.visible);
      const el = freshM[ti];
      if (!el) { add("note", "interactive elements (touch)", `The element list changed after a navigation -- stopped this pass at ${ti}/${NM}.`); break; }
      const label = `${el.tag}${el.type ? `[${el.type}]` : ""} "${el.text || el.href || "(no accessible label)"}" (touch)`;
      process.stderr.write(`uat: touch ${ti + 1}/${NM} ${label}\n`);
      const mLocator = mpage.locator(`[data-uat-id="${el.id}"]`);
      // Fix #1 again (mobile): scroll then fresh box, or below-the-fold taps miss and look dead.
      await mLocator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      const box = await mLocator.boundingBox({ timeout: 5000 }).catch(() => null);
      if (!box || box.width === 0 || box.height === 0) {
        add("note", label, "Could not get on-screen coordinates for this element (0-size or detached) -- skipped.");
        continue;
      }
      if (box.width < 44 || box.height < 44) {
        counts.undersizedTargets++;
        add("problem", label, `Hit area is ${Math.round(box.width)}x${Math.round(box.height)}px — under the 44x44px minimum a real fingertip needs.`, contractFor("target-size"));
      }
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      counts.touchTapsTried++;
      const before = await domSignature(mpage);
      try {
        await mpage.touchscreen.tap(cx, cy);
        await mpage.waitForTimeout(SETTLE_MS);
      } catch (e) {
        add("problem", label, `A real touch tap at its own rendered coordinates threw: ${e.message.split("\n")[0]}`);
        continue;
      }
      const after = await domSignature(mpage).catch(() => before);
      const ds = consumeBlocked();
      if (ds.length) {
        add("note", label, `tapped — request blocked by read-only mode, would have sent: ${fmtBlocks(ds)} (not a dead control: the write never left the browser).`);
      } else if (before.url === after.url && before.bodyLen === after.bodyLen) {
        if (!(el.tag === "a" && (el.href === "#" || el.href === null)))
          add("note", label, "Tapping it with a real touch event caused no visible change.");
      }
      if (after.url !== url && after.url !== before.url) {
        // Fix #2 again (mobile): re-goto, never goBack(); fresh inventory every iteration.
        await mpage.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
        await mpage.waitForTimeout(300);
      }
    }
    process.stderr.write(`uat: axe mobile scan\n`);
    if (AXE_PATH) {
      try {
        await mpage.goto(url, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
        await mpage.waitForTimeout(400);
        await mpage.addScriptTag({ path: AXE_PATH });
        const results = await mpage.evaluate(async () => await window.axe.run());
        fs.writeFileSync(path.join(STAGE_DIR, "axe-mobile.json"), JSON.stringify(results, null, 2));
        for (const v of results.violations) {
          add(v.impact === "critical" || v.impact === "serious" ? "problem" : "note",
            `accessibility (mobile): ${v.id}`,
            `${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}).`,
            contractFor(v.id));
        }
      } catch (e) {
        add("note", "accessibility (mobile)", `axe-core scan failed to run: ${e.message.split("\n")[0]}`);
      }
    }
  } catch (e) {
    add("problem", "mobile load", `Could not load ${url} on mobile emulation: ${e.message.slice(0, 300)}`);
  }
  await mobileCtx.tracing.stop({ path: path.join(STAGE_DIR, "trace-mobile.zip") }).catch(() => {});
  const mobileVideoPath = reportVideoPath("mobile", await mpage.video()?.path().catch(() => null));
  await mobileCtx.close();
  await browser.close();

  // Any write blocked outside a click/submit (background timers, autosave) still gets reported.
  for (const b of blocked.slice(blockedAttributed)) {
    add("note", "network (read-only)", `blocked in the browser, would have sent: ${fmtBlocks([b])}`);
  }
  blockedAttributed = blocked.length;

  const httpBlocked = blocked.filter((b) => b.kind !== "websocket").length;
  const wsBlockedCount = blocked.filter((b) => b.kind === "websocket").length;
  const report = {
    url, ok: true, at: new Date().toISOString(),
    readOnly: { on: readOnly, blockedWrites: httpBlocked },
    networkPolicy: {
      readOnly,
      authenticatedOriginsCount: AUTH_ALLOWLIST.length,
      authScopedToAllowlist: AUTH_ALLOWLIST.length > 0,
      serviceWorkers: "block",
      blockedHttpMethods: httpBlocked,
      blockedWebSocketMessages: wsBlockedCount,
      note: "read-only blocks non-GET HTTP methods, blocks service workers, and drops WebSocket messages; it does not prevent mutations caused by GET side effects",
    },
    findings, counts, coverage,
    screenshots: { desktop: "desktop.png", mobile: "mobile.png" },
    traces: { desktop: "trace-desktop.zip", mobile: "trace-mobile.zip" },
    videos: { desktop: desktopVideoPath, mobile: mobileVideoPath },
  };
  fs.writeFileSync(path.join(STAGE_DIR, "findings.json"), JSON.stringify(report, null, 2));
  writeMarkdownReport(STAGE_DIR, report);
  return emit(report, 0);
}

// Pure decision helpers, re-exported so a unit test can require the driver (or
// lib/policy.cjs directly) without launching a browser. Requiring this module
// resolves the Playwright dependency but does not run a scan.
module.exports = { isApprovedOrigin, buildAuthAllowlist, decideRequest, normalizeOrigin, safePath };

if (require.main === module) {
  main().catch((e) => {
    console.error("uat_driver fatal:", e);
    emit({ ok: false, reason: `fatal: ${e.message}`, findings: [], counts: {} }, 1);
  });
}
