// Helpers shared by the route modules.
import { sortKeysDeep } from "../../storage/core/util.ts";
import { decodeStruct, type FieldType, GoJsonError } from "../gojson.ts";
import { type Ctx, decodeBody, respondError } from "../http.ts";

export { sortKeysDeep };

export type Obj = Record<string, unknown>;

/** Go map[string]X marshals with keys sorted at every level. */
export const goMap = <T>(v: T): T => sortKeysDeep(v) as T;

/**
 * decodeJSON into a typed struct, answering 400 "<prefix><go error>" like the handlers do.
 * `prefix` is "invalid request body: " for most routes.
 */
export async function readStruct(
  c: Ctx,
  struct: string,
  fields: Record<string, FieldType>,
  prefix = "invalid request body: ",
): Promise<{ ok: true; v: Obj; raw: unknown } | { ok: false; res: Response }> {
  const body = await decodeBody(c);
  if (!body.ok) return { ok: false, res: respondError(400, prefix + body.error) };
  try {
    return { ok: true, v: decodeStruct(body.value, struct, fields), raw: body.value };
  } catch (e) {
    if (e instanceof GoJsonError) return { ok: false, res: respondError(400, prefix + e.message) };
    throw e;
  }
}

/** Reads a JSON object body as a map[string]json.RawMessage (any object; null is an empty map). */
export async function readMap(
  c: Ctx,
  prefix = "invalid request body: ",
): Promise<{ ok: true; v: Obj } | { ok: false; res: Response }> {
  const body = await decodeBody(c);
  if (!body.ok) return { ok: false, res: respondError(400, prefix + body.error) };
  const v = body.value;
  if (v === null) return { ok: true, v: {} };
  if (typeof v !== "object" || Array.isArray(v)) {
    const kind = Array.isArray(v)
      ? "array"
      : typeof v === "object"
        ? "object"
        : typeof v === "boolean"
          ? "bool"
          : typeof v;
    return {
      ok: false,
      res: respondError(
        400,
        `${prefix}json: cannot unmarshal ${kind} into Go value of type map[string]json.RawMessage`,
      ),
    };
  }
  return { ok: true, v: v as Obj };
}

/** Go's Atoi: base-10 integer with optional sign, nothing else. */
export function atoi(s: string): number | undefined {
  return /^[+-]?\d+$/.test(s) ? Number(s) : undefined;
}

export function firstNonEmpty(...vals: string[]): string {
  for (const v of vals) if (v !== "") return v;
  return "";
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A Go map[string]X: top-level keys sorted by bytes, values untouched. */
export function goTop(o: Obj): Obj {
  const out: Obj = {};
  for (const k of Object.keys(o).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    out[k] = o[k];
  }
  return out;
}
