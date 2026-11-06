// `knowns doctor` against the Go 0.34.1 oracle: stdout, stderr, exit code and the project tree.
//
// Everything runs offline: HTTPS_PROXY points at a closed port, so the online checks fail the same
// way on both sides (network_request_failed) and nothing depends on the registry. The PATH holds
// no ollama (the machine's own would change search.model), only the system directories; machine
// facts that remain (installed language servers, global skills) are the same for both sides.
// Go reports its version as `dev`; search-harness maps it to the TS version.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { VERSION } from "../../../src/version.ts";
import { hasGoBin, makeFixtureProject, writeFixtureText } from "./search-harness.ts";
import { expectParity as parity } from "./search-parity.ts";

const expectParity: typeof parity = (fixture, steps, opts = {}) =>
  parity(fixture, steps, { map: sameVersion, ...opts });

const cases = hasGoBin ? describe : describe.skip;
const SLOW = 180_000;

// The TS side runs as a real process (stdin: "") so it sees the same PATH as Go; bun's own
// directory is on it only so the child can be started.
const offline = {
  PATH:
    process.platform === "win32"
      ? (process.env.PATH ?? "")
      : ["/usr/bin", "/bin", dirname(process.execPath)].join(delimiter),
  HTTPS_PROXY: "http://127.0.0.1:1",
  HTTP_PROXY: "http://127.0.0.1:1",
  NO_PROXY: "",
};

const step = (args: string[], env = offline) => ({ args, env, stdin: "" });

/** Go says `dev`, TS says its package version: the one intended difference. */
const SPINNER = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";
const sameVersion = (t: string): string =>
  t
    // `setup` draws a spinner whose frame count depends on timing (init-harness strips it too).
    .replace(new RegExp(`\\r  \\x1b\\[90m${SPINNER}\\x1b\\[m [^\\r\\n]*`, "g"), "")
    .replace(/\r {2,}(?=\r)/g, "")
    .replaceAll('"knownsVersion": "dev"', '"knownsVersion": "<V>"')
    .replaceAll(`"knownsVersion": "${VERSION}"`, '"knownsVersion": "<V>"')
    .replaceAll('"currentVersion": "dev"', '"currentVersion": "<V>"')
    .replaceAll(`"currentVersion": "${VERSION}"`, '"currentVersion": "<V>"');

const modes = (extra: string[] = []) => [
  step(["doctor", ...extra]),
  step(["doctor", "--plain", ...extra]),
  step(["doctor", "--json", ...extra]),
  step(["doctor", "--verbose", ...extra]),
];

