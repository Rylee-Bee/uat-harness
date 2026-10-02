// E02: the read-only guarantee is "blocked HTTP methods + blocked channels",
// not "server prevented mutations". These fixtures prove the declared policy:
// a mutating GET still runs, a service worker is blocked, and a WebSocket
// message is recorded but never forwarded.
"use strict";

const { test, expect } = require("@playwright/test");
const { installRequestPolicy, installWebSocketPolicy } = require("../lib/netpolicy.cjs");
const { startHttpServer, startWsServer } = require("./helpers/servers.cjs");

test("E02: a mutating GET still runs while a POST is blocked", async ({ browser }) => {
  let mutations = 0;
  const app = await startHttpServer((req, res, url) => {
    if (url.pathname === "/mutate") {
      mutations++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><body><script>fetch("/mutate"); fetch("/mutate", {method:"POST"});</script></body></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const blocked = [];
  const ctx = await browser.newContext();
  await installRequestPolicy(ctx, { allowlist: [app.origin], token: "", readOnly: true, onBlock: (b) => blocked.push(b) });
  const page = await ctx.newPage();
  await page.goto(`${app.origin}/`, { waitUntil: "load" });
  await page.waitForTimeout(600);

  // GET reached the server, so the guard blocks methods, not mutations.
  expect(mutations).toBe(1);
  expect(blocked.some((b) => b.method === "POST"), "the POST should be blocked").toBe(true);
  expect(blocked.filter((b) => b.method === "GET")).toEqual([]);

  await ctx.close();
  app.close();
});

test("E02: service workers are blocked, so their requests never happen", async ({ browser }) => {
  const hits = [];
  const app = await startHttpServer((req, res, url) => {
    if (url.pathname === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("self.addEventListener('install', e => self.skipWaiting());\nself.addEventListener('activate', e => e.waitUntil(fetch('/sw-hit')));\n");
      return;
    }
    if (url.pathname === "/sw-hit") {
      hits.push(url.pathname);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hit");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>service worker fixture</body></html>");
  });

  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.goto(`${app.origin}/`);
  const outcome = await page.evaluate(async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");
      return "registered";
    } catch (e) {
      return `blocked:${e.name}`;
    }
  });
  await page.waitForTimeout(800);

  const controller = await page.evaluate(() => (navigator.serviceWorker.controller ? "controlled" : "none"));
  expect(controller, "a blocked service worker must not control the page").toBe("none");
  expect(hits, "a blocked service worker must not reach the network").toEqual([]);
  expect(outcome === "registered" || /^blocked/.test(outcome), `unexpected register outcome: ${outcome}`).toBe(true);

  // Control: without the block, the worker's activate fetch DOES reach the network,
  // proving it is the serviceWorkers:"block" policy that prevents it above.
  const ctxAllow = await browser.newContext();
  const pageAllow = await ctxAllow.newPage();
  await pageAllow.goto(`${app.origin}/`);
  await pageAllow.evaluate(() => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  await pageAllow.waitForTimeout(1500);
  expect(hits.length, "control: worker request should reach the network when allowed").toBeGreaterThan(0);
  await ctxAllow.close();

  await ctx.close();
  app.close();
});

test("E02: a WebSocket write is recorded but never forwarded in read-only mode", async ({ browser }) => {
  const ws = await startWsServer();
  const app = await startHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>websocket fixture</body></html>");
  });

  const blocked = [];
  const ctx = await browser.newContext();
  await installRequestPolicy(ctx, { allowlist: [], token: "", readOnly: true, onBlock: (b) => blocked.push(b) });
  await installWebSocketPolicy(ctx, { readOnly: true, onBlock: (b) => blocked.push(b) });
  const page = await ctx.newPage();
  await page.goto(`${app.origin}/`);
  await page.evaluate((wsUrl) => new Promise((resolve) => {
    const s = new WebSocket(wsUrl);
    s.onopen = () => { s.send("MUTATE-STATE"); setTimeout(() => resolve("sent"), 200); };
    s.onerror = () => resolve("error");
    s.onclose = () => resolve("closed");
  }), `${ws.origin}/ws`);
  await page.waitForTimeout(500);

  expect(ws.connectionCount(), "read-only mode must not connect to the real server").toBe(0);
  expect(ws.messages, "the server must never receive the WebSocket write").toEqual([]);
  expect(blocked.some((b) => b.kind === "websocket"), "the dropped write must be recorded").toBe(true);

  await ctx.close();
  app.close();
  ws.close();
});

test("E02 control: with read-only off, the WebSocket write reaches the server", async ({ browser }) => {
  const ws = await startWsServer();
  const app = await startHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>websocket control</body></html>");
  });

  const ctx = await browser.newContext();
  await installWebSocketPolicy(ctx, { readOnly: false });
  const page = await ctx.newPage();
  await page.goto(`${app.origin}/`);
  await page.evaluate((wsUrl) => new Promise((resolve) => {
    const s = new WebSocket(wsUrl);
    s.onopen = () => { s.send("MUTATE-STATE"); setTimeout(() => resolve("sent"), 200); };
    s.onerror = () => resolve("error");
  }), `${ws.origin}/ws`);
  await page.waitForTimeout(500);

  expect(ws.messages).toContain("MUTATE-STATE");

  await ctx.close();
  app.close();
  ws.close();
});
