// E03: every path that produces artifacts -- direct driver, normal wrapper run,
// failed load, and a timeout -- must leave no canary token in plain files or
// ZIP entries, and an incomplete run must publish nothing.
"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REPO_ROOT, runDriver, runWrapper, scanForToken } = require("./helpers/run.cjs");
const { startStaticServer, startStallingServer } = require("./helpers/servers.cjs");

const CANARY = "CANARY-e03-token-7c1d-nt";

function outDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `uat-e03-${tag}-`));
}

test("E03 direct driver run: no canary token survives finalization", async () => {
  const app = await startStaticServer(path.join(REPO_ROOT, "fixtures"));
  const out = outDir("direct");
  const res = await runDriver(`${app.origin}/sample.html`, out, { UAT_TOKEN: CANARY, UAT_MAX_ELEMENTS: "2" });

  expect(res.status, `driver exited ${res.status}\n${res.stderr}`).toBe(0);
  expect(fs.existsSync(path.join(out, "trace-desktop.zip")), "trace should be published").toBe(true);
  expect(scanForToken(out, CANARY), "canary token found in published artifacts").toEqual([]);
  expect(fs.existsSync(path.join(out, ".staging")), "staging must be gone after finalization").toBe(false);

  const report = JSON.parse(fs.readFileSync(path.join(out, "findings.json"), "utf8"));
  expect(report.redaction && report.redaction.ok, "redaction should report success").toBe(true);
  app.close();
});

test("E03 failed direct run still redacts and publishes nothing unredacted", async () => {
  const out = outDir("failed");
  // Port 1 is closed, so the page never loads; the driver still stops tracing.
  const res = await runDriver("http://127.0.0.1:1/nope.html", out, { UAT_TOKEN: CANARY });
  expect(res.status).toBe(1);
  expect(scanForToken(out, CANARY)).toEqual([]);
  expect(fs.existsSync(path.join(out, ".staging"))).toBe(false);
});

test("E03 timeout: the wrapper withholds unredacted staging and fails closed", async () => {
  const slow = await startStallingServer();
  const out = outDir("timeout");
  const res = await runWrapper(`${slow.origin}/slow.html`, out, { UAT_TOKEN: CANARY, UAT_TIMEOUT: "5" });

  expect(res.status).toBe(1);
  expect(scanForToken(out, CANARY), "timed-out run leaked the canary").toEqual([]);
  expect(fs.existsSync(path.join(out, ".staging")), "unredacted staging must be withheld").toBe(false);
  expect(fs.existsSync(path.join(out, "findings.json")), "an incomplete run must publish nothing").toBe(false);
  slow.close();
});
