// `runtime ps`, `runtime reload` and `runtime logs` against the Go 0.34.1 oracle.
//
// The sandbox HOME of each side is seeded with the same runtime state (pid file, status.json,
// leases, a registered project queue holding queued, running, failed and dead-lettered jobs, the
// daemon's semantic-status snapshot, and log files). Normalised, and only because Go itself is
// nondeterministic or the LSP manager is not ported:
//   - durations measured against "now" (client age, running / queued time). The seeded timestamps are
//     months in the past, so they all have the `NNNh..m..s` shape and are rewritten to `<D>`;
//   - request ids and the requesting pid (a fresh UUID and the CLI process id per `runtime reload`);
//   - the LSP service: Go's snapshot lists the host's language servers (the LSP manager is a separate
//     port), so the Services box line `LSP ... detail: knowns lsp list`, the `lsp` entries of the
//     `--json` services array, and the Services (N) count are made to agree.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeProjectKey } from "../../../src/runtime/queue.ts";
import { compare, dispose, hasGoBin, type Step } from "./search-harness.ts";

const cases = hasGoBin ? describe : describe.skip;

const PAST = "2026-01-01T00:00:00Z";
const T = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;

function seed(opts: { running: boolean; leases?: boolean }): (dir: string) => void {
  return (dir) => {
    const home = join(dirname(dir), "home");
    const rt = join(home, ".knowns", "runtime");
    const store = join(dir, ".knowns");
    mkdirSync(join(rt, "queues"), { recursive: true });
    mkdirSync(join(rt, "leases"), { recursive: true });
    mkdirSync(join(home, ".knowns", "logs"), { recursive: true });

    if (opts.running) {
      writeFileSync(join(rt, "knowns-runtime.pid"), String(process.pid));
      writeFileSync(
        join(rt, "status.json"),
        JSON.stringify({
          version: "9.9.9",
          startedAt: PAST,
          watchers: [
            { projectRoot: store, demand: 2, active: true, state: "running" },
            {
              projectRoot: "/elsewhere/other/.knowns",
              demand: 1,
              active: false,
              state: "grace",
              gracePending: true,
              graceUntil: "2099-01-01T00:00:00Z",
            },
          ],
        }),
      );
      writeFileSync(
        join(rt, "semantic-status.json"),
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          status: {
            enabled: true,
            idleTimeout: 120_000_000_000,
            lastReloadAt: T(30),
            reloadGeneration: 4,
            reloadRequestId: "req-seeded",
            entries: [
              {
                key: "k1",
                provider: "ollama",
                model: "nomic",
                dimensions: 768,
                loaded: true,
                activeSessions: 2,
                lastUsed: T(10),
                idleFor: 5_000_000_000,
                idleUnloadAfter: T(40),
                storeConsumers: ["a", "b"],
                providerIdentity: "ollama@http://localhost:11434",
              },
            ],
          },
        }),
      );
    }
    if (opts.leases) {
      const lease = (id: string, kind: string, root: string, pid?: number) => ({
        id,
        clientKind: kind,
        projectRoot: root,
        watch: true,
        ...(pid ? { pid } : {}),
        createdAt: PAST,
        updatedAt: PAST,
        expiresAt: "2099-01-01T00:00:00Z",
      });
      const leases = [
        lease("a1", "mcp", store, process.pid),
        lease("a2", "cli", store),
        lease("a3", "server", "/x/y/.knowns", process.pid),
      ];
      for (const l of leases) writeFileSync(join(rt, "leases", `${l.id}.json`), JSON.stringify(l));
    }

    writeFileSync(join(rt, "projects.json"), JSON.stringify([store]));
    const job = (id: string, kind: string, target: string, extra: object = {}) => ({
      id,
      key: `${kind}:${target}`,
      kind,
      target,
      requestedAt: PAST,
      runAfter: PAST,
      ...extra,
    });
    const result = (
      id: string,
      kind: string,
      target: string,
      success: boolean,
      done: number,
      error = "",
    ) => ({
      jobId: id,
      key: `${kind}:${target}`,
      kind,
      target,
      success,
      ...(error ? { error } : {}),
      completedAt: T(done),
      requestedAt: T(0),
      startedAt: T(done - 1),
      attemptCount: 1,
    });
    writeFileSync(
      join(rt, "queues", `${sanitizeProjectKey(store)}.json`),
      JSON.stringify({
        jobs: [
          job("j1", "reindex-search", "", {
            startedAt: PAST,
            phase: "embedding",
            processed: 5,
            total: 10,
          }),
          job("j2", "index-doc", "guides/some/really/long/document/path/that/needs/shortening.md", {
            startedAt: PAST,
          }),
          job("j3", "index-task", "abc123", { startedAt: PAST, phase: "chunking" }),
          job("j4", "index-task", "def456"),
          job("j5", "reconcile-qdrant", "task:t1", {
            attempts: 8,
            lastError: "qdrant down",
            deadLetter: true,
          }),
        ],
        recent: [
          result("r1", "index-task", "ok1", true, 50),
          result(
            "r2",
            "index-doc",
            "docs/a",
            false,
            55,
            "index doc: semantic runtime unavailable: model missing",
          ),
          result(
            "r3",
            "index-doc",
            "docs/a",
            false,
            57,
            "index doc: semantic runtime unavailable: model missing",
          ),
          result("r4", "index-task", "t9", false, 58, "dial tcp:\nconnection refused"),
          result("r5", "remove-doc", "docs/z", true, 59),
          result("r6", "index-memory", "m1", false, 52, ""),
        ],
        updatedAt: PAST,
      }),
    );

    writeFileSync(
      join(home, ".knowns", "logs", "runtime.log"),
      `${Array.from({ length: 70 }, (_, i) => `runtime line ${i + 1}`).join("\n")}\n`,
    );
    writeFileSync(join(home, ".knowns", "logs", "mcp.log"), "mcp one\r\nmcp two\nmcp three");
  };
}

