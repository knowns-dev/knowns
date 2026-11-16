"use strict";

const { afterEach, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getPlatformPackage,
  pruneNpmRuntimes,
  sweepStrayTmp,
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

// Real output of npm's cmd-shim 7.0.0 for a bin that runs node_modules/knowns/bin/knowns.js.
const FIXTURES = path.join(__dirname, "testdata", "npm-shims");
const npmShim = (name, local) => {
  const text = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  // A local install's .bin shims reach the package as ..\knowns\bin\knowns.js.
  return local ? text.replace(/node_modules([\\/])knowns/g, "..$1knowns") : text;
};
function writeNpmShims(dir, local = false) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["knowns", "kn"]) {
    for (const ext of ["", ".cmd", ".ps1"]) {
      fs.writeFileSync(path.join(dir, name + ext), npmShim(`knowns${ext}`, local));
    }
  }
}
const WIN = getPlatformPackage("win32", "x64");
const winLayout = () =>
  installLayout({ binary: "exe", pkgName: "@knowns/win-x64", binaryName: "knowns.exe" });
const EXE = "C:\\Users\\me\\AppData\\Local\\Knowns\\npm-runtime\\9.9.9-x64\\knowns.exe";
const LOCAL = "C:\\Users\\me\\AppData\\Local";

test("a global install's shims are rewritten to start the staged binary directly", () => {
  const { root, packageRoot } = winLayout();
  writeNpmShims(root);
  const staged = [];

  const count = useNativeBinaryOnWindows(packageRoot, WIN, {
    platform: "win32",
    env: { npm_config_global: "true", npm_config_prefix: root },
    localAppData: LOCAL,
    stage: (source) => {
      staged.push(source);
      return EXE;
    },
    verify: () => true,
  });

  expect(staged).toEqual([
    path.join(packageRoot, "node_modules", "@knowns", "win-x64", "knowns.exe"),
  ]);
  expect(count).toBe(6);
  const cmd = fs.readFileSync(path.join(root, "knowns.cmd"), "utf8");
  expect(cmd).toContain('SET "KN_EXE=%LOCALAPPDATA%\\Knowns\\npm-runtime\\9.9.9-x64\\knowns.exe"');
  expect(cmd).toContain('node "%~dp0node_modules\\knowns\\bin\\knowns.js" %*');
  expect(fs.readFileSync(path.join(root, "kn.ps1"), "utf8")).toContain(
    "Join-Path $env:LOCALAPPDATA 'Knowns\\npm-runtime\\9.9.9-x64\\knowns.exe'",
  );
  expect(fs.readFileSync(path.join(root, "knowns"), "utf8")).toContain(
    '"$LOCALAPPDATA/Knowns/npm-runtime/9.9.9-x64/knowns.exe"',
  );
});

test("a local install is rewritten in node_modules/.bin only, never in the project root", () => {
  const { root, packageRoot } = winLayout();
  const bin = path.join(root, "node_modules", ".bin");
  writeNpmShims(bin, true);
  writeNpmShims(root); // look-alikes in the project root (packageRoot/../..): must stay untouched
  const before = fs.readFileSync(path.join(root, "knowns.cmd"), "utf8");

  const count = useNativeBinaryOnWindows(packageRoot, WIN, {
    platform: "win32",
    env: {},
    localAppData: LOCAL,
    stage: () => EXE,
    verify: () => true,
  });

  expect(count).toBe(6);
  expect(fs.readFileSync(path.join(root, "knowns.cmd"), "utf8")).toBe(before);
  expect(fs.readFileSync(path.join(bin, "knowns.cmd"), "utf8")).toContain(
    'node "%~dp0..\\knowns\\bin\\knowns.js" %*',
  );
});

test("a staged binary that does not run leaves npm's shims alone", () => {
  const { root, packageRoot } = winLayout();
  writeNpmShims(root);

  const count = useNativeBinaryOnWindows(packageRoot, WIN, {
    platform: "win32",
    env: { npm_config_global: "true", npm_config_prefix: root },
    stage: () => "C:\\nope\\knowns.exe",
    verify: () => false,
  });

  expect(count).toBe(0);
  expect(fs.readFileSync(path.join(root, "knowns.cmd"), "utf8")).toContain("knowns.js");
});

