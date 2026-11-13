/**
 * pflag, as cobra uses it: flag sets, typed values, GNU-ish parsing and the FlagUsages layout.
 * The parse loop and every error string follow spf13/pflag v1.0.9 so a bad invocation produces
 * the same stderr as the Go binary.
 */
import {
  formatGoDuration,
  goQuote,
  parseGoBool,
  parseGoDuration,
  parseGoFloat,
  parseGoInt,
} from "./gofmt.ts";

/** Sentinel raised when `-h`/`--help` is met while parsing (pflag's ErrHelp). */
export class HelpRequested extends Error {
  constructor() {
    super("pflag: help requested");
    this.name = "HelpRequested";
  }
}

/** A flag parse or value error; `message` is exactly what pflag prints after "Error: ". */
export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

export type FlagType =
  | "bool"
  | "string"
  | "int"
  | "float64"
  | "duration"
  | "stringArray"
  | "stringSlice"
  | "intSlice";

/** The typed value behind a flag. `set` returns an error message (Go's err.Error()) or undefined. */
export interface FlagValue {
  readonly type: FlagType;
  set(raw: string): string | undefined;
  /** Go's Value.String(), used for the "(default ...)" text. */
  text(): string;
  get(): unknown;
}

function csvEscape(field: string): string {
  const needs = field !== "" && (field === "\\." || /[,"\r\n]/.test(field) || /^\s/u.test(field));
  return needs ? `"${field.replaceAll('"', '""')}"` : field;
}

function writeAsCSV(vals: string[]): string {
  return vals.map(csvEscape).join(",");
}

/** encoding/csv for one record. */
function readAsCSV(val: string): string[] | string {
  if (val === "") return [];
  const out: string[] = [];
  let i = 0;
  for (;;) {
    let field = "";
    if (val[i] === '"') {
      i++;
      for (;;) {
        const q = val.indexOf('"', i);
        if (q < 0)
          return `parse error on line 1, column ${val.length + 1}: extraneous or missing " in quoted-field`;
        field += val.slice(i, q);
        if (val[q + 1] === '"') {
          field += '"';
          i = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
      if (i < val.length && val[i] !== ",") {
        return `parse error on line 1, column ${i + 1}: extraneous or missing " in quoted-field`;
      }
    } else {
      const c = val.indexOf(",", i);
      const end = c < 0 ? val.length : c;
      field = val.slice(i, end);
      const bare = field.indexOf('"');
      if (bare >= 0)
        return `parse error on line 1, column ${i + bare + 1}: bare " in non-quoted field`;
      i = end;
    }
    out.push(field);
    if (i >= val.length) return out;
    i++; // the comma
    if (i >= val.length) {
      out.push("");
      return out;
    }
  }
}

class BoolValue implements FlagValue {
  readonly type = "bool";
  constructor(private v: boolean) {}
  set(raw: string): string | undefined {
    const r = parseGoBool(raw);
    if (!r.ok) return r.error;
    this.v = r.value;
    return undefined;
  }
  text(): string {
    return String(this.v);
  }
  get(): boolean {
    return this.v;
  }
}

class StringValue implements FlagValue {
  readonly type = "string";
  constructor(private v: string) {}
  set(raw: string): string | undefined {
    this.v = raw;
    return undefined;
  }
  text(): string {
    return this.v;
  }
  get(): string {
    return this.v;
  }
}

class IntValue implements FlagValue {
  readonly type = "int";
  constructor(private v: number) {}
  set(raw: string): string | undefined {
    const r = parseGoInt(raw);
    if (!r.ok) return r.error;
    this.v = Number(r.value);
    return undefined;
  }
  text(): string {
    return String(this.v);
  }
  get(): number {
    return this.v;
  }
}

class FloatValue implements FlagValue {
  readonly type = "float64";
  constructor(private v: number) {}
  set(raw: string): string | undefined {
    const r = parseGoFloat(raw);
    if (!r.ok) return r.error;
    this.v = r.value;
    return undefined;
  }
  text(): string {
    return String(this.v);
  }
  get(): number {
    return this.v;
  }
}

/** Nanoseconds, like Go's time.Duration. */
class DurationValue implements FlagValue {
  readonly type = "duration";
  constructor(private v: number) {}
  set(raw: string): string | undefined {
    const r = parseGoDuration(raw);
    if (!r.ok) return r.error;
    this.v = r.value;
    return undefined;
  }
  text(): string {
    return formatGoDuration(this.v);
  }
  get(): number {
    return this.v;
  }
}

class StringArrayValue implements FlagValue {
  readonly type = "stringArray";
  private changed = false;
  constructor(private v: string[]) {}
  set(raw: string): string | undefined {
    if (!this.changed) this.v = [raw];
    else this.v = [...this.v, raw];
    this.changed = true;
    return undefined;
  }
  text(): string {
    return `[${writeAsCSV(this.v)}]`;
  }
  get(): string[] {
    return this.v;
  }
}

class StringSliceValue implements FlagValue {
  readonly type = "stringSlice";
  private changed = false;
  constructor(private v: string[]) {}
  set(raw: string): string | undefined {
    const parsed = readAsCSV(raw);
    if (typeof parsed === "string") return parsed;
    this.v = this.changed ? [...this.v, ...parsed] : parsed;
    this.changed = true;
    return undefined;
  }
  text(): string {
    return `[${writeAsCSV(this.v)}]`;
  }
  get(): string[] {
    return this.v;
  }
}

class IntSliceValue implements FlagValue {
  readonly type = "intSlice";
  private changed = false;
  constructor(private v: number[]) {}
  set(raw: string): string | undefined {
    const out: number[] = [];
    for (const part of raw.split(",")) {
      const r = parseGoInt(part, 10, "Atoi");
      if (!r.ok) return r.error;
      out.push(Number(r.value));
    }
    this.v = this.changed ? [...this.v, ...out] : out;
    this.changed = true;
    return undefined;
  }
  text(): string {
    return `[${this.v.join(",")}]`;
  }
  get(): number[] {
    return this.v;
  }
}

export interface Flag {
  name: string;
  shorthand: string;
  usage: string;
  value: FlagValue;
  defValue: string;
  changed: boolean;
  /** Value used when the flag is given without one (`--flag`), as pflag's NoOptDefVal. */
  noOptDefVal: string;
  hidden: boolean;
  deprecated: string;
  shorthandDeprecated: string;
  annotations: Record<string, string[]>;
}

/** Build a flag of `type`. `def` must match the type (a bool for "bool", a string[] for slices...). */
export function newValue(type: FlagType, def?: unknown): FlagValue {
  switch (type) {
    case "bool":
      return new BoolValue(def === true);
    case "string":
      return new StringValue(typeof def === "string" ? def : "");
    case "int":
      return new IntValue(typeof def === "number" ? def : 0);
    case "float64":
      return new FloatValue(typeof def === "number" ? def : 0);
    case "duration":
      return new DurationValue(typeof def === "number" ? def : 0);
    case "stringArray":
      return new StringArrayValue(Array.isArray(def) ? (def as string[]) : []);
    case "stringSlice":
      return new StringSliceValue(Array.isArray(def) ? (def as string[]) : []);
    case "intSlice":
      return new IntSliceValue(Array.isArray(def) ? (def as number[]) : []);
  }
}

export function newFlag(
  name: string,
  shorthand: string,
  usage: string,
  type: FlagType,
  def?: unknown,
): Flag {
  const value = newValue(type, def);
  return {
    name,
    shorthand,
    usage,
    value,
    defValue: value.text(),
    changed: false,
    noOptDefVal: type === "bool" ? "true" : "",
    hidden: false,
    deprecated: "",
    shorthandDeprecated: "",
    annotations: {},
  };
}

function defaultIsZeroValue(f: Flag): boolean {
  switch (f.value.type) {
    case "bool":
      return f.defValue === "false" || f.defValue === "";
    case "duration":
      return f.defValue === "0" || f.defValue === "0s";
    case "int":
    case "float64":
      return f.defValue === "0";
    case "string":
      return f.defValue === "";
    case "intSlice":
    case "stringSlice":
    case "stringArray":
      return f.defValue === "[]";
  }
}

/** pflag.UnquoteUsage: a back-quoted word in the usage names the value, else the type does. */
function unquoteUsage(f: Flag): [name: string, usage: string] {
  const usage = f.usage;
  const i = usage.indexOf("`");
  if (i >= 0) {
    const j = usage.indexOf("`", i + 1);
    if (j >= 0) {
      const name = usage.slice(i + 1, j);
      return [name, usage.slice(0, i) + name + usage.slice(j + 1)];
    }
  }
  switch (f.value.type) {
    case "bool":
      return ["", usage];
    case "float64":
      return ["float", usage];
    case "stringSlice":
      return ["strings", usage];
    case "intSlice":
      return ["ints", usage];
    default:
      return [f.value.type, usage];
  }
}

function wrapN(i: number, slop: number, s: string): [string, string] {
  if (i + slop > s.length) return [s, ""];
  const head = s.slice(0, i);
  const w = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\t"), head.lastIndexOf("\n"));
  if (w <= 0) return [s, ""];
  const nl = head.lastIndexOf("\n");
  if (nl > 0 && nl < w) return [s.slice(0, nl), s.slice(nl + 1)];
  return [s.slice(0, w), s.slice(w + 1)];
}

function wrap(indent: number, width: number, s: string): string {
  if (width === 0) return s.replaceAll("\n", `\n${" ".repeat(indent)}`);
  let i = indent;
  let room = width - i;
  let r = "";
  if (room < 24) {
    i = 16;
    room = width - i;
    r += `\n${" ".repeat(i)}`;
  }
  if (room < 24) return s.replaceAll("\n", r);
  const slop = 5;
  room -= slop;
  let [l, rest] = wrapN(room, slop, s);
  r += l.replaceAll("\n", `\n${" ".repeat(i)}`);
  while (rest !== "") {
    let t: string;
    [t, rest] = wrapN(room, slop, rest);
    r += `\n${" ".repeat(i)}${t.replaceAll("\n", `\n${" ".repeat(i)}`)}`;
  }
  return r;
}

export class FlagSet {
  sortFlags = true;
  private formal = new Map<string, Flag>();
  private ordered: Flag[] = [];
  private shorthands = new Map<string, Flag>();
  private argsList: string[] = [];
  private dashAt = -1;
  /** Notices pflag writes to the flag set's output (deprecation warnings). */
  readonly notices: string[] = [];

  constructor(readonly name: string) {}

  lookup(name: string): Flag | undefined {
    return this.formal.get(name);
  }

  shorthandLookup(name: string): Flag | undefined {
    if (name.length === 0) return undefined;
    if (name.length > 1) {
      throw new Error(
        `can not look up shorthand which is more than one ASCII character: ${goQuote(name)}`,
      );
    }
    return this.shorthands.get(name);
  }

  hasFlags(): boolean {
    return this.formal.size > 0;
  }

  hasAvailableFlags(): boolean {
    for (const f of this.formal.values()) if (!f.hidden) return true;
    return false;
  }

  addFlag(flag: Flag): void {
    if (this.formal.has(flag.name)) {
      throw new Error(`${this.name} flag redefined: ${flag.name}`);
    }
    this.formal.set(flag.name, flag);
    this.ordered.push(flag);
    if (flag.shorthand === "") return;
    if (flag.shorthand.length > 1) {
      throw new Error(`${goQuote(flag.shorthand)} shorthand is more than one ASCII character`);
    }
    const used = this.shorthands.get(flag.shorthand);
    if (used) {
      throw new Error(
        `unable to redefine ${goQuote(flag.shorthand)} shorthand in ${goQuote(this.name)} flagset: it's already used for ${goQuote(used.name)} flag`,
      );
    }
    this.shorthands.set(flag.shorthand, flag);
  }

  /** Adds every flag of `other` this set does not already have by name. */
  addFlagSet(other: FlagSet | undefined): void {
    if (!other) return;
    other.visitAll((f) => {
      if (!this.lookup(f.name)) this.addFlag(f);
    });
  }

  visitAll(fn: (f: Flag) => void): void {
    const list = this.sortFlags
      ? [...this.ordered].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      : this.ordered;
    for (const f of list) fn(f);
  }

  /** Positional arguments left after parsing. */
  args(): string[] {
    return this.argsList;
  }

  argsLenAtDash(): number {
    return this.dashAt;
  }

  changed(name: string): boolean {
    return this.lookup(name)?.changed ?? false;
  }

  set(name: string, raw: string): void {
    const flag = this.formal.get(name);
    if (!flag) throw new FlagError(`no such flag -${name}`);
    const err = flag.value.set(raw);
    if (err !== undefined) {
      const flagName =
        flag.shorthand !== "" && flag.shorthandDeprecated === ""
          ? `-${flag.shorthand}, --${flag.name}`
          : `--${flag.name}`;
      throw new FlagError(`invalid argument ${goQuote(raw)} for ${goQuote(flagName)} flag: ${err}`);
    }
    flag.changed = true;
    if (flag.deprecated !== "") {
      this.notices.push(`Flag --${flag.name} has been deprecated, ${flag.deprecated}\n`);
    }
  }

  // --- typed definition helpers (cobra's Flags().String(...) family) ---------------------------

  define(type: FlagType, name: string, shorthand: string, usage: string, def?: unknown): Flag {
    const f = newFlag(name, shorthand, usage, type, def);
    this.addFlag(f);
    return f;
  }

  // --- parsing ---------------------------------------------------------------------------------

  /** pflag FlagSet.Parse. Throws FlagError / HelpRequested. */
  parse(argv: string[]): void {
    this.argsList = [];
    this.dashAt = -1;
    if (argv.length === 0) return;
    this.parseArgs(argv);
  }

  private parseArgs(input: string[]): void {
    let args = input;
    while (args.length > 0) {
      const s = args[0] ?? "";
      args = args.slice(1);
      if (s.length === 0 || s[0] !== "-" || s.length === 1) {
        this.argsList.push(s);
        continue;
      }
      if (s[1] === "-") {
        if (s.length === 2) {
          this.dashAt = this.argsList.length;
          this.argsList.push(...args);
          break;
        }
        args = this.parseLongArg(s, args);
      } else {
        args = this.parseShortArg(s, args);
      }
    }
  }

  private parseLongArg(s: string, args: string[]): string[] {
    let a = args;
    const full = s.slice(2);
    if (full.length === 0 || full[0] === "-" || full[0] === "=") {
      throw new FlagError(`bad flag syntax: ${s}`);
    }
    const eq = full.indexOf("=");
    const name = eq >= 0 ? full.slice(0, eq) : full;
    const flag = this.formal.get(name);
    if (!flag) {
      if (name === "help") throw new HelpRequested();
      throw new FlagError(`unknown flag: --${name}`);
    }
    let value: string;
    if (eq >= 0) {
      value = full.slice(eq + 1);
    } else if (flag.noOptDefVal !== "") {
      value = flag.noOptDefVal;
    } else if (a.length > 0) {
      value = a[0] ?? "";
      a = a.slice(1);
    } else {
      throw new FlagError(`flag needs an argument: --${name}`);
    }
    this.set(flag.name, value);
    return a;
  }

  private parseSingleShortArg(
    shorthands: string,
    args: string[],
  ): { shorts: string; args: string[] } {
    // pflag skips go test's -test.* flags rather than treating them as shorthands.
    if (shorthands.startsWith("test.")) return { shorts: "", args };
    let shorts = shorthands.slice(1);
    let outArgs = args;
    const c = shorthands[0] ?? "";
    const flag = this.shorthands.get(c);
    if (!flag) {
      if (c === "h") throw new HelpRequested();
      throw new FlagError(`unknown shorthand flag: ${goQuoteRune(c)} in -${shorthands}`);
    }
    let value: string;
    if (shorthands.length > 2 && shorthands[1] === "=") {
      value = shorthands.slice(2);
      shorts = "";
    } else if (flag.noOptDefVal !== "") {
      value = flag.noOptDefVal;
    } else if (shorthands.length > 1) {
      value = shorthands.slice(1);
      shorts = "";
    } else if (args.length > 0) {
      value = args[0] ?? "";
      outArgs = args.slice(1);
    } else {
      throw new FlagError(`flag needs an argument: ${goQuoteRune(c)} in -${shorthands}`);
    }
    if (flag.shorthandDeprecated !== "") {
      this.notices.push(
        `Flag shorthand -${flag.shorthand} has been deprecated, ${flag.shorthandDeprecated}\n`,
      );
    }
    this.set(flag.name, value);
    return { shorts, args: outArgs };
  }

  private parseShortArg(s: string, args: string[]): string[] {
    let a = args;
    let shorthands = s.slice(1);
    while (shorthands.length > 0) {
      // pflag feeds the *original* args to every iteration, not the remainder; keep that quirk.
      const r = this.parseSingleShortArg(shorthands, args);
      shorthands = r.shorts;
      a = r.args;
    }
    return a;
  }

  // --- usage -----------------------------------------------------------------------------------

  /** pflag FlagUsagesWrapped; cols 0 means no wrapping. */
  flagUsagesWrapped(cols: number): string {
    const lines: string[] = [];
    let maxlen = 0;
    this.visitAll((flag) => {
      if (flag.hidden) return;
      let line =
        flag.shorthand !== "" && flag.shorthandDeprecated === ""
          ? `  -${flag.shorthand}, --${flag.name}`
          : `      --${flag.name}`;
      const [varname, usage] = unquoteUsage(flag);
      if (varname !== "") line += ` ${varname}`;
      if (flag.noOptDefVal !== "") {
        switch (flag.value.type) {
          case "string":
            line += `[="${flag.noOptDefVal}"]`;
            break;
          case "bool":
            if (flag.noOptDefVal !== "true") line += `[=${flag.noOptDefVal}]`;
            break;
          default:
            line += `[=${flag.noOptDefVal}]`;
        }
      }
      line += "\0";
      if (line.length > maxlen) maxlen = line.length;
      line += usage;
      if (!defaultIsZeroValue(flag)) {
        line +=
          flag.value.type === "string"
            ? ` (default ${goQuote(flag.defValue)})`
            : ` (default ${flag.defValue})`;
      }
      if (flag.deprecated.length !== 0) line += ` (DEPRECATED: ${flag.deprecated})`;
      lines.push(line);
    });
    let out = "";
    for (const line of lines) {
      const sidx = line.indexOf("\0");
      const spacing = " ".repeat(maxlen - sidx);
      out += `${line.slice(0, sidx)} ${spacing} ${wrap(maxlen + 2, cols, line.slice(sidx + 1))}\n`;
    }
    return out;
  }

  flagUsages(): string {
    return this.flagUsagesWrapped(0);
  }
}

/** Go's %q for a single rune. */
function goQuoteRune(c: string): string {
  if (c === "'") return "'\\''";
  return `'${goQuote(c).slice(1, -1).replaceAll('\\"', '"')}'`;
}
