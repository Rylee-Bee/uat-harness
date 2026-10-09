# AGENTS.md — uat-harness

A general-purpose real-browser UAT driver: point it at any URL and it clicks, taps and types for
real (Playwright), runs axe-core, and writes findings a human reads. "For real" means raw
`page.mouse` move/down/up at each element's own coordinates, `page.touchscreen.tap` on an
iPhone-13 emulation and `page.keyboard` typing into real forms — not a `locator.click()` smoke
script. Two axe-core scans (desktop + mobile) mapped to contract clauses, plus full-page
screenshots, traces and videos for both passes. **Public repo**
(`github.com/Rylee-Bee/uat-harness`) — everything tracked must be safe to publish.

Owns: the driver, its contract map, and the persona/journey/acceptance templates. Does not own:
any repo's own Playwright suite (that suite stays the gate for its repo), or CI wiring (that
belongs to `ci-harness`). This is the canonical UAT home by owner decision — port behaviour
here, don't fork it elsewhere.

## Map

| Path | What | Open it? |
| --- | --- | --- |
| `uat_driver.cjs` | All Playwright work: dep resolution, inventory, real mouse/touch/typing, axe, report; stages artifacts, redacts tokens and finalizes (fail closed) | yes, for any behaviour change |
| `lib/policy.cjs` | Pure origin-allowlist / request decision functions (no Playwright) | when changing credential or read-only policy |
| `lib/netpolicy.cjs` | Playwright glue: per-request auth scoping, read-only block, WebSocket policy | when changing network policy |
| `lib/redact.cjs` | In-driver artifact redaction (plain files + ZIP entries), fail closed | when changing redaction |
| `lib/artifacts.cjs` | Hidden staging + redact-then-promote finalization | when changing artifact flow |
| `uat.py` | Thin wrapper: runs the driver, withholds incomplete staging, re-scans as defence in depth, prints summary | yes |
| `contract-map.json` | axe rule id → plain-words contract clause (override with `UAT_CONTRACT_MAP`) | when mapping rules |
| `fixtures/sample.html` | The smoke-test page (undersized targets, POST button, form) | when changing the smoke test |
| `contracts/{personas,journeys,acceptance}/` | Templates + one example each | docs work only |
| `package.json` | Scripts `uat`, `check`, `test:unit`, `test:browser`, `test`; deps | rarely |
| `tests/unit/*.test.cjs` | Browser-free unit tests for `lib/policy.cjs`, `lib/redact.cjs`, `lib/artifacts.cjs` | when changing those decisions |
| `tests/*.spec.cjs` | Playwright acceptance fixtures for E01/E02/E03 (canary tokens only) | when changing the guarantees |
| `.github/workflows/ci.yml` | CI: unit tests + Playwright fixtures on chromium | when changing what CI proves |
| `README.md` | Short human entry point: what this is, is it running, how to run it, where to read more. The detail it no longer carries lives in this file | keep in sync with behaviour |
| `uat-out/`, `runs/`, `playwright-report/` | Run output (gitignored): screenshots, traces, videos, reports | to review a run; never commit |

Tests, a committed lockfile and a CI workflow now exist. `npm test` runs the unit
tests then the browser fixtures; no test skips silently.

## Commands

| Command | Defined in | Notes |
| --- | --- | --- |
| `npm run check` | `package.json` | `node --check` on the driver and every `lib/*.cjs` — syntax only, **not** the tests |
| `npm run test:unit` | `package.json` | `node --test tests/unit` — browser-free policy/redaction tests |
| `npm run test:browser` | `package.json` | `playwright test` — E01/E02/E03 fixtures (chromium) |
| `npm test` | `package.json` | unit tests then browser fixtures |
| `npm run uat -- URL OUTDIR` | `package.json` | canonical safe driver; stages + redacts even without the wrapper |
| `python3 uat.py URL [URL…] [--out DIR]` | `uat.py` | normal entry point; default out `./uat-out/<slug>-<ts>` |
| `npm install && npx playwright install chromium` | README | only if not reusing an install via `UAT_NODE_MODULES` |

`uat.py` parses nothing but `--out`: `--help` is treated as a URL (and writes a `uat-out/`
dir). Run it with no arguments to print usage.

**Smoke test (run before claiming it works):**

```sh
python3 -m http.server PORT --bind 127.0.0.1 --directory fixtures
UAT_NODE_MODULES=<existing node_modules with @playwright/test + axe-core> \
  python3 uat.py http://127.0.0.1:PORT/sample.html --out <dir under runs/ or outside the repo>
```