test("a user's own wrapper, even one that runs knowns.js, is never rewritten", () => {
  const { root, packageRoot } = winLayout();
  const wrappers = {
    "knowns.cmd": "@echo off\r\nset FOO=1\r\nnode \"%~dp0node_modules\\knowns\\bin\\knowns.js\" %*\r\n",
    "knowns.ps1": "$env:FOO=1\n& node \"$PSScriptRoot/node_modules/knowns/bin/knowns.js\" $args\n",
    // npm's own shape with one extra line added by the user
    knowns: `${npmShim("knowns", false)}echo done\n`,
    "kn.cmd": "@echo my own wrapper\r\n",
  };
  for (const [name, text] of Object.entries(wrappers)) fs.writeFileSync(path.join(root, name), text);
  let staged = 0;

  const count = useNativeBinaryOnWindows(packageRoot, WIN, {
    platform: "win32",
    env: { npm_config_global: "true", npm_config_prefix: root },
    stage: () => {
      staged++;
      return "x";
    },
  });

  expect(count).toBe(0);
  expect(staged).toBe(0);
  for (const [name, text] of Object.entries(wrappers)) {
    expect(fs.readFileSync(path.join(root, name), "utf8")).toBe(text);
  }
});

test("shims are plain ASCII for a non-ASCII profile and still name the staged exe", () => {
  const profile = "C:\\Users\\Nguyễn";
  const exe = `${profile}\\AppData\\Local\\Knowns\\npm-runtime\\9.9.9-x64\\knowns.exe`;
  for (const ext of ["", ".cmd", ".ps1"]) {
    const text = windowsShimContents(ext, exe, {
      localAppData: `${profile}\\AppData\\Local`,
      fallbackRel: "node_modules/knowns/bin/knowns.js",
    });
    expect(/^[\x00-\x7f]*$/.test(text)).toBe(true);
    expect(text).toContain("LOCALAPPDATA");
    expect(text).toContain("npm-runtime");
  }
  // Outside LOCALAPPDATA the literal path is all there is.
  expect(windowsShimContents(".cmd", "D:\\kn\\knowns.exe", { localAppData: LOCAL })).toContain(
    'SET "KN_EXE=D:\\kn\\knowns.exe"',
  );
});

test("shims fall back to node bin/knowns.js and keep exit codes (sh, run for real)", () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowns-shim-"));
  tempRoots.push(dir);
  const pkgBin = path.join(dir, "node_modules", "knowns", "bin");
  fs.mkdirSync(pkgBin, { recursive: true });
  fs.writeFileSync(path.join(pkgBin, "knowns.js"), "process.exit(Number(process.argv[2] ?? 0) + 40);\n");
  const localAppData = path.join(dir, "local");
  const exe = path.join(localAppData, "Knowns", "npm-runtime", "1-x64", "knowns.exe");
  const shim = path.join(dir, "knowns");
  const text = windowsShimContents("", exe, { localAppData, fallbackRel: "node_modules/knowns/bin/knowns.js" });
  fs.writeFileSync(shim, text, { mode: 0o755 });
  const env = { ...process.env, LOCALAPPDATA: localAppData };

  // exe missing: the node fallback runs and its exit code comes through
  expect(spawnSync("sh", [shim, "2"], { env }).status).toBe(42);
  // exe present: it runs instead, and its exit code comes through
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  expect(spawnSync("sh", [shim, "2"], { env }).status).toBe(7);
});

