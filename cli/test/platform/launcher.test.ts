import { describe, expect, test } from "bun:test";
import { proxyCheckers } from "../../src/domain/doctor/proxy-checks.ts";
import {
  engineBeside,
  launcherPath,
  launcherProblem,
  selfExecutable,
  stableLauncherPath,
} from "../../src/platform/launcher.ts";

const real = (map: Record<string, string>) => (p: string) => {
  const v = map[p];
  if (v === undefined) throw new Error(`ENOENT ${p}`);
  return v;
};
const here = { execPath: "/x/bin/knowns-engine", platform: "linux" };

describe("launcher helpers (spec mcp-thin-proxy D10)", () => {
  test("KNOWNS_LAUNCHER is believed only for the launcher of this very engine", () => {
    const ok = { ...here, realpath: real({ "/x/bin/knowns-engine": "/x/bin/knowns-engine" }) };
    expect(launcherPath({ KNOWNS_LAUNCHER: "/x/bin/knowns" }, ok)).toBe("/x/bin/knowns");
    expect(launcherPath({ KNOWNS_LAUNCHER: "/x/bin/kn" }, ok)).toBe("/x/bin/kn");
    expect(launcherPath({ KNOWNS_LAUNCHER: "  " }, ok)).toBeUndefined();
    expect(launcherPath({}, ok)).toBeUndefined();
    // relative, wrong name, or a neighbour engine that is some other file: all unset
    expect(launcherPath({ KNOWNS_LAUNCHER: "bin/knowns" }, ok)).toBeUndefined();
    expect(launcherPath({ KNOWNS_LAUNCHER: "/tmp/evil" }, ok)).toBeUndefined();
    expect(launcherPath({ KNOWNS_LAUNCHER: "/tmp/knowns" }, ok)).toBeUndefined();
    const other = real({
      "/tmp/knowns-engine": "/tmp/knowns-engine",
      "/x/bin/knowns-engine": "/x/bin/knowns-engine",
    });
    expect(
      launcherPath({ KNOWNS_LAUNCHER: "/tmp/knowns" }, { ...here, realpath: other }),
    ).toBeUndefined();
    // a symlinked engine that resolves to this process still counts
    const linked = real({
      "/l/bin/knowns-engine": "/x/bin/knowns-engine",
      "/x/bin/knowns-engine": "/x/bin/knowns-engine",
    });
    expect(launcherPath({ KNOWNS_LAUNCHER: "/l/bin/knowns" }, { ...here, realpath: linked })).toBe(
      "/l/bin/knowns",
    );
    expect(selfExecutable({ KNOWNS_LAUNCHER: "/tmp/evil" }, ok)).toBe(process.execPath);
    expect(
      selfExecutable({ KNOWNS_LAUNCHER: "/x/bin/knowns" }, { ...ok, exists: () => true }),
    ).toBe("/x/bin/knowns");
  });

  test("a Homebrew Cellar path is never recorded", () => {
    const cellar = "/opt/homebrew/Cellar/knowns/1.0.0/bin/knowns";
    expect(stableLauncherPath(cellar, (p) => p === "/opt/homebrew/bin/knowns")).toBe(
      "/opt/homebrew/bin/knowns",
    );
    expect(stableLauncherPath(cellar, () => false)).toBe("knowns");
    expect(stableLauncherPath("/home/u/.knowns/bin/knowns", () => false)).toBe(
      "/home/u/.knowns/bin/knowns",
    );
    const seams = {
      execPath: "/opt/homebrew/Cellar/knowns/1.0.0/bin/knowns-engine",
      platform: "linux",
      realpath: (p: string) => p,
      exists: () => false,
    };
    expect(selfExecutable({ KNOWNS_LAUNCHER: cellar }, seams)).toBe("knowns");
  });

  test("the engine is expected beside the launcher", () => {
    expect(engineBeside("/x/bin/knowns", "linux")).toBe("/x/bin/knowns-engine");
    expect(engineBeside("C:\\k\\knowns.exe", "win32")).toMatch(/knowns-engine\.exe$/);
  });

  test("launcherProblem: whole, launcher gone, engine gone, moved by a package manager, no launcher", () => {
    const env = { KNOWNS_LAUNCHER: "/x/bin/knowns", PATH: "" };
    const seams = { ...here, realpath: (p: string) => p };
    expect(launcherProblem(env, () => true, "linux", seams)).toBeUndefined();
    expect(launcherProblem(env, (p) => p !== "/x/bin/knowns", "linux", seams)?.kind).toBe(
      "launcher-missing",
    );
    expect(launcherProblem(env, (p) => !p.endsWith("knowns-engine"), "linux", seams)).toEqual({
      kind: "engine-missing",
      path: "/x/bin/knowns-engine",
    });
    expect(launcherProblem({}, () => false, "linux", seams)).toBeUndefined();
    // Cellar launcher replaced by an upgrade: the stable path is whole, so nothing to report
    const cellar = "/opt/homebrew/Cellar/knowns/1.0.0/bin/knowns";
    const present = new Set(["/opt/homebrew/bin/knowns", "/opt/homebrew/bin/knowns-engine"]);
    const cs = {
      execPath: "/opt/homebrew/Cellar/knowns/1.0.0/bin/knowns-engine",
      platform: "linux",
      realpath: (p: string) => p,
    };
    expect(
      launcherProblem({ KNOWNS_LAUNCHER: cellar, PATH: "" }, (p) => present.has(p), "linux", cs),
    ).toBeUndefined();
  });

  test("doctor: a moved launcher warns, a launcher without its engine fails, none is silent", async () => {
    const base = { proxyEnabled: true, reports: [], fallbacks: [], proxyNamedEntries: [] };
    expect(proxyCheckers(base)).toEqual([]);
    const engine = proxyCheckers({
      ...base,
      launcher: { kind: "engine-missing", path: "/x/bin/knowns-engine" },
    });
    expect(engine.map((c) => c.id)).toEqual(["runtime.launcher"]);
    const r = await engine[0]?.check(new AbortController().signal);
    expect(r?.status).toBe("fail");
    expect(r?.remediation?.command).toBe("knowns update");
    const gone = proxyCheckers({
      ...base,
      launcher: { kind: "launcher-missing", path: "/x/bin/knowns" },
    });
    expect((await gone[0]?.check(new AbortController().signal))?.status).toBe("warn");
  });
});

