# uat-harness agent reference

The detail behind [`AGENTS.md`](../AGENTS.md). The rules live in `AGENTS.md`; this page is the
reference they point at — file map, commands, environment variables, outputs, and the reasoning
behind the load-bearing rules. If the two ever disagree, `AGENTS.md` is the rule and this page is
wrong. The design brief (estate root's `docs/guides/agent-driven-uat.md` and decision
`docs/decisions/uat-harness-shared-home-2026-09-28.md`) is outside this repo: read it there, link
to it, do not copy it here.

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
| `README.md` | Short human entry point: what this is, is it running, how to run it, where to read more. The detail it no longer carries lives in [`AGENTS.md`](../AGENTS.md) and here | keep in sync with behaviour |
| `uat-out/`, `runs/`, `playwright-report/` | Run output (gitignored): screenshots, traces, videos, reports | to review a run; never commit |

Tests, a committed lockfile and a CI workflow exist. `npm test` runs the unit tests then the browser
fixtures; no test skips silently.

## What "for real" means

Raw `page.mouse` move/down/up at each element's own coordinates, `page.touchscreen.tap` on an
iPhone-13 emulation and `page.keyboard` typing into real forms — not a `locator.click()` smoke
script. Two axe-core scans (desktop + mobile) mapped to contract clauses, plus full-page
screenshots, traces and videos for both passes.

## Commands

| Command | Defined in | Notes |
| --- | --- | --- |
| `npm run check` | `package.json` | `node --check` on the driver and every `lib/*.cjs` — syntax only, **not** the tests |
| `npm run test:unit` | `package.json` | `node --test tests/unit` — browser-free policy/redaction tests |
| `npm run test:browser` | `package.json` | `playwright test` — E01/E02/E03 fixtures (chromium) |
| `npm test` | `package.json` | unit tests then browser fixtures |
| `npm run uat -- URL OUTDIR` | `package.json` | canonical safe driver; stages + redacts even without the wrapper |
| `python3 uat.py URL [URL…] [--out DIR]` | `uat.py` | normal entry point; default out `./uat-out/<slug>-<ts>` |
| `npm install && npx playwright install chromium` | `README.md` | only if not reusing an install via `UAT_NODE_MODULES` |

`uat.py` parses nothing but `--out`: `--help` is treated as a URL (and writes a `uat-out/` dir).
Run it with no arguments to print usage.

**Smoke test (run before claiming it works):**

```sh
python3 -m http.server PORT --bind 127.0.0.1 --directory fixtures
UAT_NODE_MODULES=<existing node_modules with @playwright/test + axe-core> \
  python3 uat.py http://127.0.0.1:PORT/sample.html --out <dir under runs/ or outside the repo>
```

Expect exit 0, `findings.json` + `report.md`, undersized targets flagged (`"level": "problem"` in
`findings.json`, `PROBLEM` in `report.md`), and read-only notes (`would have sent: POST …`).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `UAT_NODE_MODULES` | unset | Path to an existing `node_modules` containing `@playwright/test` and `axe-core`. Resolution order: this → `./node_modules` in this repo → bare `require`. |
| `UAT_READONLY` | `1` (on) | `1`/unset: every non-GET HTTP request is aborted at the network layer and recorded as a `note` (`would have sent: POST /api/thing`); service workers are blocked and WebSocket messages are dropped. This blocks **HTTP methods/channels, not server mutation** — a GET endpoint with side effects still runs. Stated loudly in stderr and in the report header. `0`: real writes are allowed. |
| `UAT_CONTRACT_MAP` | `./contract-map.json` | JSON file mapping axe rule ids → plain-words contract clauses. Unmapped rules fall back to `general accessibility (no contract clause mapped for this rule)`. An explicitly-set-but-broken path is a hard stop; a missing default file just degrades. |
| `UAT_TOKEN` | unset | Optional bearer token for a walkthrough of a live, authenticated app, sent as `Authorization: Bearer …`. **Environment-only** — never written to a config, never echoed. The token is bound to an explicit scheme/host/port allowlist (see `UAT_AUTH_ORIGINS`): it is attached per-request only to the target origin, and is stripped from off-origin subresources and never sent on off-origin navigation. The driver redacts it from every artifact, **including the trace zips**, as part of finalization before the output directory is publishable. Unset means the page is visited unauthenticated. |
| `UAT_AUTH_ORIGINS` | unset | Extra approved origins for `UAT_TOKEN`, comma-separated (e.g. `https://api.example.test:8443`). Only used when `UAT_TOKEN` is set. The target URL's own origin is always included; anything not listed gets no credential. A malformed entry is a hard stop. Redirects are followed hop-by-hop with the allowlist re-checked at each hop, so an authenticated request can never be redirected off the approved origins. |
| `UAT_MAX_ELEMENTS` | `20` | Max interactive elements exercised per pass, per viewport. Exceeding it reports **PARTIAL COVERAGE** explicitly instead of silently truncating. |
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

