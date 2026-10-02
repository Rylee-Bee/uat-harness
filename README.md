# uat-harness

| | |
| --- | --- |
| **What** | A real-browser UAT driver: it clicks, taps and types for **real**, then reports what it found in plain words |
| **Not** | A `locator.click()` smoke script — raw `page.mouse` move/down/up at each element's own coordinates, real `page.touchscreen.tap` on an iPhone-13 emulation, real `page.keyboard` typing into real forms |
| **Also** | Two axe-core scans (desktop + mobile) mapped to contract clauses, full-page screenshots, Playwright traces and videos for both passes |
| **Safety** | **Read-only by default** — every non-GET HTTP request is aborted in the browser and recorded as a finding; service workers are blocked and WebSocket messages are dropped. Blocks HTTP methods/channels, **not** server mutation |
| **Verdicts** | None, ever. Findings are `problem` / `note`; only an unreachable page exits non-zero |
| **Parts** | `uat.py` (thin Python wrapper) + `uat_driver.cjs` (the Playwright work) |
| **Deps** | `@playwright/test`, `axe-core` — declared in `package.json`, never vendored |

## What this is

A general-purpose driver you point at **any URL**: it loads the page in headless Chromium,
inventories every button/link/input, and interacts with each one for real — a real mouse
move+down+up at the element's rendered coordinates, a real touch tap on mobile emulation after
checking the 44×44 CSS px hit-area floor, real keystrokes into real form fields, a real click on
the real submit control. It then reports what actually changed (URL or DOM), what broke (console
errors, failed requests, broken images), and what axe-core says about accessibility.

**This really clicks.** It clicks links, types into fields and submits forms on whatever URL you
give it. Point it at a dev server or a built static site — never at a production form that emails
someone, a live payment flow, or anything you can't afford to be clicked on for real. Read-only
mode (`UAT_READONLY`, **on by default**) stops the *non-GET HTTP requests* those
clicks cause from leaving the browser (service workers are blocked and WebSocket
messages are dropped), but the clicks, typing and navigation are still real; a `GET`
with side effects still runs. `UAT_READONLY=0` removes the guard entirely, so only use
that against a target you are allowed to mutate.

## Quickstart

```sh
# Dependencies: reuse an existing Playwright install (no second browser download) ...
export UAT_NODE_MODULES=/path/to/node_modules        # a dir that contains @playwright/test + axe-core
# ... or install into this repo instead (declared in package.json):
#   npm install && npx playwright install chromium

# Serve the page under test (this repo's own fixture for a dry run) ...
python3 -m http.server PORT --directory fixtures

# ... and run it.
python3 uat.py http://127.0.0.1:PORT/sample.html --out runs/smoke

# Housekeeping
npm run check            # syntax-check the driver
node uat_driver.cjs URL OUTDIR   # driver directly, if you don't want the Python wrapper
```

If nothing resolves, the driver stops with the list of paths it tried and how to fix it
(`UAT_NODE_MODULES=...` or `npm install`) — it does not silently skip.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `UAT_NODE_MODULES` | unset | Path to an existing `node_modules` containing `@playwright/test` and `axe-core`. Resolution order: this → `./node_modules` in this repo → bare `require`. |
| `UAT_READONLY` | `1` (on) | `1`/unset: every non-GET HTTP request is aborted at the network layer and recorded as a `note` (`would have sent: POST /api/thing`); service workers are blocked and WebSocket messages are dropped. This blocks **HTTP methods/channels, not server mutation** — a GET endpoint with side effects still runs. Stated loudly in stderr and in the report header. `0`: real writes are allowed. |
| `UAT_CONTRACT_MAP` | `./contract-map.json` | JSON file mapping axe rule ids → plain-words contract clauses. Unmapped rules fall back to `general accessibility (no contract clause mapped for this rule)`. An explicitly-set-but-broken path is a hard stop; a missing default file just degrades. |
| `UAT_TOKEN` | unset | Optional bearer token for a walkthrough of a live, authenticated app, sent as `Authorization: Bearer …`. **Environment-only** — never written to a config, never echoed. The token is bound to an explicit scheme/host/port allowlist (see `UAT_AUTH_ORIGINS`): it is attached per-request only to the target origin, and is stripped from off-origin subresources and never sent on off-origin navigation. The driver redacts it from every artifact, **including the trace zips**, as part of finalization before the output directory is publishable. Unset means the page is visited unauthenticated. |
| `UAT_AUTH_ORIGINS` | unset | Extra approved origins for `UAT_TOKEN`, comma-separated (e.g. `https://api.example.test:8443`). Only used when `UAT_TOKEN` is set. The target URL's own origin is always included; anything not listed gets no credential. A malformed entry is a hard stop. |
| `UAT_MAX_ELEMENTS` | `20` | Max interactive elements exercised per pass, per viewport. Exceeding it now reports **PARTIAL COVERAGE** explicitly instead of silently truncating. |

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

## Design brief

The reasoning behind this approach — why agent-driven UAT means a real browser doing real
interactions instead of synthetic clicks, and why the output is findings a human reads rather
than a pass/fail bit — is written up in the parent estate as
[`../docs/guides/agent-driven-uat.md`](../docs/guides/agent-driven-uat.md) (relative to this
repo's parent; it lives in the estate root's `docs/guides/`). Read it there; this README only
links it.
