import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { DependencyAdapter, defaultLSPBaseDir } from "../../src/lsp/dependency-adapter.ts";
import {
  currentPlatformID,
  dependencyBinaryPath,
  dependencyVersionID,
  Installer,
  normalizeResolution,
  parseNPMMetadata,
} from "../../src/lsp/installer.ts";
import {
  acquireLanguageInstallLock,
  acquireLanguageInstallLockSync,
} from "../../src/lsp/installer-lock.ts";
import type { RuntimeDependency } from "../../src/lsp/types.ts";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "knowns-installer-"));
  roots.push(d);
  return d;
}
afterAll(() => {
  // temp dirs live under the OS tmpdir; left for the OS to clean
});

const content = Buffer.from("#!/bin/sh\necho hello\n");
const sha = createHash("sha256").update(content).digest("hex");

function serve(body: Buffer | (() => Buffer), delayMs = 0) {
  let count = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      count++;
      if (delayMs) await Bun.sleep(delayMs);
      return new Response(typeof body === "function" ? body() : body);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/x`,
    count: () => count,
    stop: () => server.stop(true),
  };
}

function tarGz(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000755\0", 100);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, data, pad, Buffer.alloc(1024)]));
}

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc32(data), 14);
    l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(nameBuf.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(((name.endsWith("/") ? 0o40755 : 0o100755) << 16) >>> 0, 38);
    c.writeUInt32LE(off, 42);
    locals.push(l, nameBuf, comp);
    centrals.push(c, nameBuf);
    off += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Object.keys(files).length, 8);
  e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

function dep(over: Partial<RuntimeDependency>): RuntimeDependency {
  return {
    id: "v1.0.0",
    platform_id: currentPlatformID(),
    archive_type: "binary",
    binary_name: "test-server",
    ...over,
  };
}

describe("installer", () => {
  test("binary install, status, isInstalled and selection file", async () => {
    const srv = serve(content);
    const base = tmp();
    const inst = new Installer(base);
    const ad = new DependencyAdapter("testlang", [dep({ url: srv.url, sha256: sha })]);
    const path = await inst.install(undefined, ad);
    srv.stop();
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(inst.isInstalled(ad)).toBe(path);
    const st = inst.status(ad);
    expect(st.installed).toBe(true);
    expect(st.source).toBe("binary");
    expect(st.version).toBe("v1.0.0");
    expect(st.selected_path).toBe(path);
    const raw = readFileSync(join(base, "testlang", ".selected.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).slice(0, 5)).toEqual([
      "version",
      "version_id",
      "source",
      "cache_path",
      "selected_path",
    ]);
    expect(parsed.requested_version).toBe("legacy-default");
    expect(raw.startsWith('{\n  "version"')).toBe(true);
  });

  test("sha256 mismatch fails and records the error", async () => {
    const srv = serve(content);
    const base = tmp();
    const inst = new Installer(base);
    const ad = new DependencyAdapter("bad", [dep({ url: srv.url, sha256: "00".repeat(32) })]);
    await expect(inst.install(undefined, ad)).rejects.toThrow("SHA-256 mismatch");
    srv.stop();
    expect(inst.status(ad).install_error).toContain("SHA-256 mismatch");
    expect(readdirSync(join(base, "bad")).filter((n) => n.startsWith(".install-"))).toEqual([]);
  });

  test("tar.gz and zip extraction pick the nested file", async () => {
    const tgz = tarGz("pkg/bin/server", content);
    const s1 = serve(tgz);
    const inst = new Installer(tmp());
    const p1 = await inst.install(
      undefined,
      new DependencyAdapter("tgz", [
        dep({
          url: s1.url,
          sha256: createHash("sha256").update(tgz).digest("hex"),
          archive_type: "tar.gz",
          extract_path: "bin/server",
          binary_name: "server",
        }),
      ]),
    );
    s1.stop();
    expect(readFileSync(p1)).toEqual(content);

    const z = zip({ "dir/": Buffer.alloc(0), "dir/server": content });
    const s2 = serve(z);
    const p2 = await inst.install(
      undefined,
      new DependencyAdapter("zp", [
        dep({
          url: s2.url,
          sha256: createHash("sha256").update(z).digest("hex"),
          archive_type: "zip",
          extract_path: "server",
          binary_name: "server",
        }),
      ]),
    );
    s2.stop();
    expect(readFileSync(p2)).toEqual(content);
  });

  test("nuget package is extracted whole, sha512 verified", async () => {
    const z = zip({ "tools/net/ls.dll": content, "other.txt": Buffer.from("x") });
    const s = serve(z);
    const sha512 = createHash("sha512").update(z).digest("base64");
    const inst = new Installer(tmp());
    const p = await inst.install(
      undefined,
      new DependencyAdapter("nu", [
        dep({
          url: s.url,
          source: "nuget",
          archive_type: "nupkg",
          sha512,
          extract_path: "tools/net/ls.dll",
          binary_name: "ls.dll",
          package_name: "Pkg",
          version: "1.2.3",
        }),
      ]),
    );
    s.stop();
    expect(readFileSync(p)).toEqual(content);
    expect(existsSync(join(p, "..", "..", "..", "other.txt"))).toBe(true);
    const bad = serve(z);
    await expect(
      inst.install(
        undefined,
        new DependencyAdapter("nu2", [
          dep({
            url: bad.url,
            source: "nuget",
            archive_type: "nupkg",
            sha512: Buffer.alloc(64).toString("base64"),
            extract_path: "tools/net/ls.dll",
            binary_name: "ls.dll",
            package_name: "Pkg",
            version: "1.2.3",
          }),
        ]),
      ),
    ).rejects.toThrow("SHA-512 mismatch");
    bad.stop();
  });

  test("npm install uses the managed cache and resolves recommended provenance", async () => {
    const base = tmp();
    const inst = new Installer(base);
    const calls: string[][] = [];
    inst.runCommand = async (_ctx, name, ...args) => {
      calls.push([name, ...args]);
      if (args[0] === "view")
        return JSON.stringify({ version: "1.2.3", "dist.integrity": "sha512-abc" });
      const prefix = args[args.indexOf("--prefix") + 1] ?? "";
      const bin = join(prefix, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, process.platform === "win32" ? "ts-ls.cmd" : "ts-ls"), "x");
      return "";
    };
    const ad = new DependencyAdapter("npmlang", [
      dep({
        source: "npm",
        archive_type: "npm",
        package_name: "ts-ls",
        binary_name: "ts-ls",
        recommended_version: "1.2.3",
        recommended_integrity: "sha512-abc",
      }),
    ]);
    const p = await inst.install(undefined, ad);
    expect(p).toContain(join("node_modules", ".bin"));
    expect(calls[0]).toEqual(["npm", "view", "ts-ls@1.2.3", "version", "dist.integrity", "--json"]);
    const st = inst.status(ad);
    expect(st.verified).toBe(true);
    expect(st.requested_version).toBe("recommended");
    expect(st.resolved_version).toBe("1.2.3");
    expect(st.source_location).toBe("ts-ls@1.2.3");
  });

  test("npm install failure records install_error", async () => {
    const inst = new Installer(tmp());
    inst.runCommand = async () => {
      const e = new Error("exit status 1") as Error & { output?: string };
      e.output = "boom\n";
      throw e;
    };
    const ad = new DependencyAdapter("npmbad", [
      dep({ source: "npm", archive_type: "npm", package_name: "x", binary_name: "x" }),
    ]);
    await expect(inst.install(undefined, ad)).rejects.toThrow(
      "npm install failed: exit status 1: boom",
    );
    expect(inst.status(ad).install_error).toContain("boom");
  });

  test("concurrent installs of one language download once", async () => {
    const s = serve(content, 100);
    const inst = new Installer(tmp());
    const ad = new DependencyAdapter("conc", [dep({ url: s.url, sha256: sha })]);
    const [a, b] = await Promise.all([inst.install(undefined, ad), inst.install(undefined, ad)]);
    s.stop();
    expect(a).toBe(b);
    expect(s.count()).toBe(1);
  });

  test("independent installers serialize and coalesce through the file lock", async () => {
    const s = serve(content, 100);
    const base = tmp();
    const ad = new DependencyAdapter("lockd", [dep({ url: s.url, sha256: sha })]);
    const [a, b] = await Promise.all([
      new Installer(base).install(undefined, ad),
      new Installer(base).install(undefined, ad),
    ]);
    s.stop();
    expect(a).toBe(b);
    expect(s.count()).toBe(1);
  });

  test("failed beforeCleanup rolls back and restores the previous selection", async () => {
    const s1 = serve(content);
    const base = tmp();
    const inst = new Installer(base);
    const v1 = dep({ id: "v1", url: s1.url, sha256: sha });
    const p1 = await inst.install(undefined, new DependencyAdapter("roll", [v1]));
    s1.stop();
    const before = readFileSync(join(base, "roll", ".selected.json"), "utf8");
    const other = Buffer.from("other");
    const s2 = serve(other);
    const v2 = dep({
      id: "v2",
      url: s2.url,
      sha256: createHash("sha256").update(other).digest("hex"),
    });
    await expect(
      inst.installWithOptions(undefined, new DependencyAdapter("roll", [v2]), {
        selector: {},
        beforeCleanup: () => {
          throw new Error("refresh failed");
        },
      }),
    ).rejects.toThrow("refresh failed");
    s2.stop();
    expect(readFileSync(join(base, "roll", ".selected.json"), "utf8")).toBe(before);
    expect(existsSync(p1)).toBe(true);
    expect(inst.status(new DependencyAdapter("roll", [v2])).install_error).toContain(
      "refresh failed",
    );
  });

  test("conflicting selectors are rejected", async () => {
    const inst = new Installer(tmp());
    await expect(
      inst.installWithOptions(undefined, new DependencyAdapter("c", [dep({})]), {
        selector: { latest: true, version: "1" },
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  test("cleanup is a no-op without a selection, then keeps only the selected version", async () => {
    const base = tmp();
    const inst = new Installer(base);
    const lang = join(base, "cleantest");
    for (const d of ["server-v1.0.0", "server-v2.0.0", "server-v3.0.0"]) {
      mkdirSync(join(lang, d), { recursive: true });
      writeFileSync(join(lang, d, "server"), "bin");
    }
    inst.cleanup("cleantest");
    expect(readdirSync(lang).length).toBe(3);
    const ad = new DependencyAdapter("cleantest", [dep({ id: "v3.0.0", binary_name: "server" })]);
    const selected = join(lang, "server-v3.0.0", "server");
    writeFileSync(
      join(lang, ".selected.json"),
      JSON.stringify({
        version: "v3.0.0",
        version_id: "v3.0.0",
        source: "binary",
        cache_path: join(lang, "server-v3.0.0"),
        selected_path: selected,
        verified: false,
      }),
    );
    expect(inst.status(ad).cleanup_eligible).toBe(true);
    inst.cleanup("cleantest");
    expect(
      readdirSync(lang, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    ).toEqual(["server-v3.0.0"]);
    inst.remove("cleantest");
    expect(existsSync(lang)).toBe(false);
  });

  test("legacy selection without provenance still reads", () => {
    const base = tmp();
    const lang = join(base, "legacy");
    mkdirSync(lang, { recursive: true });
    const sel = join(lang, "s-1", "s");
    mkdirSync(join(lang, "s-1"));
    writeFileSync(sel, "x");
    writeFileSync(
      join(lang, ".selected.json"),
      JSON.stringify({
        version: "1",
        version_id: "1",
        source: "binary",
        cache_path: join(lang, "s-1"),
        selected_path: sel,
        verified: false,
      }),
    );
    const st = new Installer(base).status(
      new DependencyAdapter("legacy", [dep({ binary_name: "s" })]),
    );
    expect(st.installed).toBe(true);
    expect(st.resolved_version).toBe("1");
  });

  test("missing platform dependency is reported as install_error", () => {
    const st = new Installer(tmp()).status(
      new DependencyAdapter("none", [dep({ platform_id: "plan9-mips" })]),
    );
    expect(st.install_error).toContain("no runtime dependency for platform");
    expect(st.installable).toBe(true);
  });
});

describe("pure helpers", () => {
  test("currentPlatformID matches GOOS-GOARCH", () => {
    expect(currentPlatformID()).toMatch(/^(darwin|linux|windows)-(amd64|arm64)$/);
  });
  test("windows npm shim and exe suffix", () => {
    expect(dependencyBinaryPath("/v", { source: "npm", binary_name: "x" }, "windows")).toContain(
      "x.cmd",
    );
    expect(dependencyBinaryPath("/v", { binary_name: "x" }, "windows")).toEndWith("x.exe");
    expect(dependencyBinaryPath("/v", { binary_name: "x" }, "linux")).toEndWith("x");
  });
  test("version ids preserve simple ids and avoid collisions", () => {
    expect(dependencyVersionID({ version: "v1.2.3" })).toBe("v1.2.3");
    const a = dependencyVersionID({ version: "a/b" });
    const b = dependencyVersionID({ version: "a_b" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^a_b-[0-9a-f]{12}$/);
  });
  test("npm metadata supports dotted, nested and array forms", () => {
    expect(parseNPMMetadata('{"version":"1","dist.integrity":"i"}')).toEqual(["1", "i"]);
    expect(parseNPMMetadata('{"version":"1","dist":{"integrity":"i"}}')).toEqual(["1", "i"]);
    expect(parseNPMMetadata('["1",{"version":"2","dist.integrity":"j"}]')).toEqual(["2", "j"]);
  });
  test("normalizeResolution derives verified from pinned integrity and rejects mismatch", () => {
    const orig = dep({
      recommended_version: "1",
      recommended_integrity: "sha256:AB",
      sha256: "ab",
      version: "1",
    });
    const r = normalizeResolution(
      orig,
      {},
      {
        dependency: { ...orig },
        requested_version: "",
        resolved_version: "1",
        source: "",
        verified: false,
      },
    );
    expect(r.verified).toBe(true);
    expect(r.requested_version).toBe("recommended");
    expect(() =>
      normalizeResolution(
        { ...orig, recommended_integrity: "sha256:ff" },
        {},
        {
          dependency: { ...orig },
          requested_version: "",
          resolved_version: "1",
          source: "",
          verified: false,
        },
      ),
    ).toThrow("integrity mismatch");
  });
  test("defaultLSPBaseDir ends with .knowns/lsp-servers", () => {
    expect(defaultLSPBaseDir().replaceAll("\\", "/")).toEndWith(".knowns/lsp-servers");
  });
});

describe("install lock", () => {
  test("second acquirer waits, stale owner is taken over", async () => {
    const base = tmp();
    const first = await acquireLanguageInstallLock(undefined, base, "go");
    expect(first.waited).toBe(false);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await expect(acquireLanguageInstallLock(ac.signal, base, "go")).rejects.toThrow(
      "lock install for go",
    );
    first.unlock();
    const again = await acquireLanguageInstallLock(undefined, base, "go");
    again.unlock();
    // stale: a lock file naming a dead pid
    const locks = join(base, ".locks");
    const f = `${createHash("sha256").update("go").digest("hex")}.tslock`;
    writeFileSync(join(locks, f), "2147483000");
    const stolen = acquireLanguageInstallLockSync(base, "go", 2000);
    expect(stolen.waited).toBe(true);
    stolen.unlock();
  });
});
