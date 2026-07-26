"use strict";

const { test, expect } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const { getPlatformPackage } = require("./install.js");

function readPackageJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, relativePath), "utf8"));
}

test("maps Windows x64 to the published package name", () => {
  expect(getPlatformPackage("win32", "x64")).toEqual({
    name: "@knowns/win-x64",
    asset: "knowns-win-x64",
    ext: ".exe",
    packageOs: "win32",
    packageCpu: "x64",
  });
});

test("maps macOS Intel to the darwin-x64 package and release asset", () => {
  expect(getPlatformPackage("darwin", "x64")).toEqual({
    name: "@knowns/darwin-x64",
    asset: "knowns-darwin-x64",
    ext: "",
    packageOs: "darwin",
    packageCpu: "x64",
  });
});

test("macOS Intel package contains only the CLI binary", () => {
  const pkg = readPackageJson("../knowns-darwin-x64/package.json");

  expect(pkg.os).toEqual(["darwin"]);
  expect(pkg.cpu).toEqual(["x64"]);
  expect(pkg.files).toEqual(["knowns"]);
});

test("Windows platform packages use npm's win32 os identifier", () => {
  const x64Pkg = readPackageJson("../knowns-win-x64/package.json");
  const arm64Pkg = readPackageJson("../knowns-win-arm64/package.json");

  expect(x64Pkg.os).toEqual(["win32"]);
  expect(arm64Pkg.os).toEqual(["win32"]);
  expect(x64Pkg.cpu).toEqual(["x64"]);
  expect(arm64Pkg.cpu).toEqual(["arm64"]);
});