// The LSP row of the Services box ("LSP  17 languages ... detail: knowns lsp list"), which a narrow
// terminal truncates.
const LSP_BOX_LINE = /^.*LSP.*\d+ languages.*\n/m;

function mapText(text: string): string {
  let t = text;
  try {
    const j = JSON.parse(t) as { services?: Array<{ type: string }> };
    if (Array.isArray(j.services)) {
      j.services = j.services.filter((s) => s.type !== "lsp");
      t = `${JSON.stringify(j, null, 2)}\n`;
    }
  } catch {
    // not JSON
  }
  t = t.replace(LSP_BOX_LINE, "");
  t = t.replace(/("request": \{[^}]*"pid": )\d+/, "$1<PID>");
  t = t.replace(/Services \(3\)/, "Services (2)");
  t = t.replace(/\d{3,}h\d+m\d+s/g, "<D>");
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<UUID>");
  return t;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function parity(
  fixture: string,
  steps: Array<string[] | Step>,
  setup: (dir: string) => void,
  env?: Record<string, string>,
): Promise<void> {
  const normalized: Step[] = steps.map((s) => (Array.isArray(s) ? { args: s } : s));
  if (env) for (const s of normalized) s.env = { ...env, ...s.env };
  const c = await compare(fixture, normalized, { setup, map: mapText });
  cleanups.push(
    () => dispose(c.goP),
    () => dispose(c.tsP),
  );
  for (let i = 0; i < normalized.length; i++) {
    const label = (normalized[i] as Step).args.join(" ");
    expect({ step: label, ...(c.ts[i] as object) }).toEqual({
      step: label,
      ...(c.go[i] as object),
    });
  }
}

const SLOW = 180_000;

cases("runtime ps matches Go", () => {
  test(
    "daemon stopped, empty queue",
    async () => {
      await parity(
        "full",
        [
          ["runtime", "ps"],
          ["runtime", "ps", "--plain"],
          ["runtime", "ps", "--json"],
          ["runtime", "ps", "--jobs"],
          ["runtime", "ps", "--failed"],
          ["runtime", "ps", "--all", "--plain"],
        ],
        () => {},
      );
    },
    SLOW,
  );

  test(
    "running daemon with clients, watchers, jobs and failures",
    async () => {
      const setup = seed({ running: true, leases: true });
      await parity(
        "full",
        [
          ["runtime", "ps"],
          ["runtime", "ps", "--plain"],
          ["runtime", "ps", "--json"],
          ["runtime", "ps", "--jobs"],
          ["runtime", "ps", "--jobs", "--plain"],
          ["runtime", "ps", "--jobs", "--tail", "2"],
          ["runtime", "ps", "--tail", "2", "--plain"],
          ["runtime", "ps", "--failed"],
          ["runtime", "ps", "--failed", "--plain"],
          ["runtime", "ps", "--all"],
          ["runtime", "ps", "--all", "--plain"],
          ["runtime", "ps", "--all", "--json"],
          ["runtime", "ps", "--clients", "1"],
          ["runtime", "ps", "--clients", "1", "--plain"],
          ["runtime", "ps", "--clients", "0", "--failures", "0"],
          ["runtime", "ps", "--failures", "1", "--plain"],
          ["runtime", "ps", "--failures", "-4", "--tail", "-1", "--json"],
        ],
        setup,
      );
    },
    SLOW,
  );

  test(
    "daemon not running but a project queue exists",
    async () => {
      await parity(
        "full",
        [
          ["runtime", "ps"],
          ["runtime", "ps", "--plain"],
          ["runtime", "ps", "--json"],
          ["runtime", "ps", "--jobs"],
        ],
        seed({ running: false, leases: false }),
      );
    },
    SLOW,
  );

  test(
    "semantic runtime disabled by the environment",
    async () => {
      await parity(
        "full",
        [
          ["runtime", "ps"],
          ["runtime", "ps", "--plain"],
          ["runtime", "ps", "--json"],
        ],
        seed({ running: true }),
        { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1" },
      );
    },
    SLOW,
  );

  test(
    "embedding detector with semantic search enabled",
    async () => {
      await parity(
        "full",
        [
          ["config", "set", "embedding", "true"],
          ["runtime", "ps"],
          ["runtime", "ps", "--json"],
          ["runtime", "reload", "--plain"],
        ],
        seed({ running: true }),
      );
      await parity(
        "full",
        [
          ["config", "set", "embedding", "true"],
          ["runtime", "ps"],
          ["runtime", "ps", "--json"],
        ],
        seed({ running: false }),
      );
    },
    SLOW,
  );

  test(
    "narrow terminal and no project",
    async () => {
      const saved = process.env.COLUMNS;
      process.env.COLUMNS = "70";
      try {
        const steps: Step[] = [
          { args: ["runtime", "ps", "--jobs"], env: { COLUMNS: "70" } },
          { args: ["runtime", "ps"], env: { COLUMNS: "70" } },
        ];
        await parity("full", steps, seed({ running: true, leases: true }));
        await parity(
          "",
          [
            ["runtime", "ps"],
            ["runtime", "ps", "--json"],
          ],
          seed({ running: true }),
          { COLUMNS: "70" },
        );
      } finally {
        if (saved === undefined) delete process.env.COLUMNS;
        else process.env.COLUMNS = saved;
      }
    },
    SLOW,
  );

  test(
    "help",
    async () => {
      await parity(
        "full",
        [
          ["runtime", "ps", "--help"],
          ["runtime", "reload", "--help"],
          ["runtime", "logs", "--help"],
        ],
        () => {},
      );
    },
    SLOW,
  );
});

cases("runtime reload matches Go", () => {
  test(
    "daemon not running: noop",
    async () => {
      await parity(
        "full",
        [
          ["runtime", "reload"],
          ["runtime", "reload", "--plain"],
          ["runtime", "reload", "--json"],
          ["runtime", "reload", "--wait"],
        ],
        () => {},
      );
      await parity(
        "",
        [
          ["runtime", "reload"],
          ["runtime", "reload", "--json"],
        ],
        () => {},
      );
    },
    SLOW,
  );

  test(
    "daemon running: request is written, wait times out",
    async () => {
      const setup = seed({ running: true });
      await parity(
        "full",
        [
          ["runtime", "reload"],
          ["runtime", "reload", "--plain"],
          ["runtime", "reload", "--json"],
          ["runtime", "reload", "--wait", "--timeout", "300ms"],
        ],
        setup,
      );
    },
    SLOW,
  );
});

cases("runtime logs matches Go", () => {
  test(
    "no log yet",
    async () => {
      await parity(
        "full",
        [
          ["runtime", "logs"],
          ["runtime", "logs", "--plain", "-s", "mcp"],
        ],
        // Every Go process creates an empty ~/.knowns/logs/mcp.log at start-up (the mcp package
        // opens its logger at init). The TS binary does not, so both sides get the empty file.
        (dir) => {
          const logs = join(dirname(dir), "home", ".knowns", "logs");
          mkdirSync(logs, { recursive: true });
          writeFileSync(join(logs, "mcp.log"), "");
        },
      );
    },
    SLOW,
  );

  test(
    "seeded logs: tail, source, plain",
    async () => {
      const setup = seed({ running: false });
      await parity(
        "full",
        [
          ["runtime", "logs"],
          ["runtime", "logs", "--plain"],
          ["runtime", "logs", "-n", "3"],
          ["runtime", "logs", "--tail", "0", "--source", "runtime"],
          ["runtime", "logs", "-s", "mcp", "-n", "2"],
          ["runtime", "logs", "-s", "mcp", "--plain"],
          ["runtime", "logs", "--source", "all", "-n", "1"],
          ["runtime", "logs", "--source", "nope"],
        ],
        setup,
      );
    },
    SLOW,
  );
});
