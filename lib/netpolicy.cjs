// Playwright glue that applies lib/policy.cjs to a browser context. Kept apart
// from the pure decisions so the latter stay unit-testable without a browser.
//
// Two implementations, one policy:
//
//  * Unauthenticated runs use context.route: it handles direct requests (abort
//    non-GET in read-only mode, allow GET) cheaply.
//
//  * Authenticated runs use a raw Chromium CDP `Fetch` session. This is the
//    only mechanism that sees REDIRECT HOPS: `context.route` invokes the handler
//    for the first request only, so a 302 from the approved origin to an
//    off-origin host was followed by the browser with the Authorization header
//    still attached (measured). CDP `Fetch.requestPaused` fires again for the
//    redirected request (with `redirectedRequestId`), so the allowlist is
//    re-evaluated at every hop and an off-allowlist hop is failed, not followed.
"use strict";

const { decideRequest, safePath } = require("./policy.cjs");

function withoutAuthorization(headers) {
  const out = Object.assign({}, headers);
  let had = false;
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "authorization") {
      delete out[key];
      had = true;
    }
  }
  return { headers: out, had };
}

async function installRouteRequestPolicy(context, { allowlist = [], token = "", readOnly = true, onBlock } = {}) {
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
      withoutAuthorization(headers);
      headers["authorization"] = `Bearer ${token}`;
      return route.continue({ headers });
    }
    const stripped = withoutAuthorization(req.headers());
    if (stripped.had) return route.continue({ headers: stripped.headers });
    return route.continue();
  });
}

function cdpHeaderList(headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

async function installCdpRequestPolicy(context, { allowlist = [], token = "", readOnly = true, onBlock } = {}) {
  const authConfigured = !!token;

  async function handlePaused(cdp, ev) {
    const url = ev.request.url;
    const method = String(ev.request.method || "GET").toUpperCase();
    const isNavigation = ev.resourceType === "Document";
    let decision;
    try {
      decision = decideRequest({ url, method, isNavigation, allowlist, authConfigured, readOnly });
    } catch (_) {
      return cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "Failed" }).catch(() => {});
    }
    if (decision.action === "abort") {
      if (onBlock) onBlock({ kind: "http", method, path: safePath(url), reason: decision.reason });
      return cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "Aborted" }).catch(() => {});
    }
    const headers = Object.assign({}, ev.request.headers);
    withoutAuthorization(headers);
    if (decision.credential) headers["Authorization"] = `Bearer ${token}`;
    try {
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId, headers: cdpHeaderList(headers) });
    } catch (_) {
      // Never leave a request hanging: fall back to continuing untouched. The
      // request then carries no injected token, so this cannot leak one.
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
    }
  }

  // Must be awaited before the page's first navigation: Fetch interception only
  // sees requests issued after Fetch.enable. `context.on("page")` covers popups
  // best-effort; an unintercepted request simply carries no injected token.
  const attachments = new WeakMap();

  async function attachPage(page) {
    if (attachments.has(page)) return attachments.get(page);
    const pending = (async () => {
      const cdp = await context.newCDPSession(page);
      let chain = Promise.resolve();
      cdp.on("Fetch.requestPaused", (ev) => {
        chain = chain.then(() => handlePaused(cdp, ev)).catch(() => {});
      });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    })();
    attachments.set(page, pending);
    return pending;
  }

  context.on("page", (page) => { attachPage(page).catch(() => {}); });
  for (const page of context.pages()) await attachPage(page);
  return { attachPage };
}

// Public entry: pick the mechanism that can enforce the policy correctly.
// Attach every page with the returned `attachPage` BEFORE its first navigation.
async function installRequestPolicy(context, options = {}) {
  if (options.token) return installCdpRequestPolicy(context, options);
  await installRouteRequestPolicy(context, options);
  return { attachPage: async () => {} };
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

module.exports = { installRequestPolicy, installWebSocketPolicy, installRouteRequestPolicy, installCdpRequestPolicy };
