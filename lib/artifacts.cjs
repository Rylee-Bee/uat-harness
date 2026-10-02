// Artifact staging and finalization (E03). The driver never writes
// publishable artifacts straight into the output directory: everything goes
// into a hidden `outDir/.staging/` first. finalizeArtifacts() redacts that
// staging directory, then promotes its contents; only then do the real
// artifact names exist under outDir.
//
// Why this shape:
//   - Incomplete artifacts cannot be uploaded before finalization: until the
//     promote step runs, the only files on disk are inside the hidden
//     `.staging` directory. GitHub's upload-artifact excludes hidden files by
//     default, and a killed/timed-out run leaves at most `.staging` behind.
//   - Redaction happens before promotion, so there is exactly one publishable
//     path and it is always scrubbed.
//   - FAIL CLOSED: if redaction or promotion fails, the staging directory is
//     deleted and nothing is promoted, so an unredacted artifact can never be
//     published and no secret is left in the output tree.
"use strict";

const fs = require("fs");
const path = require("path");
const { redactArtifacts } = require("./redact.cjs");

const STAGE_DIRNAME = ".staging";

function stageDirFor(outDir) {
  return path.join(outDir, STAGE_DIRNAME);
}

// `redact` is injectable so a unit test can prove the fail-closed path without
// a corrupt ZIP. Returns the redaction stats; throws (after deleting staging)
// if anything cannot be guaranteed.
function finalizeArtifacts(outDir, secret, opts = {}) {
  const stageDir = opts.stageDir || stageDirFor(outDir);
  const redact = opts.redact || redactArtifacts;
  try {
    const stats = fs.existsSync(stageDir) ? redact(stageDir, secret) : { scanned: 0, changed: 0 };
    if (fs.existsSync(stageDir)) {
      fs.mkdirSync(outDir, { recursive: true });
      for (const name of fs.readdirSync(stageDir)) {
        const src = path.join(stageDir, name);
        const dest = path.join(outDir, name);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
    return stats;
  } catch (e) {
    // Fail closed: never leave unredacted staged artifacts behind.
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    throw e;
  }
}

module.exports = { finalizeArtifacts, stageDirFor, STAGE_DIRNAME };
