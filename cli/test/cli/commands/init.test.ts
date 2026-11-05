// `knowns init` (flag-driven) against the Go 0.34.1 oracle: stdout, stderr, exit code, the whole
// project tree (.knowns, CLAUDE.md, AGENTS.md, ...) and the HOME tree must match.
//
// Not covered: the interactive wizard (TSR-2P6ZDV), `--open` (starts the web server, not ported)
// and the language server download (see init-lsp cases below).
//
// Init has no platform flag. The platforms it writes come from ~/.knowns/settings.json
// projectDefaults, or from the existing config with --force, so those are the way platform
// selections are exercised here. MCP configs and skills belong to `setup` / `sync`, not init; the
// "no extra files" assertions prove init writes none of them.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  compareInit,
  disposeInit,
  hasGoBin,
  type InitCompareOptions,
  type InitProject,
  type InitStep,
  makeInitProject,
  runInitGo,
  runInitTs,
  treeDiff,
} from "./init-harness.ts";

const cases = hasGoBin ? describe : describe.skip;

function put(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

const globalSettings = (defaults: object) => (p: InitProject) =>
  put(p.home, ".knowns/settings.json", JSON.stringify({ projectDefaults: defaults }));

async function expectInitParity(
  steps: Array<InitStep | string[]>,
  opts: InitCompareOptions = {},
): Promise<Awaited<ReturnType<typeof compareInit>>> {
  const c = await compareInit(steps, opts);
  try {
    for (let i = 0; i < steps.length; i++) {
      const raw = steps[i] as InitStep | string[];
      const label = (Array.isArray(raw) ? raw : raw.args).join(" ");
      expect({ step: label, ...(c.ts[i] as object) }).toEqual({
        step: label,
        ...(c.go[i] as object),
      });
    }
    expect(treeDiff(c.goTree, c.tsTree)).toEqual([]);
    expect(treeDiff(c.goHome, c.tsHome)).toEqual([]);
    expect(c.tsHasGit).toBe(c.goHasGit);
  } finally {
    disposeInit(c.goP);
    disposeInit(c.tsP);
  }
  return c;
}

const CONFIG_TS = /"createdAt": "<TS>"/;

cases("init with flags matches Go", () => {
  test("--no-wizard on an empty directory", async () => {
    const c = await compareInit([["init", "--no-wizard"]]);
    try {
      expect(c.goTree.get(".knowns/config.json")).toMatch(CONFIG_TS);
      expect(
        [...c.goTree.keys()].filter((k) => !k.startsWith(".knowns/") && !k.endsWith("/")),
      ).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(c.tsHasGit).toBe(true);
      // Directories are part of the tree, empty ones included, and carry Go's permission bits.
      const dirs = [...c.goTree.keys()].filter((k) => k.endsWith("/"));
      expect(dirs.length).toBeGreaterThanOrEqual(5);
      expect(dirs).toContain(".knowns/");
      expect(c.goTree.get(".knowns/")).toBe("[755]");
      expect([...c.tsTree.keys()].filter((k) => k.endsWith("/"))).toEqual(dirs);
      expect(treeDiff(c.goTree, c.tsTree)).toEqual([]);
      expect(c.ts[0]).toEqual(c.go[0]);
    } finally {
      disposeInit(c.goP);
      disposeInit(c.tsP);
    }
  });

  test("name argument", async () => {
    await expectInitParity([["init", "myproj"]]);
  });

  test("git tracking mode flags", async () => {
    await expectInitParity([["init", "--no-wizard", "--git-ignored"]]);
    await expectInitParity([["init", "--no-wizard", "--git-tracked"]]);
    await expectInitParity([["init", "--no-wizard", "--git-tracked", "--git-ignored"]]);
  });

  test("task prefix", async () => {
    await expectInitParity([["init", "--no-wizard", "--task-prefix", "kn"]]);
    await expectInitParity([["init", "demo", "--task-prefix", "AB12", "--git-ignored"]]);
  });

  test("invalid task prefix", async () => {
    for (const bad of ["x", "toolongprefix", "a-b", "ab cd", ""]) {
      await expectInitParity([["init", "--no-wizard", "--task-prefix", bad]]);
    }
  });

  test("flag and argument errors", async () => {
    await expectInitParity([["init", "a", "b"]]);
    await expectInitParity([["init", "--bogus"]]);
    await expectInitParity([["init", "--task-prefix"]]);
    await expectInitParity([["init", "--help"]]);
    await expectInitParity([["help", "init"]]);
  });

  test("--wizard with --no-wizard, --no-open", async () => {
    await expectInitParity([["init", "--no-wizard", "--wizard", "--no-open"]]);
  });

  test("no flags and no terminal fails the way Go does", async () => {
    // Detached: no controlling terminal, so Go's wizard cannot open /dev/tty and fails.
    const c = await expectInitParity([{ args: ["init"], detached: true }]);
    expect(c.go[0]?.code).toBe(1);
    expect(c.go[0]?.stderr).toContain("could not open a new TTY");
  });

  test("a project name skips the wizard even without a terminal", async () => {
    await expectInitParity([{ args: ["init", "named"], detached: true }]);
  });
});

cases("init platform selection from global defaults", () => {
  const platformSets: string[][] = [
    ["claude-code"],
    ["agents"],
    ["codex"],
    ["hermes"],
    ["opencode", "gemini", "copilot"],
    ["kiro", "cursor", "antigravity"],
    [
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
    ],
    ["nonsense"],
  ];
  for (const platforms of platformSets) {
    test(platforms.join(","), async () => {
      const c = await expectInitParity([["init", "--no-wizard"]], {
        setup: globalSettings({ settings: { platforms } }),
      });
      // init writes instruction files only, never MCP configs or skills.
      for (const k of c.goTree.keys()) {
        expect(k).not.toMatch(/^(\.mcp\.json|\.agents\/|\.claude\/|\.kiro\/|\.cursor\/|\.codex\/)/);
      }
    });
  }

  test("empty platform list falls back to the defaults", async () => {
    await expectInitParity([["init", "--no-wizard"]], {
      setup: globalSettings({ settings: { platforms: [] } }),
    });
  });
});

cases("init global defaults", () => {
  const variants: Record<string, object> = {
    "project name and prefix": {
      projectName: "Global Name",
      settings: { defaultTaskIdPrefix: "GN" },
    },
    "git ignored with section toggles": {
      settings: {
        gitTrackingMode: "git-ignored",
        gitTracking: {
          tasks: false,
          docs: true,
          templates: false,
          memories: true,
          decisions: false,
        },
      },
    },
    "git tracked with section toggles": {
      settings: {
        gitTrackingMode: "git-tracked",
        gitTracking: {
          tasks: true,
          docs: false,
          templates: true,
          memories: false,
          decisions: true,
        },
      },
    },
    "git tracking none": { settings: { gitTrackingMode: "none" } },
    "semantic search enabled (ollama)": {
      settings: {
        semanticSearch: { enabled: true, provider: "ollama", model: "qwen3-embedding:0.6b" },
      },
    },
    "semantic search enabled (api)": {
      settings: {
        semanticSearch: { enabled: true, provider: "api", model: "text-embedding-3-small" },
      },
    },
    "semantic search disabled with custom model": {
      settings: { semanticSearch: { enabled: false, model: "nomic-embed-text" } },
    },
    "semantic search enabled without model": { settings: { semanticSearch: { enabled: true } } },
    "task lifecycle": {
      settings: { taskLifecycle: { autoArchive: false, archiveAfter: "7d", purgeAfter: "90d" } },
    },
    "task lifecycle with defaults only": { settings: { taskLifecycle: {} } },
  };
  for (const [name, defaults] of Object.entries(variants)) {
    test(name, async () => {
      await expectInitParity([["init", "--no-wizard"]], { setup: globalSettings(defaults) });
    });
  }

  test("flags outrank global defaults", async () => {
    await expectInitParity([["init", "named", "--git-tracked", "--task-prefix", "ZZ"]], {
      setup: globalSettings({
        projectName: "Global",
        settings: { defaultTaskIdPrefix: "GN", gitTrackingMode: "git-ignored" },
      }),
    });
  });

  test("unreadable global settings only warn", async () => {
    await expectInitParity([["init", "--no-wizard"]], {
      setup: (p) => put(p.home, ".knowns/settings.json", "{ not json"),
    });
  });

  test("invalid global project defaults", async () => {
    await expectInitParity([["init", "--no-wizard"]], {
      setup: globalSettings({ settings: { gitTrackingMode: "bogus", defaultPriority: "nope" } }),
    });
  });
});

cases("init global settings with wrongly typed fields", () => {
  // Go decodes ~/.knowns/settings.json into typed structs; the first type mismatch in document
  // order fails the load and init only warns (then carries on with no global defaults).
  const bad: Record<string, unknown> = {
    "platforms is a string": { projectDefaults: { settings: { platforms: "x" } } },
    "platforms holds a number": {
      projectDefaults: { settings: { platforms: ["claude-code", 3] } },
    },
    "defaultPriority is a number": { projectDefaults: { settings: { defaultPriority: 5 } } },
    "gitTracking is a string": { projectDefaults: { settings: { gitTracking: "yes" } } },
    "gitTracking.tasks is a string": {
      projectDefaults: { settings: { gitTracking: { tasks: "no" } } },
    },
    "projectName is a number": { projectDefaults: { projectName: 3 } },
    "projectDefaults is a string": { projectDefaults: "x" },
    "statuses holds numbers": { projectDefaults: { settings: { statuses: [1, 2] } } },
    "semanticSearch.enabled is a string": {
      projectDefaults: { settings: { semanticSearch: { enabled: "yes" } } },
    },
    "serverPort is a string": { projectDefaults: { settings: { serverPort: "80" } } },
    "serverPort is fractional": { projectDefaults: { settings: { serverPort: 1.5 } } },
    "statusColors holds a bool": {
      projectDefaults: { settings: { statusColors: { todo: true } } },
    },
    "taskLifecycle is an array": { projectDefaults: { settings: { taskLifecycle: [] } } },
    "taskLifecycle.autoArchive is a string": {
      projectDefaults: { settings: { taskLifecycle: { autoArchive: "yes" } } },
    },
    "embeddingModels is an array": { embeddingModels: [] },
    "embeddingProviders is a string": { embeddingProviders: "x" },
    "defaultEmbeddingModel is a number": { defaultEmbeddingModel: 4 },
    "the document is an array": [],
    "the first mismatch in document order wins": {
      projectDefaults: { settings: { serverPort: "x", platforms: "y" } },
    },
  };
  for (const [name, doc] of Object.entries(bad)) {
    test(name, async () => {
      await expectInitParity([["init", "--no-wizard"]], {
        setup: (p) => put(p.home, ".knowns/settings.json", JSON.stringify(doc)),
      });
    });
  }
});

cases("init language detection", () => {
  // KNOWN_LSP_AUTO_INSTALL=0 makes Go skip detection altogether, so this runs with it unset and
  // makes installing impossible instead: an empty PATH (no go, npm, curl) and a proxy that refuses
  // connections. Go then records settings.lsp in config.json before every install attempt fails;
  // its warning lines are not compared, because TS installs nothing and prints nothing.
  const lspEnv = (p: InitProject) => ({
    KNOWN_LSP_AUTO_INSTALL: "",
    PATH: join(p.base, "empty-path"),
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
  });
  const fixture = (p: InitProject) => {
    mkdirSync(join(p.base, "empty-path"), { recursive: true });
    put(p.dir, "go.mod", "module example.com/x\n\ngo 1.22\n");
    put(p.dir, "main.go", "package main\n");
    put(p.dir, "package.json", '{"name":"x"}\n');
    put(p.dir, "src/index.ts", "export {};\n");
    put(p.dir, "vendor/ignored.py", "x = 1\n");
    put(p.dir, "node_modules/dep/index.js", "1;\n");
  };

  async function lspConfig(steps: Array<(p: InitProject) => InitStep>) {
    // The env holds the sandbox PATH, which differs per side, so steps are built per side.
    const goP = makeInitProject(fixture);
    const tsP = makeInitProject(fixture);
    try {
      const configs: Array<{ go: unknown; ts: unknown }> = [];
      for (const mk of steps) {
        runInitGo(goP, mk(goP));
        await runInitTs(tsP, mk(tsP));
        const read = (p: InitProject) =>
          JSON.parse(readFileSync(join(p.dir, ".knowns", "config.json"), "utf8")).settings;
        configs.push({ go: read(goP), ts: read(tsP) });
      }
      return configs;
    } finally {
      disposeInit(goP);
      disposeInit(tsP);
    }
  }

  test("detected languages are recorded in settings.lsp like Go", async () => {
    const [first] = await lspConfig([(p) => ({ args: ["init", "--no-wizard"], env: lspEnv(p) })]);
    const go = first?.go as { lsp?: { enabled?: boolean; languages?: object } };
    expect(go.lsp?.enabled).toBe(true);
    // go, typescript (src/index.ts), json (package.json) and markdown (the instruction files);
    // vendor/ and node_modules/ are ignored directories.
    expect(Object.keys(go.lsp?.languages ?? {}).sort()).toEqual([
      "go",
      "json",
      "markdown",
      "typescript",
    ]);
    expect(first?.ts).toEqual(first?.go);
  });

  test("--force keeps what was recorded and adds nothing", async () => {
    const mk = (p: InitProject): InitStep => ({
      args: ["init", "--no-wizard", "--force"],
      env: lspEnv(p),
    });
    const configs = await lspConfig([mk, mk]);
    for (const c of configs) expect(c.ts).toEqual(c.go);
  });

  test("KNOWN_LSP_AUTO_INSTALL=0 records nothing on either side", async () => {
    const [first] = await lspConfig([
      (p) => ({
        args: ["init", "--no-wizard"],
        env: { ...lspEnv(p), KNOWN_LSP_AUTO_INSTALL: "0" },
      }),
    ]);
    expect((first?.go as { lsp?: unknown } | undefined)?.lsp).toBeUndefined();
    expect(first?.ts).toEqual(first?.go);
  });
});

cases("init in a symlinked directory", () => {
  // proj -> real, with PWD=proj. Go's os.Getwd honours $PWD, so the project is named "proj" and
  // paths stay under the link; commands run as real processes so each side sees its own PWD.
  test("the link name is used", async () => {
    const c = await expectInitParity([{ args: ["init", "--no-wizard"], detached: true }], {
      linked: true,
    });
    const cfg = JSON.parse((c.goTree.get(".knowns/config.json") ?? "").replace(/^\[\d+\] /, ""));
    expect(cfg.name).toBe("proj");
    expect(c.goTree.get("CLAUDE.md")).toBeDefined();
  });

  test("a second run and --force see the same project", async () => {
    await expectInitParity(
      [
        { args: ["init", "--no-wizard"], detached: true },
        { args: ["init", "--no-wizard"], detached: true },
        { args: ["init", "--git-ignored"], detached: true },
        { args: ["init", "--no-wizard", "--force"], detached: true },
      ],
      { linked: true },
    );
  });

  test("a subdirectory of the link", async () => {
    await expectInitParity([{ args: ["init", "--no-wizard"], detached: true }], {
      linked: true,
      sub: "pkg/app",
    });
  });
});

cases("init on an existing project", () => {
  test("second run reports the project is initialized", async () => {
    await expectInitParity([
      ["init", "--no-wizard"],
      ["init", "--no-wizard"],
    ]);
  });

  test("tracking mode change without --force", async () => {
    await expectInitParity([
      ["init", "--no-wizard"],
      ["init", "--git-ignored"],
      ["init", "--git-tracked"],
      ["init", "--git-ignored", "--git-tracked"],
    ]);
  });

  test("--force keeps name, prefix, platforms and tracking from the existing config", async () => {
    await expectInitParity([
      ["init", "first", "--git-ignored", "--task-prefix", "FS"],
      ["init", "--no-wizard", "--force"],
      ["init", "--no-wizard", "-f", "--git-tracked"],
      ["init", "second", "--force", "--task-prefix", "NW"],
    ]);
  });

  test("--force after the config was edited", async () => {
    const edit = (p: InitProject) => {
      const file = join(p.dir, ".knowns", "config.json");
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      cfg.name = "Renamed";
      cfg.mystery = { keep: "me" };
      cfg.settings.defaultTaskIdPrefix = "ED";
      cfg.settings.defaultPriority = "high";
      cfg.settings.unknownSetting = 7;
      cfg.settings.platforms = ["opencode"];
      writeFileSync(file, JSON.stringify(cfg, null, 2));
    };
    const c = await expectInitParity([
      ["init", "--no-wizard"],
      { args: ["init", "--no-wizard", "--force"], before: edit },
    ]);
    const cfg = c.goTree.get(".knowns/config.json") ?? "";
    // The edited name, prefix and platforms survive the re-init on both sides.
    expect(cfg).toContain('"name": "Renamed"');
    expect(cfg).toContain('"defaultTaskIdPrefix": "ED"');
    expect(c.goTree.has("OPENCODE.md")).toBe(true);
  });

  test("--force with another platform set than the first run", async () => {
    const c = await expectInitParity(
      [
        ["init", "--no-wizard"],
        {
          args: ["init", "--no-wizard", "--force"],
          before: (p) => globalSettings({ settings: { platforms: ["gemini", "copilot"] } })(p),
        },
      ],
      { setup: globalSettings({ settings: { platforms: ["claude-code"] } }) },
    );
    // The first run wrote CLAUDE.md; the forced run follows the existing config, not the new global
    // default, so no GEMINI.md appears. Either way Go and TS agree (asserted above).
    expect(c.goTree.has("CLAUDE.md")).toBe(true);
  });

  test("existing instruction files are left alone without --force", async () => {
    await expectInitParity([["init", "--no-wizard"]], {
      setup: (p) => {
        put(p.dir, "CLAUDE.md", "# my own notes\n");
        put(p.dir, "AGENTS.md", "user agents file");
      },
    });
  });

  test("--force syncs the managed block and keeps user content", async () => {
    const managed = "<!-- KNOWNS GUIDELINES START -->\nold block\n<!-- KNOWNS GUIDELINES END -->";
    await expectInitParity(
      [
        ["init", "--no-wizard"],
        ["init", "--no-wizard", "--force"],
      ],
      {
        setup: (p) => {
          put(p.dir, "CLAUDE.md", `# mine\n\n${managed}\n\ntail\n`);
          put(p.dir, "AGENTS.md", "no markers here");
          put(p.dir, "OPENCODE.md", "no markers, no newline");
        },
      },
    );
  });

  test("--force appends the block after content ending in blank lines", async () => {
    await expectInitParity([["init", "--no-wizard", "--force"]], {
      setup: (p) => {
        put(p.dir, "CLAUDE.md", "one\n\n");
        put(p.dir, "AGENTS.md", "two\n");
      },
    });
  });

  test("--force on a directory with a half-written .knowns", async () => {
    await expectInitParity([["init", "--no-wizard", "--force"]], {
      setup: (p) => put(p.dir, ".knowns/notes.txt", "stray"),
    });
  });

  test("an unreadable config.json", async () => {
    await expectInitParity(
      [
        ["init", "--git-ignored"],
        ["init", "--no-wizard", "--force"],
      ],
      { setup: (p) => put(p.dir, ".knowns/config.json", "{ broken") },
    );
  });
});

cases("init and git", () => {
  test("inside an existing repository no git init runs", async () => {
    await expectInitParity([["init", "--no-wizard"]], {
      setup: (p) => mkdirSync(join(p.dir, ".git"), { recursive: true }),
    });
  });

  test("a repository in a parent directory counts", async () => {
    await expectInitParity([["init", "--no-wizard"]], {
      setup: (p) => mkdirSync(join(p.dir, ".git"), { recursive: true }),
      sub: "packages/app",
    });
  });

  test("git is not on PATH", async () => {
    await expectInitParity([{ args: ["init", "--no-wizard"], env: { PATH: "/nonexistent" } }]);
  });

  test("legacy .gitignore block is removed", async () => {
    const legacy = "node_modules\n# >>> KNOWNS >>>\n.knowns/\n# <<< KNOWNS <<<\ndist\n";
    await expectInitParity([["init", "--no-wizard", "--git-ignored"]], {
      setup: (p) => put(p.dir, ".gitignore", legacy),
    });
    await expectInitParity([["init", "--no-wizard"]], {
      setup: (p) => put(p.dir, ".gitignore", "# >>> KNOWNS >>>\nx\n# <<< KNOWNS <<<\n\n\n"),
    });
  });
});
