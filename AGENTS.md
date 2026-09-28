# AGENTS.md — uat-harness

Rules for agents working in this repo.

1. **Read the driver's comments before touching click/navigation logic.** `uat_driver.cjs` carries
   two load-bearing, hard-won comments (the mouse-coordinate lesson and the navigation/re-inventory
   lesson). They explain *why* the code is shaped the way it is.
2. **Never remove `scrollIntoViewIfNeeded()` + a fresh `boundingBox()` before each click/tap**, and
   **never replace the `page.goto(url, {waitUntil:"domcontentloaded"})` return-to-page with
   `page.goBack()`**, and **never re-run the element inventory only once** (fresh every iteration).
   If either fix goes, every element after the first real navigation silently looks broken — the
   tool starts lying about "dead" buttons. That is this tool failing, not the site.

   **Never remove `redact_artifacts()` from `uat.py`.** Playwright tracing records request
   headers, so a bearer token sent as `Authorization: Bearer …` lands inside `trace-*.zip`
   (`trace.network`, `trace.trace`) — which is exactly what CI uploads as an artifact. GitHub
   masks secrets in logs, not in uploaded files. This was found by a canary test, not by reading
   the code; it is load-bearing in the same way as the two fixes above.
3. **Findings are never pass/fail.** Only an unreachable page (or unresolvable deps) exits
   non-zero. Do not add a threshold that turns findings into an exit code.
4. **Run the smoke test before claiming it works:** serve `fixtures/` with
   `python3 -m http.server PORT --directory fixtures`, then
   `UAT_NODE_MODULES=<existing node_modules> python3 uat.py http://127.0.0.1:PORT/sample.html --out <dir>`
   and check `findings.json` + `report.md` (undersized target flagged as `problem`, read-only
   notes present). `npm run check` is a syntax check only — it is not the smoke test.
5. **No secrets, credentials, tokens, hostnames, real ports, LAN IPs, or deployment topology in
   any tracked file.** Examples use `http://127.0.0.1:PORT/...` literally. No absolute paths from
   a developer's machine — document environment variables instead.
6. **Do not point this at live mutating endpoints.** Read-only (`UAT_READONLY`, default on) is the
   default for a reason; `UAT_READONLY=0` is only for targets you are allowed to mutate.
7. **Git is the orchestrator's job here** unless told otherwise — this repo may be handed off
   untracked; don't init/commit/push on your own initiative.
