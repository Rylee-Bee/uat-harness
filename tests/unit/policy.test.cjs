// Browser-free unit tests for the E01 origin-allowlist decisions.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOrigin,
  isApprovedOrigin,
  buildAuthAllowlist,
  decideRequest,
  safePath,
} = require("../../lib/policy.cjs");

test("normalizeOrigin fills scheme-default ports and lowercases the host", () => {
  assert.equal(normalizeOrigin("http://Example.TEST"), "http://example.test:80");
  assert.equal(normalizeOrigin("http://Example.TEST:80"), "http://example.test:80");
  assert.equal(normalizeOrigin("https://Example.TEST"), "https://example.test:443");
  assert.equal(normalizeOrigin("https://example.test:8443/path?q=1#f"), "https://example.test:8443");
});

test("normalizeOrigin rejects non-http(s) and malformed inputs", () => {
  for (const bad of ["data:text/plain,hi", "blob:http://example.test/x", "ws://example.test", "file:///etc/hosts", "not a url", ""]) {
    assert.equal(normalizeOrigin(bad), null, `${bad} should not normalise`);
  }
});

test("isApprovedOrigin matches exact scheme/host/port and ignores path", () => {
  const allow = ["http://127.0.0.1:8080"];
  assert.equal(isApprovedOrigin("http://127.0.0.1:8080/page?x=1", allow), true);
  assert.equal(isApprovedOrigin("http://127.0.0.1:8080", allow), true);
});

test("isApprovedOrigin is port-, host- and scheme-sensitive", () => {
  const allow = ["http://127.0.0.1:8080"];
  assert.equal(isApprovedOrigin("http://127.0.0.1:8081/page", allow), false, "different port");
  assert.equal(isApprovedOrigin("http://127.0.0.2:8080/page", allow), false, "different host");
  assert.equal(isApprovedOrigin("https://127.0.0.1:8080/page", allow), false, "different scheme");
  assert.equal(isApprovedOrigin("http://sub.127.0.0.1:8080/page", allow), false, "subdomain is not the origin");
});

test("isApprovedOrigin normalises the default port", () => {
  assert.equal(isApprovedOrigin("http://example.test", ["http://example.test:80"]), true);
  assert.equal(isApprovedOrigin("https://example.test:443", ["https://example.test"]), true);
});

test("buildAuthAllowlist includes the target origin plus extras, deduped", () => {
  const list = buildAuthAllowlist("http://127.0.0.1:3000/app", "https://api.test:8443, http://127.0.0.1:3000");
  assert.deepEqual(list, ["http://127.0.0.1:3000", "https://api.test:8443"]);
});

test("buildAuthAllowlist rejects a malformed extra origin", () => {
  assert.throws(() => buildAuthAllowlist("http://127.0.0.1:3000", "not-a-url"), /not a valid http\(s\) origin/);
});

test("decideRequest aborts non-GET in read-only mode", () => {
  const d = decideRequest({ url: "http://app.test/x", method: "POST", isNavigation: false, allowlist: ["http://app.test"], authConfigured: true, readOnly: true });
  assert.equal(d.action, "abort");
  assert.match(d.reason, /read-only/);
  assert.equal(d.credential, false);
});

test("decideRequest attaches the credential only to an approved origin", () => {
  const approved = decideRequest({ url: "http://app.test/api", method: "GET", allowlist: ["http://app.test"], authConfigured: true, readOnly: true });
  assert.equal(approved.action, "continue");
  assert.equal(approved.credential, true);

  const offOrigin = decideRequest({ url: "http://evil.test/x", method: "GET", allowlist: ["http://app.test"], authConfigured: true, readOnly: true });
  assert.equal(offOrigin.action, "continue");
  assert.equal(offOrigin.credential, false);
  assert.equal(offOrigin.stripAuth, true);
});

test("decideRequest aborts an authenticated navigation that leaves the allowlist", () => {
  const d = decideRequest({ url: "http://evil.test/landing", method: "GET", isNavigation: true, allowlist: ["http://app.test"], authConfigured: true, readOnly: true });
  assert.equal(d.action, "abort");
  assert.match(d.reason, /navigation/);
});

test("decideRequest allows writes when read-only is off, still scoping auth", () => {
  const d = decideRequest({ url: "http://app.test/x", method: "POST", allowlist: ["http://app.test"], authConfigured: true, readOnly: false });
  assert.equal(d.action, "continue");
  assert.equal(d.credential, true);
  const off = decideRequest({ url: "http://evil.test/x", method: "POST", allowlist: ["http://app.test"], authConfigured: true, readOnly: false });
  assert.equal(off.action, "continue");
  assert.equal(off.credential, false);
});

test("decideRequest with no token never sets a credential", () => {
  const d = decideRequest({ url: "http://app.test/x", method: "GET", allowlist: ["http://app.test"], authConfigured: false, readOnly: true });
  assert.equal(d.credential, false);
});

test("safePath drops query strings so a secret in a URL never reaches a log", () => {
  assert.equal(safePath("http://app.test/api?token=secret-value#frag"), "http://app.test/api");
  assert.equal(safePath("::::not a url"), "(unparseable url)");
});
