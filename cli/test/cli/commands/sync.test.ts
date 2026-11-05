// `knowns sync` against the Go 0.34.1 oracle: stdout, stderr, exit code, the whole project tree
// and the sandboxed HOME must match for each case. See sync-harness.ts for what is normalised.
//
// Not covered, and why: git-import refresh and semantic reindex (both need subsystems that are
// not ported; sync reports a warning there instead). Those cases are asserted separately below.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  dispose,
  editConfig,
  hasGoBin,
  homeTreeDiff,
  makePair,
  makeTemplate,
  type Pair,
  projectTreeDiff,
  runBoth,
  runGoIn,
  type Side,
  tree,
  writeText,
} from "./sync-harness.ts";

const cases = hasGoBin ? describe : describe.skip;
const SLOW = 180_000;
const templates: Side[] = [];

function template(initArgs: string[] = [], prepare?: (dir: string) => void): Side {
  const t = makeTemplate(initArgs, prepare);
  templates.push(t);
  return t;
}

afterAll(() => dispose(...templates));

/** Run each step on both sides; every result and both trees must match. */
async function parity(
  t: Side,
  steps: Array<
    string[] | { args: string[]; before?: (p: Pair) => void; env?: Record<string, string> }
  >,
): Promise<void> {
  const p = makePair(t);
  try {
    for (const raw of steps) {
      const step = Array.isArray(raw) ? { args: raw } : raw;
      step.before?.(p);
      const r = await runBoth(p, step.args, step.env);
      expect({ step: step.args.join(" "), ...r.ts }).toEqual({
        step: step.args.join(" "),
        ...r.go,
      });
      expect(projectTreeDiff(p)).toEqual([]);
      expect(homeTreeDiff(p)).toEqual([]);
    }
  } finally {
    dispose(p.go, p.ts);
  }
}

/** Apply the same filesystem change to both sides. */
const both = (fn: (dir: string, home: string) => void) => (p: Pair) => {
  fn(p.go.dir, p.go.home);
  fn(p.ts.dir, p.ts.home);
};

const ALL_PLATFORMS = [
  "claude-code",
  "opencode",
  "codex",
  "kiro",
  "hermes",
  "antigravity",
  "cursor",
  "gemini",
  "copilot",
  "agents",
];

cases("sync matches Go: flags", () => {
  test(
    "default run, then a re-run that changes nothing",
    async () => {
      await parity(template(), [["sync"], ["sync"]]);
    },
    SLOW,
  );

  test(
    "--force is accepted and changes nothing",
    async () => {
      await parity(template(), [["sync", "--force"]]);
    },
    SLOW,
  );

  test(
    "--skills only",
    async () => {
      await parity(template(), [["sync", "--skills"]]);
    },
    SLOW,
  );

  test(
    "--instructions only",
    async () => {
      await parity(template(), [["sync", "--instructions"]]);
    },
    SLOW,
  );

  test(
    "--model only",
    async () => {
      await parity(template(), [["sync", "--model"]]);
    },
    SLOW,
  );

  test(
    "flags combine: --skills --instructions",
    async () => {
      await parity(template(), [["sync", "--skills", "--instructions"]]);
    },
    SLOW,
  );

  test(
    "--platform claude / claude-code / CLAUDE (case) / agents / codex / hermes",
    async () => {
      const t = template();
      for (const platform of ["claude", "claude-code", "CLAUDE", " agents ", "codex", "hermes"]) {
        await parity(t, [["sync", "--platform", platform]]);
      }
    },
    SLOW,
  );

  test(
    "--platform all and gemini / opencode / copilot",
    async () => {
      const t = template();
      for (const platform of ["all", "gemini", "opencode", "copilot"]) {
        await parity(t, [["sync", "--platform", platform]]);
      }
    },
    SLOW,
  );

  test(
    "--platform values Go rejects, at different stages",
    async () => {
      const t = template();
      // unknown (selection), and valid-looking ones with no instruction shim (instructions step).
      for (const platform of ["bogus", "kiro", "cursor", "antigravity"]) {
        await parity(t, [["sync", "--platform", platform]]);
      }
    },
    SLOW,
  );

  test(
    "--platform with --skills only syncs that platform's skills",
    async () => {
      await parity(template(), [["sync", "--skills", "--platform", "kiro"]]);
    },
    SLOW,
  );

  test(
    "--help",
    async () => {
      await parity(template(), [["sync", "--help"]]);
    },
    SLOW,
  );
});

