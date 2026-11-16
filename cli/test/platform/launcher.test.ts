import { describe, expect, test } from "bun:test";
import { proxyCheckers } from "../../src/domain/doctor/proxy-checks.ts";
import {
  engineBeside,
  launcherPath,
  launcherProblem,
  selfExecutable,
} from "../../src/platform/launcher.ts";

describe("launcher helpers (spec mcp-thin-proxy D10)", () => {
  test("KNOWNS_LAUNCHER names the launcher; blank means none", () => {
    expect(launcherPath({ KNOWNS_LAUNCHER: "/x/bin/knowns" })).toBe("/x/bin/knowns");
    expect(launcherPath({ KNOWNS_LAUNCHER: "  " })).toBeUndefined();
    expect(launcherPath({})).toBeUndefined();
    expect(selfExecutable({ KNOWNS_LAUNCHER: "/x/bin/knowns" })).toBe("/x/bin/knowns");
    expect(selfExecutable({})).toBe(process.execPath);
  });

  test("the engine is expected beside the launcher", () => {
    expect(engineBeside("/x/bin/knowns", "linux")).toBe("/x/bin/knowns-engine");
    expect(engineBeside("C:\\k\\knowns.exe", "win32")).toMatch(/knowns-engine\.exe$/);
  });

  test("launcherProblem: whole, launcher gone, engine gone, no launcher at all", () => {
    const env = { KNOWNS_LAUNCHER: "/x/bin/knowns" };
    expect(launcherProblem(env, () => true, "linux")).toBeUndefined();
    expect(launcherProblem(env, (p) => p !== "/x/bin/knowns", "linux")?.kind).toBe(
      "launcher-missing",
    );
    expect(launcherProblem(env, (p) => !p.endsWith("knowns-engine"), "linux")).toEqual({
      kind: "engine-missing",
      path: "/x/bin/knowns-engine",
    });
    expect(launcherProblem({}, () => false, "linux")).toBeUndefined();
  });

  test("doctor reports a broken pair and stays silent when there is none", async () => {
    const base = { proxyEnabled: true, reports: [], fallbacks: [], proxyNamedEntries: [] };
    expect(proxyCheckers(base)).toEqual([]);
    const checks = proxyCheckers({
      ...base,
      launcher: { kind: "engine-missing", path: "/x/bin/knowns-engine" },
    });
    expect(checks.map((c) => c.id)).toEqual(["runtime.launcher"]);
    const r = await checks[0]?.check(new AbortController().signal);
    expect(r?.status).toBe("fail");
    expect(r?.remediation?.command).toBe("knowns update");
  });
});
