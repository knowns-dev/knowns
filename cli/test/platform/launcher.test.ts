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

describe("daemon identity with the engine name", () => {
  test("a daemon started as knowns-engine __runtime run is a Knowns runtime daemon", async () => {
    const { isRuntimeDaemonCommand } = await import("../../src/runtime/process-identity.ts");
    expect(isRuntimeDaemonCommand("/x/bin/knowns-engine __runtime run")).toBe(true);
    expect(isRuntimeDaemonCommand('"C:\\k\\knowns-engine.exe" __runtime run')).toBe(true);
    expect(isRuntimeDaemonCommand("/x/bin/other __runtime run")).toBe(false);
  });
});