cases("sync matches Go: platform files and marker blocks", () => {
  test(
    "a missing platform file is created, an existing one only refreshed",
    async () => {
      await parity(template(), [
        {
          args: ["sync"],
          before: both((dir) => rmSync(join(dir, "CLAUDE.md"))),
        },
        ["sync"],
      ]);
    },
    SLOW,
  );

  test(
    "a hand-edited marker block is restored, user text around it is kept",
    async () => {
      const edited = [
        "# My notes\n\nhand written above\n\n",
        "<!-- KNOWNS GUIDELINES START -->\nI edited the managed block\n<!-- KNOWNS GUIDELINES END -->\n",
        "\ntrailing user text, with ünïcode\n",
      ].join("");
      await parity(template(), [
        {
          args: ["sync", "--instructions"],
          before: both((dir) => writeText(dir, "CLAUDE.md", edited)),
        },
        ["sync", "--instructions"],
      ]);
    },
    SLOW,
  );

  test(
    "a file without markers gets the block appended",
    async () => {
      await parity(template(), [
        {
          args: ["sync", "--instructions"],
          before: both((dir) => {
            writeText(dir, "CLAUDE.md", "just my own text");
            writeText(dir, "AGENTS.md", "own text\n");
          }),
        },
      ]);
    },
    SLOW,
  );

  test(
    "a file with only a start marker or reversed markers",
    async () => {
      await parity(template(), [
        {
          args: ["sync", "--instructions"],
          before: both((dir) => {
            writeText(dir, "CLAUDE.md", "x\n<!-- KNOWNS GUIDELINES START -->\nnever closed\n");
            writeText(
              dir,
              "AGENTS.md",
              "<!-- KNOWNS GUIDELINES END -->\nabc\n<!-- KNOWNS GUIDELINES START -->\n\n",
            );
          }),
        },
      ]);
    },
    SLOW,
  );

  test(
    "a platform file in a missing directory (.github) is created with its directory",
    async () => {
      const t = template([], (dir) =>
        editConfig(dir, (cfg) => {
          cfg.settings.platforms = ["copilot", "gemini", "opencode"];
        }),
      );
      await parity(t, [["sync", "--instructions"], ["sync"]]);
    },
    SLOW,
  );

  test(
    "config platforms restrict the shims; empty means all five",
    async () => {
      const only = template([], (dir) =>
        editConfig(dir, (cfg) => {
          cfg.settings.platforms = ["agents"];
        }),
      );
      await parity(only, [["sync", "--instructions"]]);
      const none = template([], (dir) =>
        editConfig(dir, (cfg) => {
          delete cfg.settings.platforms;
        }),
      );
      await parity(none, [["sync"]]);
    },
    SLOW,
  );
});

