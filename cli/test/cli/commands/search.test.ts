// search against the Go 0.34.1 oracle: keyword and degraded-hybrid results in every output mode,
// every filter flag, paging, the maintenance modes and flag errors.
import { describe, expect, test } from "bun:test";
import {
  formatMatchedBy,
  formatMemoryScope,
  goFixed,
  groupResults,
  scoreToPercent,
  truncate,
} from "../../../src/cli/commands/search-support.ts";
import { hasGoBin } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const cases = hasGoBin ? describe : describe.skip;

cases("search: keyword results match Go", () => {
  for (const mode of [[], ["--plain"], ["--json"]]) {
    for (const q of ["login", "auth", "setup guide", "zzzqq", "Implement"]) {
      test(`${q} ${mode.join(" ")}`, async () => {
        await expectParity("full", [["search", ...q.split(" "), "--keyword", ...mode]]);
      });
    }
  }

  test("every type filter", async () => {
    await expectParity(
      "full",
      ["all", "task", "doc", "memory", "decision"].flatMap((t) => [
        ["search", "a", "--keyword", "--type", t, "--plain"],
        ["search", "a", "--keyword", "--type", t, "--json"],
        ["search", "a", "--keyword", "--type", t],
      ]),
    );
  });

  test("filters", async () => {
    await expectParity("full", [
      ["search", "login", "--keyword", "--status", "done", "--plain"],
      ["search", "a", "--keyword", "--type", "task", "--priority", "high", "--plain"],
      ["search", "a", "--keyword", "--type", "task", "--label", "auth", "--plain"],
      ["search", "a", "--keyword", "--type", "doc", "--tag", "guide", "--plain"],
      ["search", "a", "--keyword", "--type", "task", "--assignee", "@fixture", "--json"],
      ["search", "a", "--keyword", "--type", "decision", "--status", "accepted", "--plain"],
      ["search", "a", "--keyword", "--include-historical", "--plain"],
      ["search", "a", "--keyword", "--limit", "1", "--plain"],
      ["search", "a", "--keyword", "--limit", "0", "--plain"],
      ["search", "a", "--keyword", "--limit", "-3", "--json"],
    ]);
  });

  test("paging", async () => {
    await expectParity("full", [
      ["search", "a", "--keyword", "--plain", "--page", "1", "--page-size", "5"],
      ["search", "a", "--keyword", "--plain", "--page", "2", "--page-size", "5"],
      ["search", "a", "--keyword", "--plain", "--page", "99", "--page-size", "5"],
    ]);
  });

  test("NO_COLOR strips the styles but not the badges (Go builds those per call)", async () => {
    await expectParity("full", [
      { args: ["search", "bun", "--keyword"], env: { NO_COLOR: "1" } },
      { args: ["search", "auth"], env: { NO_COLOR: "1" } },
      { args: ["search", "--status-check"], env: { NO_COLOR: "1" } },
      { args: ["search", "--status-check", "--plain"], env: { NO_COLOR: "1" } },
    ]);
  });

  test("a multi-word query is joined with spaces", async () => {
    await expectParity("full", [["search", "login", "flow", "--keyword", "--plain"]]);
  });

  test("project with nothing in it", async () => {
    await expectParity("empty", [
      ["search", "x", "--keyword", "--plain"],
      ["search", "x", "--keyword"],
      ["search", "x", "--keyword", "--json"],
    ]);
  });
});

