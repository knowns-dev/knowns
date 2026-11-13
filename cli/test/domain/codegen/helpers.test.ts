import { describe, expect, test } from "bun:test";
import {
  camelCase,
  Engine,
  kebabCase,
  lowerCase,
  pascalCase,
  snakeCase,
  startCase,
  upperCase,
} from "../../../src/domain/codegen/index.ts";
import { askGo, GO_ORACLE } from "./oracle.ts";

const inputs = [
  "",
  "a",
  "A",
  "my name",
  "MyName",
  "my-name",
  "my_name",
  "XMLParser",
  "HTTPServer2Go",
  "hello_world-foo bar",
  "a1B2",
  "ABC",
  "aBC",
  "  lead  trail  ",
  "A-B_C D",
  "ñandú Ñandú",
  "ÀB àb",
  "ǆ ǅ Ǆ",
  "İstanbul",
  "straße STRASSE",
  "日本語 テスト",
  "x😀Y",
  "ΑΣ ΑΣΑ",
  "tab\tsep\nnl",
  "ﬁne",
  "i̇",
];

const fns: Record<string, (s: string) => string> = {
  camelCase,
  pascalCase,
  kebabCase,
  snakeCase,
  startCase,
  upperCase,
  lowerCase,
};

describe("case helpers", () => {
  test("documented examples", () => {
    expect(camelCase("my name")).toBe("myName");
    expect(camelCase("MyName")).toBe("myName");
    expect(pascalCase("my-name")).toBe("MyName");
    expect(kebabCase("myName")).toBe("my-name");
    expect(snakeCase("my name")).toBe("my_name");
    expect(startCase("myName")).toBe("My Name");
    expect(kebabCase("XMLParser")).toBe("xml-parser");
    expect(camelCase("")).toBe("");
  });

  (GO_ORACLE ? test : test.skip)("match the Go helpers on a unicode corpus", () => {
    const reqs = Object.keys(fns).flatMap((fn) =>
      inputs.map((s) => ({ op: "render" as const, tpl: `{{${fn} s}}`, vars: { s } })),
    );
    const go = askGo(reqs);
    const engine = new Engine("/p");
    let i = 0;
    for (const [name, fn] of Object.entries(fns)) {
      for (const s of inputs) {
        const want = go[i++];
        // helpers are also reached through the engine, which must agree with the direct call
        expect({ fn: name, s, out: engine.renderString(`{{${name} s}}`, { s }) }).toEqual({
          fn: name,
          s,
          out: want?.out ?? "<missing>",
        });
        expect({ fn: name, s, out: fn(s) }).toEqual({ fn: name, s, out: want?.out ?? "<missing>" });
      }
    }
  });
});
