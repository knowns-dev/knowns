// A hand port of the part of mcp-go v0.44.1 that Knowns uses (server.MCPServer, ServeStdio and the
// request handler): JSON-RPC 2.0 over newline-delimited stdio, initialize / ping / tools / resources,
// the Go error codes and texts, sorted tool listing, a 5-wide tool-call pool, panic recovery and the
// before/after tool-call hooks. Byte parity of the wire matters, so this is not the TS SDK.
import { type Args, marshal, sortKeysDeep } from "./gojson.ts";
import type { CallToolRequest, CallToolResult, Tool, ToolContext, ToolHandler } from "./tool.ts";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const RESOURCE_NOT_FOUND = -32002;

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
const VALID_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"];
const TOOL_WORKERS = 5;

type JsonValue = unknown;
type Response = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: unknown };

export interface ServerOptions {
  name: string;
  version: string;
  instructions: string;
  /** The permission guard middleware: a result to return instead of running the handler. */
  guard?: (req: CallToolRequest) => CallToolResult | undefined;
  /** Awaited before a tool call starts (project detection runs in the background). */
  ready?: () => Promise<void>;
  /** Called with the handshake's clientInfo (name is the client, e.g. "claude-code"). */
  onInitialize?: (info: { name: string; version?: string; title?: string } | undefined) => void;
  hooks?: {
    beforeCallTool?: (id: unknown, req: CallToolRequest) => void;
    afterCallTool?: (
      id: unknown,
      req: CallToolRequest,
      result: CallToolResult,
    ) => void | Promise<void>;
  };
}

interface Registered {
  tool: Tool;
  handler: ToolHandler;
}

class RequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Go's JSON type word for the "cannot unmarshal X into" text. */
function jsonKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "bool";
    default:
      return "object";
  }
}

const unparsable = (method: string, detail: string): RequestError =>
  new RequestError(INVALID_REQUEST, `unparsable ${method} request: json: ${detail}`);
const cannot = (v: unknown, field: string, goType: string): string =>
  `cannot unmarshal ${jsonKind(v)} into Go struct field ${field} of type ${goType}`;

const PAGINATED = {
  "tools/list": "ListToolsRequest.PaginatedRequest.params",
  "resources/list": "ListResourcesRequest.PaginatedRequest.params",
  "resources/templates/list": "ListResourceTemplatesRequest.PaginatedRequest.params",
} as const;

