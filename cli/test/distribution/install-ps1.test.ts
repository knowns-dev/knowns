// install.ps1 against a fake release mirror, with a temp USERPROFILE. The executed case needs
// Windows and PowerShell, and it is opt-in (CI or KNOWNS_PS1_E2E=1) because install.ps1 writes
// the persistent user PATH through the .NET environment API: harmless on a CI runner, not on a
// developer machine. Elsewhere only the static checks run.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_PS1, makeSandbox, run, sha256Hex, tempDir } from "./install-harness.ts";

const src = readFileSync(INSTALL_PS1, "utf8");
const pwsh = Bun.which("pwsh") ?? Bun.which("powershell");
const runExecuted =
  !!pwsh &&
  process.platform === "win32" &&
  (!!process.env.CI || process.env.KNOWNS_PS1_E2E === "1");

describe("install.ps1 (static)", () => {
  test("maps arm64 and x64 to the win-<arch> release asset", () => {
    expect(src).toContain('"win-$arch"');
    expect(src).toContain('$Archive = "knowns-$Platform.tar.gz"');
  });
  test("KNOWNS_BASE_URL overrides the download prefix; default stays GitHub releases", () => {
    expect(src).toContain("https://github.com/$Repo/releases/download");
    expect(src).toContain("$env:KNOWNS_BASE_URL");
  });
  test("pinned versions get a v prefix so 0.34.x resolves the Go tags", () => {
    expect(src).toContain('if (-not $v.StartsWith("v")) { $v = "v$v" }');
  });
});

// TSR-SCTJSW (contributor PR #157): Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a
// BOM, and 0.34.x `knowns update` could not parse install.json then (issue #155).
const metadataWrite = src
  .split(/\r?\n/)
  .find((l) => l.includes('"install.json"') && /Set-Content|WriteAllText|Out-File/.test(l));

describe("install.ps1 install.json encoding", () => {
  test("install.json is written as UTF-8 without a BOM", () => {
    expect(metadataWrite).toBeDefined();
    expect(metadataWrite).not.toContain("-Encoding UTF8");
    expect(metadataWrite).toContain("New-Object System.Text.UTF8Encoding $false");
  });

  // Runs only the metadata write, in Windows PowerShell 5.1 (the shell `irm | iex` users get):
  // the full script would also edit the persistent user PATH.
  const winps = process.platform === "win32" ? Bun.which("powershell") : null;
  test.skipIf(!winps)("Windows PowerShell 5.1 writes it without a BOM", () => {
    const home = tempDir("ps1-meta");
    const script = [
      `$KnownsHome = '${home.replaceAll("'", "''")}'`,
      `$metadata = @{ method = "script"; version = "1.0.0" }`,
      (metadataWrite as string).trim(),
    ].join("\n");
    const r = run([
      winps as string,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ]);
    expect(r.stderr).toBe("");
    const bytes = readFileSync(join(home, "install.json"));
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(JSON.parse(bytes.toString("utf8")).version).toBe("1.0.0");
  });
});

describe.skipIf(!runExecuted)("install.ps1 (executed)", () => {
  test("installs knowns.exe and kn.exe from a local HTTP mirror into a temp profile", async () => {
    const profile = makeSandbox().home;
    const mirror = tempDir("mirror");
    const stage = tempDir("stage");
    writeFileSync(join(stage, "knowns.exe"), "MZ-fake");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const asset = `knowns-win-${arch}.tar.gz`;
    mkdirSync(join(mirror, "v1.0.0"), { recursive: true });
    const archive = join(mirror, "v1.0.0", asset);
    expect(run(["tar", "-czf", archive, "-C", stage, "knowns.exe"]).code).toBe(0);
    writeFileSync(`${archive}.sha256`, `${sha256Hex(archive)}  ${asset}\n`);

    // Invoke-WebRequest in PowerShell 7 refuses file:// URLs, so serve the mirror over HTTP.
    // The child is spawned async: a sync spawn would block the server's event loop.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = decodeURIComponent(new URL(req.url).pathname);
        const file = Bun.file(join(mirror, path));
        return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
      },
    });
    try {
      const child = Bun.spawn(
        [pwsh as string, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALL_PS1],
        {
          env: {
            ...(process.env as Record<string, string>),
            USERPROFILE: profile,
            KNOWNS_VERSION: "1.0.0",
            KNOWNS_BASE_URL: `http://127.0.0.1:${server.port}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(out + err).toContain("Checksum verified");
      expect(code).toBe(0);
      const bin = join(profile, ".knowns", "bin");
      expect(readFileSync(join(bin, "knowns.exe"), "utf8")).toBe("MZ-fake");
      expect(readFileSync(join(bin, "kn.exe"), "utf8")).toBe("MZ-fake");
      const meta = JSON.parse(
        readFileSync(join(profile, ".knowns", "install.json"), "utf8").replace(/^﻿/, ""),
      );
      expect(meta.version).toBe("1.0.0");
    } finally {
      server.stop(true);
    }
  }, 120_000);
});
