// Port of internal/lsp/adapters/{adapters,typescript,swift,bash,json,yaml}_test.go.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashInitializeParams,
  bashLanguageServerIntegrity,
  bashLanguageServerVersion,
} from "../../../src/lsp/adapters/bash.ts";
import {
  all,
  allAdapters,
  find,
  newBashAdapter,
  newClangdAdapter,
  newDartAdapter,
  newGoAdapter,
  newIntelephenseAdapter,
  newJdtlsAdapter,
  newJSONAdapter,
  newMarksmanAdapter,
  newPythonAdapter,
  newRoslynAdapter,
  newRubyLspAdapter,
  newRustAnalyzerAdapter,
  newScssAdapter,
  newSwiftAdapter,
  newTerraformLSAdapter,
  newTypeScriptAdapter,
  newYAMLAdapter,
} from "../../../src/lsp/adapters/index.ts";
import {
  jsonLanguageServerIntegrity,
  jsonLanguageServerVersion,
} from "../../../src/lsp/adapters/json.ts";
import { typeScriptLanguageID } from "../../../src/lsp/adapters/typescript.ts";
import {
  yamlLanguageServerIntegrity,
  yamlLanguageServerVersion,
  yamlPathPriority,
} from "../../../src/lsp/adapters/yaml.ts";
import {
  codeCapabilityProfile,
  documentConfigCapabilityProfile,
} from "../../../src/lsp/capabilities.ts";
import { Config } from "../../../src/lsp/config.ts";
import { Detector } from "../../../src/lsp/detect.ts";
import { Installer } from "../../../src/lsp/installer.ts";
import { Registry } from "../../../src/lsp/registry.ts";
import { collectRuntimeStatuses } from "../../../src/lsp/status.ts";
import type { Language, LanguageAdapter } from "../../../src/lsp/types.ts";

function languageOf(a: LanguageAdapter): Language {
  return {
    id: a.id(),
    name: a.name(),
    extensions: a.extensions(),
    matchers: a.pathMatchers?.() ?? [],
    lazyStart: a.lazyStart?.() ?? false,
  };
}

