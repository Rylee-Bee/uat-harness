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
| `uat_driver.cjs` | All Playwright work: dep resolution, inventory, real mouse/touch/typing, axe, report | yes, for any behaviour change |
| `uat.py` | Thin wrapper: runs the driver, **redacts `UAT_TOKEN` from every artifact incl. trace zips**, prints summary | yes |
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

Expect exit 0, `findings.json` + `report.md`, undersized targets flagged as `PROBLEM`, and
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
3. **Keep `redact_artifacts()` in `uat.py`.** Playwright traces record request headers, so a
   bearer token lands inside `trace-*.zip` — exactly what CI uploads. GitHub masks logs, not
   uploaded files. Found by a canary test; load-bearing like rule 2.
4. **Findings are never pass/fail.** Only an unreachable page (or unresolvable deps) exits
   non-zero. Do not add a threshold that turns findings into an exit code.
5. **Read-only stays the default** (`UAT_READONLY` unset/1 aborts every non-GET). Never point
   this at live mutating endpoints; `UAT_READONLY=0` only for targets you may mutate.
6. **`@playwright/test` and `axe-core` stay in `dependencies`, not `devDependencies`** —
   consumers install this repo as a package (`npm install github:Rylee-Bee/uat-harness`), and
   npm skips a dependency's devDependencies.
7. **Public-safe tracked files.** No secrets, tokens, hostnames, real ports, LAN IPs, deployment
   topology, or absolute machine paths. Examples use `http://127.0.0.1:PORT/...` literally;
   document environment variables instead of paths. Never commit a run directory.

## Boundaries

- **Consumers:** other estate frontends, via `ci-harness` (planned; no workflow references this
  repo yet) or a direct package install. Changing CLI args, env var names, output file names or
  the `findings.json` shape breaks consumers — update README and record the companion change.
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
