// internal/references: unit tests ported from references_test.go / rewrite_test.go, plus a
// differential run against the real Go package (cli/test/helpers/references-oracle.go) over a
// corpus of tricky inputs. The differential part skips when `go` is not installed.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  allowedRelation,
  allRelationKinds,
  extract,
  parse,
  referenceExtractor,
  rewriteDocPath,
} from "../../../src/domain/references/index.ts";

describe("parse", () => {
  test("legacy task ref with relation", () => {
    const ref = parse("@task-rag001{blocked-by}");
    expect(ref).toMatchObject({
      type: "task",
      target: "rag001",
      relation: "blocked-by",
      explicitRelation: true,
      validRelation: true,
      legacy: true,
      canonical: "@task/rag001{blocked-by}",
    });
  });

  test("canonical slash refs", () => {
    const cases: Array<[string, string, string, string]> = [
      ["@task/rag001{blocked-by}", "task", "rag001", "@task/rag001{blocked-by}"],
      ["@memory/mem001{follows}", "memory", "mem001", "@memory/mem001{follows}"],
      [
        "@decision/20260618-1024-use-qdrant-as-default-vector-db",
        "decision",
        "20260618-1024-use-qdrant-as-default-vector-db",
        "@decision/20260618-1024-use-qdrant-as-default-vector-db",
      ],
      ["@template/go-feature", "template", "go-feature", "@template/go-feature"],
    ];
    for (const [raw, type, target, canonical] of cases) {
      const ref = parse(raw);
      expect(ref?.type).toBe(type);
      expect(ref?.target).toBe(target);
      expect(ref?.legacy).toBeUndefined();
      expect(ref?.canonical).toBe(canonical);
    }
  });

  test("doc ref defaults to references", () => {
    const ref = parse("@doc/guides/setup");
    expect(ref).toMatchObject({ type: "doc", target: "guides/setup", relation: "references" });
    expect(ref?.explicitRelation).toBeUndefined();
  });

  test("doc ref with heading and relation", () => {
    const ref = parse("@doc/guides/setup#overview{implements}");
    expect(ref?.target).toBe("guides/setup");
    expect(ref?.fragment?.heading).toBe("overview");
    expect(ref?.relation).toBe("implements");
  });

  test("doc ref with line range", () => {
    const ref = parse("@doc/guides/setup:10-25{related}");
    expect(ref?.fragment).toEqual({ raw: ":10-25", rangeStart: 10, rangeEnd: 25 });
  });

  test("invalid relation parses but is flagged", () => {
    expect(parse("@memory-mem001{owns}")?.validRelation).toBe(false);
  });

  test("rejects non references", () => {
    for (const raw of ["", "plain", "@", "@unknown/x", "@task/", "@doc/", "@doc/#h", " "]) {
      expect(parse(raw)).toBeUndefined();
    }
  });

  test("JSON key order is Go's struct order", () => {
    const ref = parse("@doc/a#h{related}");
    expect(Object.keys(ref ?? {})).toEqual([
      "raw",
      "canonical",
      "type",
      "target",
      "relation",
      "explicitRelation",
      "validRelation",
      "fragment",
    ]);
  });
});

describe("extract", () => {
  test("mixed semantic refs", () => {
    const refs = extract(
      "See @doc/guides/setup{implements}, @task/rag001, @task-legacy, @memory/mem001, @memory-old{follows}, and @decision/20260618-1024-use-qdrant-as-default-vector-db.",
    );
    expect(refs).toHaveLength(6);
    expect(refs[1]?.relation).toBe("references");
    expect(refs[2]).toMatchObject({ canonical: "@task/legacy", legacy: true });
    expect(refs[4]).toMatchObject({ canonical: "@memory/old{follows}", legacy: true });
    expect(refs[5]?.type).toBe("decision");
  });

  test("skips fenced code and mid-line fences", () => {
    expect(extract("```\n@doc/a\n```\n@doc/b")).toHaveLength(1);
    expect(extract("text ``` @doc/a")).toHaveLength(1);
    expect(extract("```js\n@doc/a")).toHaveLength(0);
  });

  test("adapter for the search library", () => {
    expect(referenceExtractor.extract("@doc/x")).toEqual(extract("@doc/x"));
  });
});

describe("relations", () => {
  test("allowlist", () => {
    expect(allowedRelation("implements")).toBe(true);
    expect(allowedRelation("references")).toBe(true);
    expect(allowedRelation("owns")).toBe(false);
    expect(allRelationKinds().sort()).toEqual(
      [
        "blocked-by",
        "depends",
        "follows",
        "implements",
        "imported-from",
        "parent",
        "references",
        "related",
        "spec",
        "template-for",
      ].sort(),
    );
  });
});

describe("rewriteDocPath", () => {
  test("rewrites preserving fragment and relation", () => {
    expect(
      rewriteDocPath("a @doc/old#h{implements} b @doc/old:3-4 c @doc/old.", "old", "new/p"),
    ).toBe("a @doc/new/p#h{implements} b @doc/new/p:3-4 c @doc/new/p.");
  });

  test("no-ops", () => {
    expect(rewriteDocPath("  ", "a", "b")).toBe("  ");
    expect(rewriteDocPath("@doc/a", " ", "b")).toBe("@doc/a");
    expect(rewriteDocPath("@doc/a", "a", "a")).toBe("@doc/a");
    expect(rewriteDocPath("@doc/other", "a", "b")).toBe("@doc/other");
  });
});