test("the .cmd and .ps1 fall back to node and propagate the exit code in their text", () => {
  const opts = { localAppData: LOCAL, fallbackRel: "node_modules/knowns/bin/knowns.js" };
  const cmd = windowsShimContents(".cmd", EXE, opts);
  expect(cmd).toBe(
    [
      "@ECHO off",
      "SETLOCAL",
      'SET "KN_EXE=%LOCALAPPDATA%\\Knowns\\npm-runtime\\9.9.9-x64\\knowns.exe"',
      'IF NOT EXIST "%KN_EXE%" GOTO kn_fallback',
      '"%KN_EXE%" %*',
      "EXIT /B %ERRORLEVEL%",
      ":kn_fallback",
      'node "%~dp0node_modules\\knowns\\bin\\knowns.js" %*',
      "EXIT /B %ERRORLEVEL%",
      "",
    ].join("\r\n"),
  );
  const ps1 = windowsShimContents(".ps1", EXE, opts);
  expect(ps1).toContain("if (Test-Path -LiteralPath $kn_exe) {");
  expect(ps1).toContain("& node (Join-Path $PSScriptRoot 'node_modules/knowns/bin/knowns.js') $args");
  expect(ps1.trimEnd().endsWith("exit $LASTEXITCODE")).toBe(true);
});

test("stray bin swap leftovers are swept and unused staged runtimes are pruned", () => {
  const { packageRoot } = installLayout();
  const bin = path.join(packageRoot, "bin");
  fs.writeFileSync(path.join(bin, "knowns.js.123.tmp"), "x");
  fs.writeFileSync(path.join(bin, "knowns.js.9.tmp"), "x");
  expect(sweepStrayTmp(packageRoot)).toBe(2);
  expect(fs.readdirSync(bin)).toEqual(["knowns.js"]);

  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "knowns-cache-")), "npm-runtime");
  tempRoots.push(path.dirname(cache));
  for (const v of ["0.33.0-x64", "0.34.0-x64", "0.35.0-x64"]) {
    fs.mkdirSync(path.join(cache, v), { recursive: true });
    fs.writeFileSync(path.join(cache, v, "knowns.exe"), "x");
  }
  fs.mkdirSync(path.join(cache, ".staging-abc"));
  expect(pruneNpmRuntimes(cache, path.join(cache, "0.35.0-x64")).sort()).toEqual([
    ".staging-abc",
    "0.33.0-x64",
    "0.34.0-x64",
  ]);
  expect(fs.readdirSync(cache)).toEqual(["0.35.0-x64"]);
  // never prune a directory that is not the npm-runtime cache
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "knowns-other-"));
  tempRoots.push(other);
  fs.mkdirSync(path.join(other, "keep"));
  expect(pruneNpmRuntimes(other, path.join(other, "x"))).toEqual([]);
  expect(fs.readdirSync(other)).toEqual(["keep"]);
});

unix("bin/knowns-proxy.js becomes the native proxy too, and a missing proxy leaves its shim", () => {
  const { packageRoot, shim } = installLayout({ binary: '#!/bin/sh\necho "native $@"\n' });
  const proxyShim = path.join(packageRoot, "bin", "knowns-proxy.js");
  fs.writeFileSync(proxyShim, SHIM, { mode: 0o755 });
  const platformPackage = getPlatformPackage("linux", "x64");

  // Without a proxy in the platform package the shim is untouched.
  expect(useNativeBinaryDirectly(packageRoot, platformPackage, { platform: "linux" })).toBe(true);
  expect(fs.readFileSync(proxyShim, "utf8")).toBe(SHIM);

  // With one, it is replaced by the native file.
  const pkgDir = path.join(packageRoot, "node_modules", "@knowns", "linux-x64");
  fs.writeFileSync(path.join(pkgDir, "knowns-proxy"), '#!/bin/sh\necho "proxy $@"\n', { mode: 0o755 });
  fs.writeFileSync(shim, SHIM, { mode: 0o755 });
  expect(useNativeBinaryDirectly(packageRoot, platformPackage, { platform: "linux" })).toBe(true);
  const run = spawnSync(proxyShim, ["mcp", "--stdio"], { encoding: "utf8" });
  expect(run.stdout.trim()).toBe("proxy mcp --stdio");
});
