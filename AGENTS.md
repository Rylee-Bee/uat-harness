# AGENTS.md — uat-harness

A general-purpose real-browser UAT driver: point it at any URL and it clicks, taps and types for real
(Playwright), runs axe-core, and writes findings a human reads. **Public repo**
(`github.com/Rylee-Bee/uat-harness`) — everything tracked must be safe to publish.

Owns the driver, contract map, and persona/journey/acceptance templates. Not any repo's own
Playwright suite (that suite stays the gate for its repo), nor CI wiring (belongs to `ci-harness`).
Canonical UAT home by owner decision: port behaviour here, don't fork it elsewhere.

Build/test: `npm run check`, `npm run test:unit`, `npm run test:browser`, `npm test`. Run:
`python3 uat.py URL [URL…] [--out DIR]`. Reference detail (file map, commands, env vars, outputs, smoke
test, templates, and why rules 1–3 and 8 are shaped as they are):
[`docs/agent-reference.md`](docs/agent-reference.md).

## Load-bearing rules

1. **Read the driver's comments before touching click/navigation logic.**
2. **Keep `scrollIntoViewIfNeeded()` + a fresh `boundingBox()` before each click/tap; keep
   `page.goto(url, {waitUntil:"domcontentloaded"})` as the return-to-page (never
   `page.goBack()`); re-run the element inventory fresh every iteration.**
3. **Keep redaction inside the driver, before promotion.** `lib/redact.cjs` scrubs tokens from plain
   files and `trace-*.zip`; `lib/artifacts.cjs` redacts the hidden `<out>/.staging/` tree and only
   then promotes it. A scrub failure must withhold everything (fail closed). `redact_artifacts()`
   in `uat.py` stays as defence in depth, not as the primary guard.
4. **Findings are never pass/fail.** Only an unreachable page (or unresolvable deps) exits
   non-zero. Do not add a threshold that turns findings into an exit code.
5. **Read-only stays the default** (`UAT_READONLY` unset/1 aborts every non-GET HTTP
   request, blocks service workers, and drops WebSocket messages). This blocks
   methods/channels, not server mutation; never point this at live mutating endpoints;
   `UAT_READONLY=0` only for targets you may mutate.
6. **`@playwright/test` and `axe-core` stay in `dependencies`, not `devDependencies`** — consumers
   install this repo as a package and npm skips a dependency's devDependencies.
7. **Public-safe tracked files.** No secrets, tokens, hostnames, real ports, LAN IPs, deployment
   topology, or absolute machine paths. Examples use `http://127.0.0.1:PORT/...` literally;
   document environment variables instead of paths. Never commit a run directory.
8. **Authenticated requests are policed via CDP `Fetch`, not `context.route`.** `lib/netpolicy.cjs`
   uses a raw CDP `Fetch.requestPaused` session so the allowlist is re-checked at every hop, and an
   off-allowlist hop is failed rather than followed. Chromium-only (the driver's browser): await the
   returned `attachPage(page)` before a page's first navigation.

Do not point an artifact uploader at `.staging/`.

**`UAT_TOKEN` is environment-only** — never written to a config, never echoed, redacted from every
artifact (trace ZIPs included) before publication.

## Boundaries

- **Consumers:** other estate frontends, installing this package or via `ci-harness`'s
  `reusable-uat.yml`. This repo does not read `UAT_URL` (URLs are CLI args). Changing CLI args, env
  var names, the `uat-out/` default, output file names or the `findings.json` shape breaks
  consumers: update this file and `README.md`, and record the companion change for `ci-harness`
  rather than editing it from here.
- **Duplicates elsewhere:** an older copy of `uat.py` / `uat_driver.cjs` lives in `hive-works`.
  Retiring it is that repo owner's call; do not edit it from here.
- **Design brief:** the estate root's `docs/guides/agent-driven-uat.md` and decision
  `docs/decisions/uat-harness-shared-home-2026-09-28.md` (outside this repo; link, don't copy).

## Needs Rylee's approval here

Pushing (the repo is public — a push publishes), changing visibility, adding telemetry or any
network call beyond the target URL. General gates: the estate constitution.

## Done means

`npm run check` passes **and** the smoke test (reference page) ran with the expected findings; for
behaviour changes, open `report.md` (and a screenshot or trace) and quote what changed. This file
and `README.md` updated if env vars, outputs or commands changed. Handoff state goes to Project Home
(there is no in-repo `.agent/`).