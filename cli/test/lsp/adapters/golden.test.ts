// Diffs the TypeScript adapters against a dump produced by the Go adapters
// (go run cli/test/lsp/adapters/dump_adapters.go > go-dump.json). Any difference in ids, names,
// extensions, binaries, check args, install guides, runtime dependency tables (urls, hashes,
// versions, platform ids), initialize params, ignored dirs, matchers, capability profiles,
// document-sync and path-capability behaviour fails here.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allAdapters } from "../../../src/lsp/adapters/index.ts";
import type { LanguageAdapter } from "../../../src/lsp/types.ts";

const ignoredProbes = [
  "vendor",
  "node_modules",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  "target",
  "cmake-build-debug",
  "cmake-build-release",
  ".cache",
  ".gradle",
  ".idea",
  "out",
  "bin",
  "obj",
  ".vs",
  "packages",
  ".dart_tool",
  ".pub",
  ".packages",
  ".build",
  ".swiftpm",
  "DerivedData",
  "Pods",
  ".bundle",
  "tmp",
  "storage",
  "bootstrap/cache",
  ".git",
  "generated",
  "testdata",
  ".terraform",
  "src",
  "Sources",
];
const syncProbes = [
  "main.tf",
  "vars.tfvars",
  "net.tf.json",
  "C:\\repo\\X.TFVARS.JSON",
  "a.ts",
  "a.tsx",
  "a.js",
  "a.jsx",
  "A.JSX",
  "C:\\r\\i.JS",
  "x.d.ts",
  "x.py",
];
const settingsCases: Record<string, Record<string, unknown> | undefined> = {
  nil: undefined,
  empty: {},
  initopt: { initializationOptions: { foo: "bar" } },
  flat: { a: 1 },
};

function dump(a: LanguageAdapter): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: a.id(),
    name: a.name(),
    extensions: a.extensions(),
    binaries: a.binaries(),
    prerequisites: a.prerequisites(),
    installGuide: a.installGuide(),
    canInstall: a.canInstall(),
    runtimeDeps: a.runtimeDeps(),
    defaultArgs: a.defaultArgs(),
    supportsImplementation: a.supportsImplementation(),
    supportsReferences: a.supportsReferences(),
    ignoredDirs: ignoredProbes.filter((n) => a.isIgnoredDir(n)),
  };
  const params: Record<string, unknown> = {};
  const opts: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(settingsCases)) {
    params[k] = a.initializeParams("/nonexistent/project", s);
    opts[k] = a.initializationOptions(s);
  }
  entry.initializeParams = params;
  entry.initializationOptions = opts;
  if (a.pathMatchers) {
    entry.pathMatchers = a.pathMatchers().map((m) => ({
      kind: m.kind,
      pattern: m.pattern,
      priority: m.priority ?? 0,
      explicitOnly: m.explicitOnly ?? false,
    }));
  }
  if (a.lazyStart) entry.lazyStart = a.lazyStart();
  if (a.capabilityProfile) {
    const cp = a.capabilityProfile();
    entry.capabilityProfile = {
      required: cp.required,
      legacyPushDiagnostics: cp.legacyPushDiagnostics ?? false,
      enforceAdvertised: cp.enforceAdvertised ?? false,
    };
  }
  if (a.documentSyncForPath) {
    const sync: Record<string, unknown> = {};
    for (const p of syncProbes) sync[p] = a.documentSyncForPath(p);
    entry.documentSync = sync;
  }
  if (a.pathCapabilityForAction) {
    const caps: Record<string, unknown> = {};
    for (const p of syncProbes) {
      for (const action of ["", "definition"]) {
        const [d, handled] = a.pathCapabilityForAction(p, action, "");
        caps[`${p}|${action}`] = {
          handled,
          supported: d.supported,
          explanation: d.explanation ?? "",
          capabilities: d.capabilities ?? [],
          advertised: d.advertisedCapabilities ?? [],
        };
      }
    }
    entry.pathCapability = caps;
  }
  // JSON round trip drops undefined fields the way Go's omitempty does.
  return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
}

const golden = JSON.parse(readFileSync(join(import.meta.dir, "go-dump.json"), "utf8")) as Record<
  string,
  unknown
>[];

test("adapter order and count match Go", () => {
  expect(allAdapters().map((a) => a.id())).toEqual(golden.map((g) => g.id as string));
});

for (const g of golden) {
  test(`${g.id as string} equals the Go adapter`, () => {
    const adapter = allAdapters().find((a) => a.id() === g.id);
    expect(adapter).toBeDefined();
    if (!adapter) return;
    const got = dump(adapter);
    // The Roslyn dependency is selected by the current platform; the golden file came from
    // darwin-arm64, so only its shape is compared elsewhere.
    if (g.id === "csharp" && !(process.platform === "darwin" && process.arch === "arm64")) {
      delete got.runtimeDeps;
      delete g.runtimeDeps;
    }
    // The golden file came from a unix host: a rooted path gains a drive letter on Windows
    // (Go's filepath.Abs does the same), so compare the URIs without it.
    if (g.id === "bash" && process.platform === "win32") {
      // bash-language-server gets a native rootPath on Windows (covered by bash.test.ts).
      delete got.initializeParams;
      delete g.initializeParams;
    }
    const norm = (v: unknown): unknown =>
      process.platform === "win32"
        ? JSON.parse(JSON.stringify(v).replaceAll("file:///C:/", "file:///"))
        : v;
    expect(norm(got)).toEqual(norm(g));
  });
}