// Real Windows paths, run on every OS: the helpers follow the platform they are asked about.
describe("launcher helpers with Windows paths", () => {
  const dir = "C:\\Users\\Admin\\.knowns\\bin";
  const win = { execPath: `${dir}\\knowns-engine.exe`, platform: "win32" };
  const same = (p: string) => p;

  test("KNOWNS_LAUNCHER: knowns.exe, kn.exe, any case, only beside this engine", () => {
    for (const name of ["knowns.exe", "kn.exe", "KNOWNS.EXE", "Knowns"]) {
      const v = `${dir}\\${name}`;
      expect(launcherPath({ KNOWNS_LAUNCHER: v }, { ...win, realpath: same })).toBe(v);
    }
    // wrong stem, relative, a POSIX-looking path, a drive-relative path
    for (const v of [`${dir}\\evil.exe`, "bin\\knowns.exe", "/x/bin/knowns", "C:knowns.exe"]) {
      expect(launcherPath({ KNOWNS_LAUNCHER: v }, { ...win, realpath: same })).toBeUndefined();
    }
  });

  test("the engine comparison ignores case and a drive letter written differently", () => {
    const upper = { ...win, execPath: `c:\\users\\admin\\.knowns\\bin\\KNOWNS-ENGINE.EXE` };
    expect(
      launcherPath({ KNOWNS_LAUNCHER: `${dir}\\knowns.exe` }, { ...upper, realpath: same }),
    ).toBe(`${dir}\\knowns.exe`);
    // a different engine beside the launcher is not this process
    const other = { ...win, execPath: "D:\\elsewhere\\knowns-engine.exe" };
    expect(
      launcherPath({ KNOWNS_LAUNCHER: `${dir}\\knowns.exe` }, { ...other, realpath: same }),
    ).toBeUndefined();
  });

  test("engineBeside keeps the directory and adds .exe; a UNC launcher works too", () => {
    expect(engineBeside(`${dir}\\knowns.exe`, "win32")).toBe(`${dir}\\knowns-engine.exe`);
    expect(engineBeside("\\\\srv\\share\\k\\knowns.exe", "win32")).toBe(
      "\\\\srv\\share\\k\\knowns-engine.exe",
    );
  });

  test("stableLauncherPath leaves a Windows path alone; launcherProblem sees a missing engine", () => {
    expect(stableLauncherPath(`${dir}\\knowns.exe`, () => false)).toBe(`${dir}\\knowns.exe`);
    const env = { KNOWNS_LAUNCHER: `${dir}\\knowns.exe`, PATH: "" };
    const seams = { ...win, realpath: same };
    expect(launcherProblem(env, () => true, "win32", seams)).toBeUndefined();
    expect(launcherProblem(env, (p) => !p.endsWith("knowns-engine.exe"), "win32", seams)).toEqual({
      kind: "engine-missing",
      path: `${dir}\\knowns-engine.exe`,
    });
  });
});

describe("daemon identity with the engine name", () => {
  test("a daemon started as knowns-engine __runtime run is a Knowns runtime daemon", async () => {
    const { isRuntimeDaemonCommand } = await import("../../src/runtime/process-identity.ts");
    expect(isRuntimeDaemonCommand("/x/bin/knowns-engine __runtime run")).toBe(true);
    expect(isRuntimeDaemonCommand('"C:\\k\\knowns-engine.exe" __runtime run')).toBe(true);
    expect(isRuntimeDaemonCommand("/x/bin/other __runtime run")).toBe(false);
  });
});
