// status against the Go 0.34.1 oracle, plus the readiness library.
//
// Two documented differences are normalised. The oracle prints `dev` as its version (handled by
// the harness). The LSP section is host state (which language servers are installed) from the
// LSP manager, which is a separate port (TSR-XSEKND); it is removed from the Go side's output and
// the TS side omits it until that port provides `BuildOptions.lsp`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatTimeSince, renderStatusPlain } from "../../../src/cli/commands/status.ts";
import { buildReadiness, inactivePayload } from "../../../src/domain/readiness/index.ts";
import { buildSearchEnvironment } from "../../../src/domain/searchenv/index.ts";
import { createStorage } from "../../../src/storage/adapters.ts";
import { Store } from "../../../src/storage/core/store.ts";
import { dispose, hasGoBin, makeFixtureProject, writeFixtureText } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const cases = hasGoBin ? describe : describe.skip;

/** Drops the LSP section from `status` output (styled, plain and json). */
function withoutLsp(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if ("lsp" in j) {
      const { lsp: _lsp, ...rest } = j;
      return JSON.stringify(rest);
    }
    return JSON.stringify(j);
  } catch {
    return (
      text
        .replace(/^LSP: .*\n/m, "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI styling is part of the output
        .replace(/\x1b\[1mLSP\x1b\[m\n(?: {2}.*\n| {4}.*\n)+\n/, "")
    );
  }
}

const opts = { map: withoutLsp };
/** The oracle probes every language server on the host: slow. */
const SLOW = 120_000;

cases("status matches Go", () => {
  test(
    "every output mode",
    async () => {
      await expectParity(
        "full",
        [["status"], ["status", "--plain"], ["status", "--json"], ["status", "--help"]],
        opts,
      );
    },
    SLOW,
  );

  test(
    "empty project",
    async () => {
      await expectParity("empty", [["status"], ["status", "--plain"], ["status", "--json"]], opts);
    },
    SLOW,
  );

  test(
    "outside a project: error, or the inactive payload under --json",
    async () => {
      await expectParity("", [["status"], ["status", "--plain"], ["status", "--json"]], opts);
    },
    SLOW,
  );

  test(
    "semantic search enabled, with and without a model",
    async () => {
      await expectParity(
        "full",
        [
          ["config", "set", "embedding", "true"],
          ["status"],
          ["status", "--plain"],
          ["status", "--json"],
          ["config", "set", "settings.semanticSearch.model", "foo"],
          ["status"],
          ["status", "--plain"],
          ["status", "--json"],
        ],
        opts,
      );
    },
    SLOW,
  );

  test(
    "environment switches that change the search section",
    async () => {
      await expectParity(
        "full",
        [
          { args: ["status", "--json"], env: { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1" } },
          { args: ["status", "--json"], env: { KNOWNS_SEMANTIC_RUNTIME_IDLE_TIMEOUT_MS: "90000" } },
          { args: ["status", "--json"], env: { KNOWNS_SEMANTIC_VECTOR_ENABLED: "1" } },
        ],
        opts,
      );
    },
    SLOW,
  );

  test(
    "permissions, imports and legacy decision memories",
    async () => {
      await expectParity("full", [["status", "--json"], ["status", "--plain"], ["status"]], {
        ...opts,
        setup: (dir) => {
          const cfgPath = join(dir, ".knowns", "config.json");
          const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
          cfg.settings.permissions = { preset: "read-only" };
          writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
          mkdirSync(join(dir, ".knowns", "imports", "one"), { recursive: true });
          writeFileSync(join(dir, ".knowns", "imports", "one", "_import.json"), "{}");
          mkdirSync(join(dir, ".knowns", "imports", "empty"), { recursive: true });
          writeFixtureText(
            dir,
            ".knowns/memory/memory-legacy.md",
            `---
id: legacy
title: Old decision
layer: project
category: decision
createdAt: '2026-11-03T13:37:36.502Z'
updatedAt: '2026-11-03T13:37:36.502Z'
---
body
`,
          );
        },
      });
    },
    SLOW,
  );
});

/**
 * Writes the runtime daemon's files under the sandboxed HOME: a pid file, leases, the project
 * registry and one queue file. The queue file name is Go's sanitizeProjectKey of this side's store
 * root, written here independently of the port, so Go only finds the jobs if the key is right, and
 * the port only reports them if its own key agrees with Go's.
 */
function runtimeFiles(pidText: string) {
  return (dir: string) => {
    const home = join(dirname(dir), "home");
    const root = join(home, ".knowns", "runtime");
    const store = join(dir, ".knowns");
    mkdirSync(join(root, "leases"), { recursive: true });
    mkdirSync(join(root, "queues"), { recursive: true });
    writeFileSync(join(root, "knowns-runtime.pid"), pidText);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const lease = (id: string, over: Record<string, unknown>) =>
      writeFileSync(
        join(root, "leases", `${id}.json`),
        JSON.stringify({
          id,
          clientKind: "cli",
          projectRoot: store,
          watch: false,
          expiresAt: future,
          ...over,
        }),
      );
    lease("live-a", {});
    lease("live-b", { pid: process.pid });
    lease("expired", { expiresAt: past });
    lease("dead-pid", { pid: 2_147_483_000 });
    writeFileSync(join(root, "leases", "broken.json"), "{not json");
    writeFileSync(join(root, "leases", "ignored.txt"), "x");
    // Go's key: <parent dir name>-<hex of h = h*31 + rune over the whole path, uint32>.
    let h = 0;
    for (const ch of store) h = (Math.imul(h, 31) + (ch.codePointAt(0) as number)) >>> 0;
    const key = `${basename(dirname(store))}-${h.toString(16).padStart(8, "0")}`;
    writeFileSync(
      join(root, "queues", `${key}.json`),
      JSON.stringify({
        jobs: [
          { id: "1", kind: "reindex", startedAt: future },
          { id: "2", kind: "reindex" },
          { id: "3", kind: "reindex" },
        ],
      }),
    );
    // A registered project with no queue file and a duplicate entry must not change the counts.
    writeFileSync(
      join(root, "projects.json"),
      JSON.stringify([store, store, "", join(dir, "gone")]),
    );
  };
}

cases("status: the runtime section reads the daemon's files like Go", () => {
  const steps = [["status", "--plain"], ["status", "--json"], ["status"]];
  test(
    "a live daemon, live and stale leases, a queue with a running job",
    async () => {
      await expectParity("full", steps, { ...opts, setup: runtimeFiles(`${process.pid}\n`) });
    },
    SLOW,
  );
  test(
    "pid file padded with whitespace",
    async () => {
      await expectParity("full", [steps[1] as string[]], {
        ...opts,
        setup: runtimeFiles(`  ${process.pid} \n`),
      });
    },
    SLOW,
  );
  test(
    "pid text that is not wholly an integer means not running (strconv.Atoi)",
    async () => {
      for (const text of [`${process.pid}abc`, `${process.pid}.0`, "", "abc", `0x${process.pid}`]) {
        await expectParity("full", [steps[1] as string[]], { ...opts, setup: runtimeFiles(text) });
      }
    },
    SLOW,
  );
  test(
    "a pid that is not alive",
    async () => {
      await expectParity("full", [steps[1] as string[]], {
        ...opts,
        setup: runtimeFiles("2147483000"),
      });
    },
    SLOW,
  );
});

describe("readiness library", () => {
  const made: ReturnType<typeof makeFixtureProject>[] = [];
  afterEach(() => {
    for (const p of made.splice(0)) dispose(p);
  });

  test("inactive payload is minimal", () => {
    expect(inactivePayload()).toMatchObject({ active: false, projectName: "", projectPath: "" });
  });

  test("counts and capabilities over the full fixture", () => {
    const p = makeFixtureProject("full");
    made.push(p);
    const storage = createStorage(Store.open(join(p.dir, ".knowns")), {
      globalRoot: join(p.home, ".knowns"),
    });
    const env = buildSearchEnvironment({
      env: { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1" },
      settingsPath: join(p.home, ".knowns", "settings.json"),
      globalStorage: () => undefined,
    });
    const payload = buildReadiness(storage, env, {
      runtime: {
        enabled: true,
        running: true,
        connectedClients: 2,
        queuedJobs: 1,
        runningJobs: 0,
        state: "healthy",
      },
    });
    expect(payload.knowledge).toMatchObject({ docs: 4, tasks: 7, templates: 1 });
    expect(payload.knowledge?.decisions).toEqual({ total: 3, current: 1, draft: 1, historical: 1 });
    expect(payload.search?.semanticRuntime).toMatchObject({
      enabled: false,
      disabledBy: "KNOWNS_SEMANTIC_RUNTIME_DISABLED",
    });
    expect(payload.capabilities).toContain("browser-chat");
    expect(payload.capabilities).not.toContain("semantic-search");
    expect(payload.permissions).toMatchObject({ preset: "read-write-no-delete", isDefault: true });
    expect(payload.lsp).toBeUndefined();
  });

  test("time since", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(formatTimeSince("2026-11-04T11:59:40Z", now)).toBe("just now");
    expect(formatTimeSince("2026-11-04T11:55:00Z", now)).toBe("5m ago");
    expect(formatTimeSince("2026-11-04T09:00:00Z", now)).toBe("3h ago");
    expect(formatTimeSince("2026-11-01T12:00:00Z", now)).toBe("3d ago");
  });

  test("plain rendering of an inactive payload", () => {
    expect(renderStatusPlain(inactivePayload())).toBe("No active project.\n");
  });
});