// --- differential -------------------------------------------------------------------------------

const hasGo = Bun.which("go") !== null;
const repoRoot = resolve(import.meta.dir, "../../../..");
let binary: string | undefined;

function oracle(requests: unknown[]): Array<Record<string, unknown>> {
  if (!binary) {
    const dir = mkdtempSync(join(tmpdir(), "references-oracle-"));
    binary = join(dir, process.platform === "win32" ? "oracle.exe" : "oracle");
    const b = spawnSync("go", ["build", "-o", binary, "cli/test/helpers/references-oracle.go"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (b.status !== 0) throw new Error(`go build failed: ${b.stderr}`);
  }
  const r = spawnSync(binary, [], {
    input: `${requests.map((q) => JSON.stringify(q)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`oracle failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const CORPUS: string[] = [
  "@doc/a",
  "@doc/a/b/c.d_e-f",
  "@doc/a#heading",
  "@doc/a#head.ing-1_x{implements}",
  "@doc/a#",
  "@doc/a:",
  "@doc/a:1",
  "@doc/a:1-",
  "@doc/a:1-2-3",
  "@doc/a:12-34{related}",
  // "@doc/a:99999999999999999999" is left out on purpose: Go prints the clamped line as the exact
  // int64 maximum, which a JS number cannot represent.
  "@doc/a{",
  "@doc/a{}",
  "@doc/a{Bad}",
  "@doc/a{blocked-by}trailing",
  "@doc/a{nope}",
  "@doc/.",
  "@doc//x",
  "@doc/x..",
  "@doc/x.,;:!?`'\"",
  "(@doc/x)",
  "[@doc/x](y)",
  "@doc/tiếng-việt",
  "@doc/x y @doc/z",
  "@task-abc.def-1 and @task-",
  "@task-abc{depends} @task-abc{x}",
  "@task/abc/def{follows}",
  "@task/",
  "@memory-ab_cd @memory-ab-cd{related}",
  "@memory/a.b_c-d",
  "@decision/2026-x{parent}",
  "@decision/",
  "@template/t1/t2",
  "@unknown/x @doc @doc/ @@doc/x",
  "email@doc/x.com and a@task-1",
  "line1\n@doc/a\n```\n@doc/b\n```\n@doc/c",
  "```\n@doc/a",
  "x```\n@doc/a",
  "  ```\n@doc/a\n```\n@doc/b",
  "````\n@doc/a\n````\n@doc/b",
  "@doc/a @doc/a @doc/b#h @doc/b:1",
  "@doc/old#h{implements}, @doc/old:3-4. @doc/old2 @doc/old",
  "\t@doc/x\r\n@doc/y\r\n",
  "@doc/a#h:1-2{related}",
  "@doc/a:1#h",
  "@doc/a#h#i",
  "@doc/a{related}{depends}",
  "@doc/a:5 @task/x:5",
  "@doc/日本語",
  "@@@@",
  "@",
  "",
];

(hasGo ? describe : describe.skip)("references match the Go package", () => {
  test("extract", () => {
    const answers = oracle(CORPUS.map((content) => ({ op: "extract", content })));
    CORPUS.forEach((content, i) => {
      const want = (answers[i]?.refs ?? []) as unknown[];
      // JSON.stringify keeps key order, so this also checks the field order.
      expect({ content, refs: JSON.stringify(extract(content)) }).toEqual({
        content,
        refs: JSON.stringify(want),
      });
    });
  });

  test("parse", () => {
    const raws = [
      ...CORPUS,
      "  @doc/a  ",
      "@doc/a.",
      "@doc/a#h.",
      "@task-x.",
      "@task/x..",
      "@task/ x",
      "@memory-",
      "@memory/",
      "@decision/{related}",
      "@doc/a b",
      "@doc/a{related",
      "@doc/{related}",
    ];
    const answers = oracle(raws.map((raw) => ({ op: "parse", raw })));
    raws.forEach((raw, i) => {
      const want = answers[i];
      const got = parse(raw);
      expect({ raw, ok: got !== undefined }).toEqual({ raw, ok: want?.ok === true });
      if (got) expect(JSON.stringify(got)).toBe(JSON.stringify(want?.ref));
    });
  });

  test("rewriteDocPath", () => {
    const requests = CORPUS.flatMap((content) =>
      [
        ["a", "z/y"],
        ["old", "new"],
        ["x", "x2"],
        ["a/b/c.d_e-f", "moved"],
        ["tiếng-việt", "viet"],
        ["", "q"],
        ["a", "a"],
      ].map(([old, nw]) => ({ op: "rewrite", content, old, new: nw })),
    );
    const answers = oracle(requests);
    requests.forEach((q, i) => {
      expect({ q, out: rewriteDocPath(q.content, q.old as string, q.new as string) }).toEqual({
        q,
        out: (answers[i]?.out as string | undefined) ?? "",
      });
    });
  });
});