describe("adapter metadata", () => {
  const cases: [LanguageAdapter, string, string, string[], boolean][] = [
    [newGoAdapter(), "go", "Go", [".go"], false],
    [newTypeScriptAdapter(), "typescript", "TypeScript", [".ts", ".tsx", ".js", ".jsx"], true],
    [newPythonAdapter(), "python", "Python", [".py"], true],
    [newRustAnalyzerAdapter(), "rust", "Rust", [".rs"], true],
    [
      newClangdAdapter(),
      "c_cpp",
      "C/C++",
      [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
      true,
    ],
    [newJdtlsAdapter(), "java", "Java", [".java"], true],
    [newRoslynAdapter(), "csharp", "C#", [".cs"], true],
    [newDartAdapter(), "dart", "Dart", [".dart"], false],
    [newSwiftAdapter(), "swift", "Swift", [".swift"], false],
    [newRubyLspAdapter(), "ruby", "Ruby", [".rb", ".rake", ".gemspec"], true],
    [newIntelephenseAdapter(), "php", "PHP", [".php"], true],
    [newScssAdapter(), "scss", "SCSS/Sass/CSS", [".scss", ".sass", ".css"], true],
    [newMarksmanAdapter(), "markdown", "Markdown", [".md", ".markdown"], true],
    [newBashAdapter(), "bash", "Bash", [".sh", ".bash"], true],
    [newJSONAdapter(), "json", "JSON/JSONC", [".json", ".jsonc"], true],
    [
      newTerraformLSAdapter(),
      "terraform",
      "Terraform",
      [".tf", ".tfvars", ".tf.json", ".tfvars.json"],
      true,
    ],
    [newYAMLAdapter(), "yaml", "YAML", [".yaml", ".yml"], true],
  ];
  for (const [a, id, name, ext, canInstall] of cases) {
    test(id, () => {
      expect(a.id()).toBe(id);
      expect(a.name()).toBe(name);
      expect(a.extensions()).toEqual(ext);
      const g = a.installGuide();
      expect(g.command || g.knowns_cmd || g.url || g.notes).toBeTruthy();
      expect(a.canInstall()).toBe(canInstall);
    });
  }
});

test("AllAdapters returns the 17 built-ins in Go order", () => {
  const ids = allAdapters().map((a) => a.id());
  expect(ids).toEqual([
    "go",
    "typescript",
    "python",
    "rust",
    "c_cpp",
    "java",
    "csharp",
    "dart",
    "swift",
    "ruby",
    "php",
    "scss",
    "markdown",
    "bash",
    "json",
    "terraform",
    "yaml",
  ]);
  expect(all()).toHaveLength(17);
  expect(find("yaml")?.id()).toBe("yaml");
  expect(find("nope")).toBeUndefined();
});

test("priority adapters expose shared runtime and install metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "adapters-root-"));
  const detector = new Detector(null);
  detector.lookPath = () => undefined;
  detector.runCheck = async () => {
    throw new Error("not installed");
  };
  detector.runCommand = async () => {
    throw new Error("not installed");
  };
  const statuses = await collectRuntimeStatuses(undefined, {
    root,
    config: new Config(),
    adapters: all(),
    detector,
    installer: new Installer(mkdtempSync(join(tmpdir(), "adapters-lsp-"))),
  });
  const byID = new Map(statuses.map((s) => [s.id, s]));
  for (const id of ["markdown", "bash", "json", "terraform", "yaml"]) {
    const adapter = find(id);
    expect(adapter).toBeDefined();
    if (!adapter) continue;
    expect(adapter.canInstall()).toBe(true);
    expect(adapter.installGuide().knowns_cmd).toBe(`knowns lsp install ${id}`);
    const deps = adapter.runtimeDeps();
    expect(deps[0]?.recommended_version).toBeTruthy();
    expect(deps[0]?.recommended_integrity).toBeTruthy();
    expect(adapter.lazyStart?.()).toBe(true);
    const status = byID.get(id);
    expect(status).toBeDefined();
    expect(status?.install_cmd).toBe(`knowns lsp install ${id}`);
    expect(status?.backend).toBeTruthy();
    expect((status?.required_capabilities ?? []).length).toBeGreaterThan(0);
  }
});

test("phase 1 adapter prerequisites", () => {
  expect(newClangdAdapter().prerequisites()).toEqual([]);
  expect(newJdtlsAdapter().prerequisites()).toEqual([
    {
      name: "Java JDK 17+",
      check_cmd: "java -version",
      install_hint: "Install JDK 17+ from https://adoptium.net/",
    },
  ]);
  expect(newRoslynAdapter().prerequisites()).toEqual([
    {
      name: ".NET SDK 10+",
      check_cmd: "dotnet --version",
      install_hint: "Install .NET SDK 10+ from https://dotnet.microsoft.com/download",
    },
  ]);
  expect(newDartAdapter().prerequisites()).toEqual([
    {
      name: "Dart SDK",
      check_cmd: "dart --version",
      install_hint: "Install Dart SDK from https://dart.dev/get-dart",
    },
  ]);
  expect(newRubyLspAdapter().prerequisites()).toEqual([
    {
      name: "Ruby 3.1+",
      check_cmd: "ruby --version",
      install_hint: "Install Ruby 3.1+ from https://www.ruby-lang.org/en/downloads/",
    },
  ]);
  expect(newIntelephenseAdapter().prerequisites()).toEqual([
    {
      name: "Node.js 18+",
      check_cmd: "node --version",
      install_hint: "Install Node.js 18+ from https://nodejs.org/",
    },
  ]);
});

test("dart adapter command", () => {
  const a = newDartAdapter();
  expect(a.binaries()).toHaveLength(1);
  expect(a.binaries()[0]?.name).toBe("dart");
  expect(a.binaries()[0]?.args).toEqual(["language-server"]);
  expect(a.defaultArgs()).toEqual(["language-server"]);
  expect(a.canInstall()).toBe(false);
});

