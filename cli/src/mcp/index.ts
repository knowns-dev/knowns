// internal/mcp/server.go: NewMCPServer and Start. Tool definitions are light (defs.ts); handler
// modules load on the first call of their tool so `initialize` and `tools/list` stay fast.
import { auditEventFor, type PendingCall } from "./audit.ts";
import {
  codeTool,
  decisionTool,
  docsTool,
  helpTool,
  initialTool,
  memoryTool,
  projectTool,
  searchTool,
  tasksTool,
  templatesTool,
  timeTool,
  validateTool,
  WRAPPED_TOOLS,
} from "./defs.ts";
import { McpLogger } from "./log.ts";
import { guard } from "./permissions.ts";
import { McpServer } from "./server.ts";
import { McpState } from "./state.ts";
import {
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  type Tool,
  type ToolContext,
  type ToolHandler,
} from "./tool.ts";

export const MCP_VERSION = "0.1.0";
const INSTRUCTIONS =
  "CRITICAL: Call the `initial` tool at the start of every session before performing any work to receive operating instructions.";

type HandlerModule = {
  handle: (state: McpState, ctx: ToolContext, req: CallToolRequest) => Promise<CallToolResult>;
};

/** RejectUnknownArguments: a parameter the tool's schema does not declare fails the call. */
function rejectUnknown(tool: Tool, handler: ToolHandler): ToolHandler {
  return async (ctx, req) => {
    const unknown: string[] = [];
    for (const key of Object.keys(req.args ?? {})) {
      if (!Object.hasOwn(tool.properties, key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      unknown.sort(compareStrings);
      return errorResult(
        `${tool.name} does not accept ${unknown.join(", ")}; call help("${tool.name}.*") for the parameters it takes`,
      );
    }
    return handler(ctx, req);
  };
}

const compareStrings = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

export interface McpApp {
  server: McpServer;
  state: McpState;
  /** Resolves once the project (if any) is detected and the runtime lease acquired. */
  /** Starts project detection (idempotent); resolves once the project and lease are set up. */
  begin: () => Promise<void>;
  /** Stops the lease heartbeat and releases it. */
  cleanup: (reason: string) => void;
}

export function newMcpApp(projectHint: string, log: McpLogger = new McpLogger()): McpApp {
  const state = new McpState(log);
  const pending = new WeakMap<CallToolRequest, PendingCall>();
  let auditStorePromise: Promise<import("../storage/stores/audit-store.ts").AuditStore> | undefined;
  const auditStore = () => {
    auditStorePromise ??= import("../storage/stores/audit-store.ts").then(
      (m) => new m.AuditStore(),
    );
    return auditStorePromise;
  };

  const ac = new AbortController();
  let lease: { release: () => void } | undefined;

  let ready: Promise<void> | undefined;

  const server = new McpServer({
    name: "knowns",
    version: MCP_VERSION,
    instructions: INSTRUCTIONS,
    ready: () => begin(),
    guard: (req) =>
      guard(req, () => {
        const project = state.getProject();
        if (!project) return null;
        try {
          return project.storage.config.load().settings.permissions;
        } catch {
          return null;
        }
      }),
    hooks: {
      beforeCallTool: (_id, req) => {
        const args = req.args ?? {};
        pending.set(req, {
          startedAt: new Date(),
          toolName: req.name,
          action: typeof args.action === "string" ? args.action : "",
        });
      },
      afterCallTool: async (_id, req, result) => {
        const pc = pending.get(req);
        if (!pc) return;
        pending.delete(req);
        if (pc.toolName === "audit") return;
        const event = auditEventFor(pc, req, result, state.getRoot());
        try {
          (await auditStore()).append(event);
        } catch (e) {
          log.printf(`audit: write failed: ${(e as Error).message}`);
        }
      },
    },
  });

  const lazy =
    (load: () => Promise<HandlerModule>): ToolHandler =>
    async (ctx, req) =>
      (await load()).handle(state, ctx, req);

  const add = (tool: Tool, load: () => Promise<HandlerModule>): void => {
    const handler = lazy(load);
    server.addTool(tool, WRAPPED_TOOLS.has(tool.name) ? rejectUnknown(tool, handler) : handler);
  };

  add(initialTool(), () => import("./handlers/initial.ts"));
  add(helpTool(), () => import("./handlers/help.ts"));
  add(projectTool(), () => import("./handlers/project.ts"));
  add(tasksTool(), () => import("./handlers/task.ts"));
  add(docsTool(), () => import("./handlers/doc.ts"));
  add(timeTool(), () => import("./handlers/time.ts"));
  add(searchTool(), () => import("./handlers/search.ts"));
  add(codeTool(), () => import("./handlers/code.ts"));
  add(templatesTool(), () => import("./handlers/template.ts"));
  add(validateTool(), () => import("./handlers/validate.ts"));
  add(memoryTool(), () => import("./handlers/memory.ts"));
  add(decisionTool(), () => import("./handlers/decision.ts"));

  // Project detection loads the storage libraries; it starts after the first response so that
  // `initialize` is not queued behind it (D5 readiness budget).
  const begin = (): Promise<void> => {
    ready ??= (async () => {
      try {
        await autoDetectProject(state, projectHint);
        const project = state.getProject();
        if (project) {
          const { shouldBypassDaemon, acquireConfiguredClient, startHeartbeat } = await import(
            "../runtime/queue.ts"
          );
          if (!shouldBypassDaemon()) {
            try {
              const handle = acquireConfiguredClient("mcp", project.store.root);
              lease = handle;
              startHeartbeat(ac.signal, handle);
            } catch (e) {
              log.printf(`runtime lease unavailable: ${(e as Error).message}`);
            }
          }
        }
      } catch {
        // no project
      }
    })();
    return ready;
  };

  return {
    server,
    state,
    begin,
    cleanup: (reason) => {
      log.printf(`shutdown: ${reason}`);
      ac.abort();
      try {
        lease?.release();
      } catch {
        // ignore
      }
    },
  };
}

/** autoDetectProject: the hint (honouring store links), then a walk up from the working directory. */
async function autoDetectProject(state: McpState, hint: string): Promise<void> {
  const core = await import("../storage/core/index.ts");
  const { goGetwd } = await import("../storage/core/getwd.ts");
  const use = async (loc: ReturnType<typeof core.locateProject>): Promise<void> => {
    const store = new core.Store(loc.knowledgeRoot, loc.projectRoot);
    const { createStorage } = await import("../storage/adapters.ts");
    try {
      createStorage(store).config.load();
    } catch {
      return;
    }
    for (const msg of core.locationWarnings(loc)) state.log.printf(`warn: ${msg}`);
    await state.setProject(store, loc.projectRoot);
  };
  if (hint !== "") {
    try {
      await use(core.locateProjectAt(hint));
      if (state.getProject()) return;
    } catch {
      // fall through to the cwd walk
    }
  }
  let cwd: string;
  try {
    cwd = goGetwd();
  } catch {
    return;
  }
  try {
    await use(core.locateProject(cwd));
  } catch {
    // no project
  }
}