cases("sync matches Go: platform configs, MCP configs and hooks", () => {
  const allPlatforms = () =>
    template([], (dir) =>
      editConfig(dir, (cfg) => {
        cfg.settings.platforms = ALL_PLATFORMS;
      }),
    );

  test(
    "every platform configured: cursor, codex, hermes, antigravity files",
    async () => {
      await parity(allPlatforms(), [["sync"], ["sync"]]);
    },
    SLOW,
  );

  test(
    "--instructions with every platform writes the MCP and rule files",
    async () => {
      await parity(allPlatforms(), [["sync", "--instructions"]]);
    },
    SLOW,
  );

  test(
    "stale MCP configs are rewritten to the current command",
    async () => {
      const stale = (command: string) =>
        `${JSON.stringify({ mcpServers: { knowns: { command, args: ["mcp"] }, other: { command: "x" } } }, null, 2)}\n`;
      await parity(allPlatforms(), [
        {
          args: ["sync"],
          before: both((dir, home) => {
            writeText(dir, ".mcp.json", stale("/old/knowns"));
            writeText(dir, ".kiro/settings/mcp.json", stale("/old/knowns"));
            writeText(dir, ".cursor/mcp.json", stale("/old/knowns"));
            writeText(
              dir,
              "opencode.json",
              `${JSON.stringify({ mcp: { knowns: { command: ["/old/knowns", "mcp"] } } }, null, 2)}\n`,
            );
            writeText(
              dir,
              ".codex/config.toml",
              '[mcp_servers.knowns]\ncommand = "/old/knowns"\nargs = ["mcp"]\n',
            );
            writeText(home, ".gemini/antigravity/mcp_config.json", stale("/old/knowns"));
            writeText(
              home,
              ".hermes/config.yaml",
              "mcp_servers:\n  knowns:\n    command: /old/knowns\n    args:\n      - mcp\n",
            );
          }),
        },
        ["sync"],
      ]);
    },
    SLOW,
  );

  test(
    "npx fallback when knowns is not on PATH",
    async () => {
      await parity(allPlatforms(), [{ args: ["sync"], env: { PATH: "/usr/bin:/bin" } }]);
    },
    SLOW,
  );

  test(
    "a malformed MCP config only warns",
    async () => {
      await parity(allPlatforms(), [
        { args: ["sync"], before: both((dir) => writeText(dir, ".mcp.json", "{ not json")) },
      ]);
    },
    SLOW,
  );

  test(
    "pre-existing runtime hook files are replaced by the current ones",
    async () => {
      await parity(allPlatforms(), [
        {
          args: ["sync"],
          before: both((_dir, home) => {
            writeText(home, ".claude/settings.json", '{"theme":"dark","hooks":{"Stop":[]}}\n');
            writeText(home, ".codex/config.toml", "[features]\ncodex_hooks = false\n");
          }),
        },
      ]);
    },
    SLOW,
  );
});

cases("sync matches Go: skills scope", () => {
  const withScope = (scope: string | undefined) =>
    template([], (dir) =>
      editConfig(dir, (cfg) => {
        if (scope === undefined) delete cfg.settings.skillsScope;
        else cfg.settings.skillsScope = scope;
      }),
    );

  test(
    "project scope writes project skill directories",
    async () => {
      await parity(withScope("project"), [["sync", "--skills"]]);
    },
    SLOW,
  );

  test(
    "global scope writes ~/.claude/skills and leaves the project alone",
    async () => {
      const t = withScope("global");
      await parity(t, [["sync", "--skills"], ["sync"]]);
    },
    SLOW,
  );

  test(
    "global scope with several platforms shares ~/.agents/skills",
    async () => {
      const t = template([], (dir) =>
        editConfig(dir, (cfg) => {
          cfg.settings.skillsScope = "global";
          cfg.settings.platforms = ["claude-code", "kiro", "codex", "cursor"];
        }),
      );
      await parity(t, [["sync", "--skills"]]);
    },
    SLOW,
  );

  test(
    'scope "none" leaves skill directories untouched',
    async () => {
      await parity(withScope("none"), [["sync", "--skills"], ["sync"]]);
    },
    SLOW,
  );

  test(
    "scope is normalised (case and spaces)",
    async () => {
      await parity(withScope(" GLOBAL "), [["sync", "--skills"]]);
    },
    SLOW,
  );

  test(
    "an unset scope inherits the machine default in ~/.knowns/settings.json",
    async () => {
      const settings = JSON.stringify({ projectDefaults: { settings: { skillsScope: "global" } } });
      await parity(withScope(undefined), [
        {
          args: ["sync", "--skills"],
          before: both((_d, home) => writeText(home, ".knowns/settings.json", settings)),
        },
      ]);
    },
    SLOW,
  );

  test(
    "an explicit project scope beats the machine default",
    async () => {
      const settings = JSON.stringify({ projectDefaults: { settings: { skillsScope: "global" } } });
      await parity(withScope("project"), [
        {
          args: ["sync", "--skills"],
          before: both((_d, home) => writeText(home, ".knowns/settings.json", settings)),
        },
      ]);
    },
    SLOW,
  );

  test(
    "--platform all selects every skill directory",
    async () => {
      await parity(withScope("project"), [["sync", "--skills", "--platform", "all"]]);
    },
    SLOW,
  );

  test(
    "stale skill files are overwritten, extra files in a skill removed",
    async () => {
      await parity(withScope("project"), [
        { args: ["sync", "--skills"] },
        {
          args: ["sync", "--skills"],
          before: both((dir) => {
            writeText(dir, ".claude/skills/kn-plan/SKILL.md", "stale");
            writeText(dir, ".claude/skills/kn-plan/extra.txt", "left over");
            writeText(dir, ".claude/skills/own-skill/SKILL.md", "mine");
          }),
        },
      ]);
    },
    SLOW,
  );
});

