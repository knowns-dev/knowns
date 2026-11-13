// Read and write the JSON config files the setup writers touch, the way Go does: a missing file is
// an empty object, keys come out sorted (Go marshals map[string]any), two-space indent, and the
// HTML characters <, > and & are escaped as < etc.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { goJsonStringify, sortKeysDeep } from "../../storage/core/util.ts";

export type JsonMap = Record<string, unknown>;

export function isMap(v: unknown): v is JsonMap {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The text of a file, or "" when it does not exist (readTextIfExists). */
export function readTextIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/**
 * Read a JSON object. `missing` says what an absent file means: an empty object. A blank file is
 * also an empty object (readJSONMap); anything that is not a JSON object is an error.
 */
export function readJsonMap(path: string): JsonMap {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (text.trim() === "") return {};
  const value: unknown = JSON.parse(text);
  if (value === null) return {};
  if (!isMap(value)) {
    throw new Error("json: cannot unmarshal into Go value of type map[string]interface {}");
  }
  return value;
}

/** json.MarshalIndent(value, "", "  ") of a map (sorted keys). */
export function marshalMap(value: unknown): string {
  return goJsonStringify(sortKeysDeep(value));
}

/** os.WriteFile(path, data, 0644) after creating the parent directory. */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, text, { mode: 0o644 });
}

/** writeJSONMap: indented JSON plus a trailing newline. */
export function writeJsonMap(path: string, value: unknown): void {
  writeText(path, `${marshalMap(value)}\n`);
}
