// OS regression tests against the TypeScript CLI (KNOWNS_TS_BIN, else `bun src/main.ts`).
// Ported from tests/e2e_os_regression_test.go for task KN-NDD5YY (remove Go from the repo). Each
// test pins an OS-specific bug that was already fixed; the inventory (commit/issue, platform, test)
// is the doc specs/2026-11-03/os-regression-inventory. Platform guards are kept as test.skipIf.
//
// Go test (e2e_os_regression_test.go)             -> TS test (this file)
//   TestOSRegression_RegistryStoresOnDiskCasing       -> "registry stores the on-disk casing"
//   TestOSRegression_RegistryCollapsesCaseDuplicates  -> "registry collapses case duplicates"
//   TestOSRegression_HomeIsolation                    -> "home isolation"
//   TestOSRegression_RuntimeDoesNotWatchSourceTree    -> "runtime does not watch the source tree"
//   TestOSRegression_DocPathContainment               -> "doc path containment"
//   TestOSRegression_DocSymlinkEscape                 -> "doc symlink escape"
//   TestOSRegression_HistoryWriteSurvivesDirectorySync-> "history write survives directory sync"
//   TestOSRegression_ConfigAcceptsUTF8BOM             -> "config.json accepts a UTF-8 BOM"
//   TestOSRegression_RegistryAcceptsUTF8BOM           -> "registry.json accepts a UTF-8 BOM"
//   TestOSRegression_UpdateReadsBOMInstallMetadata    -> "update reads BOM-prefixed install.json"
//   TestOSRegression_StatusPollingDoesNotLeakConsoles -> "status polling does not leak consoles"
//
// Two Go tests were opt-in only because the Go build had the bug (registry.json BOM, #155
// install.json BOM). They record the contract for this build, so here they always run.
// The nearest existing coverage is unit level (test/stores/registry.test.ts reads a BOM registry);
// nothing drives the real CLI and `browser` server, hence the port.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadInstallMetadata } from "../../src/domain/update/install-metadata.ts";
import {
  freePort,
  initProject,
  registerCleanup,
  requireSuccess,
  runCli,
  sleep,
  spawnCli,
  tmp,
} from "./harness.ts";

registerCleanup();

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface Workspace {
  id: string;
  name: string;
  path: string;
}

const inline = (home: string, dir: string, ...args: string[]) =>
  runCli(dir, args, { home, timeoutMs: 90_000 });

function initIn(dir: string): string {
  // Like the Go suite: init with the ordinary sandbox, only the commands under test use the
  // isolated home.
  return initProject(dir, "osr-test");
}

interface Browser {
  base: string;
  proc: ReturnType<typeof spawnCli>;
  workspaces(): Promise<Workspace[]>;
  get(path: string): Promise<string>;
  stop(): Promise<void>;
}