cases("sync matches Go: git integration, model and search", () => {
  for (const mode of ["git-ignored", "git-tracked", "none"]) {
    test(
      `git tracking mode ${mode}`,
      async () => {
        const t = template([], (dir) =>
          editConfig(dir, (cfg) => {
            cfg.settings.gitTrackingMode = mode;
          }),
        );
        await parity(t, [["sync"], ["sync"]]);
      },
      SLOW,
    );
  }

  test(
    "per-section git tracking toggles and a legacy root .gitignore block",
    async () => {
      const t = template([], (dir) => {
        editConfig(dir, (cfg) => {
          cfg.settings.gitTrackingMode = "git-ignored";
          cfg.settings.gitTracking = {
            tasks: false,
            docs: true,
            memories: true,
            decisions: false,
            templates: false,
          };
        });
        writeText(
          dir,
          ".gitignore",
          "node_modules\n# >>> KNOWNS >>>\n.knowns/\n# <<< KNOWNS <<<\ndist\n",
        );
      });
      await parity(t, [["sync"]]);
    },
    SLOW,
  );

  test(
    "no gitTrackingMode skips the git step",
    async () => {
      const t = template([], (dir) =>
        editConfig(dir, (cfg) => {
          delete cfg.settings.gitTrackingMode;
        }),
      );
      await parity(t, [["sync"]]);
    },
    SLOW,
  );

  test(
    "a project with tasks takes the keyword-only reindex path",
    async () => {
      const t = template();
      const r = runGoIn(t, ["task", "create", "Sync fixture task"]);
      expect(r.code).toBe(0);
      await parity(t, [["sync"]]);
    },
    SLOW,
  );

  test(
    "global semantic config present and not enabled",
    async () => {
      const t = template();
      const r = runGoIn(t, ["task", "create", "Another task"]);
      expect(r.code).toBe(0);
      await parity(t, [
        {
          args: ["sync"],
          before: both((_d, home) =>
            writeText(
              home,
              ".knowns/global/config.json",
              JSON.stringify({ id: "g", name: "g", settings: {} }),
            ),
          ),
        },
      ]);
    },
    SLOW,
  );

  test(
    "--model with semantic search configured: model, provider and reachability reports",
    async () => {
      const withModel = (model: string) =>
        template([], (dir) =>
          editConfig(dir, (cfg) => {
            cfg.settings.semanticSearch = { enabled: true, provider: "ollama", model };
          }),
        );
      // default seeded model, provider unreachable on a closed port
      await parity(withModel("qwen3-embedding:0.6b"), [["sync", "--model"]]);
      // a model the machine registry does not know
      await parity(withModel("no-such-model"), [["sync", "--model"]]);
    },
    SLOW,
  );

  test(
    "--model with a reachable provider",
    async () => {
      // The server must live in another process: Go runs under spawnSync, which blocks this one.
      const server = Bun.spawn(
        [
          "bun",
          "-e",
          'const s=Bun.serve({port:0,fetch:()=>new Response("{}",{status:400})});console.log(s.port);setInterval(()=>{},1e6)',
        ],
        { stdout: "pipe" },
      );
      try {
        const reader = server.stdout.getReader();
        const port = Number.parseInt(
          new TextDecoder().decode((await reader.read()).value).trim(),
          10,
        );
        const settings = JSON.stringify({
          embeddingProviders: { local: { apiBase: `http://127.0.0.1:${port}` } },
          embeddingModels: { m1: { provider: "local", model: "m1", dimensions: 8 } },
        });
        const t = template([], (dir) =>
          editConfig(dir, (cfg) => {
            cfg.settings.semanticSearch = { enabled: true, provider: "api", model: "m1" };
          }),
        );
        await parity(t, [
          {
            args: ["sync", "--model"],
            before: both((_d, home) => writeText(home, ".knowns/settings.json", settings)),
          },
        ]);
      } finally {
        server.kill();
      }
    },
    SLOW,
  );

  test(
    "provider missing for a known model",
    async () => {
      const settings = JSON.stringify({
        embeddingProviders: {},
        embeddingModels: { m2: { provider: "ghost", model: "m2", dimensions: 8 } },
      });
      const t = template([], (dir) =>
        editConfig(dir, (cfg) => {
          cfg.settings.semanticSearch = { enabled: true, provider: "api", model: "m2" };
        }),
      );
      await parity(t, [
        {
          args: ["sync", "--model"],
          before: both((_d, home) => writeText(home, ".knowns/settings.json", settings)),
        },
      ]);
    },
    SLOW,
  );
});

