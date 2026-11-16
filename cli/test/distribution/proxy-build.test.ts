import { describe, expect, test } from "bun:test";
import { goBuildArgs, goTarget, launcherExeName } from "../../scripts/proxy.ts";

describe("proxy build", () => {
  test("every release target maps to a Go target", () => {
    expect(goTarget("bun-darwin-arm64")).toEqual({ goos: "darwin", goarch: "arm64" });
    expect(goTarget("bun-darwin-x64")).toEqual({ goos: "darwin", goarch: "amd64" });
    expect(goTarget("bun-linux-x64")).toEqual({ goos: "linux", goarch: "amd64" });
    expect(goTarget("bun-linux-arm64")).toEqual({ goos: "linux", goarch: "arm64" });
    expect(goTarget("bun-windows-x64")).toEqual({ goos: "windows", goarch: "amd64" });
    expect(goTarget("bun-windows-arm64")).toEqual({ goos: "windows", goarch: "arm64" });
    expect(() => goTarget("bun-freebsd-x64")).toThrow();
  });

  test("names and flags", () => {
    expect(launcherExeName("bun-windows-x64")).toBe("knowns.launcher.exe");
    expect(launcherExeName("bun-linux-x64")).toBe("knowns.launcher");
    const args = goBuildArgs("1.2.3", "/out/knowns.launcher");
    expect(args).toContain("-s -w -X main.version=1.2.3");
    expect(args.slice(-3)).toEqual(["-o", "/out/knowns.launcher", "."]);
  });
});
