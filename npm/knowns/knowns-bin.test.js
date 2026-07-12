"use strict";

const { afterEach, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { stageWindowsBinary } = require("./bin/knowns.js");

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createPlatformPackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowns-bin-test-"));
  tempRoots.push(root);
  const packageDir = path.join(root, "package");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  fs.writeFileSync(path.join(packageDir, "knowns.exe"), "binary");
  fs.writeFileSync(path.join(packageDir, "onnxruntime.dll"), "dll");
  return { binary: path.join(packageDir, "knowns.exe"), cacheRoot };
}

test("stages the Windows binary and adjacent DLLs outside node_modules", () => {
  const { binary, cacheRoot } = createPlatformPackage();

  const staged = stageWindowsBinary(binary, { platform: "win32", arch: "x64", cacheRoot });

  expect(staged).toBe(path.join(cacheRoot, "1.2.3-x64", "knowns.exe"));
  expect(fs.readFileSync(staged, "utf8")).toBe("binary");
  expect(fs.readFileSync(path.join(path.dirname(staged), "onnxruntime.dll"), "utf8")).toBe("dll");
});

test("reuses an existing staged Windows runtime", () => {
  const { binary, cacheRoot } = createPlatformPackage();
  const first = stageWindowsBinary(binary, { platform: "win32", arch: "x64", cacheRoot });
  fs.writeFileSync(first, "cached");

  const second = stageWindowsBinary(binary, { platform: "win32", arch: "x64", cacheRoot });

  expect(second).toBe(first);
  expect(fs.readFileSync(second, "utf8")).toBe("cached");
});

test("does not stage binaries on non-Windows platforms", () => {
  const { binary, cacheRoot } = createPlatformPackage();

  expect(stageWindowsBinary(binary, { platform: "linux", arch: "x64", cacheRoot })).toBe(binary);
  expect(fs.existsSync(cacheRoot)).toBe(false);
});
