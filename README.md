# uat-harness

## What this is

The estate's user-acceptance driver and its contract map. Point it at a URL and it drives that page
for real in a real browser — clicking, tapping and typing — then tells you what changed, what broke
and what the accessibility scan says, in plain words.

## Is it running?

**UNKNOWN.** This README was rewritten without a Node runtime available, so no claim is made either
way. Check it yourself:

```sh
npm test
```

Anything other than a clean exit means it is not passing right now. A green suite is not a
substitute for the end-to-end smoke run in [`AGENTS.md`](AGENTS.md).

## How to use it

```sh
# Dependencies. Or skip this and point UAT_NODE_MODULES at a node_modules
# that already has @playwright/test, axe-core and adm-zip.
npm install && npx playwright install chromium

# Serve this repo's own smoke page.
python3 -m http.server PORT --bind 127.0.0.1 --directory fixtures

# Drive it.
python3 uat.py http://127.0.0.1:PORT/sample.html --out runs/smoke
```

That last command clicks, taps and types for real. Read-only mode is on by default: it blocks
non-GET HTTP requests, service workers and WebSocket messages, but **not** server mutation, so a
`GET` with side effects still runs. Never point it at a production form that emails someone, a live
payment flow, or anything you cannot afford to be clicked on for real.

## Where to read more

- [`AGENTS.md`](AGENTS.md) — the rules it keeps: read-only default, redaction before promotion,
  findings never gating. Commands, env vars, outputs and file map: [`docs/agent-reference.md`](docs/agent-reference.md).
- [`uat.py`](uat.py) — the entry point. Run it with no arguments for usage.
- [`contract-map.json`](contract-map.json) — axe-core rule ids mapped to plain-words contract
  clauses.