test("npm adapters use managed runtime dependencies", () => {
  for (const a of [
    newTypeScriptAdapter(),
    newIntelephenseAdapter(),
    newScssAdapter(),
    newBashAdapter(),
    newJSONAdapter(),
    newYAMLAdapter(),
  ]) {
    const d = a.runtimeDeps()[0];
    expect(d?.source).toBe("npm");
    expect(d?.archive_type).toBe("npm");
    expect(d?.binary_name).toBeTruthy();
  }
});

test("csharp adapter backend candidates", () => {
  const a = newRoslynAdapter();
  const b = a.binaries();
  expect(b).toHaveLength(3);
  expect(b[0]?.name).toBe("roslyn-ls");
  expect(b[0]?.args ?? []).toHaveLength(0);
  expect(b[1]?.name).toBe("csharp-ls");
  expect(b[1]?.args ?? []).toHaveLength(0);
  expect(b[2]?.name).toBe("omnisharp");
  expect(b[2]?.args).toEqual(["--languageserver"]);
  expect(a.defaultArgs()).toHaveLength(0);
});

test("initialization options come from config for every adapter", () => {
  const settings = { initializationOptions: { foo: "bar" } };
  for (const a of allAdapters()) {
    expect(a.initializationOptions(settings)?.foo).toBe("bar");
    const params = a.initializeParams("/tmp/project", settings);
    expect((params?.initializationOptions as Record<string, unknown> | undefined)?.foo).toBe("bar");
  }
});

describe("typescript", () => {
  const a = newTypeScriptAdapter();
  const cases: [string, string][] = [
    ["src/index.ts", "typescript"],
    ["src/types.d.ts", "typescript"],
    ["src/pages/AuditPage.tsx", "typescriptreact"],
    ["src/util.js", "javascript"],
    ["src/Button.jsx", "javascriptreact"],
    ["src/PAGE.TSX", "typescriptreact"],
    ["C:\\repo\\src\\Legacy.JSX", "javascriptreact"],
    ["C:\\repo\\src\\index.JS", "javascript"],
  ];
  for (const [path, want] of cases) {
    test(`language id for ${path}`, () => {
      const got = a.documentSyncForPath?.(path);
      expect(got?.languageID).toBe(want);
      expect(got?.suppress).toBe(false);
    });
  }
  test("every claimed extension is mapped", () => {
    const want: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
    };
    for (const ext of a.extensions()) {
      expect(want[ext]).toBeDefined();
      expect(typeScriptLanguageID(`file${ext}`)).toBe(want[ext] as string);
    }
  });
});

describe("swift", () => {
  const a = newSwiftAdapter();
  test("checks with --help, not --version", () => {
    const b = a.binaries();
    expect(b).toHaveLength(1);
    expect(b[0]?.name).toBe("sourcekit-lsp");
    expect(b[0]?.check_args).toEqual(["--help"]);
  });
  test("ignores both project layouts", () => {
    for (const d of [".build", ".swiftpm", "DerivedData", "Pods"])
      expect(a.isIgnoredDir(d)).toBe(true);
    for (const d of ["Sources", "Tests", "ChopKit"]) expect(a.isIgnoredDir(d)).toBe(false);
  });
  test("is not auto-installable", async () => {
    expect(a.canInstall()).toBe(false);
    await expect(a.install(undefined, tmpdir())).rejects.toThrow();
    expect(a.installGuide().url).toContain("swift.org");
    expect(a.installGuide().knowns_cmd ?? "").toBe("");
  });
});

