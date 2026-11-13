import { expect, test } from "bun:test";
import { Config } from "../../src/lsp/config.ts";
import { resolveDotnet10 } from "../../src/lsp/dotnet.ts";
import { RuntimeError } from "../../src/lsp/runtime-error.ts";
import { CSharpLanguageID } from "../../src/lsp/types.ts";

test("uses configured path", async () => {
  const cfg = new Config({
    [CSharpLanguageID]: { settings: { dotnetPath: "/opt/dotnet/dotnet" } },
  });
  const path = await resolveDotnet10(
    undefined,
    cfg,
    undefined,
    async (_c, name, ...args) => {
      expect(name).toBe("/opt/dotnet/dotnet");
      expect(args).toEqual(["--version"]);
      return "10.0.100";
    },
    "/tmp/csharp.log",
  );
  expect(path).toBe("/opt/dotnet/dotnet");
});

test("runs configured bootstrap", async () => {
  const cfg = new Config({
    [CSharpLanguageID]: { settings: { dotnetBootstrapCommand: "install-dotnet --channel 10.0" } },
  });
  let installed = false;
  const path = await resolveDotnet10(
    undefined,
    cfg,
    (name) => (name === "dotnet" && installed ? "/tmp/dotnet" : undefined),
    async (_c, name, ...args) => {
      if (name === "install-dotnet") {
        installed = true;
        expect(args).toEqual(["--channel", "10.0"]);
        return "ok";
      }
      if (name === "/tmp/dotnet") return "10.0.1";
      throw new Error(`unexpected ${name}`);
    },
    "/tmp/csharp.log",
  );
  expect(path).toBe("/tmp/dotnet");
});

test("missing returns actionable RuntimeError", async () => {
  const err = await resolveDotnet10(
    undefined,
    new Config(),
    () => undefined,
    undefined,
    "/tmp/csharp.log",
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RuntimeError);
  const re = err as RuntimeError;
  expect(re.code).toBe("dotnet_10_missing");
  expect(re.logPath).toBe("/tmp/csharp.log");
  expect(re.remediation).toContain("dotnetPath");
});

test("old version rejected, bootstrap failure carries output", async () => {
  const cfg = new Config({
    [CSharpLanguageID]: { settings: { dotnetPath: "/d", dotnetBootstrapCommand: "boom" } },
  });
  const err = await resolveDotnet10(
    undefined,
    cfg,
    undefined,
    async (_c, name) => {
      if (name === "/d") return "8.0.1";
      throw Object.assign(new Error("exit 1"), { output: "nope\n" });
    },
    "",
  ).catch((e: unknown) => e as RuntimeError);
  expect((err as RuntimeError).code).toBe("dotnet_bootstrap_failed");
  expect((err as RuntimeError).rawMessage).toBe("Configured .NET bootstrap command failed: nope");
});
