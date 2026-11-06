// /api/imports after D8 was extended to the HTTP API (TSR-0MM0QC). The read endpoints answer exactly
// as 0.34.1 over content already in .knowns/imports. The add, remove and sync endpoints are gone:
// each answers the way the router answers a method or path that never existed there (compared with
// Go's answer for one), and none of them changes .knowns/imports or clones anything.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hasGoBin, mask, type Side, seedTemplate, send, startSide, stopSide } from "./harness.ts";

setDefaultTimeout(120_000);
let go: Side;
let ts: Side;
let gitRepo = "";

function put(root: string, rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

beforeAll(async () => {
  if (!hasGoBin) return;
  const tpl = seedTemplate();
  const imports = join(tpl, ".knowns", "imports");
  // Written the way 0.34.1's `knowns import add` left them.
  put(
    imports,
    "loc/_import.json",
    '{\n  "source": "/src/shared-docs",\n  "type": "local",\n  "importedAt": "2026-10-01T10:00:00Z"\n}',
  );
  put(imports, "loc/docs/guide.md", "---\ntitle: Shared guide\n---\n\nBody.\n");
  put(imports, "loc/docs/deep/ref.md", "---\ntitle: Deep ref\n---\n\nRef.\n");
  put(
    imports,
    "upstream/_import.json",
    '{\n  "source": "https://example.invalid/team/kb.git",\n  "type": "git",\n  "ref": "main",\n  "lastSync": "2026-10-02T09:30:00Z",\n  "importedAt": "2026-10-01T10:00:00Z",\n  "lastCommitHash": "abc123"\n}',
  );
  put(imports, "upstream/templates/t.md", "x\n");
  // A real local git repository, so a surviving add or sync could actually clone something.
  gitRepo = join(tpl, "..", "repo-to-import");
  mkdirSync(gitRepo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: gitRepo });
  writeFileSync(join(gitRepo, "README.md"), "hello\n");
  Bun.spawnSync(["git", "add", "."], { cwd: gitRepo });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], {
    cwd: gitRepo,
  });
  go = await startSide("go", tpl);
  ts = await startSide("ts", tpl);
});
afterAll(() => {
  if (go) stopSide(go);
  if (ts) stopSide(ts);
});

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const J = { "Content-Type": "application/json" };
const shape = async (s: Side, method: string, path: string, body?: unknown) => {
  const r = await send(s, method, path, {
    ...(body !== undefined && { body: JSON.stringify(body), headers: J }),
  });
  return { status: r.status, allow: r.headers.allow, body: mask(r.text, s) };
};

describe.skipIf(!hasGoBin)("/api/imports", () => {
  for (const path of [
    "/api/imports",
    "/api/imports/loc",
    "/api/imports/upstream",
    "/api/imports/missing",
    "/api/imports/..%2Fx",
  ]) {
    test(`GET ${path} matches 0.34.1`, async () => {
      expect(await shape(ts, "GET", path)).toEqual(await shape(go, "GET", path));
    });
  }

  // [removed request, Go request to a method/path that never existed on that route]
  const removed: [string, string, unknown, string, string][] = [
    ["POST", "/api/imports", { source: "", name: "x" }, "PATCH", "/api/imports"],
    ["DELETE", "/api/imports/loc", undefined, "PATCH", "/api/imports/loc"],
    ["POST", "/api/imports/sync", { name: "upstream" }, "PATCH", "/api/imports/sync"],
    ["POST", "/api/imports/sync-all", {}, "PATCH", "/api/imports/sync-all"],
    ["POST", "/api/imports/upstream/sync", {}, "POST", "/api/imports/upstream/never-a-route"],
  ];
  for (const [method, path, body, ctlMethod, ctlPath] of removed) {
    test(`${method} ${path} answers as an unknown route`, async () => {
      const t = await shape(ts, method, path, body ?? undefined);
      const control = await shape(go, ctlMethod, ctlPath);
      expect(t).toEqual(control);
    });
  }

  test("no removed endpoint changes .knowns/imports or clones anything", async () => {
    const dir = join(ts.dir, ".knowns", "imports");
    const before = tree(dir);
    await send(ts, "POST", "/api/imports", {
      body: JSON.stringify({ source: gitRepo, name: "cloned" }),
      headers: J,
    });
    await send(ts, "POST", "/api/imports", {
      body: JSON.stringify({ source: gitRepo, name: "cloned", type: "git" }),
      headers: J,
    });
    await send(ts, "POST", "/api/imports/upstream/sync", { body: "{}", headers: J });
    await send(ts, "POST", "/api/imports/sync-all", { body: "{}", headers: J });
    await send(ts, "DELETE", "/api/imports/loc");
    await send(ts, "DELETE", "/api/imports/upstream");
    expect(tree(dir)).toEqual(before);
    // On 0.34.1 the same add copies the repository in, which is what is being taken away.
    const g = await send(go, "POST", "/api/imports", {
      body: JSON.stringify({ source: gitRepo, name: "cloned" }),
      headers: J,
    });
    expect(g.status).toBe(201);
    expect(readdirSync(join(go.dir, ".knowns", "imports"))).toContain("cloned");
  });
});
