# AGENTS.md — uat-harness

A general-purpose real-browser UAT driver: point it at any URL and it clicks, taps and types for
real (Playwright) — raw `page.mouse` coordinates, `page.touchscreen.tap`, `page.keyboard` — runs
axe-core, and writes findings a human reads. Entry point `python3 uat.py URL [--out DIR]`.
Evidence-gathering, not a gate. **Public repo** (`github.com/rylee-bee-labs/uat-harness`):
everything tracked must be safe to publish.

Owns the driver, its contract map, and the persona/journey/acceptance templates. Does not own any
repo's own Playwright suite (that suite stays its repo's gate) or CI wiring (`ci-harness`). This
is the canonical UAT home by owner decision — port behaviour here, don't fork elsewhere.

## Map

Which file to open for which change. Full inventory, commands, env vars, outputs and tests:
[`docs/agent-reference.md`](docs/agent-reference.md)

- `uat_driver.cjs` — all Playwright work: inventory, real mouse/touch/typing, axe, report; stages,
  redacts and finalizes artifacts (fail closed). Any behaviour change.
- `lib/policy.cjs`, `lib/netpolicy.cjs` — origin-allowlist decisions (pure); Playwright glue for
  auth scoping, read-only block and WebSocket policy.
- `lib/redact.cjs`, `lib/artifacts.cjs` — in-driver redaction (plain files + ZIP entries) and
  hidden-staging finalization, both fail closed.
- `uat.py` — thin wrapper: withholds incomplete staging, re-scans as defence in depth.
- `tests/` — browser-free unit tests; E01/E02/E03 Playwright fixtures (canary tokens only).
- `contracts/`, `contract-map.json` — templates and the axe-rule → contract-clause map. Docs only.
- `uat-out/`, `runs/` — run output (gitignored). Never commit.

## Load-bearing rules

1. **Read the driver's comments before touching click/navigation logic.** `uat_driver.cjs`
   carries two hard-won comments (the mouse-coordinate lesson and the navigation/re-inventory
   lesson) explaining the code's shape.
2. **Keep `scrollIntoViewIfNeeded()` + a fresh `boundingBox()` before each click/tap; keep
   `page.goto(url, {waitUntil:"domcontentloaded"})` as the return-to-page (never
   `page.goBack()`); re-run the element inventory fresh every iteration.** Lose any and every
   element after the first real navigation silently looks "dead" — the tool lying, not the site.
3. **Keep redaction inside the driver, before promotion.** `lib/redact.cjs` scrubs a bearer token
   from plain files and inside `trace-*.zip`; `lib/artifacts.cjs` redacts the hidden
   `<out>/.staging/` tree and only then promotes it. Traces record request headers, so the token
   is what CI would upload. A scrub failure must withhold everything (fail closed).
   `redact_artifacts()` in `uat.py` stays defence in depth, not the primary guard.
4. **Findings are never pass/fail.** Only an unreachable page (or unresolvable deps) exits
   non-zero. Do not add a threshold that turns findings into an exit code.
5. **Read-only stays the default** (`UAT_READONLY` unset/1 aborts every non-GET HTTP request,
   blocks service workers, and drops WebSocket messages). This blocks methods/channels, not server
   mutation; never point this at live mutating endpoints; `UAT_READONLY=0` only for targets you
   may mutate.
6. **`@playwright/test` and `axe-core` stay in `dependencies`, not `devDependencies`** —
   consumers install this repo as a package (`npm install github:rylee-bee-labs/uat-harness`) and
   npm skips a dependency's devDependencies.
7. **Public-safe tracked files.** No secrets, tokens, hostnames, real ports, LAN IPs, deployment
   topology or absolute machine paths. Examples use `http://127.0.0.1:PORT/...` literally; document
   environment variables instead of paths. Never commit a run directory.
8. **Authenticated requests are policed via CDP `Fetch`, not `context.route`.** Playwright's
   route handler is NOT invoked for redirect hops (measured: a 302 to an off-origin host followed
   with the Authorization header still attached). `lib/netpolicy.cjs` uses a raw CDP
   `Fetch.requestPaused` session so the allowlist is re-checked at every hop, and an off-allowlist
   hop is failed rather than followed. Chromium-only; await the returned `attachPage(page)` before
   a page's first navigation.

## Done means

`npm run check` passes **and** the smoke test in `docs/agent-reference.md` ran with the expected
findings; for behaviour changes, open `report.md` (and a screenshot or trace) and quote what
changed. Update this file and `README.md` if env vars, outputs or commands changed.

Reference detail: docs/agent-reference.md