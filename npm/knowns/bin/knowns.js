#!/usr/bin/env node

const { execFileSync } = require("child_process");
const { ensureExecutable, getBinaryPath, rosettaHint, stageWindowsBinary } = require("./runtime.js");

function main() {
  const binary = stageWindowsBinary(getBinaryPath());
  const args = process.argv.slice(2);
  const hint = rosettaHint();
  if (hint) {
    process.stderr.write(hint);
  }

  try {
    ensureExecutable(binary);
    execFileSync(binary, args, {
      stdio: "inherit",
      env: process.env,
    });
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