cases("sync matches Go: errors", () => {
  test(
    "outside a project",
    async () => {
      const t = template();
      const p = makePair(t);
      try {
        rmSync(join(p.go.dir, ".knowns"), { recursive: true });
        rmSync(join(p.ts.dir, ".knowns"), { recursive: true });
        const r = await runBoth(p, ["sync"]);
        expect(r.ts).toEqual(r.go);
        expect(r.ts.code).toBe(1);
      } finally {
        dispose(p.go, p.ts);
      }
    },
    SLOW,
  );

  test(
    "unknown flag",
    async () => {
      await parity(template(), [["sync", "--nope"]]);
    },
    SLOW,
  );

  test(
    "a corrupt config.json",
    async () => {
      // The JSON parser's own message differs between Go and Bun, so only its prefix is compared.
      const p = makePair(template());
      try {
        for (const s of [p.go, p.ts]) writeText(s.dir, ".knowns/config.json", "{ nope");
        const r = await runBoth(p, ["sync"]);
        const head = (t: string) => t.split("\n")[0]?.replace(/(parse config:).*/, "$1");
        expect(r.ts.code).toBe(r.go.code);
        expect(head(r.ts.stderr)).toBe(head(r.go.stderr));
        expect(r.ts.stdout).toBe(r.go.stdout);
      } finally {
        dispose(p.go, p.ts);
      }
    },
    SLOW,
  );
});

