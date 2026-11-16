// KN-A1Q129: the daemon's live report, the proxy fallback record and what doctor says about them.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyCheckers } from "../../src/domain/doctor/proxy-checks.ts";
import { liveViewEmpty, liveViewJson, liveViewLines } from "../../src/runtime/live-lines.ts";
import {
  liveReportNow,
  readFallbacks,
  readLiveReports,
  removeLiveReport,
  writeLiveReport,
} from "../../src/runtime/live-report.ts";
import { proxyEnabled } from "../../src/runtime/proxy-mode.ts";

const root = mkdtempSync(join(tmpdir(), "knowns-live-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const writeFallbacks = (lines: string[]): void => {
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(join(root, "mcp", "proxy-fallback.jsonl"), `${lines.join("\n")}\n`);
};

describe("KNOWNS_MCP_PROXY", () => {
  test("only 0 opts out", () => {
    expect(proxyEnabled({})).toBe(true);
    expect(proxyEnabled({ KNOWNS_MCP_PROXY: "1" })).toBe(true);
    expect(proxyEnabled({ KNOWNS_MCP_PROXY: "" })).toBe(true);
    expect(proxyEnabled({ KNOWNS_MCP_PROXY: "0" })).toBe(false);
    expect(proxyEnabled({ KNOWNS_MCP_PROXY: " 0 " })).toBe(false);
  });
});

describe("live report", () => {
  test("a running daemon's report is read, a dead one's is ignored, removal works", () => {
    writeLiveReport(
      liveReportNow(
        [{ id: "s-1", client: "claude", project: "/p", startedAt: "t", pid: 5 }],
        [{ id: "u-1", port: 6420, projectRoot: "/p", startedAt: "t" }],
        { size: 2, busy: 1, queued: 0 },
      ),
      root,
    );
    const live = readLiveReports(root, () => true);
    expect(live).toHaveLength(1);
    expect(live[0]?.sessions[0]?.client).toBe("claude");
    expect(readLiveReports(root, () => false)).toEqual([]);
    removeLiveReport(undefined, root);
    expect(readLiveReports(root, () => true)).toEqual([]);
  });

  test("garbage in the live directory is not a report", () => {
    mkdirSync(join(root, "live"), { recursive: true });
    writeFileSync(join(root, "live", "daemon-bad.json"), "{nope");
    expect(readLiveReports(root, () => true)).toEqual([]);
  });
});

describe("proxy fallback record", () => {
  test("missing file, malformed lines and unknown fields are tolerated", () => {
    expect(readFallbacks(join(root, "nowhere"))).toEqual([]);
    writeFallbacks([
      "not json",
      '{"at":"nope","kind":"fallback"}',
      JSON.stringify({
        at: hoursAgo(1),
        pid: 7,
        version: "0.36.0",
        kind: "fallback",
        code: "busy",
        reason: "x",
        extra: 1,
      }),
      "",
    ]);
    const rows = readFallbacks(root, Date.now(), () => false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe("busy");
  });

  test("an old event of a dead pid is stale, a live pid's is not, a recovered one is closed", () => {
    writeFallbacks([
      JSON.stringify({
        at: hoursAgo(30),
        pid: 1,
        version: "v",
        kind: "fallback",
        code: "a",
        reason: "r",
      }),
      JSON.stringify({
        at: hoursAgo(30),
        pid: 2,
        version: "v",
        kind: "fallback",
        code: "b",
        reason: "r",
      }),
      JSON.stringify({
        at: hoursAgo(2),
        pid: 3,
        version: "v",
        kind: "fallback",
        code: "c",
        reason: "r",
      }),
      JSON.stringify({
        at: hoursAgo(1),
        pid: 3,
        version: "v",
        kind: "recovered",
        code: "",
        reason: "back",
      }),
    ]);
    const rows = readFallbacks(root, Date.now(), (pid) => pid === 2);
    expect(rows.map((r) => r.code)).toEqual(["b"]);
  });
});

describe("what is shown", () => {
  test("nothing to show means nothing is printed", () => {
    const view = { reports: [], fallbacks: [] };
    expect(liveViewEmpty(view)).toBe(true);
    expect(
      proxyCheckers({ proxyEnabled: true, reports: [], fallbacks: [], missingEntries: [] }),
    ).toEqual([]);
  });

  test("sessions, listeners, pool and fallbacks are listed", () => {
    const report = liveReportNow(
      [{ id: "s-1", client: "cursor", project: "/work/app", startedAt: "t", pid: 42 }],
      [{ id: "u-1", port: 6420, projectRoot: "/work/app", startedAt: "t" }],
      { size: 4, busy: 1, queued: 2 },
    );
    const fb = [
      {
        at: "2026-11-16T10:00:00Z",
        pid: 9,
        version: "v",
        kind: "fallback" as const,
        code: "busy",
        reason: "session limit",
      },
    ];
    const view = { reports: [report], fallbacks: fb };
    expect(liveViewEmpty(view)).toBe(false);
    const text = liveViewLines(view).join("\n");
    expect(text).toContain("cursor");
    expect(text).toContain("/work/app");
    expect(text).toContain("http://localhost:6420");
    expect(text).toContain("worker pool 1/4 busy, 2 queued");
    expect(text).toContain("session limit");
    expect(JSON.stringify(liveViewJson(view))).toContain('"uiListeners"');
  });

  test("doctor: a fallback warns and carries codes, not reasons; a healthy daemon passes", async () => {
    const report = liveReportNow([{ id: "s", client: "c", project: "/p", startedAt: "t" }], []);
    const fb = [
      {
        at: "2026-11-16T10:00:00Z",
        pid: 9,
        version: "v",
        kind: "fallback" as const,
        code: "busy",
        reason: "SECRET reason text",
      },
    ];
    const warn = proxyCheckers({
      proxyEnabled: true,
      reports: [report],
      fallbacks: fb,
      missingEntries: [],
    });
    expect(warn.map((c) => c.id)).toEqual(["runtime.mcp-proxy"]);
    const w = await warn[0]?.check(new AbortController().signal);
    expect(w?.status).toBe("warn");
    expect(JSON.stringify(w)).not.toContain("SECRET");
    expect(w?.evidence?.lastFallbackCode).toBe("busy");
    const pass = proxyCheckers({
      proxyEnabled: true,
      reports: [report],
      fallbacks: [],
      missingEntries: [],
    });
    expect((await pass[0]?.check(new AbortController().signal))?.status).toBe("pass");
  });

  test("doctor: a config entry pointing at a missing knowns-proxy says run knowns sync", async () => {
    const checks = proxyCheckers({
      proxyEnabled: true,
      reports: [],
      fallbacks: [],
      missingEntries: [
        { file: ".mcp.json", command: "knowns-proxy" },
        { file: ".cursor/mcp.json", command: "/x/knowns-proxy" },
      ],
    });
    expect(checks.map((c) => c.id)).toEqual(["runtime.mcp-config"]);
    const r = await checks[0]?.check(new AbortController().signal);
    expect(r?.status).toBe("warn");
    expect(r?.remediation?.command).toBe("knowns sync");
    expect(r?.evidence?.files).toEqual([".cursor/mcp.json", ".mcp.json"]);
  });
});

describe("proxy text is cleaned and the env's runtime root is used", () => {
  test("control characters and long reasons never reach the terminal", async () => {
    const { liveViewLines: lines } = await import("../../src/runtime/live-lines.ts");
    const fb = [
      {
        at: "2026-11-16T10:00:00Z",
        pid: 1,
        version: "v",
        kind: "fallback" as const,
        code: "busy",
        reason: `\u001b[31mred\u001b[0m\nsecond line ${"x".repeat(500)}`,
      },
    ];
    const text = lines({ reports: [], fallbacks: fb }).join("\n");
    expect(text).not.toContain("\u001b");
    expect(text.split("\n").length).toBe(2);
    expect(text.length).toBeLessThan(260);
  });

  test("loadLiveView reads the root of the env it is given", async () => {
    const { loadLiveView } = await import("../../src/runtime/live-lines.ts");
    const mine = mkdtempSync(join(tmpdir(), "knowns-live-env-"));
    mkdirSync(join(mine, "mcp"), { recursive: true });
    writeFileSync(
      join(mine, "mcp", "proxy-fallback.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: "v", kind: "fallback", code: "c", reason: "r" })}\n`,
    );
    expect(loadLiveView({ KNOWNS_RUNTIME_ROOT: mine }).fallbacks).toHaveLength(1);
    expect(loadLiveView({ KNOWNS_RUNTIME_ROOT: join(mine, "other") }).fallbacks).toHaveLength(0);
    rmSync(mine, { recursive: true, force: true });
  });
});
