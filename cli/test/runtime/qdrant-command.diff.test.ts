// `knowns qdrant` (install, purge, status, start, stop, logs, cleanup) against the Go 0.34.1
// oracle: stdout, stderr, exit code and the resulting tree, in two isolated HOMEs. The managed
// runtime is seeded as files under <home>/.knowns/runtime/qdrant (a fake binary, pid and log
// files); no real Qdrant is started and the user's real ~/.knowns is never touched. Only what the
// harness normalises is masked (timestamps, temp roots); `start` against a missing binary and
// `install` against a bad mirror fail before any network or process.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compare, dispose, hasGoBin, type Step } from "../cli/commands/search-harness.ts";
import { withoutD14 } from "../helpers/d14.ts";

const cases = hasGoBin ? describe : describe.skip;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const SLOW = 180_000;
const rtDir = (dir: string) => join(dirname(dir), "home", ".knowns", "runtime", "qdrant");

interface Seed {
  binary?: boolean;
  pid?: number | string;
  log?: string;
}

function seed(s: Seed): (dir: string) => void {
  return (dir) => {
    const root = rtDir(dir);
    mkdirSync(join(root, "bin"), { recursive: true });
    if (s.binary) writeFileSync(join(root, "bin", "qdrant"), "#!/bin/sh\n", { mode: 0o755 });
    if (s.pid !== undefined) writeFileSync(join(root, "qdrant.pid"), String(s.pid));
    if (s.log !== undefined) {
      mkdirSync(join(root, "logs"), { recursive: true });
      writeFileSync(join(root, "logs", "qdrant.log"), s.log);
    }
  };
}

async function parity(steps: Array<string[] | Step>, setup: (dir: string) => void, env = {}) {
  const normalized: Step[] = steps.map((s) => (Array.isArray(s) ? { args: s } : s));
  // Semantic search is off by default, which would hide every other state.
  for (const s of normalized) s.env = { KNOWNS_SEMANTIC_VECTOR_ENABLED: "true", ...env, ...s.env };
  // D14: the `setup` subcommand row is dropped from TS help before the diff (Go output has none).
  const c = await compare("full", normalized, { setup, map: withoutD14 });
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
  expect([...c.tsTree.keys()].sort()).toEqual([...c.goTree.keys()].sort());
  for (const [k, v] of c.goTree) expect({ k, v: c.tsTree.get(k) }).toEqual({ k, v });
}

const STATUS = (extra: string[] = []) => [
  ["qdrant", "status", ...extra],
  ["qdrant", "status", "--plain", ...extra],
  ["qdrant", "status", "--json", ...extra],
];

cases("qdrant command matches Go", () => {
  test(
    "status: nothing installed",
    async () => {
      await parity(STATUS(), () => {});
    },
    SLOW,
  );

  test(
    "status: installed, stopped",
    async () => {
      await parity(STATUS(), seed({ binary: true }));
    },
    SLOW,
  );

  test(
    "status: stale pid",
    async () => {
      await parity(STATUS(), seed({ binary: true, pid: 2_999_999 }));
    },
    SLOW,
  );

  test(
    "status: running pid (this process)",
    async () => {
      await parity(STATUS(), seed({ binary: true, pid: process.pid }));
    },
    SLOW,
  );

  test(
    "status: external url and disabled backend",
    async () => {
      await parity(STATUS(), () => {}, {
        KNOWNS_QDRANT_URL: "https://user:pw@q.example.com:6333/x?k=1",
      });
      await parity(STATUS(), () => {}, { KNOWNS_SEMANTIC_VECTOR_ENABLED: "false" });
    },
    SLOW,
  );

  test(
    "cleanup: stale, running, none, external",
    async () => {
      await parity(
        [
          ["qdrant", "cleanup"],
          ["qdrant", "status", "--json"],
        ],
        seed({ binary: true, pid: 2_999_999 }),
      );
      await parity([["qdrant", "cleanup", "--plain"]], seed({ binary: true, pid: process.pid }));
      await parity([["qdrant", "cleanup", "--json"]], () => {});
      await parity([["qdrant", "cleanup", "--plain"]], () => {}, {
        KNOWNS_QDRANT_URL: "https://q.example.com",
      });
    },
    SLOW,
  );

  test(
    "stop: not running, stale pid, external",
    async () => {
      await parity(
        [
          ["qdrant", "stop"],
          ["qdrant", "stop", "--plain"],
        ],
        seed({ binary: true }),
      );
      await parity([["qdrant", "stop", "--json"]], seed({ binary: true, pid: 2_999_999 }));
      await parity([["qdrant", "stop", "--plain"]], () => {}, {
        KNOWNS_QDRANT_URL: "https://q.example.com",
      });
    },
    SLOW,
  );

  test(
    "logs: none, tail default, -n, --tail, CRLF and no final newline",
    async () => {
      await parity([["qdrant", "logs"]], () => {});
      const lines = Array.from({ length: 70 }, (_, i) => `line ${i + 1}`).join("\n");
      await parity(
        [
          ["qdrant", "logs"],
          ["qdrant", "logs", "-n", "3"],
          ["qdrant", "logs", "--tail", "0"],
        ],
        seed({ log: `${lines}\n` }),
      );
      await parity(
        [
          ["qdrant", "logs", "-n", "2"],
          ["qdrant", "logs", "--tail", "-5"],
        ],
        seed({ log: "a\r\nb\r\nc" }),
      );
      await parity([["qdrant", "logs"]], seed({ log: "" }));
    },
    SLOW,
  );

  test(
    "start: not installed, disabled, external",
    async () => {
      await parity(
        [
          ["qdrant", "start"],
          ["qdrant", "start", "--plain"],
        ],
        () => {},
      );
      await parity([["qdrant", "start", "--json"]], () => {}, {
        KNOWNS_SEMANTIC_VECTOR_ENABLED: "false",
      });
      await parity([["qdrant", "start", "--plain"]], () => {}, {
        KNOWNS_QDRANT_URL: "https://q.example.com",
      });
    },
    SLOW,
  );

  test(
    "install: external mode, bad mirrors, unsupported mirror scheme, missing/ bad file mirror",
    async () => {
      await parity([["qdrant", "install"]], () => {}, { KNOWNS_SEMANTIC_VECTOR_MODE: "external" });
      // D14: windows/amd64 has a managed artifact in the TS build, so it reaches the mirror checks
      // where Go 0.34.1 stops at "unsupported Qdrant platform". The mirror cases only compare
      // where both have an artifact; the Windows installer is covered in qdrant-installer.test.ts.
      if (process.platform === "win32") return;
      for (const mirror of [
        "http://mirror.example.com",
        "/plain/path",
        "https://u:p@mirror.example.com",
        "https://mirror.example.com?x=1",
        "file://remote/dir",
      ]) {
        await parity([["qdrant", "install"]], () => {}, { KNOWNS_QDRANT_MIRROR: mirror });
      }
      await parity([["qdrant", "install"]], () => {}, {
        KNOWNS_QDRANT_MIRROR: "file:///nonexistent-dir-xyz",
      });
    },
    SLOW,
  );

  test(
    "purge: no ownership proof, and the bare group",
    async () => {
      await parity([["qdrant", "purge"], ["qdrant"], ["qdrant", "bogus"]], () => {});
    },
    SLOW,
  );
});
