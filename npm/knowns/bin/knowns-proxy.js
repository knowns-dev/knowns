#!/usr/bin/env node

// Node shim for the native MCP proxy. The postinstall replaces it with the native binary where it
// can (see install.js), so this runs only after --ignore-scripts or a failed optimisation. A
// missing proxy falls back to the in-process server: `knowns <same arguments>`.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getBinaryPath, stageWindowsBinary } = require("./runtime.js");

function main() {
  const binary = stageWindowsBinary(getBinaryPath());
  const ext = process.platform === "win32" ? ".exe" : "";
  const proxy = path.join(path.dirname(binary), `knowns-proxy${ext}`);
  const args = process.argv.slice(2);
  const target = fs.existsSync(proxy) ? proxy : binary;
  try {
    execFileSync(target, args, { stdio: "inherit", env: process.env });
  } catch (err) {
    if (err.status !== undefined) {
      process.exit(err.status);
    }
    throw err;
  }
}

if (require.main === module) {
  main();
}
