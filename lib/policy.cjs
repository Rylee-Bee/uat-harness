// Pure request/credential policy for the UAT driver. No Playwright, no I/O --
// deliberately requireable from a unit test so the security decisions can be
// proven without launching a browser.
//
// E01 context: a bearer token must never be context-wide. Playwright's
// context-level `extraHTTPHeaders` applies to EVERY request a page makes, with
// no origin restriction, so an off-origin image, link, popup or redirect hop
// would become a credential recipient. These functions bind the credential to
// an explicit scheme/host/port allowlist and are the single place that decides
// whether a request may carry it.
"use strict";

const WEB_SCHEMES = new Set(["http:", "https:"]);

// Normalise any URL/origin string to a canonical `scheme//host:port` key, with
// scheme-default ports filled in. Returns null for anything that is not a
// plain http(s) origin (data:, blob:, file:, ws:, garbage) -- opaque schemes
// are never approved.
function normalizeOrigin(input) {
  let u;
  try {
    u = new URL(String(input));
  } catch (_) {
    return null;
  }
  const scheme = u.protocol.toLowerCase();
  if (!WEB_SCHEMES.has(scheme)) return null;
  if (!u.hostname) return null;
  const port = u.port ? String(Number(u.port)) : scheme === "https:" ? "443" : "80";
  return `${scheme}//${u.hostname.toLowerCase()}:${port}`;
}

// Exact scheme+host+port match. Path, query and fragment are irrelevant: two
// URLs are "same origin" only when all three authority components agree. A
// missing port normalises to the scheme default, so http://host and
// http://host:80 are the same origin while http://host:3000 is not.
function isApprovedOrigin(url, allowlist) {
  const target = normalizeOrigin(url);
  if (!target) return false;
  for (const entry of allowlist || []) {
    if (normalizeOrigin(entry) === target) return true;
  }
  return false;
}

// Build the allowlist: the target URL's own origin, plus any explicitly
// configured extra origins (comma-separated `UAT_AUTH_ORIGINS`). An extra
// entry that is not a valid http(s) origin is a configuration error and throws
// -- better to stop than to silently send a token somewhere unapproved.
function buildAuthAllowlist(targetUrl, extraRaw) {
  const list = [];
  const main = normalizeOrigin(targetUrl);
  if (main) list.push(main);
  const extras = Array.isArray(extraRaw) ? extraRaw : String(extraRaw || "").split(",");
  for (const raw of extras) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    const normalised = normalizeOrigin(trimmed);
    if (!normalised) throw new Error(`UAT_AUTH_ORIGINS entry is not a valid http(s) origin: ${trimmed}`);
    list.push(normalised);
  }
  return Array.from(new Set(list));
}

// Strip a secret-bearing query string before it is written to any log. The
// path alone is enough to attribute a block; the token never belongs in stderr.
function safePath(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return "(unparseable url)";
  }
}

// The single decision point for one request. Returns:
//   action:     "continue" | "abort"
//   credential: true only for an approved-origin request while authenticated
//   stripAuth:  true when any inherited Authorization header must be removed
//   reason:     human-readable explanation for the block/record
//
// Read-only mode blocks non-GET HTTP methods regardless of origin. When a
// credential is configured, an off-origin NAVIGATION is aborted (the driver
// refuses to follow an authenticated link/popup/redirect somewhere unapproved
// rather than trusting the page), and an off-origin subresource continues with
// the credential stripped.
function decideRequest({ url, method = "GET", isNavigation = false, allowlist = [], authConfigured = false, readOnly = true }) {
  const m = String(method).toUpperCase();
  if (readOnly && m !== "GET") {
    return { action: "abort", credential: false, stripAuth: false, reason: `read-only: ${m} HTTP method blocked` };
  }
  const approved = isApprovedOrigin(url, allowlist);
  if (authConfigured && !approved) {
    if (isNavigation) {
      return { action: "abort", credential: false, stripAuth: false, reason: "auth: navigation would leave the approved origin set" };
    }
    return { action: "continue", credential: false, stripAuth: true, reason: "auth: off-origin request -- credential stripped" };
  }
  return {
    action: "continue",
    credential: authConfigured && approved,
    stripAuth: !approved,
    reason: approved ? "approved origin" : "unauthenticated origin",
  };
}

module.exports = { normalizeOrigin, isApprovedOrigin, buildAuthAllowlist, safePath, decideRequest };
