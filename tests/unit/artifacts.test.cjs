// Browser-free unit tests for E03 staging + finalization (fail closed).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { finalizeArtifacts, stageDirFor, STAGE_DIRNAME } = require("../../lib/artifacts.cjs");
const { redactArtifacts } = require("../../lib/redact.cjs");

const CANARY = "CANARY-finalize-xyz789";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `uat-final-${tag}-`));
}

test("staging is a hidden directory under the output dir", () => {
  const out = tmpDir("stage");
  assert.equal(stageDirFor(out), path.join(out, STAGE_DIRNAME));
  assert.ok(STAGE_DIRNAME.startsWith("."), "staging must be hidden so uploaders skip it by default");
  fs.rmSync(out, { recursive: true, force: true });
});

test("incomplete artifacts are not publishable before finalization", () => {
  const out = tmpDir("before");
  const stage = stageDirFor(out);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "findings.json"), "{}");
  fs.writeFileSync(path.join(stage, "trace-desktop.zip"), "placeholder");
  // Nothing at the real names yet.
  assert.ok(!fs.existsSync(path.join(out, "findings.json")));
  assert.ok(!fs.existsSync(path.join(out, "trace-desktop.zip")));
  fs.rmSync(out, { recursive: true, force: true });
});

test("finalizeArtifacts redacts then promotes, and removes staging", () => {
  const out = tmpDir("promote");
  const stage = stageDirFor(out);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "findings.json"), CANARY);
  const stats = finalizeArtifacts(out, CANARY, { stageDir: stage });
  assert.equal(stats.changed, 1);
  assert.ok(fs.existsSync(path.join(out, "findings.json")));
  assert.ok(!fs.readFileSync(path.join(out, "findings.json"), "utf8").includes(CANARY));
  assert.ok(!fs.existsSync(stage), "staging is removed after promotion");
  fs.rmSync(out, { recursive: true, force: true });
});

test("finalizeArtifacts fails closed: a scrub error withholds everything", () => {
  const out = tmpDir("fail");
  const stage = stageDirFor(out);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "trace-desktop.zip"), CANARY);
  assert.throws(
    () => finalizeArtifacts(out, CANARY, { stageDir: stage, redact: () => { throw new Error("scrub exploded"); } }),
    /scrub exploded/,
  );
  assert.ok(!fs.existsSync(stage), "unredacted staging is deleted on failure");
  assert.deepEqual(fs.readdirSync(out), [], "nothing is promoted on failure");
  fs.rmSync(out, { recursive: true, force: true });
});

test("finalizeArtifacts end to end with the real redactor", () => {
  const out = tmpDir("real");
  const stage = stageDirFor(out);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "report.md"), `token=${CANARY}`);
  const stats = finalizeArtifacts(out, CANARY, { stageDir: stage, redact: redactArtifacts });
  assert.equal(stats.changed, 1);
  assert.ok(!fs.readFileSync(path.join(out, "report.md"), "utf8").includes(CANARY));
  fs.rmSync(out, { recursive: true, force: true });
});
