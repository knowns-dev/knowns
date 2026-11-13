import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginAdapters } from "../../src/lsp/plugin-adapter.ts";

const dir = () => mkdtempSync(join(tmpdir(), "lsp-plugin-"));

test("parses manifest", () => {
  const d = dir();
  writeFileSync(
    join(d, "toy.json"),
    JSON.stringify({
      language_id: "toy",
      backend_id: "toy-ls",
      name: "Toy",
      extensions: [".toy"],
      binary_candidates: [{ name: "toy-lsp" }],
      default_args: ["--stdio"],
      prerequisites: [
        { name: "Node.js", check_cmd: "node --version", install_hint: "Install Node" },
      ],
      install_guide: {
        command: "npm install -g toy-lsp",
        knowns_cmd: "knowns lsp install toy",
        notes: "Requires Node",
      },
      runtime_dependencies: [
        {
          id: "toy-lsp",
          version: "1.0.0",
          source: "npm",
          archive_type: "npm",
          binary_name: "toy-lsp",
          package_name: "toy-lsp",
        },
      ],
      initialization_options: { diagnostics: true },
      ignored_dirs: ["vendor"],
      capabilities: { implementation: false, references: true },
    }),
  );
  const r = loadPluginAdapters({ dir: d });
  expect(r.errors).toEqual([]);
  expect(r.adapters.length).toBe(1);
  const a = r.adapters[0];
  if (!a) throw new Error("no adapter");
  expect([a.id(), a.name()]).toEqual(["toy", "Toy"]);
  expect(a.extensions()).toEqual([".toy"]);
  expect(a.binaries()).toEqual([{ name: "toy-lsp", args: ["--stdio"] }]);
  expect(a.canInstall()).toBe(true);
  expect(a.runtimeDeps().length).toBe(1);
  expect(a.initializationOptions(undefined)).toEqual({ diagnostics: true });
  expect(a.initializationOptions({ initializationOptions: { x: 1 } })).toEqual({
    diagnostics: true,
    x: 1,
  });
  expect(a.isIgnoredDir("vendor")).toBe(true);
  expect(a.supportsImplementation()).toBe(false);
  expect(a.supportsReferences()).toBe(true);
  expect(a.installGuide().knowns_cmd).toBe("knowns lsp install toy");
  expect(a.sourcePath?.()).toBe(join(d, "toy.json"));
});

test("fails open on invalid manifests", () => {
  const d = dir();
  writeFileSync(
    join(d, "valid.json"),
    '{"id":"ok","name":"OK","extensions":[".ok"],"binaries":[{"name":"ok-lsp"}]}',
  );
  writeFileSync(
    join(d, "invalid.json"),
    '{"id":"bad","extensions":[".bad"],"binaries":[{"name":"bad-lsp"}]}',
  );
  writeFileSync(
    join(d, "unknown.json"),
    '{"id":"u","name":"U","extensions":[".u"],"binaries":[{"name":"u"}],"bogus":1}',
  );
  writeFileSync(join(d, "notes.txt"), "ignored");
  const r = loadPluginAdapters({ dir: d });
  expect(r.adapters.map((a) => a.id())).toEqual(["ok"]);
  expect(r.errors.length).toBe(2);
  expect(
    r.errors.map((e) => e.path.endsWith("invalid.json") || e.path.endsWith("unknown.json")),
  ).toEqual([true, true]);
});

test("missing dir is empty, mismatched ids and bad extensions rejected", () => {
  expect(loadPluginAdapters({ dir: join(dir(), "nope") })).toEqual({ adapters: [], errors: [] });
  const d = dir();
  writeFileSync(
    join(d, "a.json"),
    '{"id":"a","language_id":"b","name":"A","extensions":[".a"],"binaries":[{"name":"x"}]}',
  );
  writeFileSync(
    join(d, "b.json"),
    '{"id":"b","name":"B","extensions":["b"],"binaries":[{"name":"x"}]}',
  );
  const r = loadPluginAdapters({ dir: d });
  expect(r.adapters.length).toBe(0);
  expect(r.errors[0]?.message).toContain("must match");
  expect(r.errors[1]?.message).toContain("must start with '.'");
});