describe("bash", () => {
  const a = newBashAdapter();
  test("contracts", () => {
    expect(a.id()).toBe("bash");
    expect(a.name()).toBe("Bash");
    expect(a.extensions()).toEqual([".sh", ".bash"]);
    expect(a.lazyStart()).toBe(true);
    expect(a.capabilityProfile()).toEqual(codeCapabilityProfile());
  });
  test("path matchers route files and shebangs", () => {
    expect(a.pathMatchers()).toEqual([
      { kind: "suffix", pattern: ".bash", priority: 220 },
      { kind: "suffix", pattern: ".sh", priority: 210 },
      { kind: "shebang", pattern: "bash", priority: 120 },
      { kind: "shebang", pattern: "sh", priority: 110 },
    ]);
    const registry = Registry.empty();
    registry.register(languageOf(a));
    const dir = mkdtempSync(join(tmpdir(), "bash-route-"));
    const files: Record<string, string> = {
      "script.sh": "echo sh\n",
      "script.bash": "echo bash\n",
      "env-bash": "#!/usr/bin/env bash\necho bash\n",
      "bin-sh": "#!/bin/sh\necho sh\n",
    };
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name);
      writeFileSync(p, content, { mode: 0o755 });
      expect(registry.forPath(p)?.id).toBe("bash");
    }
    const zsh = join(dir, "zsh-script");
    writeFileSync(zsh, "#!/usr/bin/env zsh\necho zsh\n", { mode: 0o755 });
    expect(registry.forPath(zsh)).toBeUndefined();
  });
  test("command, prerequisite and managed metadata", () => {
    expect(a.binaries()).toEqual([
      { name: "bash-language-server", args: ["start"], check_args: ["--version"] },
    ]);
    expect(a.defaultArgs()).toEqual(["start"]);
    expect(a.prerequisites()).toEqual([
      {
        name: "Node.js 20+",
        check_cmd: "node --version",
        install_hint: "Install Node.js 20+ from https://nodejs.org/",
      },
    ]);
    const deps = a.runtimeDeps();
    expect(deps).toHaveLength(1);
    const d = deps[0];
    expect(d?.id).toBe("bash-language-server");
    expect(d?.source).toBe("npm");
    expect(d?.packages).toEqual(["bash-language-server"]);
    expect(d?.version).toBe(bashLanguageServerVersion);
    expect(d?.recommended_version).toBe(bashLanguageServerVersion);
    expect(d?.recommended_integrity).toBe(bashLanguageServerIntegrity);
    expect(d?.recommended_integrity?.slice(0, 7)).toBe("sha512-");
    expect(a.canInstall()).toBe(true);
  });
  test("windows initialize params use the native root path", () => {
    const root = "C:\\workspace\\knowns";
    const params = bashInitializeParams(
      root,
      { initializationOptions: { globPattern: "**/*.sh" } },
      "windows",
    );
    expect(params.rootPath).toBe(root);
    expect("rootUri" in params).toBe(false);
    expect((params.initializationOptions as Record<string, unknown>).globPattern).toBe("**/*.sh");
    expect("rootUri" in bashInitializeParams(root, undefined, "linux")).toBe(true);
  });
});