cases("sync and imports (spec D8: `knowns import` is removed)", () => {
  // Go's sync refreshes git imports under .knowns/imports; the TypeScript build does not, because
  // spec D8 removes import management. Content in .knowns/imports stays readable, but nothing
  // refreshes it. So for a project WITH a git import the outputs differ only in Go's import lines.
  test(
    "a project with a git import differs only by Go's import-refresh output",
    async () => {
      const t = template([], (dir) =>
        writeText(
          dir,
          ".knowns/imports/lib/_import.json",
          JSON.stringify({ source: "https://127.0.0.1:1/x.git", type: "git" }),
        ),
      );
      const p = makePair(t);
      try {
        const importsBefore = (s: Pair["go"]) => tree(join(s.dir, ".knowns", "imports"), s);
        const goBefore = importsBefore(p.go);
        const tsBefore = importsBefore(p.ts);
        const r = await runBoth(p, ["sync"]);

        // Go's refresh prints, on stdout, a banner line and the blank line that ends the step,
        // each matched in full here and removed exactly once.
        const BANNER = "\u001b[36mℹ Syncing 1 import(s)...\u001b[m\n\n";
        expect(r.go.stdout.split(BANNER).length).toBe(2);
        expect(r.ts.code).toBe(r.go.code);
        expect(r.ts.stdout).toBe(r.go.stdout.replace(BANNER, ""));

        // On stderr Go draws a spinner for the one import and ends with its failure line (the
        // number of frames and git's message are Go's own nondeterminism); TS writes nothing.
        // (The escape character is spelled <ESC> so the pattern holds no control character.)
        const SPINNER =
          /^(\r {2}<ESC>\[90m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]<ESC>\[m Syncing lib \(1\/1\))+\r {24}\r {2}<ESC>\[33m✗<ESC>\[m Syncing lib \(1\/1\): [\s\S]*\n$/;
        expect(r.go.stderr.replaceAll("\u001b", "<ESC>")).toMatch(SPINNER);
        expect(r.ts.stderr).toBe("");

        // Everything else sync writes is identical, and nothing under imports/ is touched.
        expect(projectTreeDiff(p)).toEqual([]);
        expect(homeTreeDiff(p)).toEqual([]);
        expect(importsBefore(p.ts)).toEqual(tsBefore);
        expect(importsBefore(p.go)).toEqual(goBefore);
        expect(tsBefore.get("lib/_import.json")).toContain("x.git");
      } finally {
        dispose(p.go, p.ts);
      }
    },
    SLOW,
  );
});

describe("sync reindex goes through the runtime queue seam", () => {
  const input = (env: Record<string, string>, semantic?: Record<string, unknown>) => ({
    counts: { tasks: 1, docs: 2, decisions: 3 },
    semantic: semantic as never,
    env,
    storeRoot: "/store/root",
  });

  test("a runtime (non-inline) sync enqueues and prints the queued line", async () => {
    const { runSyncReindex } = await import("../../../src/cli/commands/sync-support.ts");
    const { searchRuntimeHooks } = await import("../../../src/domain/searchenv/index.ts");
    const saved = searchRuntimeHooks.enqueueReindex;
    const calls: string[] = [];
    searchRuntimeHooks.enqueueReindex = (root) => {
      calls.push(root);
    };
    try {
      const out: string[] = [];
      await runSyncReindex({ print: (t) => out.push(t), printErr: () => {} }, input({}));
      expect(calls).toEqual(["/store/root"]);
      expect(out.join("")).toContain("Queued runtime reindex (1 tasks, 2 docs, 3 decisions)...");
    } finally {
      searchRuntimeHooks.enqueueReindex = saved;
    }
  });

  test("an inline sync with semantic search configured enqueues too, and never warns", async () => {
    const { runSyncReindex } = await import("../../../src/cli/commands/sync-support.ts");
    const { searchRuntimeHooks } = await import("../../../src/domain/searchenv/index.ts");
    const saved = searchRuntimeHooks.enqueueReindex;
    let called = 0;
    searchRuntimeHooks.enqueueReindex = () => {
      called++;
    };
    try {
      const out: string[] = [];
      const err: string[] = [];
      await runSyncReindex(
        { print: (t) => out.push(t), printErr: (t) => err.push(t) },
        input({ KNOWNS_RUNTIME_INLINE: "1" }, { enabled: true, model: "m", provider: "ollama" }),
      );
      expect(called).toBe(1);
      expect(err).toEqual([]);
    } finally {
      searchRuntimeHooks.enqueueReindex = saved;
    }
  });
});

cases("sync matches Go: error text", () => {
  test(
    "global scope with HOME unset names the home directory step",
    async () => {
      const t = template([], (dir) =>
        editConfig(dir, (cfg) => {
          cfg.settings.skillsScope = "global";
        }),
      );
      await parity(t, [{ args: ["sync", "--skills"], env: { HOME: "", USERPROFILE: "" } }]);
    },
    SLOW,
  );

  test(
    "an instruction file that is a directory fails with Go's text",
    async () => {
      await parity(template(), [
        {
          args: ["sync", "--instructions"],
          before: both((dir) => {
            rmSync(join(dir, "CLAUDE.md"));
            mkdirSync(join(dir, "CLAUDE.md"));
          }),
        },
      ]);
    },
    SLOW,
  );
});
