// E01: a bearer token must never follow a resource, link, redirect hop or
// popup off the approved origin -- on desktop AND mobile contexts. Two
// disposable local origins; the "token" is an obvious canary, never a real one.
"use strict";

const { test, expect, devices } = require("@playwright/test");
const { installRequestPolicy } = require("../lib/netpolicy.cjs");
const { startHttpServer } = require("./helpers/servers.cjs");

const CANARY = "CANARY-e01-token-2f9a-nt";

const CONTEXTS = [
  ["desktop", { viewport: { width: 900, height: 700 } }],
  ["mobile", devices["iPhone 13"]],
];

for (const [name, contextOptions] of CONTEXTS) {
  test(`E01 ${name}: canary token never reaches an off-origin resource/link/redirect/popup`, async ({ browser }) => {
    const off = await startHttpServer((req, res, url) => {
      res.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html" });
      res.end(url.pathname.endsWith(".png") ? "" : `<html><body>off-origin ${url.pathname}</body></html>`);
    });
    const app = await startHttpServer((req, res, url) => {
      if (url.pathname === "/redirect-to-off") {
        res.writeHead(302, { location: `${off.origin}/redirect-target` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>
        <a id="ext" href="${off.origin}/ext-link">external link</a>
        <a id="redir" href="/redirect-to-off">redirect</a>
        <img id="img" src="${off.origin}/ext.png">
        <script src="${off.origin}/ext.js"></script>
      </body></html>`);
    });

    const blocked = [];
    const ctx = await browser.newContext(contextOptions);
    const policy = await installRequestPolicy(ctx, {
      allowlist: [app.origin],
      token: CANARY,
      readOnly: true,
      onBlock: (b) => blocked.push(b),
    });

    const page = await ctx.newPage();
    await policy.attachPage(page);
    await page.goto(`${app.origin}/`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const extHref = await page.getAttribute("#ext", "href");

    // Popup navigating off-origin (triggered before any navigation unwinds the page).
    const popupPromise = ctx.waitForEvent("page", { timeout: 3000 }).catch(() => null);
    await page.evaluate((href) => window.open(href, "_blank"), extHref);
    const popup = await popupPromise;
    if (popup) await popup.waitForTimeout(500).catch(() => {});
    await page.waitForTimeout(300);

    // Real click on an off-origin link: the navigation is rejected.
    await page.click("#ext").catch(() => {});
    await page.waitForTimeout(500);

    // Redirect hop: an approved URL 302s to the off-origin host.
    const redirPage = await ctx.newPage();
    await policy.attachPage(redirPage);
    await redirPage.goto(`${app.origin}/redirect-to-off`).catch(() => {});
    await redirPage.waitForTimeout(500);

    // The approved origin DID authenticate...
    const appAuthed = app.requests.some((r) => String(r.headers.authorization || "").includes(CANARY));
    expect(appAuthed, "approved origin should receive the bearer token").toBe(true);

    // ...and the off-origin host saw the resources but NEVER the token.
    expect(off.requests.length, "off-origin host should have served subresources").toBeGreaterThan(0);
    const leaked = off.requests.filter((r) => String(r.headers.authorization || "").includes(CANARY));
    expect(leaked, `off-origin received the canary token: ${JSON.stringify(leaked)}`).toEqual([]);

    // Unsafe authenticated navigation was rejected, not trusted to behave.
    expect(blocked.some((b) => /navigation/.test(String(b.reason))), "a navigation abort should be recorded").toBe(true);

    await ctx.close();
    off.close();
    app.close();
  });
}
