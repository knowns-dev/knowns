// JSON.rawJSON and the reviver `context` argument (TC39 JSON.parse source text access) ship in
// Bun/JavaScriptCore but not yet in the TypeScript lib used here.
interface JSON {
  rawJSON(text: string): { rawJSON: string };
  parse(
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown,
  ): unknown;
}
