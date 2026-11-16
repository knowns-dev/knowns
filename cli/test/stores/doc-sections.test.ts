// KN-W57R68: one section parser for every walker. Fences, comments and indented code are not
// headings; only a bare integer addresses by index; MCP update never deletes its own heading.
// Go 0.34.1 divergences (D12): Go cuts sections at '#' lines inside fences (CLI and MCP), and its MCP
// treats any leading integer in a title ("2. Access control") as an index; MCP update without a
// heading in `content` removed the heading in Go and in TS before this fix.
import { describe, expect, test } from "bun:test";
import {
  extractDocSection,
  extractHeadings,
  replaceDocSection,
} from "../../src/cli/commands/doc-support.ts";
import { markdownSectionContent } from "../../src/domain/validate/validate.ts";
import {
  extractSection,
  extractHeadings as mcpHeadings,
  replaceSection,
} from "../../src/mcp/handlers/doc.ts";
import { bareIndex, headingLineIndexes } from "../../src/storage/core/doc-sections.ts";
import { docMarkdownSections, findMarkdownSection } from "../../src/storage/history/entities.ts";

const DOC = [
  "## Overview",
  "",
  "Intro.",
  "",
  "## 2. Access control",
  "",
  "Who may enter.",
  "",
  "### Development Setup",
  "",
  "```bash",
  "# Clone repository",
  "git clone x",
  "# Install",
  "make",
  "```",
  "",
  "After the block.",
  "",
  "## Last",
  "",
  "Tail.",
].join("\n");
const L = DOC.split("\n");
const HEADS = ["## Overview", "## 2. Access control", "### Development Setup", "## Last"];

describe("headings", () => {
  test("fenced # lines are not headings (backtick, tilde, fence lengths)", () => {
    expect(headingLineIndexes(L).map((i) => L[i])).toEqual(HEADS);
    expect(headingLineIndexes("## A\n~~~\n# x\n~~~\n## B".split("\n"))).toEqual([0, 4]);
    // a closing fence at least as long as the opener closes it; a shorter one does not
    expect(headingLineIndexes("## A\n```\n# x\n````\n## B".split("\n"))).toEqual([0, 4]);
    expect(headingLineIndexes("## A\n````\n# x\n```\n# y\n````\n## B".split("\n"))).toEqual([0, 6]);
  });
  test("an unclosed fence hides the rest of the document", () => {
    expect(headingLineIndexes("## A\n```\n# x\n## y".split("\n"))).toEqual([0]);
  });
  test("indented code, blockquotes and HTML comments are not headings", () => {
    const d = "## A\n    # code\n> # quote\n<!--\n# hidden\n-->\n<!-- one line -->\n## B";
    expect(headingLineIndexes(d.split("\n"))).toEqual([0, 7]);
  });
  test("bareIndex only accepts an integer", () => {
    expect(bareIndex("2")).toBe(2);
    expect(bareIndex(" 12 ")).toBe(12);
    expect(bareIndex("2. Access control")).toBeUndefined();
    expect(bareIndex("Phase 2")).toBeUndefined();
  });
});

describe("MCP section get / toc / update", () => {
  test("get keeps the whole fenced block; toc omits fenced comments", () => {
    const s = extractSection(DOC, "Development Setup");
    expect(s.startsWith("### Development Setup")).toBe(true);
    expect(s).toContain("# Install");
    expect(s.endsWith("After the block.")).toBe(true);
    expect(mcpHeadings(DOC)).toEqual(HEADS);
  });
  test("'2. Access control' is a title, '2' is the index", () => {
    expect(extractSection(DOC, "2. Access control").startsWith("## 2. Access control")).toBe(true);
    expect(extractSection(DOC, "2").startsWith("## 2. Access control")).toBe(true);
    expect(extractSection(DOC, "3").startsWith("### Development Setup")).toBe(true);
    expect(extractSection("## Phase 1\nA\n## Phase 2\nB", "Phase 2")).toBe("## Phase 2\nB");
  });
  test("update with a heading replaces it; without one keeps the heading", () => {
    const withHeading = replaceSection(DOC, "Development Setup", "### Dev Setup\n\nnew body");
    expect(withHeading).toContain("### Dev Setup\n\nnew body");
    expect(withHeading).not.toContain("### Development Setup");
    expect(withHeading).not.toContain("# Clone repository");
    expect(withHeading).toContain("## Last\n\nTail.");
    const noHeading = replaceSection(DOC, "Development Setup", "only a body");
    expect(noHeading).toContain("### Development Setup\n\nonly a body");
    expect(noHeading).not.toContain("# Clone repository");
    expect(noHeading).toContain("## Last\n\nTail.");
    // a deeper heading in content is body text, not a replacement of the section heading
    expect(replaceSection(DOC, "Overview", "#### Note\ntext")).toContain(
      "## Overview\n\n#### Note\ntext",
    );
  });
  test("updating '2. Access control' touches only that section", () => {
    const out = replaceSection(DOC, "2. Access control", "## 2. Access control\n\nnew");
    expect(out).toContain("## Overview\n\nIntro.");
    expect(out).toContain("## 2. Access control\n\nnew");
  });
});

describe("CLI section get / replace (heading kept)", () => {
  test("get and replace keep the whole fenced block together", () => {
    expect(extractDocSection(DOC, "Development Setup")).toContain("After the block.");
    const out = replaceDocSection(DOC, "Development Setup", "fresh");
    expect(out).toContain("### Development Setup\n\nfresh");
    expect(out).not.toContain("git clone x");
    expect(out).not.toContain("# Clone repository");
    expect(out).toContain("## Last\n\nTail.");
  });
  test("headings skip fences; titles starting with a number work; integer falls back", () => {
    expect(extractHeadings(DOC).length).toBe(4);
    expect(extractDocSection(DOC, "2. Access control").startsWith("## 2. Access control")).toBe(
      true,
    );
    expect(extractDocSection("## 2024\nx", "2024")).toBe("## 2024\nx");
  });
});

describe("history and validate walkers", () => {
  test("sections skip fences and address by bare index only", () => {
    expect(docMarkdownSections(DOC).map((s) => s.title)).toEqual([
      "Overview",
      "2. Access control",
      "Development Setup",
      "Last",
    ]);
    expect(findMarkdownSection(DOC, "2. Access control")?.title).toBe("2. Access control");
    expect(findMarkdownSection(DOC, "2")?.title).toBe("2. Access control");
  });
  test("markdownSectionContent does not stop at a fenced comment", () => {
    const body = markdownSectionContent(DOC, "Development Setup") ?? "";
    expect(body).toContain("git clone x");
    expect(body).toContain("After the block.");
  });
});
