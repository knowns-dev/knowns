import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isKnownsWritten, mcpCommand } from "../../../src/domain/setup/mcp-command.ts";
import { syncMcpConfigs } from "../../../src/domain/setup/mcp-config.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "kn-proxy-cmd-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const exeName = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);
const exe = (dir: string, name: string): void => {
  const f = join(dir, exeName(name));
  writeFileSync(f, "x");
  chmodSync(f, 0o755);
};

describe("mcpCommand with the native proxy", () => {
  test("the proxy on PATH wins", () => {
    const bin = tmp();
    exe(bin, "knowns");
    exe(bin, "knowns-proxy");
    expect(mcpCommand({ PATH: bin })).toEqual({
      command: "knowns-proxy",
      args: ["mcp", "--stdio"],
    });
  });

  test("a proxy next to the real knowns binary is used by absolute path", () => {
    if (process.platform === "win32") return;
    const bin = tmp();
    exe(bin, "knowns");
    exe(bin, "knowns-proxy");
    const other = tmp();
    symlinkSync(join(bin, "knowns"), join(other, "knowns"));
    expect(mcpCommand({ PATH: other }).command).toBe(join(realpathSync(bin), "knowns-proxy"));
  });

  test("KNOWNS_MCP_PROXY=0 and a missing proxy keep knowns mcp --stdio", () => {
    const bin = tmp();
    exe(bin, "knowns");
    expect(mcpCommand({ PATH: bin }).command).toBe("knowns");
    exe(bin, "knowns-proxy");
    expect(mcpCommand({ PATH: bin, KNOWNS_MCP_PROXY: "0" }).command).toBe("knowns");
  });

  test("isKnownsWritten accepts only exactly what Knowns writes", () => {
    const mcp = ["mcp", "--stdio"];
    // written by Knowns
    expect(isKnownsWritten("knowns", mcp)).toBe(true);
    expect(isKnownsWritten("knowns-proxy", mcp)).toBe(true);
    expect(isKnownsWritten("/x/bin/knowns-proxy", mcp)).toBe(true);
    expect(isKnownsWritten("C:\\kn\\knowns-proxy.exe", mcp)).toBe(true);
    expect(isKnownsWritten("npx", ["-y", "knowns", "mcp", "--stdio"])).toBe(true);
    // theirs: extra args, a custom absolute binary (the dogfood build), other servers
    expect(isKnownsWritten("knowns", [...mcp, "--debug"])).toBe(false);
    expect(isKnownsWritten("knowns-proxy", ["mcp", "--stdio", "--project", "/p"])).toBe(false);
    expect(isKnownsWritten("/home/me/.knowns-ts/bin/knowns", mcp)).toBe(false);
    expect(isKnownsWritten("npx", ["-y", "knowns", "mcp"])).toBe(true); // older releases
    expect(isKnownsWritten("npx", ["-y", "knowns", "serve"])).toBe(false);
    expect(isKnownsWritten("npx", ["-y", "knowns", "mcp", "--stdio", "--x"])).toBe(false);
    expect(isKnownsWritten("node", ["my-server.js"])).toBe(false);
    expect(isKnownsWritten("knowns", ["something-else"])).toBe(false);
    // Antigravity entries carry the project root; only there is that accepted
    const withProject = [...mcp, "--project", "/p"];
    expect(isKnownsWritten("knowns", withProject, { allowProject: true })).toBe(true);
    expect(isKnownsWritten("knowns", [...withProject, "--x"], { allowProject: true })).toBe(false);
  });

  test("sync leaves a custom binary, extra args and a non-array opencode command alone", () => {
    const bin = tmp();
    exe(bin, "knowns");
    exe(bin, "knowns-proxy");
    const env = { PATH: `${bin}${delimiter}`, HOME: tmp() };
    const cases: Array<[string, unknown]> = [
      ["custom", { command: "/home/me/.knowns-ts/bin/knowns", args: ["mcp", "--stdio"] }],
      ["extra", { command: "knowns", args: ["mcp", "--stdio", "--debug"] }],
    ];
    for (const [name, entry] of cases) {
      const dir = tmp();
      mkdirSync(join(dir, ".knowns"));
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { knowns: entry } }));
      writeFileSync(
        join(dir, "opencode.json"),
        JSON.stringify({ mcp: { knowns: { type: "local", command: "knowns mcp --stdio" } } }),
      );
      syncMcpConfigs(dir, env, () => {});
      expect(
        JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.knowns,
        name,
      ).toEqual(entry);
      expect(
        JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")).mcp.knowns.command,
        name,
      ).toBe("knowns mcp --stdio");
    }
  });

  test("sync moves a Knowns-written entry to the proxy and leaves a user's entry alone", () => {
    const bin = tmp();
    exe(bin, "knowns");
    exe(bin, "knowns-proxy");
    const env = { PATH: `${bin}${delimiter}`, HOME: tmp() };
    const mine = tmp();
    const theirs = tmp();
    for (const [dir, entry] of [
      [mine, { command: "knowns", args: ["mcp", "--stdio"] }],
      [theirs, { command: "node", args: ["custom.js"] }],
    ] as const) {
      mkdirSync(join(dir, ".knowns"));
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { knowns: entry } }));
      syncMcpConfigs(dir, env, () => {});
    }
    const read = (d: string) =>
      JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8")).mcpServers.knowns;
    expect(read(mine).command).toBe("knowns-proxy");
    expect(read(theirs).command).toBe("node");
  });
});

describe("findMissingProxyEntries", () => {
  test("reports a proxy entry whose binary is gone and nothing else", async () => {
    const { findMissingProxyEntries } = await import("../../../src/domain/setup/mcp-audit.ts");
    const root = tmp();
    const bin = tmp();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { knowns: { command: "knowns-proxy", args: ["mcp", "--stdio"] } },
      }),
    );
    mkdirSync(join(root, ".cursor"));
    writeFileSync(
      join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { knowns: { command: "knowns", args: ["mcp", "--stdio"] } } }),
    );
    expect(findMissingProxyEntries(root, { PATH: bin })).toEqual([
      { file: ".mcp.json", command: "knowns-proxy" },
    ]);
    exe(bin, "knowns-proxy");
    expect(findMissingProxyEntries(root, { PATH: bin })).toEqual([]);
  });
});