Expect exit 0, `findings.json` + `report.md`, undersized targets flagged (`"level": "problem"` in `findings.json`, `PROBLEM` in `report.md`), and
read-only notes (`would have sent: POST …`).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `UAT_NODE_MODULES` | unset | Path to an existing `node_modules` containing `@playwright/test` and `axe-core`. Resolution order: this → `./node_modules` in this repo → bare `require`. |
| `UAT_READONLY` | `1` (on) | `1`/unset: every non-GET HTTP request is aborted at the network layer and recorded as a `note` (`would have sent: POST /api/thing`); service workers are blocked and WebSocket messages are dropped. This blocks **HTTP methods/channels, not server mutation** — a GET endpoint with side effects still runs. Stated loudly in stderr and in the report header. `0`: real writes are allowed. |
| `UAT_CONTRACT_MAP` | `./contract-map.json` | JSON file mapping axe rule ids → plain-words contract clauses. Unmapped rules fall back to `general accessibility (no contract clause mapped for this rule)`. An explicitly-set-but-broken path is a hard stop; a missing default file just degrades. |
| `UAT_TOKEN` | unset | Optional bearer token for a walkthrough of a live, authenticated app, sent as `Authorization: Bearer …`. **Environment-only** — never written to a config, never echoed. The token is bound to an explicit scheme/host/port allowlist (see `UAT_AUTH_ORIGINS`): it is attached per-request only to the target origin, and is stripped from off-origin subresources and never sent on off-origin navigation. The driver redacts it from every artifact, **including the trace zips**, as part of finalization before the output directory is publishable. Unset means the page is visited unauthenticated. |
| `UAT_AUTH_ORIGINS` | unset | Extra approved origins for `UAT_TOKEN`, comma-separated (e.g. `https://api.example.test:8443`). Only used when `UAT_TOKEN` is set. The target URL's own origin is always included; anything not listed gets no credential. A malformed entry is a hard stop. Redirects are followed hop-by-hop with the allowlist re-checked at each hop, so an authenticated request can never be redirected off the approved origins. |
| `UAT_MAX_ELEMENTS` | `20` | Max interactive elements exercised per pass, per viewport. Exceeding it now reports **PARTIAL COVERAGE** explicitly instead of silently truncating. |
| `UAT_TIMEOUT` | `420` | Seconds the Python wrapper waits for the driver before killing it and withholding its incomplete staging directory (fail closed). Raise for very content-heavy pages. |

Deps (`@playwright/test`, `axe-core`, `adm-zip`) are declared in `package.json` and never vendored.
If nothing resolves, the driver stops with the list of paths it tried and how to fix it
(`UAT_NODE_MODULES=...` or `npm install`) — it does not silently skip.

## What it writes

All under the `--out` directory (default `./uat-out/<slug>-<timestamp>`):

| File | Contents |
| --- | --- |
| `findings.json` | Machine-readable run report: findings, counts, read-only state, coverage, artifact names |
| `report.md` | Human-readable run report: metadata table (URL, timestamp, read-only on/off, counts, coverage), `PROBLEM` and `note` findings grouped, and a "what this check does NOT prove" section |
| `desktop.png`, `mobile.png` | Full-page screenshots, both passes |
| `trace-desktop.zip`, `trace-mobile.zip` | Playwright trace — open with `npx playwright show-trace <file>` for a step-by-step replay with DOM snapshots |
| `video-desktop/`, `video-mobile/` | Video of each pass |
| `axe-desktop.json`, `axe-mobile.json` | Raw axe-core results |

Artifacts live in `uat-out/` / `runs/` (both git-ignored) — never commit a run.

**Finalization (E03):** the driver writes everything into a hidden
`<out>/.staging/` directory first, redacts any bearer token from plain files
**and from inside the trace ZIPs**, and only then promotes the artifacts to
their real names. There is exactly one path that produces publishable
artifacts and it always redacts; a scrub failure withholds the whole run
(fail closed) and exits non-zero. A timed-out or crashed run leaves at most
the hidden staging directory, which is not uploaded (and the Python wrapper
removes it on timeout). Do not point an artifact uploader at `.staging/`.

## Tests

```sh
npm run test:unit     # browser-free: origin-allowlist decisions, redaction, finalization
npm run test:browser  # Playwright fixtures: E01 token scoping, E02 read-only policy, E03 redaction
npm test              # both
```

The fixtures use obviously-fake canary tokens and disposable `127.0.0.1` servers only.
E01 runs both a desktop and an iPhone-13 context and proves an off-origin resource,
link, redirect hop and popup never receive the token while the approved origin still
authenticates. E02 proves a mutating GET still runs, service workers are blocked, and a
WebSocket write is dropped but recorded. E03 proves direct-driver, failed and timed-out
runs leave no token in plain files or trace ZIP entries and publish nothing on a scrub
failure. CI (`.github/workflows/ci.yml`) runs both suites on every push/PR.

## Where this fits

| Situation | Use |
| --- | --- |
| A repo with its own Playwright suite | **That suite is still the gate for that repo.** Run it (build first, every time) before saying that repo's change works. |
| Any surface with a URL and **no** dedicated suite | This driver: `python3 uat.py <url>` |
| "Does the deployed instance still make sense" | A read-only walkthrough suite with real auth, if the repo has one |
| A flow someone has clicked through once by hand | Playwright's recorder (`npx playwright codegen <url>`) turns that one walkthrough into a permanent test — worth doing for the flows that matter most |

