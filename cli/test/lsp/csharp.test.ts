import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../../src/lsp/config.ts";
import {
  csharpBackendIDs,
  csharpLSProjectPath,
  csharpProjectKind,
  csharpRoslynRID,
  csharpRoslynRuntimeDependency,
  discoverCSharpProject,
  resolveCSharpBackend,
  resolveCSharpBackendWithOptions,
} from "../../src/lsp/csharp.ts";
import type { Installer } from "../../src/lsp/installer.ts";
import {
  BackendAttemptChosen,
  BackendAttemptFailed,
  BackendAttemptSkipped,
  CSharpBackendCSharp,
  CSharpBackendOmni,
  CSharpBackendRoslyn,
  CSharpLanguageID,
  RoslynNuGetPackagePrefix,
} from "../../src/lsp/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "lsp-cs-"));
const goos = () => (process.platform === "win32" ? "windows" : process.platform);
const goarch = () =>
  process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;

test("backend ids", () => {
  expect(csharpBackendIDs()).toEqual(["roslyn-ls", "csharp-ls", "omnisharp"]);
});

test("roslyn dependency uses platform package", () => {
  const cfg = new Config({
    [CSharpLanguageID]: {
      version: "5.0.0-test",
      settings: { roslynPackageSource: "https://mirror.example/nuget", roslynSHA512: "checksum" },
    },
  });
  const dep = csharpRoslynRuntimeDependency(cfg);
  const rid = csharpRoslynRID(goos(), goarch());
  expect(dep.source).toBe("nuget");
  expect(dep.archive_type).toBe("nupkg");
  expect(dep.package_name).toBe(`${RoslynNuGetPackagePrefix}.${rid}`);
  expect(dep.version).toBe("5.0.0-test");
  expect(dep.package_source).toBe("https://mirror.example/nuget");
  expect(dep.sha512).toBe("checksum");
  expect(dep.extract_path).toContain(rid);
  expect(dep.extract_path?.endsWith("Microsoft.CodeAnalysis.LanguageServer.dll")).toBe(true);
});

test("RID mapping", () => {
  expect(csharpRoslynRID("darwin", "arm64")).toBe("osx-arm64");
  expect(csharpRoslynRID("windows", "amd64")).toBe("win-x64");
  expect(csharpRoslynRID("linux", "386")).toBe("linux-x86");
});

test("managed roslyn runs through dotnet", async () => {
  const root = tmp();
  const installer = {
    isInstalled: () => "/managed/Microsoft.CodeAnalysis.LanguageServer.dll",
  } as unknown as Installer;
  const [cmd, ok] = await resolveCSharpBackendWithOptions(undefined, root, new Config(), {
    lookPath: (n) => (n === "dotnet" ? "/usr/bin/dotnet" : undefined),
    runCommand: async (_c, name, ...args) => {
      expect(name).toBe("/usr/bin/dotnet");
      expect(args).toEqual(["--version"]);
      return "10.0.100";
    },
    installer,
  });
  expect(ok).toBe(true);
  expect(cmd.backend).toBe(CSharpBackendRoslyn);
  expect(cmd.path).toBe("/usr/bin/dotnet");
  expect(cmd.name).toBe("dotnet");
  expect(cmd.args).toEqual(["/managed/Microsoft.CodeAnalysis.LanguageServer.dll", "--stdio"]);
  expect(cmd.logPath).toContain("csharp-roslyn-ls.log");
});

test("managed roslyn not installed falls through to PATH backends", async () => {
  const installer = { isInstalled: () => undefined } as unknown as Installer;
  const [cmd, ok] = await resolveCSharpBackendWithOptions(undefined, tmp(), new Config(), {
    lookPath: (n) => (n === "csharp-ls" ? "/bin/csharp-ls" : undefined),
    installer,
  });
  expect(ok).toBe(true);
  expect(cmd.backend).toBe(CSharpBackendCSharp);
  expect(cmd.attempts?.[0]?.reason).toBe(
    "managed Roslyn LS is not installed; run: knowns lsp install csharp",
  );
});

