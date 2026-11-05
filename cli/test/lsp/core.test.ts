import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../../src/lsp/config.ts";
import {
  ErrServerUnavailable,
  errorIs,
  fileURI,
  findSymbolPosition,
  Manager,
  nameAt,
  normalizeCapabilities,
  pathFromFileURI,
  Registry,
  RuntimeError,
  Server,
  snippet,
  utf16Col,
} from "../../src/lsp/index.ts";
import { tabwrite } from "../../src/lsp/tabwriter.ts";
import { BaseAdapter, type LanguageAdapter } from "../../src/lsp/types.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lsp-core-"));
  dirs.push(d);
  return d;
}
afterEach(() => {});

describe("queries", () => {
  test("findSymbolPosition skips comments and strings, returns UTF-16 column", () => {
    const d = tmp();
    const f = join(d, "a.ts");
    writeFileSync(
      f,
      '// Widget here\nconst s = "Widget";\n/* Widget\n Widget */ const é = 1; class Widget {}\n',
    );
    const [line, col] = findSymbolPosition(f, "Widget");
    expect(line).toBe(3);
    expect(col).toBe(30);
    expect(() => findSymbolPosition(f, "Missing")).toThrow('symbol "Missing" not found');
    expect(() => findSymbolPosition(join(d, "nope.ts"), "x")).toThrow("open");
  });
  test("nameAt, snippet, utf16Col", () => {
    const d = tmp();
    const f = join(d, "b.go");
    writeFileSync(f, "  func Hello_1() {}\n");
    expect(nameAt(f, 0, 8)).toBe("Hello_1");
    expect(nameAt(f, 0, 100)).toBe("");
    expect(snippet(f, 0)).toBe("func Hello_1() {}");
    expect(snippet(f, 9)).toBe("");
    expect(utf16Col(Buffer.from("é😀x"), 6)).toBe(3);
  });
});

describe("registry and uri", () => {
  test("routing by suffix, exact name and .knowns boundary", () => {
    const r = new Registry();
    expect(r.forPath("/p/a.go")?.id).toBe("go");
    expect(r.forPath("/p/.knowns/a.go")).toBeUndefined();
    expect(r.forPath("/p/a.TS")?.id).toBe("typescript");
  });
  test("file uri round trip", () => {
    const d = tmp();
    const f = join(d, "sp ace.ts");
    writeFileSync(f, "x");
    const uri = fileURI(f);
    expect(uri.startsWith("file://")).toBe(true);
    expect(uri).toContain("sp%20ace.ts");
    expect(pathFromFileURI(uri)).toBe(pathFromFileURI(fileURI(f)));
    expect(pathFromFileURI("not-a-uri")).toBe("not-a-uri");
  });
});

describe("config and capabilities", () => {
  test("merge and enabled", () => {
    const a = new Config({ go: { binary: "gopls", settings: { a: 1 } } });
    const b = new Config({ go: { enabled: false, settings: { b: 2 } } });
    const m = a.merge(b);
    expect(m.enabled("go")).toBe(false);
    expect(m.binaryOverride("go")).toBe("gopls");
    expect(m.languageSettings("go")).toEqual({ a: 1, b: 2 });
    expect(m.enabled("rust")).toBe(true);
  });
  test("normalizeCapabilities", () => {
    expect(normalizeCapabilities([" B", "a", "b", ""])).toEqual(["a", "b"]);
  });
  test("RuntimeError payload and message", () => {
    const e = new RuntimeError({
      code: "unsupported_capability",
      language: "go",
      message: "m",
      remediation: "r",
    });
    expect(e.message).toBe("m. r");
    expect(e.payload().advertised_capabilities).toEqual([]);
  });
  test("tabwrite pads columns by block", () => {
    expect(tabwrite(["a\tx", "bbb\ty"])).toBe("a    x\nbbb  y\n");
  });
});

class FakeAdapter extends BaseAdapter implements LanguageAdapter {
  constructor(private bin: string) {
    super();
  }
  id() {
    return "fake";
  }
  name() {
    return "Fake";
  }
  extensions() {
    return [".fk"];
  }
  binaries() {
    return [{ name: this.bin, args: [`${import.meta.dir}/fake-server.ts`] }];
  }
  prerequisites() {
    return [];
  }
  async checkPrerequisites() {}
  installGuide() {
    return {};
  }
  canInstall() {
    return false;
  }
  runtimeDeps() {
    return [];
  }
  async install() {
    return "";
  }
  installedPath() {
    return undefined;
  }
  defaultArgs() {
    return [];
  }
  initializeParams() {
    return undefined;
  }
  initializationOptions() {
    return undefined;
  }
}

describe("server and manager against a fake language server", () => {
  test("documentSymbols and definition through Manager.withSession", async () => {
    const root = tmp();
    const f = join(root, "x.fk");
    writeFileSync(f, "widget\nrender\n");
    mkdirSync(join(root, ".knowns"));
    const mgr = new Manager(root, new Config());
    mgr.registerAdapter(new FakeAdapter("bun"));
    try {
      let syms: unknown[] = [];
      let defUri = "";
      await mgr.withSession(undefined, f, async (s) => {
        syms = await s.documentSymbols(undefined, f);
        defUri = (await s.definition(undefined, f, 0, 0)).uri;
      });
      expect((syms[0] as { name: string }).name).toBe("Widget");
      expect(defUri).toBe(fileURI(f));
      expect(mgr.activeLanguages()).toEqual(["fake"]);
      const st = await mgr.runtimeStatuses();
      expect(st[0]?.running_state).toBe("running");
      expect(st[0]?.capabilities).toContain("definition");
    } finally {
      await mgr.stopAll(undefined);
    }
    expect(mgr.activeLanguages()).toEqual([]);
  });
  test("unavailable reasons wrap ErrServerUnavailable", async () => {
    const root = tmp();
    const mgr = new Manager(root, new Config());
    for (const p of [root, join(root, "missing.zz"), join(root, "a.zz")]) {
      const err = await mgr
        .withSession(undefined, p, async () => {})
        .then(
          () => undefined,
          (e) => e,
        );
      expect(errorIs(err, ErrServerUnavailable)).toBe(true);
    }
  });
  test("a missing binary is a start failure, not a hang", async () => {
    const root = tmp();
    const s = new Server(root, {
      language: "fake",
      name: "x",
      path: join(root, "no-such-binary"),
      args: [],
    });
    await expect(s.start(undefined)).rejects.toThrow();
    expect(s.alive()).toBe(false);
  });
});