This is the general-purpose one: point it at anything with a URL and no dedicated suite. It is
evidence-gathering, not a gate — findings never fail the run, and a clean run is not proof there
is nothing left to find. Open a trace or a screenshot before calling a page done.

## Templates

- [`contracts/personas/`](contracts/personas/README.md) — one-line persona cards
- [`contracts/journeys/`](contracts/journeys/README.md) — jobs-to-be-done
- [`contracts/acceptance/`](contracts/acceptance/README.md) — symbolised triples, assertion vocabulary only, **no free-text verdicts**

## Load-bearing rules

1. **Read the driver's comments before touching click/navigation logic.** `uat_driver.cjs`
   carries two hard-won comments (the mouse-coordinate lesson and the navigation/re-inventory
   lesson) explaining why the code is shaped this way.
2. **Keep `scrollIntoViewIfNeeded()` + a fresh `boundingBox()` before each click/tap; keep
   `page.goto(url, {waitUntil:"domcontentloaded"})` as the return-to-page (never
   `page.goBack()`); re-run the element inventory fresh every iteration.** Lose any of these and
   every element after the first real navigation silently looks "dead" — the tool lying, not
   the site.
3. **Keep redaction inside the driver, before promotion.** `lib/redact.cjs` scrubs a
   bearer token from plain files and from inside `trace-*.zip`; `lib/artifacts.cjs`
   redacts the hidden `<out>/.staging/` tree and only then promotes it. Playwright
   traces record request headers, so the token is exactly what CI would upload;
   GitHub masks logs, not uploaded files. A scrub failure must withhold everything
   (fail closed). `redact_artifacts()` in `uat.py` stays as defence in depth, not as
   the primary guard. Found by a canary test; load-bearing like rule 2.
4. **Findings are never pass/fail.** Only an unreachable page (or unresolvable deps) exits
   non-zero. Do not add a threshold that turns findings into an exit code.
5. **Read-only stays the default** (`UAT_READONLY` unset/1 aborts every non-GET HTTP
   request, blocks service workers, and drops WebSocket messages). This blocks
   methods/channels, not server mutation; never point this at live mutating endpoints;
   `UAT_READONLY=0` only for targets you may mutate.
6. **`@playwright/test` and `axe-core` stay in `dependencies`, not `devDependencies`** —
   consumers install this repo as a package (`npm install github:Rylee-Bee/uat-harness`), and
   npm skips a dependency's devDependencies.
7. **Public-safe tracked files.** No secrets, tokens, hostnames, real ports, LAN IPs, deployment
   topology, or absolute machine paths. Examples use `http://127.0.0.1:PORT/...` literally;
   document environment variables instead of paths. Never commit a run directory.
8. **Authenticated requests are policed via CDP `Fetch`, not `context.route`.** Playwright's
   route handler is NOT invoked for redirect hops (measured: a 302 to an off-origin host
   followed with the Authorization header still attached). `lib/netpolicy.cjs` uses a raw CDP
   `Fetch.requestPaused` session so the allowlist is re-checked at every hop, and an
   off-allowlist hop is failed rather than followed. This is Chromium-only (the driver's
   browser); await the returned `attachPage(page)` before a page's first navigation.

## Boundaries

- **Consumers:** other estate frontends, by direct package install or through `ci-harness`'s
  `reusable-uat.yml`. That workflow runs a caller-supplied command (it does not install this
  repo), exports `UAT_READONLY`, `UAT_TOKEN` and `UAT_URL`, and uploads `uat-out/` by default.
  This repo does not read `UAT_URL` (URLs are CLI args). Changing CLI args, env var names, the
  `uat-out/` default, output file names or the `findings.json` shape breaks consumers: update
  this file and `README.md`, and record the companion change for `ci-harness` rather than
  editing it from here.
- **Duplicates elsewhere:** an older copy of `uat.py` / `uat_driver.cjs` lives in `hive-works`.
  Retiring it is that repo owner's call; do not edit it from here.
- **Design brief:** the estate root's `docs/guides/agent-driven-uat.md` and decision
  `docs/decisions/uat-harness-shared-home-2026-09-28.md` (outside this repo; link, don't copy).
  The reasoning behind this approach — why agent-driven UAT means a real browser doing real
  interactions instead of synthetic clicks, and why the output is findings a human reads rather
  than a pass/fail bit — is written up there. Read it there; this file only links it.

## Needs Rylee's approval here

Pushing (the repo is public — a push publishes), changing visibility, adding telemetry or any
network call beyond the target URL. General gates: the estate constitution.

## Done means

`npm run check` passes **and** the smoke test above ran with the expected findings; for
behaviour changes, open `report.md` (and a screenshot or trace) and quote what changed. This file
(and the `README.md` summary it points at) updated if env vars, outputs or commands changed.
Handoff state goes to Project Home (there is no in-repo `.agent/`).
