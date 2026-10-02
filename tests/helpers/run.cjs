// Shared helpers for the E03 end-to-end tests: run the real driver / wrapper as
// a child process and prove no canary token survives anywhere in the output.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// spawnSync blocks the caller's event loop, which starves the in-process test
// servers; use async spawn so the fixture servers can answer the child.
function run(cmd, args, { env, timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: Object.assign({}, process.env, env || {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, error, stdout, stderr });
    });
  });
}

function runDriver(url, outDir, env) {
  return run(process.execPath, [path.join(REPO_ROOT, "uat_driver.cjs"), url, outDir], { env });
}

function runWrapper(url, outDir, env) {
  return run("python3", [path.join(REPO_ROOT, "uat.py"), url, "--out", outDir], { env });
}

// Raw-byte scan for plain files; ZIP entries are decompressed first (a token
// inside a deflated entry does not appear literally in the raw bytes).
function scanForToken(dir, token) {
  const needle = Buffer.from(token, "utf8");
  const hits = [];
  const AdmZip = require("adm-zip");
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (st.isFile()) {
        if (fs.readFileSync(p).includes(needle)) hits.push(p);
      }
      if (name.toLowerCase().endsWith(".zip") || p.toLowerCase().endsWith(".zip")) {
        try {
          const zip = new AdmZip(p);
          for (const entry of zip.getEntries()) {
            if (!entry.isDirectory && entry.getData().includes(needle)) { hits.push(`${p}!${entry.entryName}`); break; }
          }
        } catch (_) { /* a corrupt zip is not a token hit */ }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}

module.exports = { REPO_ROOT, runDriver, runWrapper, scanForToken };
