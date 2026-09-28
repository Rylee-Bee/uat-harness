"""Drive a real browser at a page and report usability/accessibility findings in plain words.

    python3 uat.py URL [URL ...]      # one report per URL
    python3 uat.py URL --out DIR      # write artifacts under DIR (default: ./uat-out/<slug>)

For every URL it loads the real page in headless Chromium and:
  - records console errors, failed requests, and images that fail to load
  - inventories buttons/links/inputs and interacts with EVERY one for real: a real mouse
    move+down+up at the element's own rendered coordinates (desktop), and a real
    page.touchscreen.tap on a real mobile emulation (iPhone 13) -- not locator.click()'s
    synthetic shortcut -- then checks whether anything actually changed (URL or DOM), and
    flags any hit area under the 44x44 CSS px accessibility minimum before it even taps
  - finds real <form> elements, types into text fields with real keystrokes, picks real
    select/checkbox/radio values, and clicks the real submit control
  - runs axe-core against the page (both passes) and maps violations to the contract
    clauses named in contract-map.json (or $UAT_CONTRACT_MAP -- generic labels, no
    dependency on any other repo's document)
  - records a Playwright trace (trace-desktop.zip / trace-mobile.zip, open with
    `npx playwright show-trace <file>`) and a video for each pass, plus full-page
    screenshots, so a human can watch what actually happened instead of trusting a
    text summary alone
  - writes two reports next to the artifacts: findings.json (machine-readable) and
    report.md (run metadata, PROBLEM/note findings grouped, and what the check does
    NOT prove)

Configuration (environment variables; see README.md for the full table):
  UAT_NODE_MODULES   path to an existing node_modules with @playwright/test + axe-core
                     (otherwise ./node_modules in this repo, otherwise a bare require)
  UAT_READONLY       unset or 1 (default) = read-only: every non-GET request is aborted
                     in the browser and recorded as a finding ("would have sent: POST
                     /api/thing"); 0 = real writes are allowed
  UAT_CONTRACT_MAP   path to a JSON axe-rule -> contract-clause map
                     (otherwise ./contract-map.json next to the driver)
  UAT_MAX_ELEMENTS   max interactive elements exercised per pass per viewport (default 20)
  UAT_TOKEN          optional bearer token for a live, authenticated app, sent as
                     `Authorization: Bearer ...`. Environment-only: never written to a
                     config, never echoed. Playwright traces DO record request headers,
                     so this wrapper rewrites every artifact (including the trace zips)
                     to redact it before the directory can be read or uploaded.

This is a thin Python wrapper (house style: absolute paths, quiet stops say why) around
uat_driver.cjs, which does the actual Playwright work in Node -- there is no Python
Playwright package assumed here, and this script does not add one.

Exit code is 1 only if a URL could not be reached at all (browser launch failure, page
never loaded, dependencies unresolvable). Findings ("problem" / "note") are always
reported, never turned into a silent pass/fail -- read the report.

NOTE: this really clicks, types into, and submits forms on whatever URL you give it.
Point it at a local dev server or a built static site, never at a page you can't afford
to be clicked on for real (e.g. a production form that emails someone, a live payment
flow). Read-only mode (the default) stops the *requests* those clicks cause from leaving
the browser, but the clicks, typing and navigation are still real -- UAT_READONLY=0
turns the guard off entirely, so only use that against something you can mutate.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
DRIVER = HERE / "uat_driver.cjs"
OUT_ROOT = HERE / "uat-out"

REDACTED = b"[REDACTED]"
# Belt and braces: scrub any bearer credential by shape, not only the value we
# were handed. Catches a token that arrived by another route too.
BEARER_RE = re.compile(rb"(?i)bearer\s+[a-z0-9._~+/=-]{8,}")


def redact_artifacts(out_dir: Path, secret: str) -> int:
    """Scrub a bearer credential out of every artifact under out_dir.

    WHY THIS EXISTS (found by a canary test, not by inspection): Playwright
    tracing records request headers, so a token sent as `Authorization: Bearer
    ...` lands inside trace-*.zip -- specifically trace.network and trace.trace.
    Those zips are exactly what CI uploads as artifacts, and GitHub masks
    secrets in logs but NOT in uploaded files. So the wrapper scrubs them
    before anyone can read the directory.

    Handles both plain files and zip entries (traces are zips). Returns the
    number of files changed.
    """
    if not secret:
        return 0
    secret_b = secret.encode("utf-8", "surrogateescape")

    def scrub(data: bytes) -> bytes:
        data = data.replace(secret_b, REDACTED)
        return BEARER_RE.sub(b"Bearer " + REDACTED, data)

    touched = 0
    for path in sorted(out_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix == ".zip":
            try:
                with zipfile.ZipFile(path) as zin:
                    entries = [(info, zin.read(info.filename)) for info in zin.infolist()]
            except zipfile.BadZipFile:
                continue
            changed = False
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
                for info, data in entries:
                    new = scrub(data)
                    changed = changed or (new != data)
                    zout.writestr(info, new)
            if changed:
                touched += 1
        else:
            try:
                data = path.read_bytes()
            except OSError:
                continue
            new = scrub(data)
            if new != data:
                path.write_bytes(new)
                touched += 1
    return touched


def slug(url: str) -> str:
    s = url.lower().split("://", 1)[-1]
    return "".join(c if c.isalnum() else "-" for c in s).strip("-")[:80] or "page"


def run_one(url: str, out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    node = shutil.which("node")
    if not node:
        print(f"uat: 'node' not found on PATH -- can't drive a browser without it.", file=sys.stderr)
        return 1
    if not DRIVER.exists():
        print(f"uat: driver missing at {DRIVER} -- was uat_driver.cjs deleted or moved?", file=sys.stderr)
        return 1
    try:
        proc = subprocess.run([node, str(DRIVER), url, str(out_dir)], capture_output=True, text=True, timeout=420)
    except subprocess.TimeoutExpired:
        scrubbed = redact_artifacts(out_dir, os.environ.get("UAT_TOKEN", ""))
        if scrubbed:
            print(f"uat: redacted the bearer token from {scrubbed} artifact(s) after the timeout.", file=sys.stderr)
        print(f"uat: {url}: driver did not finish within 420s -- a very content-heavy page (many "
              f"interactive elements, two full axe-core scans) can legitimately take 2-3 minutes; "
              f"if this keeps happening, lower UAT_MAX_ELEMENTS (env, default 20) or check for a real hang.",
              file=sys.stderr)
        return 1
    # Artifacts are complete now -- scrub any credential out of them before
    # anything (including a CI artifact upload) can read this directory.
    scrubbed = redact_artifacts(out_dir, os.environ.get("UAT_TOKEN", ""))
    stdout_lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    if not stdout_lines:
        print(f"uat: {url}: driver produced no report -- stderr:\n{proc.stderr.strip()[-2000:]}", file=sys.stderr)
        return 1
    try:
        report = json.loads(stdout_lines[-1])
    except json.JSONDecodeError:
        print(f"uat: {url}: driver output wasn't valid JSON -- stderr:\n{proc.stderr.strip()[-2000:]}", file=sys.stderr)
        return 1

    print(f"\n=== {url} ===")
    if not report.get("ok", False):
        print(f"  COULD NOT COMPLETE: {report.get('reason', 'unknown reason')}")
        return 1
    findings = report.get("findings", [])
    counts = report.get("counts", {})
    coverage = report.get("coverage", {})
    ro = report.get("readOnly", {})
    problems = [f for f in findings if f["level"] == "problem"]
    notes = [f for f in findings if f["level"] == "note"]
    if ro.get("on", False):
        print(f"  READ-ONLY MODE ON: {ro.get('blockedWrites', 0)} non-GET request(s) blocked in the browser "
              f"-- nothing was written to the target (UAT_READONLY=0 allows real writes)")
    else:
        print("  read-only OFF (UAT_READONLY=0): real writes were allowed and may have reached the target")
    print(f"  real mouse clicks tried: {counts.get('mouseClicksTried', 0)} | real touch taps tried: {counts.get('touchTapsTried', 0)} "
          f"| forms filled: {counts.get('formsFilled', 0)} | undersized (<44px) targets: {counts.get('undersizedTargets', 0)}")
    if coverage.get("partial"):
        print(f"  PARTIAL COVERAGE: {coverage.get('found', 0)} visible interactive elements found, only the first "
              f"{coverage.get('exercised', 0)} exercised per pass (raise UAT_MAX_ELEMENTS)")
    if scrubbed:
        print(f"  secrets: bearer token redacted from {scrubbed} artifact(s) -- including inside the trace zips")
    print(f"  report: {out_dir / 'report.md'} , {out_dir / 'findings.json'}")
    print(f"  screenshots: {out_dir / 'desktop.png'} , {out_dir / 'mobile.png'}")
    print(f"  traces (open with `npx playwright show-trace <file>`): {out_dir / 'trace-desktop.zip'} , {out_dir / 'trace-mobile.zip'}")
    if report.get("videos", {}).get("desktop") or report.get("videos", {}).get("mobile"):
        print(f"  videos: {report.get('videos')}")
    if not findings:
        print("  no findings -- but see the trace/video before calling this page done; the check is not exhaustive.")
    for f in problems:
        c = f" [{f['contract']}]" if f.get("contract") else ""
        print(f"  PROBLEM  {f['where']}: {f['what']}{c}")
    for f in notes:
        c = f" [{f['contract']}]" if f.get("contract") else ""
        print(f"  note     {f['where']}: {f['what']}{c}")
    return 0  # findings never fail the run; only an unreachable page does (handled above)


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 0
    out_arg = None
    if "--out" in argv:
        i = argv.index("--out")
        out_arg = Path(argv[i + 1])
        del argv[i:i + 2]
    urls = argv
    worst = 0
    for url in urls:
        out_dir = out_arg if (out_arg and len(urls) == 1) else (out_arg / slug(url) if out_arg else OUT_ROOT / f"{slug(url)}-{int(time.time())}")
        worst = max(worst, run_one(url, out_dir))
    return worst


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
