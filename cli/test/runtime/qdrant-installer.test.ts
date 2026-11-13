// qdrant-installer.ts against Go's installer.go: pinned artifact table, Go's error texts, mirror
// rules, redirect policy, tar extraction guards and the "no half-installed runtime" guarantee.
// The pinned checksums cannot match a fake archive, so tests swap the artifact table the way Go's
// own tests swap supportedArtifacts. Downloads go to a real local HTTP server; the injected fetch
// only rewrites the https mirror host to it (the mirror must be https, the server is plain http).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { goNotExistReason } from "../../src/platform/goerror.ts";
import { pathsForRoot, SUPPORTED_QDRANT_VERSION } from "../../src/runtime/qdrant.ts";
import {
  extractBinary,
  MAX_QDRANT_BINARY_BYTES,
  type QdrantArtifact,
  QdrantInstaller,
  qdrantArtifactFor,
  qdrantRedirectPolicy,
  unsafeArchivePath,
} from "../../src/runtime/qdrant-installer.ts";

const dirs: string[] = [];
const servers: Array<{ stop(): void } | Server> = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "qdrant-inst-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const s of servers.splice(0)) {
    if ("stop" in s) s.stop();
    else s.close();
  }
});

interface TarSpec {
  name: string;
  type?: string;
  size?: number;
  body?: Buffer;
  link?: string;
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(spec: TarSpec): Buffer {
  const block = Buffer.alloc(512);
  const body = spec.body ?? Buffer.alloc(0);
  block.write(spec.name, 0, 100, "utf8");
  block.write(octal(0o755, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  block.write(octal(spec.size ?? body.length, 12), 124, "latin1");
  block.write(octal(0, 12), 136, "latin1");
  block.fill(0x20, 148, 156);
  block.write(spec.type ?? "0", 156, "latin1");
  if (spec.link) block.write(spec.link, 157, 100, "utf8");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  let sum = 0;
  for (const b of block) sum += b;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function tarBytes(specs: TarSpec[], opts: { trailer?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    parts.push(tarHeader(spec));
    const body = spec.body ?? Buffer.alloc(0);
    if (body.length > 0) {
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  if (opts.trailer !== false) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function archiveOf(binary: Buffer, name = "qdrant"): Buffer {
  return gzipSync(tarBytes([{ name, body: binary }]));
}

/** A single-entry zip (deflate, or stored with method 0), the shape of Qdrant's Windows asset. */
function zipOf(binary: Buffer, name = "qdrant.exe", method: 0 | 8 = 8): Buffer {
  const data = method === 8 ? deflateRawSync(binary) : binary;
  const nameBuf = Buffer.from(name);
  const crc = crc32(binary);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(binary.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(binary.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const centralOffset = local.length + nameBuf.length + data.length;
  const centralSize = central.length + nameBuf.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function artifactTable(archive: Buffer, name = "test-qdrant.tar.gz") {
  const a: QdrantArtifact = { os: "darwin", arch: "arm64", filename: name, sha256: sha(archive) };
  return { "darwin/arm64": a } as Record<string, QdrantArtifact>;
}

/** Serves `files` over plain HTTP; the returned fetch rewrites https://mirror.test to it. */
function serve(
  files: Record<string, { body: Buffer; status?: number; headers?: Record<string, string> }>,
) {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      const f = files[path];
      if (!f) return new Response("nope", { status: 404 });
      return new Response(f.body, { status: f.status ?? 200, headers: f.headers });
    },
  });
  servers.push(server);
  const rewrite: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return fetch(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  return { rewrite, hits, port: server.port as number };
}

function makeInstaller(
  root: string,
  over: Partial<ConstructorParameters<typeof QdrantInstaller>[0]>,
) {
  return new QdrantInstaller({ root, goos: "darwin", goarch: "arm64", ...over });
}

function leftovers(root: string): string[] {
  return existsSync(root) ? readdirSync(root).filter((n) => n.startsWith("install-")) : [];
}

describe("pinned artifact table", () => {
  test("matches installer.go", () => {
    expect(SUPPORTED_QDRANT_VERSION).toBe("1.14.1");
    expect(qdrantArtifactFor("darwin", "arm64")?.filename).toBe(
      "qdrant-aarch64-apple-darwin.tar.gz",
    );
    expect(qdrantArtifactFor("darwin", "amd64")?.sha256).toBe(
      "fac93bfd88f019afa312d9248d913a07fb68fe5b498b6927a26d699f865d9eb8",
    );
    expect(qdrantArtifactFor("linux", "amd64")?.filename).toBe(
      "qdrant-x86_64-unknown-linux-gnu.tar.gz",
    );
    expect(qdrantArtifactFor("linux", "arm64")?.filename).toBe(
      "qdrant-aarch64-unknown-linux-musl.tar.gz",
    );
    // D14 (spec qdrant-setup-wizard D5): not in Go 0.34.1.
    expect(qdrantArtifactFor("windows", "amd64")).toEqual({
      os: "windows",
      arch: "amd64",
      filename: "qdrant-x86_64-pc-windows-msvc.zip",
      sha256: "52f3e58a73709b81f13b035fac144089b7317da259ae2e6e71c949c536081854",
    });
    expect(qdrantArtifactFor("windows", "arm64")).toBeUndefined();
  });

  test("unsupported platform fails with Go's text before touching disk", async () => {
    const root = join(tmp(), "rt");
    for (const [goos, goarch] of [
      ["plan9", "mips"],
      ["windows", "arm64"],
    ] as const) {
      await expect(makeInstaller(root, { goos, goarch }).install()).rejects.toThrow(
        `unsupported Qdrant platform ${goos}/${goarch}; configure an external Qdrant endpoint or run \`knowns qdrant setup\``,
      );
    }
    expect(existsSync(root)).toBe(false);
  });
});

describe("windows zip artifact", () => {
  for (const method of [8, 0] as const) {
    test(`installs qdrant.exe from a zip (method ${method})`, async () => {
      const zip = zipOf(Buffer.from("windows-binary"), "qdrant.exe", method);
      const { rewrite } = serve({ "/mirror/w.zip": { body: zip } });
      const root = tmp();
      const artifacts = {
        "windows/amd64": { os: "windows", arch: "amd64", filename: "w.zip", sha256: sha(zip) },
      };
      const paths = await makeInstaller(root, {
        goos: "windows",
        goarch: "amd64",
        mirror: "https://mirror.test/mirror/",
        fetch: rewrite,
        artifacts,
      }).install();
      expect(readFileSync(paths.binaryPath, "utf8")).toBe("windows-binary");
      const manifest = JSON.parse(readFileSync(join(root, "install.json"), "utf8"));
      expect(manifest).toEqual({ version: "1.14.1", sha256: sha(zip), artifact: "w.zip" });
      expect(leftovers(root)).toEqual([]);
    });
  }

  test("a zip whose entry is corrupted fails the crc check", async () => {
    const zip = zipOf(Buffer.from("windows-binary"), "qdrant.exe", 0);
    const at = 30 + "qdrant.exe".length;
    zip.writeUInt8((zip.readUInt8(at) ^ 0xff) & 0xff, at);
    const dir = tmp();
    const archive = join(dir, "bad.zip");
    writeFileSync(archive, zip);
    await expect(extractBinary(archive, join(dir, "q.exe"))).rejects.toThrow("zip: checksum error");
  });

  test("a zip without qdrant.exe fails", async () => {
    const dir = tmp();
    const archive = join(dir, "other.zip");
    writeFileSync(archive, zipOf(Buffer.from("x"), "readme.txt"));
    await expect(extractBinary(archive, join(dir, "q.exe"))).rejects.toThrow();
  });

  // The real 25 MB release asset, when a copy is at hand (KNOWNS_QDRANT_WIN_ZIP=<path>).
  const real = process.env.KNOWNS_QDRANT_WIN_ZIP;
  test.skipIf(!real || !existsSync(real))(
    "the pinned release zip verifies and extracts",
    async () => {
      const file = real as string;
      const pinned = qdrantArtifactFor("windows", "amd64") as QdrantArtifact;
      expect(sha(readFileSync(file))).toBe(pinned.sha256);
      const dst = join(tmp(), "qdrant.exe");
      await extractBinary(file, dst);
      const exe = readFileSync(dst);
      expect(exe.length).toBe(75_142_144);
      expect(exe.subarray(0, 2).toString()).toBe("MZ");
    },
    60_000,
  );
});

describe("install over http", () => {
  test("downloads, verifies, extracts, activates and writes install.json", async () => {
    const archive = archiveOf(Buffer.from("new-binary"));
    const { rewrite, hits } = serve({ "/mirror/test-qdrant.tar.gz": { body: archive } });
    const root = tmp();
    const paths = await makeInstaller(root, {
      mirror: "https://mirror.test/mirror/",
      fetch: rewrite,
      artifacts: artifactTable(archive),
    }).install();
    expect(hits).toEqual(["/mirror/test-qdrant.tar.gz"]);
    expect(paths).toEqual(pathsForRoot(root));
    expect(readFileSync(paths.binaryPath, "utf8")).toBe("new-binary");
    if (process.platform !== "win32") {
      expect(statSync(paths.binaryPath).mode & 0o777).toBe(0o755);
      expect(statSync(join(root, "install.json")).mode & 0o777).toBe(0o644);
    }
    expect(readFileSync(join(root, "install.json"), "utf8")).toBe(
      `{\n  "version": "1.14.1",\n  "sha256": "${sha(archive)}",\n  "artifact": "test-qdrant.tar.gz"\n}`,
    );
    expect(leftovers(root)).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(["bin", "install.json"]);
  });

  test("a verified manifest and binary are reused without any download", async () => {
    const archive = archiveOf(Buffer.from("new-binary"));
    const { rewrite, hits } = serve({ "/test-qdrant.tar.gz": { body: archive } });
    const root = tmp();
    const opts = {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: artifactTable(archive),
    };
    await makeInstaller(root, opts).install();
    await makeInstaller(root, opts).install();
    expect(hits.length).toBe(1);
  });

  test("replacing an install preserves the previous binary as .previous", async () => {
    const archive = archiveOf(Buffer.from("new-binary"));
    const { rewrite } = serve({ "/test-qdrant.tar.gz": { body: archive } });
    const root = tmp();
    const paths = pathsForRoot(root);
    mkdirSync(paths.binDir, { recursive: true });
    writeFileSync(paths.binaryPath, "old-binary", { mode: 0o755 });
    await makeInstaller(root, {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: artifactTable(archive),
    }).install();
    expect(readFileSync(paths.binaryPath, "utf8")).toBe("new-binary");
    expect(readFileSync(`${paths.binaryPath}.previous`, "utf8")).toBe("old-binary");
  });

  // The next two go beyond Go: Go's installer has the same races, the port closes them.
  test("two concurrent installs download once, both succeed and leave no lock", async () => {
    const archive = archiveOf(Buffer.from("new-binary"));
    const { rewrite, hits } = serve({ "/test-qdrant.tar.gz": { body: archive } });
    const root = tmp();
    const opts = {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: artifactTable(archive),
    };
    const [a, b] = await Promise.all([
      makeInstaller(root, opts).install(),
      makeInstaller(root, opts).install(),
    ]);
    expect(a).toEqual(b);
    expect(hits.length).toBe(1);
    expect(readFileSync(a.binaryPath, "utf8")).toBe("new-binary");
    expect(readdirSync(root).sort()).toEqual(["bin", "install.json"]);
  });

  test("a crash between the two activation renames is recovered from .previous", async () => {
    const archive = archiveOf(Buffer.from("new-binary"));
    const { rewrite, hits } = serve({ "/test-qdrant.tar.gz": { body: archive } });
    const root = tmp();
    const opts = {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: artifactTable(archive),
    };
    const paths = await makeInstaller(root, opts).install();
    // bin/qdrant moved aside, the new one never moved in: only the backup is left.
    renameSync(paths.binaryPath, `${paths.binaryPath}.previous`);
    await makeInstaller(root, opts).install();
    expect(readFileSync(paths.binaryPath, "utf8")).toBe("new-binary");
    expect(hits.length).toBe(1);
  });

  test("a lock left by a dead installer is taken over", async () => {
    const archive = archiveOf(Buffer.from("new-binary"));
    const { rewrite } = serve({ "/test-qdrant.tar.gz": { body: archive } });
    const root = tmp();
    // A pid that existed and is gone: a finished child process.
    const dead = Bun.spawnSync([process.execPath, "-e", "0"]).pid;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "install.lock"), String(dead));
    const opts = {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: artifactTable(archive),
    };
    const outcome = await Promise.race([
      makeInstaller(root, opts)
        .install()
        .then(() => "installed"),
      Bun.sleep(5000).then(() => "still waiting on the dead lock"),
    ]);
    expect(outcome).toBe("installed");
    expect(existsSync(join(root, "install.lock"))).toBe(false);
  });

  test("checksum mismatch fails with Go's text and leaves nothing installed", async () => {
    const archive = archiveOf(Buffer.from("new-binary"));
    const table = artifactTable(archive);
    const bad = Buffer.from("not the pinned bytes");
    const { rewrite } = serve({ "/test-qdrant.tar.gz": { body: bad } });
    const root = tmp();
    const err = await makeInstaller(root, {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: table,
    })
      .install()
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(
      `verify pinned Qdrant 1.14.1 checksum: checksum mismatch: got ${sha(bad)} want ${sha(archive)}`,
    );
    expect(readdirSync(root)).toEqual([]);
  });

  test("a failed re-install keeps the working install untouched", async () => {
    const good = archiveOf(Buffer.from("v1"));
    const root = tmp();
    const table = artifactTable(good);
    const ok = serve({ "/test-qdrant.tar.gz": { body: good } });
    await makeInstaller(root, {
      mirror: "https://mirror.test",
      fetch: ok.rewrite,
      artifacts: table,
    }).install();
    // Force a re-install by invalidating the manifest, then serve bad bytes.
    writeFileSync(join(root, "install.json"), "{}");
    const bad = serve({ "/test-qdrant.tar.gz": { body: Buffer.from("corrupt") } });
    await expect(
      makeInstaller(root, {
        mirror: "https://mirror.test",
        fetch: bad.rewrite,
        artifacts: table,
      }).install(),
    ).rejects.toThrow("checksum mismatch");
    expect(readFileSync(pathsForRoot(root).binaryPath, "utf8")).toBe("v1");
    expect(leftovers(root)).toEqual([]);
  });

  test("HTTP errors use Go's status text", async () => {
    const { rewrite } = serve({});
    const root = tmp();
    await expect(
      makeInstaller(root, { mirror: "https://mirror.test", fetch: rewrite }).install(),
    ).rejects.toThrow("download Qdrant from mirror returned 404 Not Found");
    expect(readdirSync(root)).toEqual([]);
  });

  test("an unreachable mirror reports the offline/proxy hint", async () => {
    const root = tmp();
    const failing = (() =>
      Promise.reject(new Error("proxy unavailable"))) as unknown as typeof fetch;
    await expect(makeInstaller(root, { fetch: failing }).install()).rejects.toThrow(
      'download Qdrant (check offline/proxy/mirror settings): Get "https://github.com/qdrant/qdrant/releases/download/v1.14.1/qdrant-aarch64-apple-darwin.tar.gz": proxy unavailable',
    );
    expect(readdirSync(root)).toEqual([]);
  });

  test("a truncated download fails with unexpected EOF and leaves no half-installed runtime", async () => {
    const archive = archiveOf(randomBytes(2_000_000));
    const half = archive.subarray(0, Math.floor(archive.length / 2));
    // A raw socket server that promises the full length and hangs up early.
    const server = createServer((sock) => {
      sock.once("data", () => {
        const head = `HTTP/1.1 200 OK\r\nContent-Length: ${archive.length}\r\nConnection: close\r\n\r\n`;
        sock.write(head);
        setTimeout(() => sock.end(half), 50);
      });
      sock.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const rewrite: typeof fetch = ((input: string) =>
      fetch(`http://127.0.0.1:${port}${new URL(input).pathname}`)) as unknown as typeof fetch;
    const root = tmp();
    const err = await makeInstaller(root, {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: artifactTable(archive),
    })
      .install()
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("unexpected EOF");
    expect(readdirSync(root)).toEqual([]);
  });

  test("an interrupted extraction (truncated tar stream) leaves no half-installed runtime", async () => {
    // Pinned to the truncated bytes, so the checksum passes and extraction is what fails.
    const full = tarBytes([{ name: "qdrant", body: Buffer.alloc(100_000, 3) }]);
    const truncated = gzipSync(full.subarray(0, 40_000));
    const { rewrite } = serve({ "/test-qdrant.tar.gz": { body: truncated } });
    const root = tmp();
    const err = await makeInstaller(root, {
      mirror: "https://mirror.test",
      fetch: rewrite,
      artifacts: artifactTable(truncated),
    })
      .install()
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("extract verified Qdrant artifact: unexpected EOF");
    expect(readdirSync(root)).toEqual([]);
  });

  test("a gzip stream cut mid-way fails the same way", async () => {
    const whole = archiveOf(Buffer.alloc(300_000, 9));
    const cut = whole.subarray(0, whole.length - 50);
    const { rewrite } = serve({ "/test-qdrant.tar.gz": { body: cut } });
    const root = tmp();
    await expect(
      makeInstaller(root, {
        mirror: "https://mirror.test",
        fetch: rewrite,
        artifacts: artifactTable(cut),
      }).install(),
    ).rejects.toThrow("extract verified Qdrant artifact: unexpected EOF");
    expect(readdirSync(root)).toEqual([]);
  });

  test("oversize Content-Length is refused before reading the body", async () => {
    const { rewrite } = serve({
      "/qdrant-aarch64-apple-darwin.tar.gz": { body: Buffer.from("x") },
    });
    const huge = ((input: string, init?: RequestInit) =>
      rewrite(input, init).then(
        (r) =>
          new Response(r.body, {
            status: 200,
            headers: { "content-length": String(600 << 20) },
          }),
      )) as unknown as typeof fetch;
    const root = tmp();
    await expect(
      makeInstaller(root, { mirror: "https://mirror.test", fetch: huge }).install(),
    ).rejects.toThrow(`Qdrant artifact exceeds ${512 << 20} bytes`);
  });
});

describe("redirects", () => {
  const redirect = (to: string): Response =>
    new Response(null, { status: 302, headers: { location: to } });

  test("same-host https redirect is followed", async () => {
    const archive = archiveOf(Buffer.from("bin"));
    let n = 0;
    const f = (async (input: string) => {
      n++;
      if (input.endsWith("/a/test-qdrant.tar.gz")) return redirect("https://mirror.test/b/x.tgz");
      return new Response(archive);
    }) as unknown as typeof fetch;
    const root = tmp();
    await makeInstaller(root, {
      mirror: "https://mirror.test/a",
      fetch: f,
      artifacts: artifactTable(archive),
    }).install();
    expect(n).toBe(2);
  });

  test("downgrade, other hosts, userinfo and queries are rejected with Go's texts", async () => {
    const cases: Array<[string, string]> = [
      ["http://mirror.test/x", "Qdrant download redirect must remain HTTPS"],
      ["https://evil.test/x", "Qdrant download redirect to unapproved host evil.test"],
      [
        "https://u:p@mirror.test/x",
        "Qdrant download redirect must not contain userinfo, query, or fragment",
      ],
      [
        "https://mirror.test/x?sig=1",
        "Qdrant download redirect must not contain userinfo, query, or fragment",
      ],
    ];
    for (const [to, want] of cases) {
      const root = tmp();
      const f = (async () => redirect(to)) as unknown as typeof fetch;
      const err = await makeInstaller(root, { mirror: "https://mirror.test", fetch: f })
        .install()
        .catch((e: Error) => e);
      expect((err as Error).message).toBe(
        `download Qdrant (check offline/proxy/mirror settings): Get "https://mirror.test/qdrant-aarch64-apple-darwin.tar.gz": ${want}`,
      );
      expect(readdirSync(root)).toEqual([]);
    }
  });

  test("policy lets github.com hop to the signed release-assets host", () => {
    const policy = qdrantRedirectPolicy(new URL("https://github.com/qdrant/x.tar.gz"));
    const first = [new URL("https://github.com/qdrant/x.tar.gz")];
    expect(() =>
      policy(new URL("https://release-assets.githubusercontent.com/a?sig=abc"), first),
    ).not.toThrow();
    expect(() => policy(new URL("https://github.com/other?sig=abc"), first)).toThrow(
      "must not contain userinfo, query, or fragment",
    );
    expect(() => policy(new URL("https://objects.example.com/a"), first)).toThrow(
      "unapproved host objects.example.com",
    );
  });
});

describe("mirror rules", () => {
  const cases: Array<[string, string]> = [
    ["http://mirror.test", "Qdrant mirror must be HTTPS or file:// local path"],
    ["/some/dir", "Qdrant mirror must be HTTPS or file:// local path"],
    ["ftp://mirror.test", "Qdrant mirror must be HTTPS or file:// local path"],
    ["https:///nohost", "Qdrant mirror must be HTTPS or file:// local path"],
    ["file://remote-host/dir", "Qdrant local mirror must use a local file:// path"],
    [
      "https://user:pw@mirror.test",
      "Qdrant HTTPS mirror URL must not contain userinfo, query, or fragment",
    ],
    [
      "https://mirror.test?x=1",
      "Qdrant HTTPS mirror URL must not contain userinfo, query, or fragment",
    ],
    [
      "https://mirror.test#frag",
      "Qdrant HTTPS mirror URL must not contain userinfo, query, or fragment",
    ],
  ];
  for (const [mirror, want] of cases) {
    test(`rejects ${mirror}`, async () => {
      const root = tmp();
      await expect(makeInstaller(root, { mirror }).install()).rejects.toThrow(want);
      expect(readdirSync(root)).toEqual([]);
    });
  }

  test("file:// mirror installs, and a missing artifact reads like Go", async () => {
    const archive = archiveOf(Buffer.from("from-file"));
    const dir = tmp();
    const url =
      process.platform === "win32" ? `file:///${dir.replaceAll("\\", "/")}` : `file://${dir}`;
    const root = tmp();
    const opts = { mirror: url, artifacts: artifactTable(archive) };
    await expect(makeInstaller(root, opts).install()).rejects.toThrow(
      `read Qdrant local mirror ${join(dir, "test-qdrant.tar.gz")}: open ${join(dir, "test-qdrant.tar.gz")}: ${goNotExistReason(true)}`,
    );
    writeFileSync(join(dir, "test-qdrant.tar.gz"), archive);
    const paths = await makeInstaller(root, opts).install();
    expect(readFileSync(paths.binaryPath, "utf8")).toBe("from-file");
    expect(leftovers(root)).toEqual([]);
  });

  test("file:// checksum mismatch (Go's own case)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "qdrant-aarch64-apple-darwin.tar.gz"), "bad");
    const root = tmp();
    const url =
      process.platform === "win32" ? `file:///${dir.replaceAll("\\", "/")}` : `file://${dir}`;
    await expect(makeInstaller(root, { mirror: url }).install()).rejects.toThrow(
      "checksum mismatch",
    );
  });
});

describe("extractBinary guards", () => {
  async function extract(specs: TarSpec[], opts?: { trailer?: boolean }): Promise<Error | string> {
    const dir = tmp();
    const archive = join(dir, "bad.tar.gz");
    writeFileSync(archive, gzipSync(tarBytes(specs, opts)));
    const dst = join(dir, "qdrant");
    try {
      await extractBinary(archive, dst);
      return readFileSync(dst, "utf8");
    } catch (e) {
      return e as Error;
    }
  }
  const msg = (r: Error | string) => (typeof r === "string" ? r : r.message);

  test("rejects unsafe, link, non-regular, duplicate and oversize entries (Go's table)", async () => {
    expect(msg(await extract([{ name: "../qdrant", body: Buffer.from("x") }]))).toBe(
      'unsafe archive path "../qdrant"',
    );
    expect(msg(await extract([{ name: "qdrant", type: "2", link: "/bin/sh" }]))).toBe(
      'archive links are not allowed: "qdrant"',
    );
    expect(msg(await extract([{ name: "qdrant", type: "1", link: "other" }]))).toContain(
      "links are not allowed",
    );
    expect(msg(await extract([{ name: "qdrant", type: "5" }]))).toBe(
      "qdrant archive entry must be a regular file",
    );
    expect(
      msg(
        await extract([
          { name: "qdrant", body: Buffer.from("a") },
          { name: "nested/qdrant", body: Buffer.from("b") },
        ]),
      ),
    ).toBe("duplicate qdrant binary entries in archive");
    expect(msg(await extract([{ name: "qdrant", size: MAX_QDRANT_BINARY_BYTES + 1 }]))).toBe(
      `qdrant binary exceeds ${MAX_QDRANT_BINARY_BYTES} bytes`,
    );
    expect(msg(await extract([{ name: "other", body: Buffer.from("x") }]))).toBe(
      "qdrant binary missing from archive",
    );
    expect(msg(await extract([{ name: "C:/qdrant", body: Buffer.from("x") }]))).toContain(
      "unsafe archive path",
    );
  });

  test("finds qdrant in a subdirectory and skips other entries with data", async () => {
    const out = await extract([
      { name: "README", body: Buffer.alloc(1500, 1) },
      { name: "dist/", type: "5" },
      { name: "dist/qdrant", body: Buffer.from("payload") },
      { name: "dist/config.yaml", body: Buffer.from("x") },
    ]);
    expect(out).toBe("payload");
  });

  test("a bad header checksum is Go's invalid tar header", async () => {
    const dir = tmp();
    const raw = tarBytes([{ name: "qdrant", body: Buffer.from("x") }]);
    raw[0] = raw[0] === 65 ? 66 : 65;
    const archive = join(dir, "a.tar.gz");
    writeFileSync(archive, gzipSync(raw));
    await expect(extractBinary(archive, join(dir, "q"))).rejects.toThrow(
      "archive/tar: invalid tar header",
    );
  });

  test("not gzip at all", async () => {
    const dir = tmp();
    const archive = join(dir, "a.tar.gz");
    writeFileSync(archive, "this is not gzip data at all");
    await expect(extractBinary(archive, join(dir, "q"))).rejects.toThrow("gzip: invalid header");
  });

  test("reads PAX path and size overrides and GNU long names like Go", async () => {
    const long = `${"d".repeat(120)}/qdrant`;
    const pax = (k: string, v: string) => {
      const rest = ` ${k}=${v}\n`;
      let len = rest.length + 1;
      if (String(len).length + rest.length !== len) len = String(len + 1).length + rest.length;
      return Buffer.from(`${len}${rest}`);
    };
    const paxBody = pax("path", long);
    const raw = Buffer.concat([
      tarHeader({ name: "PaxHeader", type: "x", body: paxBody }),
      paxBody,
      Buffer.alloc((512 - (paxBody.length % 512)) % 512),
      tarBytes([{ name: "placeholder", body: Buffer.from("via-pax") }]),
    ]);
    const dir = tmp();
    const archive = join(dir, "a.tar.gz");
    writeFileSync(archive, gzipSync(raw));
    await extractBinary(archive, join(dir, "q"));
    expect(readFileSync(join(dir, "q"), "utf8")).toBe("via-pax");

    const nameBody = Buffer.from(`${long}\0`);
    const raw2 = Buffer.concat([
      tarHeader({ name: "././@LongLink", type: "L", body: nameBody }),
      nameBody,
      Buffer.alloc((512 - (nameBody.length % 512)) % 512),
      tarBytes([{ name: "short", body: Buffer.from("via-gnu") }]),
    ]);
    const archive2 = join(dir, "b.tar.gz");
    writeFileSync(archive2, gzipSync(raw2));
    await extractBinary(archive2, join(dir, "q2"));
    expect(readFileSync(join(dir, "q2"), "utf8")).toBe("via-gnu");
  });

  test("unsafeArchivePath mirrors Go's rule", () => {
    for (const bad of ["/abs", "../x", "a/../../x", "..", "C:\\x", "c:/x", "..\\x"]) {
      expect(unsafeArchivePath(bad)).toBe(true);
    }
    for (const ok of ["qdrant", "a/b/qdrant", "./qdrant", "a/../qdrant", "dir/"]) {
      expect(unsafeArchivePath(ok)).toBe(false);
    }
  });
});
