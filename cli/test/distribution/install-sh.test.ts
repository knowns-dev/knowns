// AC4 of TSR-Z7CRS1: the install.sh fixes inventoried in os-regression-inventory rows 15-17, 19,
// each proven by running the real script in a temp HOME against a fake release mirror.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  fakeUname,
  INSTALL_SH,
  makeRelease,
  makeSandbox,
  run,
  runInstall,
} from "./install-harness.ts";

const posix = process.platform !== "win32";

describe.skipIf(!posix)("install.sh", () => {
  test("syntax is valid POSIX sh", () => {
    expect(run(["sh", "-n", INSTALL_SH]).code).toBe(0);
  });

  // Row 15 (6f0d064): rename into place so the binary gets a new inode (macOS SIGKILLs a cp'd
  // binary whose old inode's signature is cached by a running process).
  test("row 15: replaces an existing binary by rename, not an in-place write", () => {
    const sb = makeSandbox();
    const rel = makeRelease("v1.0.0", "linux-x64", "1.0.0");
    const dir = join(sb.home, ".knowns", "bin");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "knowns");
    writeFileSync(target, "#!/bin/sh\necho old\n", { mode: 0o755 });
    const inodeBefore = statSync(target).ino;
    // A second name for the old inode: an in-place cp would change its content too.
    const keep = join(dir, "old-inode");
    run(["ln", target, keep]);

    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
    });
    expect(r.code).toBe(0);
    expect(statSync(target).ino).not.toBe(inodeBefore);
    expect(readFileSync(keep, "utf8")).toContain("echo old");
    expect(run([target]).stdout).toBe("knowns version 1.0.0\n");
    expect(statSync(target).mode & 0o111).not.toBe(0);
    // No temp files left behind by the rename dance.
    expect(
      run(["ls", dir])
        .stdout.split("\n")
        .filter((n) => n.includes(".new.")),
    ).toEqual([]);
  });

  // Row 16 (75b0470): link onto a PATH dir, never edit rc files.
  test("row 16: links knowns and kn into ~/.local/bin when it is on PATH, without touching rc files", () => {
    const sb = makeSandbox([".local/bin"]);
    const rel = makeRelease("v1.0.0", "linux-x64", "1.0.0");
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
    });
    expect(r.code).toBe(0);
    const bin = join(sb.home, ".knowns", "bin", "knowns");
    for (const name of ["knowns", "kn"]) {
      const link = join(sb.home, ".local", "bin", name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(bin);
    }
    for (const rc of [".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".zshenv"]) {
      expect(existsSync(join(sb.home, rc))).toBe(false);
    }
    const meta = JSON.parse(readFileSync(join(sb.home, ".knowns", "install.json"), "utf8"));
    expect(meta.version).toBe("1.0.0");
    expect(meta.linkPaths).toEqual([
      join(sb.home, ".local", "bin", "knowns"),
      join(sb.home, ".local", "bin", "kn"),
    ]);
  });

  test("row 16: does not clobber a real file (Homebrew/npm knowns) in the link dir", () => {
    const sb = makeSandbox([".local/bin"]);
    const existing = join(sb.home, ".local", "bin", "knowns");
    writeFileSync(existing, "#!/bin/sh\necho brew\n", { mode: 0o755 });
    const rel = makeRelease("v1.0.0", "linux-x64", "1.0.0");
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
    });
    expect(r.code).toBe(0);
    expect(lstatSync(existing).isSymbolicLink()).toBe(false);
    expect(readFileSync(existing, "utf8")).toContain("brew");
  });

  test("row 16: no link and a PATH hint when no PATH dir is available", () => {
    const sb = makeSandbox();
    const rel = makeRelease("v1.0.0", "linux-x64", "1.0.0");
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.home, ".local"))).toBe(false);
    expect(r.stdout).toContain("export PATH=");
    expect(existsSync(join(sb.home, ".bashrc"))).toBe(false);
  });

  // Row 17 (f3278da): link even when the install dir itself is already on PATH.
  test("row 17: links even when the install dir is already on PATH", () => {
    const sb = makeSandbox([".knowns/bin", ".local/bin"]);
    const rel = makeRelease("v1.0.0", "linux-x64", "1.0.0");
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
    });
    expect(r.code).toBe(0);
    expect(lstatSync(join(sb.home, ".local", "bin", "knowns")).isSymbolicLink()).toBe(true);
    expect(r.stdout).toContain("installed successfully");
    expect(r.stdout).not.toContain("export PATH=");
  });

  test("row 17: KNOWNS_LINK_DIR links into a chosen dir and KNOWNS_NO_LINK skips it", () => {
    const sb = makeSandbox([".knowns/bin"]);
    const rel = makeRelease("v1.0.0", "linux-x64", "1.0.0");
    const custom = join(sb.home, "custom-bin");
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
      env: { KNOWNS_LINK_DIR: custom },
    });
    expect(r.code).toBe(0);
    expect(lstatSync(join(custom, "knowns")).isSymbolicLink()).toBe(true);

    const sb2 = makeSandbox([".local/bin"]);
    const r2 = runInstall({
      sandbox: sb2,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
      env: { KNOWNS_NO_LINK: "1" },
    });
    expect(r2.code).toBe(0);
    expect(existsSync(join(sb2.home, ".local", "bin", "knowns"))).toBe(false);
  });

  // Row 19 (#133): macOS Intel resolves to the darwin-x64 asset.
  test("row 19: macOS Intel (Darwin x86_64) installs the darwin-x64 asset", () => {
    const sb = makeSandbox([".local/bin"]);
    const rel = makeRelease("v1.0.0", "darwin-x64", "1.0.0-intel");
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Darwin", "x86_64"],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("darwin-x64");
    expect(run([join(sb.home, ".knowns", "bin", "knowns")]).stdout).toBe(
      "knowns version 1.0.0-intel\n",
    );
    const meta = JSON.parse(readFileSync(join(sb.home, ".knowns", "install.json"), "utf8"));
    expect([meta.platform, meta.arch]).toEqual(["darwin", "x64"]);
  });

  test.each([
    ["Darwin", "arm64", "darwin-arm64"],
    ["Darwin", "x86_64", "darwin-x64"],
    ["Linux", "aarch64", "linux-arm64"],
    ["Linux", "x86_64", "linux-x64"],
    ["MINGW64_NT-10.0", "x86_64", "win-x64"],
    ["MINGW64_NT-10.0", "aarch64", "win-arm64"],
  ])("platform mapping: %s %s -> knowns-%s.tar.gz", (os, arch, platform) => {
    const sb = makeSandbox();
    // Only the expected asset exists, so success proves the script asked for exactly that name.
    const rel = makeRelease("v1.0.0", platform, "x");
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: [os, arch],
    });
    // Windows archives hold knowns.exe in real releases; the stub holds `knowns`, which is enough here.
    expect(r.stdout).toContain(`knowns-${platform}.tar.gz`);
    expect(r.code).toBe(0);
  });

  test("a checksum mismatch aborts the install", () => {
    const sb = makeSandbox();
    const rel = makeRelease("v1.0.0", "linux-x64", "1.0.0");
    writeFileSync(
      join(rel.dir, "v1.0.0", "knowns-linux-x64.tar.gz.sha256"),
      `${"0".repeat(64)}  x\n`,
    );
    const r = runInstall({
      sandbox: sb,
      baseUrl: rel.baseUrl,
      version: "1.0.0",
      uname: ["Linux", "x86_64"],
    });
    expect(r.code).not.toBe(0);
    expect(existsSync(join(sb.home, ".knowns", "bin", "knowns"))).toBe(false);
  });

  // AC2 / D10: --version 0.34.x resolves the existing Go release assets, unchanged names and URLs.
  test("AC2: KNOWNS_VERSION=0.34.1 fetches <base>/v0.34.1/knowns-<platform>.tar.gz (Go release layout)", () => {
    const sb = makeSandbox([".local/bin"]);
    const goRel = makeRelease("v0.34.1", "darwin-arm64", "0.34.1-go");
    // v1.0.0 exists too, with different content: the pin must pick the Go tag, not "latest".
    makeRelease("v1.0.0", "darwin-arm64", "1.0.0-ts", goRel.dir);
    const r = runInstall({
      sandbox: sb,
      baseUrl: goRel.baseUrl,
      version: "0.34.1",
      uname: ["Darwin", "arm64"],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("v0.34.1");
    expect(run([join(sb.home, ".knowns", "bin", "knowns")]).stdout).toBe(
      "knowns version 0.34.1-go\n",
    );
    // Also with an explicit v prefix.
    const sb2 = makeSandbox();
    const r2 = runInstall({
      sandbox: sb2,
      baseUrl: goRel.baseUrl,
      version: "v0.34.1",
      uname: ["Darwin", "arm64"],
    });
    expect(r2.code).toBe(0);
    expect(run([join(sb2.home, ".knowns", "bin", "knowns")]).stdout).toBe(
      "knowns version 0.34.1-go\n",
    );
  });

  test("default download prefix is unchanged without KNOWNS_BASE_URL", () => {
    const src = readFileSync(INSTALL_SH, "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
    expect(src).toContain("${KNOWNS_BASE_URL:-https://github.com/${REPO}/releases/download}");
    expect(src).toContain('REPO="knowns-dev/knowns"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
    expect(src).toContain('ARCHIVE="${BINARY}-${PLATFORM}.tar.gz"');
  });
});

// fakeUname is exercised through runInstall; keep the import used for direct sanity checks.
test.skipIf(!posix)("fakeUname stub answers -s and -m", () => {
  const d = fakeUname("Darwin", "x86_64");
  expect(run([join(d, "uname"), "-s"]).stdout).toBe("Darwin\n");
  expect(run([join(d, "uname"), "-m"]).stdout).toBe("x86_64\n");
});