describe("json", () => {
  const a = newJSONAdapter();
  const registry = () => {
    const r = Registry.empty();
    r.register(languageOf(a));
    return r;
  };
  test("contracts", () => {
    expect(a.id()).toBe("json");
    expect(a.name()).toBe("JSON/JSONC");
    expect(a.extensions()).toEqual([".json", ".jsonc"]);
    expect(a.lazyStart()).toBe(true);
    expect(a.supportsImplementation() || a.supportsReferences()).toBe(false);
    const p = a.capabilityProfile();
    expect(p.required).toEqual(["document_symbols", "diagnostics"]);
    expect(p.legacyPushDiagnostics && p.enforceAdvertised).toBe(true);
  });
  test("runtime metadata", () => {
    const b = a.binaries();
    expect(b).toHaveLength(1);
    expect(b[0]?.name).toBe("vscode-json-languageserver");
    expect(b[0]?.args).toEqual(["--stdio"]);
    expect(b[0]?.check_args ?? []).toHaveLength(0);
    expect(a.defaultArgs()).toEqual(["--stdio"]);
    const d = a.runtimeDeps()[0];
    expect(d?.version).toBe(jsonLanguageServerVersion);
    expect(d?.recommended_integrity).toBe(jsonLanguageServerIntegrity);
    expect(d?.packages).toEqual(["vscode-json-languageserver"]);
    expect(a.installGuide().knowns_cmd).toBe("knowns lsp install json");
    expect(a.prerequisites()[0]?.check_cmd).toBe("node --version");
  });
  test("routing", () => {
    const r = registry();
    for (const p of ["config.json", "settings.jsonc", "nested/service.JSON"]) {
      expect(r.forPath(p)?.id).toBe("json");
      expect(r.forDetection(p)?.id).toBe("json");
    }
    for (const p of ["package-lock.json", "npm-shrinkwrap.json", "api.generated.json"]) {
      expect(r.forPath(p)?.id).toBe("json");
      expect(r.forDetection(p)).toBeUndefined();
    }
    for (const p of [".knowns/config.json", "C:\\repo\\.knowns\\config.json"]) {
      expect(r.forPath(p)).toBeUndefined();
      expect(r.forDetection(p)).toBeUndefined();
    }
  });
  test("yields terraform compound suffixes", () => {
    const r = registry();
    r.register({
      id: "terraform",
      name: "Terraform",
      extensions: [".tf", ".tfvars", ".tf.json", ".tfvars.json"],
      matchers: [
        { kind: "suffix", pattern: ".tf.json", priority: 200 },
        { kind: "suffix", pattern: ".tfvars.json", priority: 200 },
      ],
    });
    expect(r.forPath("network.tf.json")?.id).toBe("terraform");
    expect(r.forPath("production.tfvars.json")?.id).toBe("terraform");
    expect(r.forPath("settings.json")?.id).toBe("json");
  });
});

describe("yaml", () => {
  const a = newYAMLAdapter();
  test("contracts", () => {
    expect(a.id()).toBe("yaml");
    expect(a.name()).toBe("YAML");
    expect(a.extensions()).toEqual([".yaml", ".yml"]);
    expect(a.lazyStart()).toBe(true);
    expect(a.supportsImplementation() || a.supportsReferences()).toBe(false);
    expect(a.capabilityProfile()).toEqual(documentConfigCapabilityProfile());
  });
  test("routing", () => {
    expect(a.pathMatchers()).toEqual([
      { kind: "suffix", pattern: ".yaml", priority: yamlPathPriority },
      { kind: "suffix", pattern: ".yml", priority: yamlPathPriority },
    ]);
    const r = Registry.empty();
    r.register(languageOf(a));
    for (const p of ["service.yaml", "compose.yml", "nested/CONFIG.YAML"]) {
      expect(r.forPath(p)?.id).toBe("yaml");
      expect(r.forDetection(p)?.id).toBe("yaml");
    }
    for (const p of [".knowns/config.yaml", "C:\\repo\\.knowns\\config.yml"]) {
      expect(r.forPath(p)).toBeUndefined();
      expect(r.forDetection(p)).toBeUndefined();
    }
    expect(r.forPath("config.json")).toBeUndefined();
  });
  test("runtime metadata", () => {
    expect(a.binaries()).toEqual([{ name: "yaml-language-server", args: ["--stdio"] }]);
    expect(a.defaultArgs()).toEqual(["--stdio"]);
    expect(a.prerequisites()).toEqual([
      {
        name: "Node.js 12+",
        check_cmd: "node --version",
        install_hint: "Install Node.js 12+ from https://nodejs.org/",
      },
    ]);
    const deps = a.runtimeDeps();
    expect(deps).toHaveLength(1);
    const d = deps[0];
    expect(d?.id).toBe("yaml-language-server");
    expect(d?.version).toBe(yamlLanguageServerVersion);
    expect(d?.recommended_integrity).toBe(yamlLanguageServerIntegrity);
    expect(a.canInstall()).toBe(true);
    const g = a.installGuide();
    expect(g.knowns_cmd).toBe("knowns lsp install yaml");
    expect(g.command).toBe(`npm install -g yaml-language-server@${yamlLanguageServerVersion}`);
  });
});
