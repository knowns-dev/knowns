"use strict";

const { afterEach, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getPlatformPackage,
  useNativeBinaryDirectly,
  useNativeBinaryOnWindows,
  windowsShimContents,
} = require("./install.js");

const SHIM = '#!/usr/bin/env node\nconsole.log("node shim");\n';
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** node_modules/knowns with the Node shim, plus (optionally) the platform package holding `binary`. */
function installLayout({ binary, pkgName = "@knowns/linux-x64", binaryName = "knowns" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowns-direct-"));
  tempRoots.push(root);
  const packageRoot = path.join(root, "node_modules", "knowns");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "bin", "knowns.js"), SHIM, { mode: 0o755 });
  if (binary !== undefined) {
    const pkgDir = path.join(packageRoot, "node_modules", ...pkgName.split("/"));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, binaryName), binary, { mode: 0o755 });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  }
  return { root, packageRoot, shim: path.join(packageRoot, "bin", "knowns.js") };
}

const unix = process.platform === "win32" ? test.skip : test;

unix("bin/knowns.js becomes the native binary, so no Node process is involved", () => {
  const { packageRoot, shim } = installLayout({ binary: '#!/bin/sh\necho "native $@"\n' });

  const done = useNativeBinaryDirectly(packageRoot, getPlatformPackage("linux", "x64"), {
    platform: "linux",
  });

  expect(done).toBe(true);
  expect(fs.readFileSync(shim, "utf8")).toContain("native");
  expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
  const run = spawnSync(shim, ["--version"], { encoding: "utf8" });
  expect(run.stdout.trim()).toBe("native --version");
  expect(fs.readdirSync(path.dirname(shim)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

unix("a second run leaves the already replaced binary alone", () => {
  const { packageRoot, shim } = installLayout({ binary: '#!/bin/sh\necho native\n' });
  const platformPackage = getPlatformPackage("linux", "x64");

  expect(useNativeBinaryDirectly(packageRoot, platformPackage, { platform: "linux" })).toBe(true);
  const inode = fs.statSync(shim).ino;
  // The native binary is not a "#!" file in real life; simulate that by making it non-shim.
  fs.writeFileSync(shim, "\x7fELF-pretend", { mode: 0o755 });
  expect(useNativeBinaryDirectly(packageRoot, platformPackage, { platform: "linux" })).toBe(false);
  expect(fs.readFileSync(shim, "utf8")).toBe("\x7fELF-pretend");
  expect(inode).toBeGreaterThan(0);
});

test("without the platform package the Node shim stays in place", () => {
  const { packageRoot, shim } = installLayout();

  const done = useNativeBinaryDirectly(packageRoot, getPlatformPackage("linux", "x64"), {
    platform: "linux",
  });

  expect(done).toBe(false);
  expect(fs.readFileSync(shim, "utf8")).toBe(SHIM);
});

unix("a binary that cannot run is not swapped in", () => {
  const { packageRoot, shim } = installLayout({ binary: "#!/bin/sh\nexit 3\n" });

  const done = useNativeBinaryDirectly(packageRoot, getPlatformPackage("linux", "x64"), {
    platform: "linux",
  });

  expect(done).toBe(false);
  expect(fs.readFileSync(shim, "utf8")).toBe(SHIM);
  expect(fs.readdirSync(path.dirname(shim))).toEqual(["knowns.js"]);
});

test("Windows is left to the shim rewrite, not the bin swap", () => {
  const { packageRoot, shim } = installLayout({
    binary: "x",
    pkgName: "@knowns/win-x64",
    binaryName: "knowns.exe",
  });

  expect(
    useNativeBinaryDirectly(packageRoot, getPlatformPackage("win32", "x64"), { platform: "win32" }),
  ).toBe(false);
  expect(fs.readFileSync(shim, "utf8")).toBe(SHIM);
});

// --- Windows shim rewrite (pure file work, so it runs on every OS) -------------------------------

function npmWindowsShims(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const target = "%dp0%\\node_modules\\knowns\\bin\\knowns.js";
  const files = {
    knowns: `#!/bin/sh\nexec node "$basedir/node_modules/knowns/bin/knowns.js" "$@"\n`,
    "knowns.cmd": `@ECHO off\r\nnode "${target}" %*\r\n`,
    "knowns.ps1": `& node "$basedir/node_modules/knowns/bin/knowns.js" $args\n`,
    "kn.cmd": `@ECHO off\r\nnode "${target}" %*\r\n`,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

test("npm's Windows shims are rewritten to start the staged binary directly", () => {
  const { root, packageRoot } = installLayout({
    binary: "exe",
    pkgName: "@knowns/win-x64",
    binaryName: "knowns.exe",
  });
  const prefix = path.join(root, "node_modules", "..");
  npmWindowsShims(prefix);
  const staged = [];
  const exe = "C:\\Users\\me\\AppData\\Local\\Knowns\\npm-runtime\\9.9.9-x64\\knowns.exe";

  const count = useNativeBinaryOnWindows(packageRoot, getPlatformPackage("win32", "x64"), {
    platform: "win32",
    stage: (source) => {
      staged.push(source);
      return exe;
    },
    verify: () => true,
  });

  expect(staged).toEqual([
    path.join(packageRoot, "node_modules", "@knowns", "win-x64", "knowns.exe"),
  ]);
  expect(count).toBe(4);
  for (const name of ["knowns.cmd", "kn.cmd"]) {
    expect(fs.readFileSync(path.join(prefix, name), "utf8")).toBe(`@ECHO off\r\n"${exe}" %*\r\n`);
  }
  expect(fs.readFileSync(path.join(prefix, "knowns.ps1"), "utf8")).toContain(`& "${exe}" $args`);
  expect(fs.readFileSync(path.join(prefix, "knowns"), "utf8")).toContain("exec ");
});

test("a staged binary that does not run leaves npm's shims alone", () => {
  const { root, packageRoot } = installLayout({
    binary: "exe",
    pkgName: "@knowns/win-x64",
    binaryName: "knowns.exe",
  });
  const prefix = path.join(root, "node_modules", "..");
  npmWindowsShims(prefix);

  const count = useNativeBinaryOnWindows(packageRoot, getPlatformPackage("win32", "x64"), {
    platform: "win32",
    stage: () => "C:\\nope\\knowns.exe",
    verify: () => false,
  });

  expect(count).toBe(0);
  expect(fs.readFileSync(path.join(prefix, "knowns.cmd"), "utf8")).toContain("knowns.js");
});

test("shim templates call the binary with no node in the line", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\Knowns\\npm-runtime\\9.9.9-x64\\knowns.exe";

  const cmd = windowsShimContents(".cmd", exe);
  expect(cmd).toBe(`@ECHO off\r\n"${exe}" %*\r\n`);
  expect(cmd).not.toContain("node");

  const ps1 = windowsShimContents(".ps1", exe);
  expect(ps1).toContain(`& "${exe}" $args`);
  expect(ps1).toContain("exit $LASTEXITCODE");

  expect(windowsShimContents("", exe)).toContain(
    'exec "C:/Users/me/AppData/Local/Knowns/npm-runtime/9.9.9-x64/knowns.exe" "$@"',
  );
});

test("files that are not npm's shim for knowns are never rewritten", () => {
  const { root, packageRoot } = installLayout({
    binary: "exe",
    pkgName: "@knowns/win-x64",
    binaryName: "knowns.exe",
  });
  const prefix = path.join(root, "node_modules", "..");
  fs.writeFileSync(path.join(prefix, "knowns.cmd"), "@echo my own wrapper\r\n");
  let staged = 0;

  const count = useNativeBinaryOnWindows(packageRoot, getPlatformPackage("win32", "x64"), {
    platform: "win32",
    stage: () => {
      staged++;
      return "x";
    },
  });

  expect(count).toBe(0);
  expect(staged).toBe(0);
  expect(fs.readFileSync(path.join(prefix, "knowns.cmd"), "utf8")).toBe("@echo my own wrapper\r\n");
});
