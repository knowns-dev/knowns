// Unit tests for the Go-compatibility primitives and small helpers.
import { describe, expect, test } from "bun:test";
import { FlagError, FlagSet, HelpRequested } from "../../src/cli/core/flags.ts";
import {
  formatGoDuration,
  goBackquote,
  goJSONIndent,
  goQuote,
  levenshtein,
  parseGoBool,
  parseGoDuration,
  parseGoInt,
} from "../../src/cli/core/gofmt.ts";
import { formatDuration, splitCSV } from "../../src/cli/core/helpers.ts";
import { sortSubcommands, subcommandRank } from "../../src/cli/core/helpgroups.ts";
import {
  markdownViewportWidth,
  newTerminalMarkdownBodyRenderer,
  terminalMarkdownStyle,
  terminalWidth,
} from "../../src/cli/core/markdown.ts";
import {
  noColorRequested,
  renderSuccess,
  Style,
  StyleBold,
  StyleDim,
  StyleInfo,
  setPlainOutput,
  statusStyle,
} from "../../src/cli/core/plainoutput.ts";

describe("gofmt", () => {
  test("goQuote", () => {
    expect(goQuote('a"b\\c\n\t')).toBe('"a\\"b\\\\c\\n\\t"');
    expect(goQuote("héllo ✓")).toBe('"héllo ✓"');
    expect(goQuote("\x00\x7f")).toBe('"\\x00\\x7f"');
    expect(goQuote("​")).toBe('"\\u200b"');
  });
  test("goBackquote follows %#q", () => {
    expect(goBackquote("bogus")).toBe("`bogus`");
    expect(goBackquote("a`b")).toBe('"a`b"');
  });
  test("parseGoInt base 0", () => {
    const v = (s: string) => {
      const r = parseGoInt(s);
      return r.ok ? r.value : r.error;
    };
    expect(v("42")).toBe(42n);
    expect(v("-0x1F")).toBe(-31n);
    expect(v("0b101")).toBe(5n);
    expect(v("0o17")).toBe(15n);
    expect(v("017")).toBe(15n);
    expect(v("1_000")).toBe(1000n);
    expect(v("0")).toBe(0n);
    expect(v("08")).toBe('strconv.ParseInt: parsing "08": invalid syntax');
    expect(v("_1")).toBe('strconv.ParseInt: parsing "_1": invalid syntax');
    expect(v("1__0")).toBe('strconv.ParseInt: parsing "1__0": invalid syntax');
    expect(v("")).toBe('strconv.ParseInt: parsing "": invalid syntax');
    expect(v("9223372036854775807")).toBe(9223372036854775807n);
    expect(v("9223372036854775808")).toBe(
      'strconv.ParseInt: parsing "9223372036854775808": value out of range',
    );
    expect(parseGoInt("0x10", 10, "Atoi")).toEqual({
      ok: false,
      error: 'strconv.Atoi: parsing "0x10": invalid syntax',
    });
  });
  test("parseGoBool", () => {
    for (const s of ["1", "t", "T", "TRUE", "true", "True"])
      expect(parseGoBool(s)).toEqual({ ok: true, value: true });
    for (const s of ["0", "f", "F", "FALSE", "false", "False"])
      expect(parseGoBool(s)).toEqual({ ok: true, value: false });
    expect(parseGoBool("yes").ok).toBe(false);
  });
  test("durations parse and format like Go", () => {
    const ns = (s: string) => {
      const r = parseGoDuration(s);
      return r.ok ? r.value : r.error;
    };
    expect(ns("1h30m")).toBe(5400e9);
    expect(ns("1.5s")).toBe(1.5e9);
    expect(ns("-2m")).toBe(-120e9);
    expect(ns("300ms")).toBe(300e6);
    expect(ns("0")).toBe(0);
    expect(ns("1µs")).toBe(1e3);
    expect(ns("5")).toBe('time: missing unit in duration "5"');
    expect(ns("")).toBe('time: invalid duration ""');
    expect(ns("1x")).toBe('time: unknown unit "x" in duration "1x"');
    expect(formatGoDuration(0)).toBe("0s");
    expect(formatGoDuration(90e9)).toBe("1m30s");
    expect(formatGoDuration(3600e9)).toBe("1h0m0s");
    expect(formatGoDuration(1.5e9)).toBe("1.5s");
    expect(formatGoDuration(300e6)).toBe("300ms");
    expect(formatGoDuration(1500)).toBe("1.5µs");
    expect(formatGoDuration(7)).toBe("7ns");
    expect(formatGoDuration(-120e9)).toBe("-2m0s");
  });
  test("levenshtein", () => {
    expect(levenshtein("tsk", "task")).toBe(1);
    expect(levenshtein("Task", "task")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
  test("goJSONIndent escapes like encoding/json", () => {
    expect(goJSONIndent({ a: [], b: {}, c: "<&> " })).toBe(
      '{\n  "a": [],\n  "b": {},\n  "c": "\\u003c\\u0026\\u003e\\u2028"\n}',
    );
  });
});

describe("FlagSet", () => {
  const make = () => {
    const fs = new FlagSet("t");
    fs.define("bool", "verbose", "v", "Verbose");
    fs.define("string", "name", "n", "Name");
    fs.define("int", "count", "", "Count", 3);
    return fs;
  };
  const err = (fs: FlagSet, args: string[]): string => {
    try {
      fs.parse(args);
    } catch (e) {
      if (e instanceof HelpRequested) return "help";
      if (e instanceof FlagError) return e.message;
      throw e;
    }
    return "";
  };
  test("messages", () => {
    expect(err(make(), ["--nope"])).toBe("unknown flag: --nope");
    expect(err(make(), ["-q"])).toBe("unknown shorthand flag: 'q' in -q");
    expect(err(make(), ["-vq"])).toBe("unknown shorthand flag: 'q' in -q");
    expect(err(make(), ["--name"])).toBe("flag needs an argument: --name");
    expect(err(make(), ["-n"])).toBe("flag needs an argument: 'n' in -n");
    expect(err(make(), ["---x"])).toBe("bad flag syntax: ---x");
    expect(err(make(), ["--=x"])).toBe("bad flag syntax: --=x");
    expect(err(make(), ["--help"])).toBe("help");
    expect(err(make(), ["-h"])).toBe("help");
    expect(err(make(), ["--count", "z"])).toBe(
      'invalid argument "z" for "--count" flag: strconv.ParseInt: parsing "z": invalid syntax',
    );
  });
  test("forms: --k=v, --k v, -kv, -k=v, -k v, clustered, --", () => {
    const fs = make();
    fs.parse(["a", "-vn=x", "b", "--count=7", "--", "-c", "d"]);
    expect(fs.args()).toEqual(["a", "b", "-c", "d"]);
    expect(fs.argsLenAtDash()).toBe(2);
    expect(fs.lookup("name")?.value.get()).toBe("x");
    expect(fs.lookup("count")?.value.get()).toBe(7);
    expect(fs.changed("verbose")).toBe(true);
    const g = make();
    g.parse(["-nfoo"]);
    expect(g.lookup("name")?.value.get()).toBe("foo");
  });
  test("usages align like pflag", () => {
    expect(make().flagUsages()).toBe(
      "      --count int     Count (default 3)\n  -n, --name string   Name\n  -v, --verbose       Verbose\n",
    );
  });
});

describe("plain output", () => {
  test("styles render ANSI unless plain, and wrap per line", () => {
    setPlainOutput(false);
    expect(StyleInfo.render("x")).toBe("\x1b[36mx\x1b[m");
    expect(StyleBold.render("x")).toBe("\x1b[1mx\x1b[m");
    expect(StyleDim.render("a\n\nb")).toBe("\x1b[90ma\x1b[m\n\n\x1b[90mb\x1b[m");
    expect(new Style(true, 36).render("x")).toBe("\x1b[1;36mx\x1b[m");
    expect(statusStyle("todo").render("todo")).toBe("todo");
    expect(renderSuccess("ok")).toBe("\x1b[32m✓ ok\x1b[m");
    setPlainOutput(true);
    expect(renderSuccess("ok")).toBe("✓ ok");
    expect(StyleInfo.render("x")).toBe("x");
    setPlainOutput(false);
    expect(StyleInfo.render("x")).toBe("\x1b[36mx\x1b[m");
  });
  test("NO_COLOR: set and non-empty", () => {
    expect(noColorRequested({ NO_COLOR: "1" })).toBe(true);
    expect(noColorRequested({ NO_COLOR: "0" })).toBe(true);
    expect(noColorRequested({ NO_COLOR: "" })).toBe(false);
    expect(noColorRequested({})).toBe(false);
  });
});

describe("helpers", () => {
  test("formatDuration", () => {
    expect([0, -5, 59, 60, 61, 3600, 3660, 3661, 7325].map(formatDuration)).toEqual([
      "0m",
      "0m",
      "59s",
      "1m",
      "1m 1s",
      "1h",
      "1h 1m",
      "1h 1m",
      "2h 2m",
    ]);
  });
  test("splitCSV", () => {
    expect(splitCSV("")).toEqual([]);
    expect(splitCSV(" a, b ,,c ")).toEqual(["a", "b", "c"]);
  });
  test("subcommand order: create, list, view, edit, others, destructive", () => {
    expect(
      sortSubcommands([
        "hard-delete",
        "view",
        "zeta",
        "create",
        "archive",
        "edit",
        "alpha",
        "list",
      ]),
    ).toEqual(["create", "list", "view", "edit", "alpha", "zeta", "archive", "hard-delete"]);
    expect(subcommandRank("cleanup")).toBe(5);
  });
});

describe("markdown seam", () => {
  test("width and style selection match Go; the renderer is the documented raw fallback", () => {
    expect(markdownViewportWidth(10)).toBe(20);
    expect(markdownViewportWidth(100)).toBe(98);
    expect(terminalMarkdownStyle({ TERM: "dumb" })).toBe("ascii");
    expect(terminalWidth({ COLUMNS: "77" })).toBeGreaterThan(0);
    expect(newTerminalMarkdownBodyRenderer(80, "dark")("**x**")).toBe("**x**");
  });
});