**Finalization (E03):** the driver writes everything into a hidden `<out>/.staging/` directory
first, redacts any bearer token from plain files **and from inside the trace ZIPs**, and only then
promotes the artifacts to their real names. There is exactly one path that produces publishable
artifacts and it always redacts; a scrub failure withholds the whole run (fail closed) and exits
non-zero. A timed-out or crashed run leaves at most the hidden staging directory, which is not
uploaded (and the Python wrapper removes it on timeout).

## Tests

```sh
npm run test:unit     # browser-free: origin-allowlist decisions, redaction, finalization
npm run test:browser  # Playwright fixtures: E01 token scoping, E02 read-only policy, E03 redaction
npm test              # both
```

The fixtures use obviously-fake canary tokens and disposable `127.0.0.1` servers only. E01 runs both
a desktop and an iPhone-13 context and proves an off-origin resource, link, redirect hop and popup
never receive the token while the approved origin still authenticates. E02 proves a mutating GET
still runs, service workers are blocked, and a WebSocket write is dropped but recorded. E03 proves
direct-driver, failed and timed-out runs leave no token in plain files or trace ZIP entries and
publish nothing on a scrub failure. CI (`.github/workflows/ci.yml`) runs both suites on every
push/PR.

## Where this fits

| Situation | Use |
| --- | --- |
| A repo with its own Playwright suite | **That suite is still the gate for that repo.** Run it (build first, every time) before saying that repo's change works. |
| Any surface with a URL and **no** dedicated suite | This driver: `python3 uat.py <url>` |
| "Does the deployed instance still make sense" | A read-only walkthrough suite with real auth, if the repo has one |
| A flow someone has clicked through once by hand | Playwright's recorder (`npx playwright codegen <url>`) turns that one walkthrough into a permanent test — worth doing for the flows that matter most |

The driver is the general-purpose one: point it at anything with a URL and no dedicated suite. It is
evidence-gathering, not a gate — findings never fail the run, and a clean run is not proof there is
nothing left to find. Open a trace or a screenshot before calling a page done.

## Templates

- [`contracts/personas/`](../contracts/personas/README.md) — one-line persona cards
- [`contracts/journeys/`](../contracts/journeys/README.md) — jobs-to-be-done
- [`contracts/acceptance/`](../contracts/acceptance/README.md) — symbolised triples, assertion
  vocabulary only, **no free-text verdicts**

## Why the load-bearing rules are the way they are

Each heading is the rule in `AGENTS.md`, with the reasoning that keeps it from being "simplified"
later. The rules themselves stay in `AGENTS.md`, verbatim; the lines quoted here are the ones that
were too long for that file and are carried word-for-word.

**Rule 1 — read the driver's comments.** `uat_driver.cjs` carries two hard-won comments (the
mouse-coordinate lesson and the navigation/re-inventory lesson) explaining why the code is shaped
this way.

**Rule 2 — navigation and re-inventory.** Lose `scrollIntoViewIfNeeded()` + a fresh `boundingBox()`,
the `domcontentloaded` goto, or the fresh inventory and every element after the first real navigation
silently looks "dead" — the tool lying, not the site.

**Rule 3 — redaction inside the driver, before promotion.** Playwright traces record request headers,
so the token is exactly what CI would upload; GitHub masks logs, not uploaded files. A scrub failure
must withhold everything (fail closed). `redact_artifacts()` in `uat.py` stays as defence in depth,
not as the primary guard. Found by a canary test; load-bearing like rule 2.

**Rule 8 — CDP `Fetch`, not `context.route`.** Playwright's route handler is NOT invoked for redirect
hops (measured: a 302 to an off-origin host followed with the Authorization header still attached).
`lib/netpolicy.cjs` uses a raw CDP `Fetch.requestPaused` session so the allowlist is re-checked at
every hop, and an off-allowlist hop is failed rather than followed. This is Chromium-only (the
driver's browser); await the returned `attachPage(page)` before a page's first navigation.

**Finalization (E03) — one publishable path.** The driver stages into `<out>/.staging/`, redacts,
then promotes. Do not point an artifact uploader at `.staging/`.

## Verification status of this page

**UNKNOWN.** This page was moved out of `AGENTS.md` on 2026-10-09 without a Node runtime available on
the machine doing the move, so no command was run against the tables above. Before relying on any
row, check it yourself: `npm run check` and `npm test`. Anything the tables claim about behaviour is
a restatement of what `AGENTS.md` said on 2026-10-09, not something re-verified.