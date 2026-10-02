// Playwright configuration for the E01/E02/E03 acceptance fixtures.
// Unit tests are browser-free and run with `npm run test:unit` (node --test);
// only `*.spec.cjs` files are picked up here.
"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.cjs",
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { headless: true },
});
