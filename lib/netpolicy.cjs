// Playwright glue that applies lib/policy.cjs to a browser context. Kept apart
// from the pure decisions so the latter stay unit-testable without a browser.
"use strict";

const { decideRequest, safePath } = require("./policy.cjs");

function stripAuthorization(headers) {
  let had = false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") {
      delete headers[key];
      had = true;
    }
  }
  return had;
}

// One context-level route that both enforces read-only and scopes the bearer
// token. `onBlock(entry)` receives { kind:"http", method, path, reason } for
// every blocked request so the driver can attribute it to the click that
// caused it. The token is attached ONLY here, per-request, for an approved
// origin -- never via `extraHTTPHeaders`, which would leak it everywhere.
async function installRequestPolicy(context, { allowlist = [], token = "", readOnly = true, onBlock } = {}) {
  const authConfigured = !!token;
  return context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const method = String(req.method() || "GET").toUpperCase();
    const isNavigation = typeof req.isNavigationRequest === "function" ? req.isNavigationRequest() : false;
    let decision;
    try {
      decision = decideRequest({ url, method, isNavigation, allowlist, authConfigured, readOnly });
    } catch (_) {
      return route.abort("failed");
    }
    if (decision.action === "abort") {
      if (onBlock) onBlock({ kind: "http", method, path: safePath(url), reason: decision.reason });
      return route.abort("aborted");
    }
    if (decision.credential) {
      const headers = Object.assign({}, req.headers());
      stripAuthorization(headers);
      headers["authorization"] = `Bearer ${token}`;
      return route.continue({ headers });
    }
    if (authConfigured) {
      const headers = Object.assign({}, req.headers());
      if (stripAuthorization(headers)) return route.continue({ headers });
    }
    return route.continue();
  });
}

// E02: WebSockets are not covered by context routing. In read-only mode this
// intercepts the handshake and never connects to the real server (no
// `connectToServer()`), so every page->server message is captured and dropped
// -- a write can be recorded but never forwarded. When read-only is off the
// route is not installed at all and WebSockets behave normally.
async function installWebSocketPolicy(context, { readOnly = true, onBlock } = {}) {
  if (!readOnly) return;
  return context.routeWebSocket("**/*", (ws) => {
    const path = safePath(ws.url());
    ws.onMessage((message) => {
      const bytes = Buffer.isBuffer(message) ? message.length : Buffer.byteLength(String(message));
      if (onBlock) onBlock({ kind: "websocket", method: "WS", path, bytes });
    });
  });
}

module.exports = { installRequestPolicy, installWebSocketPolicy };
