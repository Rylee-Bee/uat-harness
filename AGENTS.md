# AGENTS.md — uat-harness

A general-purpose real-browser UAT driver: point it at any URL and it clicks, taps and types for
real (Playwright), runs axe-core, and writes findings a human reads. **Public repo**
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
| `package.json` | Scripts `uat`, `check`; deps | rarely |
| `README.md` | User docs: env vars, outputs, where this fits | keep in sync with behaviour |
| `uat-out/`, `runs/` | Run output (gitignored): screenshots, traces, videos, reports | to review a run; never commit |

No tests, no CI workflow and no lockfile exist in this repo today.

## Commands

| Command | Defined in | Notes |
| --- | --- | --- |
| `npm run check` | `package.json` | `node --check uat_driver.cjs` — syntax only, **not** the smoke test |
| `npm run uat -- URL OUTDIR` | `package.json` | driver directly, skips the redaction wrapper |
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

## Boundaries

- **Consumers:** other estate frontends, by direct package install or through `ci-harness`'s
  `reusable-uat.yml`. That workflow runs a caller-supplied command (it does not install this
  repo), exports `UAT_READONLY`, `UAT_TOKEN` and `UAT_URL`, and uploads `uat-out/` by default.
  This repo does not read `UAT_URL` (URLs are CLI args). Changing CLI args, env var names, the
  `uat-out/` default, output file names or the `findings.json` shape breaks consumers: update
  README and record the companion change for `ci-harness` rather than editing it from here.
- **Duplicates elsewhere:** an older copy of `uat.py` / `uat_driver.cjs` lives in `hive-works`.
  Retiring it is that repo owner's call; do not edit it from here.
- **Design brief:** the estate root's `docs/guides/agent-driven-uat.md` and decision
  `docs/decisions/uat-harness-shared-home-2026-09-28.md` (outside this repo; link, don't copy).

## Needs Rylee's approval here

Pushing (the repo is public — a push publishes), changing visibility, adding telemetry or any
network call beyond the target URL. General gates: the estate constitution.

## Done means

`npm run check` passes **and** the smoke test above ran with the expected findings; for
behaviour changes, open `report.md` (and a screenshot or trace) and quote what changed. README
updated if env vars, outputs or commands changed. Handoff state goes to Project Home (there is
no in-repo `.agent/`).
