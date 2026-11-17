// f153f06 (KN-W57R68) diverges from the 0.34.1 oracle in the wording of the MCP docs `section` and
// `content` parameters: TS says how a section is addressed (a bare integer is the index, a title like
// "2. Access control" is a title) and that a section update keeps or replaces the heading line. Only
// these literal pairs are mapped back to the oracle text, so any other change to the tool schema or
// help text still fails the diff against Go. The behaviour itself is covered by
// test/stores/doc-sections.test.ts and test/mcp/doc-rebase-sections.test.ts.

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  [
    "Section by heading title or bare integer index (get, update). Update replaces the heading line too, so content should start with it; content without a heading keeps the existing heading",
    "Section by heading title or number (get, update)",
  ],
  [
    "replacement markdown content, or section content when section is set. A section update replaces the section INCLUDING its heading line, so start content with the heading (same or higher level); content that does not start with a heading is kept as the body under the existing heading",
    "replacement markdown content, or section content when section is set",
  ],
  [
    'heading title, or a bare integer for the nth heading (a title like "2. Access control" is a title, not index 2); lines in code fences, HTML comments and indented code are never headings',
    "heading title or section number to replace",
  ],
];

// The same text appears raw, inside a JSON-RPC line and inside a text result that is itself JSON.
function variants(s: string): string[] {
  const one = JSON.stringify(s).slice(1, -1);
  const two = JSON.stringify(one).slice(1, -1);
  return [s, one, two];
}

/** The TypeScript output with the section wording reverted to 0.34.1, for a diff against the oracle. */
export function withoutDocSections(text: string): string {
  let out = text;
  for (const [ts, go] of PAIRS) {
    const g = variants(go);
    variants(ts).forEach((t, i) => {
      out = out.replaceAll(t, g[i] as string);
    });
  }
  return out;
}