/** Starts `knowns browser` for `project` (spelled exactly as given) and waits for the API. */
async function startBrowser(home: string, project: string): Promise<Browser> {
  const port = await freePort();
  const proc = spawnCli(
    home,
    ["browser", "--project", project, "--no-open", "--port", String(port)],
    {
      home,
    },
  );
  const base = `http://127.0.0.1:${port}`;
  const get = async (path: string) => (await fetch(base + path)).text();
  const b: Browser = {
    base,
    proc,
    get,
    workspaces: async () => JSON.parse(await get("/api/workspaces")) as Workspace[],
    stop: async () => {
      proc.kill();
      await proc.exited;
      // Stop anything the server left in this home so the directory can be removed.
      runCli(home, ["runtime", "stop"], { home });
      await sleep(300);
    },
  };
  openBrowsers.push(b);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/workspaces`);
      if (r.status === 200) return b;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`browser did not answer on ${base} within 60s`);
}

const openBrowsers: Browser[] = [];

afterEach(async () => {
  for (const b of openBrowsers.splice(0)) await b.stop();
});

function readRegistry(home: string): Workspace[] {
  return JSON.parse(readFileSync(join(home, ".knowns", "registry.json"), "utf8")) as Workspace[];
}

const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";

/** <tmp>/MixedCase/Project plus an all-lowercase spelling; null when the filesystem is case-sensitive. */
function caseInsensitiveProject(): { onDisk: string; lowered: string } | null {
  if (!caseInsensitiveFs) return null;
  const root = tmp();
  const onDisk = join(root, "MixedCase", "Project");
  const lowered = join(root.toLowerCase(), "mixedcase", "project");
  initIn(onDisk);
  return existsSync(lowered) ? { onDisk, lowered } : null;
}

describe("workspace registry path casing (#144, a888550, 090ca95)", () => {
  test.skipIf(!caseInsensitiveFs)("registry stores the on-disk casing", async () => {
    const home = tmp();
    const p = caseInsensitiveProject();
    if (!p) return; // the filesystem under the temp dir is case-sensitive: the bug cannot occur
    const b = await startBrowser(home, p.lowered);
    const ws = await b.workspaces();
    expect(ws.length, JSON.stringify(ws)).toBe(1);
    // The registered spelling is the one on disk, not the one the caller typed. realpath.native
    // returns the on-disk casing on Windows and macOS, so /var vs /private/var does not matter.
    const registered = ws[0]?.path as string;
    expect(
      registered === p.onDisk || realpathSync.native(registered) === p.onDisk,
      registered,
    ).toBe(true);
    const reg = readRegistry(home);
    expect(reg.length).toBe(1);
    expect(reg[0]?.path).toBe(ws[0]?.path as string);
  });

  test.skipIf(!caseInsensitiveFs)("registry collapses case duplicates", async () => {
    const home = tmp();
    const p = caseInsensitiveProject();
    if (!p) return;
    mkdirSync(join(home, ".knowns"), { recursive: true });
    writeFileSync(
      join(home, ".knowns", "registry.json"),
      JSON.stringify([
        { id: "aaaaaa", name: "Osr", path: p.onDisk, lastUsed: "2026-01-01T00:00:00Z" },
        { id: "bbbbbb", name: "osr", path: p.lowered, lastUsed: "2026-01-02T00:00:00Z" },
      ]),
    );
    const b = await startBrowser(home, p.onDisk);
    const ws = await b.workspaces();
    expect(
      ws.length,
      `one folder under two spellings must be one workspace: ${JSON.stringify(ws)}`,
    ).toBe(1);
  });
});

describe("HOME / USERPROFILE isolation (c17bab0, 19c18f5, d492c81)", () => {
  test("home isolation", async () => {
    const home = tmp();
    const proj = initIn(join(tmp(), "proj"));
    const b = await startBrowser(home, proj);
    expect((await b.workspaces()).length).toBe(1);
    expect(readRegistry(home).length).toBe(1);
    await b.stop();

    // A second, separate home must not see the first one's registry.
    const other = tmp();
    const proj2 = initIn(join(tmp(), "proj2"));
    const b2 = await startBrowser(other, proj2);
    const ws = await b2.workspaces();
    expect(ws.length, `second home leaked state: ${JSON.stringify(ws)}`).toBe(1);
    expect(ws[0]?.path).not.toBe("");
    expect(ws[0]?.path.toLowerCase().endsWith("proj2"), JSON.stringify(ws)).toBe(true);
  });
});

function openFDs(pid: number): number | null {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    // no /proc: macOS
  }
  try {
    const out = execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8" });
    return out.trim().split("\n").length - 1;
  } catch {
    return null;
  }
}

describe("macOS kqueue descriptor exhaustion (354c413)", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "runtime does not watch the source tree",
    async () => {
      const home = tmp();
      const proj = initIn(join(tmp(), "proj"));
      const sourceFiles = 1500;
      const src = join(proj, "src");
      mkdirSync(src, { recursive: true });
      for (let i = 0; i < sourceFiles; i++) writeFileSync(join(src, `f${i}.txt`), "x");

      // Without KNOWNS_RUNTIME_INLINE so a shared runtime process starts.
      try {
        const res = runCli(proj, ["task", "create", "watch probe"], {
          home,
          env: { KNOWNS_RUNTIME_INLINE: "" },
        });
        requireSuccess(res, "task create");
        const pidFile = join(home, ".knowns", "runtime", "knowns-runtime.pid");
        let pid = 0;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && pid === 0) {
          if (existsSync(pidFile)) {
            const n = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
            if (n > 0) pid = n;
          }
          if (pid === 0) await sleep(200);
        }
        if (pid === 0) return; // this build keeps the runtime elsewhere or inline: nothing to count
        await sleep(3000); // let the watcher attach to the registered project
        const n = openFDs(pid);
        if (n === null) return; // neither /proc nor lsof
        expect(
          n,
          `runtime pid ${pid} holds ${n} descriptors with ${sourceFiles} source files`,
        ).toBeLessThan(sourceFiles);
      } finally {
        runCli(proj, ["runtime", "stop"], { home, env: { KNOWNS_RUNTIME_INLINE: "" } });
      }
    },
    120_000,
  );
});

describe("path containment across platforms (405587c, 09c5a96)", () => {
  test("doc path containment", () => {
    const home = tmp();
    const proj = initIn(join(tmp(), "proj"));
    const outside = tmp();

    // Parent traversal, forward and backslash spelling, must be refused on every platform.
    for (const folder of ["../../escape", "..\\..\\escape"]) {
      const res = inline(home, proj, "doc", "create", "Escape", "-f", folder, "-c", "x");
      expect(res.exitCode, `doc create -f ${folder} must be rejected:\n${res.stdout}`).not.toBe(0);
    }

    // An absolute folder must never write outside the project: refused, or re-rooted below
    // .knowns/docs.
    const abs = [join(outside, "abs-unix").replaceAll("\\", "/")];
    if (process.platform === "win32") abs.push(join(outside, "abs-win"));
    for (const folder of abs)
      inline(home, proj, "doc", "create", "Absolute", "-f", folder, "-c", "x");
    const stray = readdirSync(outside, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    );
    expect(
      stray.map((e) => e.name),
      "doc create wrote outside the project",
    ).toEqual([]);
    expect(existsSync(join(proj, "..", "escape"))).toBe(false);
  });

  test("doc symlink escape", () => {
    const home = tmp();
    const proj = initIn(join(tmp(), "proj"));
    const outside = tmp();
    writeFileSync(join(outside, "secret.md"), "---\ntitle: Secret\n---\nTOPSECRETMARKER\n");
    try {
      symlinkSync(outside, join(proj, ".knowns", "docs", "linkdir"), "dir");
    } catch {
      return; // cannot create symlinks on this host (Windows needs privilege or developer mode)
    }
    const view = inline(home, proj, "doc", "view", "linkdir/secret", "--plain");
    expect(view.stdout, "doc view followed a symlink out of .knowns/docs").not.toContain(
      "TOPSECRETMARKER",
    );

    // Writing through the link must not touch the outside directory either.
    inline(home, proj, "doc", "create", "Planted", "-f", "linkdir", "-c", "x");
    expect(readdirSync(outside).filter((n) => n !== "secret.md")).toEqual([]);
  });
});

describe("Windows cannot fsync a directory (5bca0e2, 12341b8)", () => {
  test("history write survives directory sync", () => {
    const home = tmp();
    const proj = initIn(join(tmp(), "proj"));
    requireSuccess(inline(home, proj, "doc", "create", "History Probe", "-c", "one"), "doc create");
    requireSuccess(inline(home, proj, "doc", "edit", "history-probe", "-c", "two"), "doc edit 1");
    requireSuccess(inline(home, proj, "doc", "edit", "history-probe", "-a", "three"), "doc edit 2");
    const hist = inline(home, proj, "doc", "history", "history-probe", "--plain");
    requireSuccess(hist, "doc history");
    expect(hist.stdout).not.toContain("No version history");
    expect(hist.stdout.trim()).not.toBe("");

    const task = inline(home, proj, "task", "create", "History task");
    requireSuccess(task, "task create");
    const id = /created\s+task\s+([A-Za-z0-9-]+)/i.exec(task.stdout)?.[1] ?? "";
    expect(id, task.stdout).not.toBe("");
    requireSuccess(inline(home, proj, "task", "edit", id, "-s", "in-progress"), "task edit");
  });
});

describe("BOM tolerance (Windows PowerShell writes UTF-8 with BOM)", () => {
  test("config.json accepts a UTF-8 BOM", () => {
    const home = tmp();
    const proj = initIn(join(tmp(), "proj"));
    const path = join(proj, ".knowns", "config.json");
    writeFileSync(path, Buffer.concat([BOM, readFileSync(path)]));
    const res = inline(home, proj, "task", "list", "--plain");
    expect(res.exitCode, `${res.stdout}${res.stderr}`).toBe(0);
  });

  test("registry.json accepts a UTF-8 BOM", async () => {
    const home = tmp();
    const proj = initIn(join(tmp(), "proj"));
    const b = await startBrowser(home, proj);
    await b.stop();
    const path = join(home, ".knowns", "registry.json");
    writeFileSync(path, Buffer.concat([BOM, readFileSync(path)]));
    const b2 = await startBrowser(home, proj);
    const ws = await b2.workspaces();
    expect(ws.length, `registry.json with a BOM must keep 1 workspace: ${JSON.stringify(ws)}`).toBe(
      1,
    );
  });

  // #155: install.json written with a BOM made `knowns update` fail with "read install metadata".
  // The Go test ran a real `knowns update`. Against a compiled release-stamped binary that call
  // finds a newer release and self-updates the binary under test, so the contract is checked at
  // the reader `update` calls first (runUpgrade -> loadInstallMetadata) instead.
  test("update reads BOM-prefixed install.json", () => {
    const home = tmp();
    mkdirSync(join(home, ".knowns"), { recursive: true });
    writeFileSync(
      join(home, ".knowns", "install.json"),
      Buffer.concat([
        BOM,
        Buffer.from('{"method":"script","managedBy":"script","updateStrategy":"self-update"}'),
      ]),
    );
    expect(loadInstallMetadata({ HOME: home, USERPROFILE: home })).toEqual({
      method: "script",
      managedBy: "script",
      updateStrategy: "self-update",
    });
  });
});

describe("Windows console handle leak (#138, 2ecd073)", () => {
  function countProcesses(image: string): number {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
    });
    return out.split("\n").filter((l) => l.trim().startsWith(`"${image}`)).length;
  }

  test.skipIf(process.platform !== "win32")(
    "status polling does not leak consoles",
    async () => {
      const home = tmp();
      const proj = initIn(join(tmp(), "proj"));
      const b = await startBrowser(home, proj);
      await b.get("/api/runtime/ps"); // warm up any one-time probe cache
      const count = () => countProcesses("conhost.exe") + countProcesses("OpenConsole.exe");
      const before = count();
      for (let i = 0; i < 30; i++) {
        await b.get("/api/runtime/ps");
        await b.get("/api/status");
      }
      await sleep(2000);
      // Other programs may open consoles meanwhile; a per-poll leak would add 30+.
      expect(
        count() - before,
        "console host processes grew across 60 status polls",
      ).toBeLessThanOrEqual(5);
    },
    120_000,
  );
});
