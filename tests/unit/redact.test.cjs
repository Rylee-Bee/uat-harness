// Browser-free unit tests for E03 in-driver artifact redaction.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { redactArtifacts, scrubBuffer, REDACTED } = require("../../lib/redact.cjs");

const CANARY = "CANARY-redact-abc123";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `uat-redact-${tag}-`));
}

test("scrubBuffer redacts the exact secret and any bearer-shaped value", () => {
  const out = scrubBuffer(Buffer.from(`x ${CANARY} y Authorization: Bearer ${CANARY} z`), CANARY).toString("utf8");
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes(CANARY));
  assert.ok(!/Bearer CANARY/.test(out));
});

test("redactArtifacts scrubs plain files and ZIP entries", () => {
  const dir = tmpDir("both");
  fs.writeFileSync(path.join(dir, "findings.json"), `{"note":"${CANARY}"}`);
  const zip = new AdmZip();
  zip.addFile("trace.network", Buffer.from(`{"headers":{"authorization":"Bearer ${CANARY}"}}`));
  zip.addFile("trace.trace", Buffer.from("unrelated entry stays put"));
  zip.writeZip(path.join(dir, "trace-desktop.zip"));

  const stats = redactArtifacts(dir, CANARY);
  assert.equal(stats.changed, 2);
  assert.ok(!fs.readFileSync(path.join(dir, "findings.json"), "utf8").includes(CANARY));

  const out = new AdmZip(path.join(dir, "trace-desktop.zip"));
  const names = out.getEntries().map((e) => e.entryName);
  assert.deepEqual(names, ["trace.network", "trace.trace"], "entry names are preserved");
  assert.ok(!out.readAsText("trace.network").includes(CANARY));
  assert.equal(out.readAsText("trace.trace"), "unrelated entry stays put");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("redactArtifacts is idempotent and reports a second pass as unchanged", () => {
  const dir = tmpDir("idem");
  fs.writeFileSync(path.join(dir, "a.txt"), CANARY);
  assert.equal(redactArtifacts(dir, CANARY).changed, 1);
  assert.equal(redactArtifacts(dir, CANARY).changed, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("redactArtifacts with no secret is a no-op", () => {
  const dir = tmpDir("nosecret");
  fs.writeFileSync(path.join(dir, "a.txt"), CANARY);
  const stats = redactArtifacts(dir, "");
  assert.deepEqual(stats, { scanned: 0, changed: 0 });
  assert.ok(fs.readFileSync(path.join(dir, "a.txt"), "utf8").includes(CANARY));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("redactArtifacts fails closed on an unreadable/corrupt ZIP", () => {
  const dir = tmpDir("corrupt");
  fs.writeFileSync(path.join(dir, "trace-x.zip"), Buffer.from("PK\x03\x04 this is not a zip"));
  assert.throws(() => redactArtifacts(dir, CANARY), /cannot open zip trace-x\.zip/);
  fs.rmSync(dir, { recursive: true, force: true });
});