/** Validate the params shape the way json.Unmarshal into the mcp request structs would. */
function checkParams(method: string, params: unknown): RequestError | undefined {
  if (params === undefined || params === null) return undefined;
  switch (method) {
    case "ping":
      if (!isObject(params))
        return unparsable(
          method,
          cannot(params, "PingRequest.Request.params", "mcp.RequestParams"),
        );
      if (params._meta !== undefined && params._meta !== null && !isObject(params._meta))
        return unparsable(
          method,
          cannot(params._meta, "RequestParams.Request.params._meta", "map[string]interface {}"),
        );
      return undefined;
    case "tools/list":
    case "resources/list":
    case "resources/templates/list": {
      if (!isObject(params))
        return unparsable(method, cannot(params, PAGINATED[method], "mcp.PaginatedParams"));
      if (
        params.cursor !== undefined &&
        params.cursor !== null &&
        typeof params.cursor !== "string"
      )
        return unparsable(
          method,
          cannot(params.cursor, "PaginatedParams.PaginatedRequest.params.cursor", "mcp.Cursor"),
        );
      return undefined;
    }
    case "initialize": {
      if (!isObject(params))
        return unparsable(
          method,
          cannot(params, "InitializeRequest.params", "mcp.InitializeParams"),
        );
      const pv = params.protocolVersion;
      if (pv !== undefined && pv !== null && typeof pv !== "string")
        return unparsable(method, cannot(pv, "InitializeParams.params.protocolVersion", "string"));
      const caps = params.capabilities;
      if (caps !== undefined && caps !== null && !isObject(caps))
        return unparsable(
          method,
          cannot(caps, "InitializeParams.params.capabilities", "mcp.ClientCapabilities"),
        );
      const ci = params.clientInfo;
      if (ci !== undefined && ci !== null) {
        if (!isObject(ci))
          return unparsable(
            method,
            cannot(ci, "InitializeParams.params.clientInfo", "mcp.Implementation"),
          );
        for (const f of ["name", "version", "title"] as const) {
          const x = ci[f];
          if (x !== undefined && x !== null && typeof x !== "string")
            return unparsable(method, cannot(x, `Implementation.params.clientInfo.${f}`, "string"));
        }
      }
      return undefined;
    }
    case "tools/call": {
      if (!isObject(params))
        return unparsable(method, cannot(params, "CallToolRequest.params", "mcp.CallToolParams"));
      const name = params.name;
      if (name !== undefined && name !== null && typeof name !== "string")
        return unparsable(method, cannot(name, "CallToolParams.params.name", "string"));
      const meta = params._meta;
      if (meta !== undefined && meta !== null && !isObject(meta))
        return unparsable(
          method,
          cannot(meta, "CallToolParams.params._meta", "map[string]interface {}"),
        );
      return undefined;
    }
    case "resources/read": {
      if (!isObject(params))
        return unparsable(
          method,
          cannot(params, "ReadResourceRequest.params", "mcp.ReadResourceParams"),
        );
      const uri = params.uri;
      if (uri !== undefined && uri !== null && typeof uri !== "string")
        return unparsable(method, cannot(uri, "ReadResourceParams.params.uri", "string"));
      return undefined;
    }
    default:
      return undefined;
  }
}

/** base64.StdEncoding.DecodeString: the decoded string, or Go's error text. */
function decodeCursor(cursor: string): { value: string } | { error: string } {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const s = cursor.replace(/[\r\n]/g, "");
  let pad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "=") {
      pad++;
      continue;
    }
    if (pad > 0 || !alphabet.includes(c))
      return { error: `illegal base64 data at input byte ${i}` };
  }
  if ((s.length - pad) % 4 === 1 || s.length % 4 !== 0 || pad > 2)
    return { error: `illegal base64 data at input byte ${s.length}` };
  return { value: Buffer.from(s, "base64").toString("utf8") };
}

export class McpServer {
  private readonly tools = new Map<string, Registered>();
  constructor(private readonly opts: ServerOptions) {}

  addTool(tool: Tool, handler: ToolHandler): void {
    this.tools.set(tool.name, { tool, handler });
  }

  /** The tool definitions in tools/list order: sorted by name (Go sort.Strings). */
  listTools(): Tool[] {
    return [...this.tools.values()].map((r) => r.tool).sort((a, b) => cmp(a.name, b.name));
  }

  // --- wire ------------------------------------------------------------------------------------

  /** mcp.Tool.MarshalJSON: a map (sorted keys) plus the fixed-order annotations struct. */
  static toolJson(tool: Tool): unknown {
    return {
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
      description: tool.description,
      inputSchema: sortKeysDeep({
        type: "object",
        properties: tool.properties,
        required: tool.required,
      }),
      name: tool.name,
    };
  }

  private ok(id: unknown, result: unknown): Response {
    return { jsonrpc: "2.0", id, result };
  }

