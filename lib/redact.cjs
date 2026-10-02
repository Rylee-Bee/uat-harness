// In-driver artifact redaction (E03). Playwright traces record request
// headers, so a bearer token lands inside trace-*.zip -- exactly what CI
// uploads. GitHub masks logs, not uploaded files. This module scrubs a token
// out of every plain file and ZIP entry under a directory.
//
// FAIL CLOSED: any error (unreadable file, unopenable/corrupt ZIP, write
// failure) throws. The caller must withhold the artifacts rather than publish
// a directory it cannot prove is token-free. No secret is ever logged.
"use strict";

const fs = require("fs");
const path = require("path");

const REDACTED = "[REDACTED]";
// Belt and braces: scrub any bearer credential by shape, not only the exact
// value we were handed. Catches a token that arrived by another route too.
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function firstLine(e) {
  return String((e && e.message) || e).split("\n")[0];
}

let AdmZip = null;
function getAdmZip() {
  if (AdmZip) return AdmZip;
  const candidates = [];
  if (process.env.UAT_NODE_MODULES) candidates.push(path.join(process.env.UAT_NODE_MODULES, "adm-zip"));
  candidates.push(path.join(__dirname, "..", "node_modules", "adm-zip"));
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { AdmZip = require(c); return AdmZip; } catch (_) { /* try next */ }
    }
  }
  try { AdmZip = require("adm-zip"); return AdmZip; } catch (_) { /* fall through */ }
  throw new Error("adm-zip is required to redact a bearer token from trace ZIPs; run `npm install` (or include adm-zip in UAT_NODE_MODULES)");
}

function replaceAll(buf, needle, replacement) {
  if (!needle || needle.length === 0) return buf;
  const parts = [];
  let i = 0;
  let idx;
  while ((idx = buf.indexOf(needle, i)) !== -1) {
    parts.push(buf.subarray(i, idx), replacement);
    i = idx + needle.length;
  }
  if (parts.length === 0) return buf;
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

// Byte-safe: latin1 round-trips every possible byte, and the bearer pattern is
// pure ASCII, so replacing on the latin1 view cannot corrupt binary payloads.
function replaceRegex(buf, re, replacement) {
  const s = buf.toString("latin1");
  const next = s.replace(re, replacement);
  return next === s ? buf : Buffer.from(next, "latin1");
}

function scrubBuffer(data, secret) {
  let out = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (secret) {
    out = replaceAll(out, Buffer.from(secret, "utf8"), Buffer.from(REDACTED, "utf8"));
  }
  out = replaceRegex(out, BEARER_RE, `Bearer ${REDACTED}`);
  return out;
}

function redactPlainFile(filePath, secret) {
  const data = fs.readFileSync(filePath);
  const next = scrubBuffer(data, secret);
  if (next.equals(data)) return false;
  fs.writeFileSync(filePath, next);
  return true;
}

function redactZip(filePath, secret) {
  const Zip = getAdmZip();
  let zip;
  try {
    zip = new Zip(filePath);
  } catch (e) {
    throw new Error(`cannot open zip ${path.basename(filePath)}: ${firstLine(e)}`);
  }
  let changed = false;
  try {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const data = entry.getData();
      const next = scrubBuffer(data, secret);
      if (!next.equals(data)) {
        zip.updateFile(entry.entryName, next);
        changed = true;
      }
    }
  } catch (e) {
    throw new Error(`cannot scrub zip ${path.basename(filePath)}: ${firstLine(e)}`);
  }
  if (changed) {
    const tmp = `${filePath}.redacting`;
    try {
      zip.writeZip(tmp);
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* best effort */ }
      throw new Error(`cannot rewrite zip ${path.basename(filePath)}: ${firstLine(e)}`);
    }
  }
  return changed;
}

function looksLikeZip(filePath, name) {
  if (name.toLowerCase().endsWith(".zip")) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    return magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;
  } catch (_) {
    return false;
  }
}

// Scrub every file under `dir`. Returns { scanned, changed } and throws on the
// first thing it cannot guarantee. A symlink is never followed.
function redactArtifacts(dir, secret) {
  const stats = { scanned: 0, changed: 0 };
  if (!secret) return stats;
  if (!fs.existsSync(dir)) return stats;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const p = path.join(current, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { stack.push(p); continue; }
      if (!st.isFile()) continue;
      stats.scanned++;
      if (looksLikeZip(p, name)) {
        if (redactZip(p, secret)) stats.changed++;
      } else if (redactPlainFile(p, secret)) {
        stats.changed++;
      }
    }
  }
  return stats;
}

module.exports = { redactArtifacts, scrubBuffer, REDACTED, BEARER_RE };