test("auto fallback records attempts", async () => {
  const looked: string[] = [];
  const [cmd, ok] = await resolveCSharpBackend(
    undefined,
    tmp(),
    new Config(),
    (n) => {
      looked.push(n);
      return n === "csharp-ls" ? "/bin/csharp-ls" : undefined;
    },
    async () => {},
  );
  expect(ok).toBe(true);
  expect(cmd.backend).toBe(CSharpBackendCSharp);
  expect(looked).toEqual(["roslyn-ls", "csharp-ls"]);
  expect(cmd.attempts?.map((a) => [a.backend, a.status])).toEqual([
    [CSharpBackendRoslyn, BackendAttemptFailed],
    [CSharpBackendCSharp, BackendAttemptChosen],
    [CSharpBackendOmni, BackendAttemptSkipped],
  ]);
});

test("csharp-ls uses discovered solution", async () => {
  const root = tmp();
  writeFileSync(join(root, "App.sln"), "");
  const [cmd, ok] = await resolveCSharpBackend(
    undefined,
    root,
    new Config(),
    (n) => (n === "csharp-ls" ? "/bin/csharp-ls" : undefined),
    async () => {},
  );
  expect(ok).toBe(true);
  expect(cmd.args).toEqual(["--solution", "App.sln"]);
});

test("csharpLSProjectPath relative inside root, absolute outside", () => {
  const root = tmp();
  expect(csharpLSProjectPath(root, join(root, "src", "App.sln"))).toBe(join("src", "App.sln"));
  const out = join(root, "..", "other", "App.sln");
  expect(csharpLSProjectPath(join(root, "root"), out)).toBe(out);
});

test("explicit backend does not fall back; unknown backend fails", async () => {
  const looked: string[] = [];
  const cfg = new Config({ [CSharpLanguageID]: { backend: CSharpBackendOmni } });
  const [cmd, ok] = await resolveCSharpBackend(
    undefined,
    tmp(),
    cfg,
    (n) => {
      looked.push(n);
      return undefined;
    },
    undefined,
  );
  expect(ok).toBe(false);
  expect(looked).toEqual(["omnisharp"]);
  expect(cmd.attempts?.length).toBe(1);
  const [bad, ok2] = await resolveCSharpBackend(
    undefined,
    tmp(),
    new Config({ [CSharpLanguageID]: { backend: "nope" } }),
    undefined,
    undefined,
  );
  expect(ok2).toBe(false);
  expect(bad.attempts?.[0]?.reason).toBe("unknown backend");
});

test("discover: breadth-first, solution before project, slnx, csproj fallback, override", () => {
  const root = tmp();
  mkdirSync(join(root, "a", "deep"), { recursive: true });
  mkdirSync(join(root, "b"));
  writeFileSync(join(root, "a", "deep", "Deep.sln"), "");
  writeFileSync(join(root, "b", "B.sln"), "");
  writeFileSync(join(root, "a", "A.csproj"), "");
  expect(discoverCSharpProject(root, "")).toEqual({ path: join(root, "b", "B.sln"), kind: "sln" });

  const r2 = tmp();
  mkdirSync(join(r2, "src", "bin"), { recursive: true });
  writeFileSync(join(r2, "src", "bin", "X.sln"), "");
  writeFileSync(join(r2, "src", "App.csproj"), "");
  expect(discoverCSharpProject(r2, "")).toEqual({
    path: join(r2, "src", "App.csproj"),
    kind: "csproj",
  });

  const r3 = tmp();
  writeFileSync(join(r3, "S.slnx"), "");
  expect(discoverCSharpProject(r3, "").kind).toBe("slnx");
  expect(discoverCSharpProject(r3, "sub/My.csproj")).toEqual({
    path: join(r3, "sub", "My.csproj"),
    kind: "csproj",
  });
  expect(csharpProjectKind("x.txt")).toBe("");
});