  private fail(id: unknown, code: number, message: string): Response {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  /**
   * HandleMessage for one decoded line. Returns the response, or undefined for a notification.
   * `raw` is the parsed JSON value.
   */
  async handle(raw: JsonValue): Promise<Response | undefined> {
    let base: { jsonrpc: string; method: string; id: unknown; result: unknown };
    if (raw === null) {
      base = { jsonrpc: "", method: "", id: undefined, result: undefined };
    } else if (!isObject(raw)) {
      return this.fail(null, PARSE_ERROR, "Failed to parse message");
    } else {
      const j = raw.jsonrpc;
      const m = raw.method;
      if (
        (j !== undefined && j !== null && typeof j !== "string") ||
        (m !== undefined && m !== null && typeof m !== "string")
      ) {
        return this.fail(null, PARSE_ERROR, "Failed to parse message");
      }
      base = {
        jsonrpc: (j as string | undefined | null) ?? "",
        method: (m as string | undefined | null) ?? "",
        id: raw.id,
        result: raw.result,
      };
    }
    const hasId = base.id !== undefined && base.id !== null;
    const idOut = hasId ? base.id : null;
    if (base.jsonrpc !== "2.0")
      return this.fail(idOut, INVALID_REQUEST, "Invalid JSON-RPC version");
    if (!hasId) {
      const p = isObject(raw) ? raw.params : undefined;
      if (p !== undefined && p !== null && !isObject(p))
        return this.fail(null, PARSE_ERROR, "Failed to parse notification");
      return undefined;
    }
    if (base.result !== undefined && base.result !== null) return undefined;

    const method = base.method;
    const params = (raw as Record<string, unknown>).params;
    const id = base.id;
    try {
      switch (method) {
        case "initialize": {
          this.throwIf(checkParams(method, params));
          return this.ok(id, this.initialize(isObject(params) ? params : {}));
        }
        case "ping":
          this.throwIf(checkParams(method, params));
          return this.ok(id, {});
        case "logging/setLevel":
          throw new RequestError(METHOD_NOT_FOUND, "logging not supported");
        case "resources/list":
          this.throwIf(checkParams(method, params));
          return this.ok(id, { resources: [] });
        case "resources/templates/list":
          this.throwIf(checkParams(method, params));
          return this.ok(id, { resourceTemplates: [] });
        case "resources/read": {
          this.throwIf(checkParams(method, params));
          const uri = isObject(params) && typeof params.uri === "string" ? params.uri : "";
          throw new RequestError(
            RESOURCE_NOT_FOUND,
            `handler not found for resource URI '${uri}': resource not found`,
          );
        }
        case "prompts/list":
        case "prompts/get":
          throw new RequestError(METHOD_NOT_FOUND, "prompts not supported");
        case "tools/list": {
          this.throwIf(checkParams(method, params));
          const cursor = isObject(params) && typeof params.cursor === "string" ? params.cursor : "";
          return this.ok(id, this.toolsList(cursor));
        }
        case "tools/call": {
          this.throwIf(checkParams(method, params));
          return await this.callTool(id, isObject(params) ? params : {});
        }
        case "tasks/get":
        case "tasks/list":
        case "tasks/result":
        case "tasks/cancel":
          throw new RequestError(METHOD_NOT_FOUND, "tasks not supported");
        case "completion/complete":
          throw new RequestError(METHOD_NOT_FOUND, "completions not supported");
        default:
          return this.fail(id, METHOD_NOT_FOUND, `Method ${method} not found`);
      }
    } catch (e) {
      if (e instanceof RequestError) return this.fail(id, e.code, e.message);
      throw e;
    }
  }

  private throwIf(e: RequestError | undefined): void {
    if (e) throw e;
  }

  private initialize(params: Record<string, unknown>): unknown {
    const ci = params.clientInfo;
    if (isObject(ci) && typeof ci.name === "string") {
      this.opts.onInitialize?.({
        name: ci.name,
        ...(typeof ci.version === "string" ? { version: ci.version } : {}),
        ...(typeof ci.title === "string" ? { title: ci.title } : {}),
      });
    } else this.opts.onInitialize?.(undefined);
    let client = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    if (client.length === 0) client = "2025-03-26";
    const protocolVersion = VALID_PROTOCOL_VERSIONS.includes(client)
      ? client
      : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { resources: {}, tools: {} },
      serverInfo: { name: this.opts.name, version: this.opts.version },
      instructions: this.opts.instructions,
    };
  }

