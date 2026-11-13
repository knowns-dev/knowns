// The slice of mcp-go (v0.44.1) the Knowns tools use: mcp.NewTool and its property options,
// CallToolRequest accessors, CallToolResult constructors and the handler types.
import type { Args } from "./gojson.ts";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** Declared property names, in declaration order. */
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  annotations: ToolAnnotations;
}

/** One property of a tool schema (mcp.WithString / WithArray / ...). */
export interface Prop {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  enum?: readonly string[];
  /** Array items: "string" or "number". */
  items?: "string" | "number";
  /** Enum on string array items (mcp.WithStringEnumItems). */
  itemsEnum?: readonly string[];
}

export const str = (name: string, description: string, o: Partial<Prop> = {}): Prop => ({
  name,
  type: "string",
  description,
  ...o,
});
export const num = (name: string, description: string, o: Partial<Prop> = {}): Prop => ({
  name,
  type: "number",
  description,
  ...o,
});
export const bool = (name: string, description: string, o: Partial<Prop> = {}): Prop => ({
  name,
  type: "boolean",
  description,
  ...o,
});
export const strArr = (name: string, description: string, o: Partial<Prop> = {}): Prop => ({
  name,
  type: "array",
  description,
  items: "string",
  ...o,
});
export const numArr = (name: string, description: string, o: Partial<Prop> = {}): Prop => ({
  name,
  type: "array",
  description,
  items: "number",
  ...o,
});
export const obj = (name: string, description: string, o: Partial<Prop> = {}): Prop => ({
  name,
  type: "object",
  description,
  ...o,
});

/** mcp.NewTool(name, WithDescription(d), props...). */
export function newTool(name: string, description: string, props: readonly Prop[]): Tool {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const p of props) {
    const schema: Record<string, unknown> = { type: p.type };
    if (p.type === "object") schema.properties = {};
    if (p.description !== undefined) schema.description = p.description;
    if (p.enum) schema.enum = [...p.enum];
    if (p.items) {
      schema.items = p.itemsEnum ? { type: p.items, enum: [...p.itemsEnum] } : { type: p.items };
    }
    if (p.required) required.push(p.name);
    properties[p.name] = schema;
  }
  return {
    name,
    description,
    properties,
    required,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

// --- results ----------------------------------------------------------------------------------

export interface CallToolResult {
  text: string;
  isError: boolean;
}

export const textResult = (text: string): CallToolResult => ({ text, isError: false });
export const errorResult = (text: string): CallToolResult => ({ text, isError: true });

/** A tool handler's request: the decoded `arguments` object (nil when it is not an object). */
export interface CallToolRequest {
  name: string;
  /** GetArguments(): the arguments map, or undefined when `arguments` is absent or not an object. */
  args: Args | undefined;
  /** The JSON-RPC request id, as the audit hook keys it. */
  id: unknown;
}

export type ToolContext = { signal?: AbortSignal };
export type ToolHandler = (ctx: ToolContext, req: CallToolRequest) => Promise<CallToolResult>;

/** req.GetArguments(), never undefined. */
export const argsOf = (req: CallToolRequest): Args => req.args ?? {};

/** req.RequireString(key). */
export function requireString(
  req: CallToolRequest,
  key: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const a = req.args;
  if (a && Object.hasOwn(a, key)) {
    const v = a[key];
    if (typeof v === "string") return { ok: true, value: v };
    return { ok: false, error: `argument "${key}" is not a string` };
  }
  return { ok: false, error: `required argument "${key}" not found` };
}