const config = (dir: string, mutate: (c: Record<string, unknown>) => void) => {
  const path = join(dir, ".knowns", "config.json");
  const c = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(c);
  writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`);
};
const settings = (c: Record<string, unknown>) => c.settings as Record<string, unknown>;

cases("doctor matches Go", () => {
  test(
    "a healthy-looking project in every mode",
    async () => {
      await expectParity("full", modes());
    },
    SLOW,
  );

  test(
    "scopes",
    async () => {
      for (const scope of ["project", "validation", "search", "runtime", "lsp", "ai", "online"]) {
        await expectParity("full", [step(["doctor", "--scope", scope, "--plain", "--verbose"])]);
      }
      await expectParity("full", [
        step(["doctor", "--scope", "project,ai", "--scope", "project", "--json"]),
      ]);
    },
    SLOW,
  );

  test(
    "strict exit code",
    async () => {
      await expectParity("full", [
        step(["doctor", "--strict", "--scope", "validation"]),
        step(["doctor", "--scope", "validation"]),
      ]);
    },
    SLOW,
  );

  test(
    "empty project",
    async () => {
      await expectParity("empty", modes());
    },
    SLOW,
  );

  test(
    "no project",
    async () => {
      await expectParity("", modes());
    },
    SLOW,
  );

  test(
    "usage errors exit 2",
    async () => {
      await expectParity("full", [
        step(["doctor", "--bogus"]),
        step(["doctor", "--scope", "nope"]),
        step(["doctor", "extra"]),
        step(["doctor", "--help"]),
        step(["help", "doctor"]),
      ]);
    },
    SLOW,
  );

  test(
    "unreadable config and missing storage directories",
    async () => {
      await expectParity("empty", modes(["--scope", "project"]), {
        setup: (dir) => writeFixtureText(dir, ".knowns/config.json", "{not json"),
      });
      await expectParity("empty", modes(["--scope", "project"]), {
        setup: (dir) => {
          rmSync(join(dir, ".knowns", "tasks"), { recursive: true });
          rmSync(join(dir, ".knowns", "templates"), { recursive: true });
        },
      });
    },
    SLOW,
  );

  test(
    "a config that needs migration",
    async () => {
      await expectParity("empty", modes(["--scope", "project"]), {
        setup: (dir) =>
          writeFixtureText(
            dir,
            ".knowns/config.json",
            `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","dimensions":384}}}`,
          ),
      });
    },
    SLOW,
  );

  test(
    "semantic search enabled with ollama missing from PATH",
    async () => {
      await expectParity("empty", modes(["--scope", "search"]), {
        setup: (dir) =>
          config(dir, (c) => {
            settings(c).semanticSearch = {
              enabled: true,
              provider: "ollama",
              model: "nomic-embed-text",
            };
          }),
      });
    },
    SLOW,
  );

  test(
    "semantic search enabled without a model, and with the api provider",
    async () => {
      await expectParity("empty", modes(["--scope", "search"]), {
        setup: (dir) =>
          config(dir, (c) => {
            settings(c).semanticSearch = { enabled: true, model: "" };
          }),
      });
      await expectParity("empty", modes(["--scope", "search"]), {
        setup: (dir) =>
          config(dir, (c) => {
            settings(c).semanticSearch = { enabled: true, provider: "api", model: "nope-model" };
          }),
      });
    },
    SLOW,
  );

  test(
    "AI integration: nothing generated, then everything generated",
    async () => {
      await expectParity("empty", [
        ...modes(["--scope", "ai"]),
        step(["setup", "all"]),
        ...modes(["--scope", "ai"]),
      ]);
    },
    SLOW,
  );

  test(
    "AI integration: instruction file without the guideline markers, missing config",
    async () => {
      await expectParity("empty", modes(["--scope", "ai"]), {
        setup: (dir) => {
          writeFixtureText(dir, "CLAUDE.md", "# mine\n");
          config(dir, (c) => {
            settings(c).platforms = ["claude-code", "codex", "kiro"];
          });
        },
      });
    },
    SLOW,
  );

  test(
    "skills scope global with project skill directories shadowing",
    async () => {
      await expectParity("empty", [step(["setup", "claude"]), ...modes(["--scope", "ai"])], {
        setup: (dir) =>
          config(dir, (c) => {
            settings(c).skillsScope = "global";
          }),
      });
    },
    SLOW,
  );

  test(
    "a stale project skill",
    async () => {
      await expectParity("empty", [step(["setup", "claude"]), ...modes(["--scope", "ai"])], {});
      await expectParity("empty", [step(["setup", "agents"])], {});
    },
    SLOW,
  );

  test(
    "LSP disabled",
    async () => {
      await expectParity("empty", modes(["--scope", "lsp"]), {
        setup: (dir) =>
          config(dir, (c) => {
            settings(c).lsp = { enabled: false };
          }),
      });
    },
    SLOW,
  );

  test(
    "an empty imports directory adds no check",
    async () => {
      await expectParity("empty", [step(["doctor", "--scope", "project", "--verbose"])], {
        setup: (dir) => mkdirSync(join(dir, ".knowns", "imports"), { recursive: true }),
      });
    },
    SLOW,
  );
});

// Not Go behaviour: D8 removed `knowns import`; doctor says so when imports/ holds content.
describe("doctor reports the removed import command", () => {
  test(
    "a populated .knowns/imports gets a warning, an empty one gets none",
    async () => {
      const { runTsStep } = await import("./search-harness.ts");
      const p = makeFixtureProject("empty", (dir) => {
        mkdirSync(join(dir, ".knowns", "imports", "pkg", "docs"), { recursive: true });
        writeFileSync(join(dir, ".knowns", "imports", "pkg", "docs", "a.md"), "# a\n");
      });
      const r = await runTsStep(p, {
        args: ["doctor", "--scope", "project", "--plain"],
        env: offline,
        // A real process: a proxy put on process.env sticks to every later test in a Bun run on Windows.
        stdin: "",
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("WARN [project.imports] Import management was removed");
      expect(r.stdout).toContain("remains readable and searchable");
      const clean = makeFixtureProject("empty");
      const c = await runTsStep(clean, {
        args: ["doctor", "--scope", "project", "--verbose", "--plain"],
        env: offline,
        // A real process: a proxy put on process.env sticks to every later test in a Bun run on Windows.
        stdin: "",
      });
      expect(c.stdout).not.toContain("project.imports");
    },
    SLOW,
  );
});