cases("search: default hybrid mode degrades to keyword with Go's notice", () => {
  test("semantic search not configured", async () => {
    await expectParity("full", [
      ["search", "auth"],
      ["search", "auth", "--plain"],
      ["search", "auth", "--json"],
      ["search", "zzzqq"],
      ["search", "zzzqq", "--plain"],
    ]);
  });

  test("semantic search enabled but no index", async () => {
    await expectParity("full", [
      ["config", "set", "embedding", "true"],
      ["config", "set", "settings.semanticSearch.model", "foo"],
      ["search", "auth"],
      ["search", "auth", "--plain"],
      ["search", "auth", "--json"],
      ["search", "auth", "--type", "doc", "--plain"],
    ]);
  });

  test("runtime disabled by the environment", async () => {
    await expectParity("full", [
      { args: ["search", "auth", "--plain"], env: { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1" } },
      { args: ["search", "auth", "--json"], env: { KNOWNS_SEMANTIC_RUNTIME: "off" } },
    ]);
  });
});

cases("search: maintenance modes and errors", () => {
  test("--status-check", async () => {
    await expectParity("full", [
      ["search", "--status-check"],
      ["search", "--status-check", "--plain"],
      ["config", "set", "embedding", "true"],
      ["search", "--status-check"],
      ["config", "set", "settings.semanticSearch.model", "foo"],
      ["search", "--status-check", "--plain"],
    ]);
  });

  test("--setup", async () => {
    await expectParity("full", [
      ["search", "--setup"],
      ["config", "set", "settings.semanticSearch.model", "foo"],
      ["search", "--setup"],
      ["search", "--setup"],
    ]);
  });

  test("flag priority: --status-check wins over --setup and a query", async () => {
    await expectParity("full", [["search", "x", "--setup", "--status-check", "--plain"]]);
  });

  test("--reindex with nothing to index", async () => {
    await expectParity("empty", [
      ["search", "--reindex"],
      ["search", "--reindex", "--plain"],
    ]);
  });

  test("search index --wait refuses when semantic search is disabled", async () => {
    await expectParity("full", [["search", "index", "--wait"]]);
  });

  test("usage errors", async () => {
    await expectParity("full", [
      ["search"],
      ["search", "--bogus"],
      ["search", "x", "--limit", "abc"],
      ["search", "x", "--keyword=maybe"],
      ["search", "--help"],
      ["search", "index", "--help"],
      ["help", "search"],
    ]);
  });

  test("outside a project", async () => {
    await expectParity("", [["search", "x"], ["search", "--status-check"], ["search"]]);
  });
});

cases("search: output of a task, doc, memory and decision hit together", () => {
  test("every section renders", async () => {
    await expectParity("full", [
      ["search", "bun", "--keyword"],
      ["search", "bun", "--keyword", "--plain"],
      ["search", "use", "--keyword", "--plain", "--include-historical"],
    ]);
  });
});

describe("search-support helpers", () => {
  test("scoreToPercent clamps and floors like Go", () => {
    expect(scoreToPercent(1, 0)).toBe(0);
    expect(scoreToPercent(1, 1)).toBe(100);
    expect(scoreToPercent(0.999, 1)).toBe(99);
    expect(scoreToPercent(0.001, 1)).toBe(1);
    expect(scoreToPercent(0, 1)).toBe(0);
    expect(scoreToPercent(2, 1)).toBe(100);
  });

  test("goFixed rounds half to even on the exact binary value (JS toFixed rounds ties up)", () => {
    expect(goFixed(0.0625, 3)).toBe("0.062");
    expect(goFixed(0.1875, 3)).toBe("0.188");
    expect(goFixed(0.5, 0)).toBe("0");
    expect(goFixed(1.5, 0)).toBe("2");
    expect(goFixed(0.4375, 3)).toBe("0.438");
    expect(goFixed(1, 3)).toBe("1.000");
    expect(goFixed(0.8333333333333334, 3)).toBe("0.833");
    expect(goFixed(123456.789, 3)).toBe("123456.789");
    expect(goFixed(-0.0004, 3)).toBe("-0.000");
    expect(goFixed(Number.NaN, 3)).toBe("NaN");
    expect(goFixed(Number.POSITIVE_INFINITY, 3)).toBe("+Inf");
  });

  test("truncate flattens whitespace and never splits a rune", () => {
    expect(truncate("a\n\n  b\tc", 100)).toBe("a b c");
    expect(truncate("héllo wörld", 6)).toBe("héllo…\x1b[0m");
    // Go counts runes (not columns) against max-1 before the ellipsis.
    expect(truncate("日本語日本語", 4)).toBe("日本語…\x1b[0m");
  });

  test("scope and matched-by labels", () => {
    expect(formatMatchedBy(undefined)).toBe("keyword");
    expect(formatMatchedBy(["keyword", "semantic"])).toBe("keyword + semantic");
    expect(formatMemoryScope("", "")).toBe("unknown");
    expect(formatMemoryScope("project", "project-store")).toBe("project / project-store");
    expect(formatMemoryScope("global", "")).toBe("global");
  });

  test("groupResults keeps only the four displayed kinds, in order", () => {
    const g = groupResults([
      { type: "code", id: "c", title: "c", score: 1 },
      { type: "doc", id: "d", title: "d", score: 1 },
      { type: "task", id: "t", title: "t", score: 1 },
    ]);
    expect(g.filtered.map((r) => r.id)).toEqual(["d", "t"]);
  });
});