  private toolsList(cursor: string): unknown {
    const tools = this.listTools();
    let start = 0;
    if (cursor !== "") {
      const decoded = decodeCursor(cursor);
      if ("error" in decoded) throw new RequestError(INVALID_PARAMS, decoded.error);
      const after = decoded.value;
      start = tools.findIndex((t) => cmp(t.name, after) > 0);
      if (start < 0) start = tools.length;
    }
    return { tools: tools.slice(start).map((t) => McpServer.toolJson(t)) };
  }

  private async callTool(id: unknown, params: Record<string, unknown>): Promise<Response> {
    const name = typeof params.name === "string" ? params.name : "";
    const rawArgs = params.arguments;
    const args: Args | undefined = isObject(rawArgs) ? rawArgs : undefined;
    const req: CallToolRequest = { name, args, id };
    await this.opts.ready?.();
    this.opts.hooks?.beforeCallTool?.(id, req);
    const entry = this.tools.get(name);
    if (!entry) {
      return this.fail(id, INVALID_PARAMS, `tool '${name}' not found: tool not found`);
    }
    const ctx: ToolContext = {};
    let result: CallToolResult;
    try {
      const denied = this.opts.guard?.(req);
      result = denied ?? (await entry.handler(ctx, req));
    } catch (e) {
      // WithRecovery: a panic in a handler becomes an INTERNAL_ERROR response.
      const msg = e instanceof Error ? e.message : String(e);
      return this.fail(id, INTERNAL_ERROR, `panic recovered in ${name} tool handler: ${msg}`);
    }
    await this.opts.hooks?.afterCallTool?.(id, req, result);
    const out: Record<string, unknown> = { content: [{ type: "text", text: result.text }] };
    if (result.isError) out.isError = true;
    return this.ok(id, out);
  }

  // --- stdio -----------------------------------------------------------------------------------

  /**
   * ServeStdio over the given streams. Resolves when input ends (EOF) after the in-flight tool
   * calls finished. A final line without a trailing newline is dropped, as ReadString + io.EOF
   * does in mcp-go.
   */
  async serve(
    input: AsyncIterable<Uint8Array>,
    write: (text: string) => void,
    onError?: (msg: string) => void,
  ): Promise<void> {
    const out = (r: Response): void => {
      try {
        write(`${marshal(r)}\n`);
      } catch (e) {
        onError?.(`Error writing response: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const inflight = new Set<Promise<void>>();
    const queue: Array<() => Promise<void>> = [];
    let running = 0;
    const track = (p: Promise<void>): void => {
      const q: Promise<void> = p.catch(() => undefined).finally(() => inflight.delete(q));
      inflight.add(q);
    };
    const pump = (): void => {
      while (running < TOOL_WORKERS && queue.length > 0) {
        const job = queue.shift() as () => Promise<void>;
        running++;
        track(
          job().finally(() => {
            running--;
            pump();
          }),
        );
      }
    };

    const process1 = (line: string): void => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        out({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        return;
      }
      const run = async (): Promise<void> => {
        let res: Response | undefined;
        try {
          res = await this.handle(raw);
        } catch (e) {
          // Tool panics are recovered inside handle (WithRecovery); anything else that escapes
          // (a lifecycle hook, readiness) must still answer the request, or the client waits on
          // its id forever.
          const id = isObject(raw) ? raw.id : undefined;
          if (id === undefined || id === null) return;
          const msg = e instanceof Error ? e.message : String(e);
          res = { jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: msg } } as Response;
        }
        if (res) out(res);
      };
      if (isObject(raw) && raw.method === "tools/call") {
        queue.push(run);
        pump();
      } else {
        track(run());
      }
    };

    const decoder = new TextDecoder();
    let buf = Buffer.alloc(0);
    for await (const chunk of input) {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a)) {
        const line = decoder.decode(buf.subarray(0, nl + 1));
        buf = buf.subarray(nl + 1);
        process1(line);
        // Non-tool messages complete before the next line is read.
        await Promise.resolve();
      }
    }
    while (inflight.size > 0 || queue.length > 0) {
      await Promise.all([...inflight]);
    }
  }
}

const enc = new TextEncoder();
function cmp(a: string, b: string): number {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
