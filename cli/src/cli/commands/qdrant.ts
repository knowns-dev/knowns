// `knowns qdrant` (internal/cli/qdrant.go): inspect and control the semantic Qdrant runtime.
// install, purge, status, start, stop, logs and cleanup over the managed-runtime manager.

import {
  type QdrantManager,
  type QdrantRuntimeStatus,
  type QdrantStartError,
  SUPPORTED_QDRANT_VERSION,
  statusJson,
} from "../../runtime/qdrant.ts";
import { type MachineEndpoint, resolveVectorStoreForEnv } from "../../runtime/qdrant-endpoint.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { Style } from "../core/plainoutput.ts";
import { setupCommand } from "./qdrant-setup.ts";

type SemanticSettings = import("../../models/config.ts").SemanticSearchSettings;

const BLUE = new Style(false, 34);
const GREEN = new Style(false, 32);
const YELLOW = new Style(false, 33);

/** The manager plus the machine endpoint (D14) that resolution used, when one did. */
type CommandManager = QdrantManager & { machineEndpoint?: MachineEndpoint };

const DOCKER_CONTAINER_NAME = "knowns-qdrant";

/** qdrantManagerForCommand: findStore (none outside a project) then qdrantManagerFromStore. */
async function managerForCommand(ctx: CommandContext): Promise<CommandManager> {
  const { semanticSettingsFor, optionalStorage } = await loadSupport();
  const storage = await optionalStorage(ctx.cwd);
  return semanticSettingsFor(storage, ctx.env);
}

async function loadSupport() {
  const [{ locateProject, Store }, { createStorage }] = await Promise.all([
    import("../../storage/core/index.ts"),
    import("../../storage/adapters.ts"),
  ]);
  const [{ buildSearchEnvironment }, models, rt] = await Promise.all([
    import("../../domain/searchenv/index.ts"),
    import("../../models/config.ts"),
    import("../../runtime/qdrant.ts"),
  ]);
  return {
    /** findOptionalQdrantStore: no project is not an error. */
    async optionalStorage(cwd: string) {
      try {
        const loc = locateProject(cwd);
        return createStorage(new Store(loc.knowledgeRoot, loc.projectRoot));
      } catch {
        return undefined;
      }
    },
    /** qdrantManagerFromStore: project and global semantic settings, resolved with the process env. */
    semanticSettingsFor(
      storage: ReturnType<typeof createStorage> | undefined,
      env: Record<string, string | undefined>,
    ): CommandManager {
      let project: SemanticSettings | undefined;
      if (storage) {
        try {
          project = storage.config.load().settings.semanticSearch;
        } catch {
          project = undefined;
        }
      }
      let global: SemanticSettings | undefined;
      try {
        const raw = buildSearchEnvironment({ env }).embeddingRegistry().projectDefaults?.settings
          .semanticSearch;
        const parsed = models.semanticSearchSettingsSchema.safeParse(raw);
        if (parsed.success) global = parsed.data;
      } catch {
        global = undefined;
      }
      const res = resolveVectorStoreForEnv(project, global, env);
      return Object.assign(new rt.QdrantManager(rt.configFromResolution(res)), {
        machineEndpoint: res.machineEndpoint,
      });
    },
  };
}

function emptyDash(s: string | undefined): string {
  return (s ?? "").trim() === "" ? "-" : (s as string);
}

function renderPlain(s: QdrantRuntimeStatus): string {
  let out = "";
  out += `state\t${s.state}\n`;
  out += `enabled\t${s.enabled}\n`;
  out += `backend\t${emptyDash(s.backend)}\n`;
  out += `mode\t${emptyDash(s.mode)}\n`;
  out += `managed\t${s.managed}\n`;
  out += `running\t${s.running}\n`;
  out += `installed\t${s.installed}\n`;
  if (s.pid) out += `pid\t${s.pid}\n`;
  out += `endpoint\t${emptyDash(s.endpoint)}\n`;
  if (s.externalURL) out += `externalURL\t${s.externalURL}\n`;
  out += `root\t${s.paths.root}\n`;
  out += `bin\t${s.paths.binDir}\n`;
  out += `binary\t${s.paths.binaryPath}\n`;
  out += `data\t${s.paths.dataDir}\n`;
  out += `logs\t${s.paths.logPath}\n`;
  out += `pidFile\t${s.paths.pidPath}\n`;
  out += `statusFile\t${s.paths.statusPath}\n`;
  if (s.message) out += `message\t${s.message}\n`;
  return out;
}

function renderStyled(s: QdrantRuntimeStatus): string {
  const text = `[${s.state.toUpperCase()}]`;
  let badge = BLUE.render(text);
  if (s.state === "running" || s.state === "external") badge = GREEN.render(text);
  else if (s.state === "stale" || s.state === "not-installed") badge = YELLOW.render(text);
  let out = `${badge} Qdrant semantic vector runtime\n`;
  out += `  Backend: ${emptyDash(s.backend)}\n`;
  out += `  Mode: ${emptyDash(s.mode)}\n`;
  out += `  Managed: ${s.managed}\n`;
  out += `  Running: ${s.running}\n`;
  out += `  Installed: ${s.installed}\n`;
  if (s.pid) out += `  PID: ${s.pid}\n`;
  out += `  Endpoint: ${emptyDash(s.endpoint)}\n`;
  if (s.externalURL) out += `  External URL: ${s.externalURL}\n`;
  out += `  Root: ${s.paths.root}\n`;
  out += `  Binary: ${s.paths.binaryPath}\n`;
  out += `  Data: ${s.paths.dataDir}\n`;
  out += `  Logs: ${s.paths.logPath}\n`;
  out += `  PID file: ${s.paths.pidPath}\n`;
  out += `  Status file: ${s.paths.statusPath}\n`;
  if (s.message) out += `  Message: ${s.message}\n`;
  return out;
}

/** Go returns a zero Status next to some Start errors; the command still renders it. */
function zeroStatus(): QdrantRuntimeStatus {
  return {
    enabled: false,
    backend: "",
    mode: "",
    managed: false,
    state: "",
    running: false,
    installed: false,
    paths: {
      root: "",
      binDir: "",
      binaryPath: "",
      dataDir: "",
      logsDir: "",
      logPath: "",
      pidPath: "",
      statusPath: "",
      snapshotsDir: "",
    },
    updatedAt: "0001-01-01T00:00:00Z",
  };
}

// Not in Go (D14): a machine endpoint whose Docker container Knowns created. status, start, stop
// and logs act on that container; an endpoint recorded as "existing" stays external and is never
// started, stopped or removed.
type DockerStatus = QdrantRuntimeStatus & {
  docker?: { container: string; image: string; volume: string; state: string };
};

function dockerOwnedEndpoint(mgr: CommandManager): MachineEndpoint | undefined {
  const m = mgr.machineEndpoint;
  return m?.source === "docker" && m.docker ? m : undefined;
}

async function dockerStatus(
  mgr: CommandManager,
  endpoint: MachineEndpoint,
  message?: string,
): Promise<DockerStatus> {
  const { defaultDockerRunner, inspectContainer } = await import("../../runtime/qdrant-docker.ts");
  const { qdrantSetupSeams } = await import("../../runtime/qdrant-setup.ts");
  const run = qdrantSetupSeams().docker ?? defaultDockerRunner;
  // start, stop and remove act on the fixed name, so status reads that same container.
  const c = await inspectContainer(run);
  const state = !c.exists ? "missing" : c.running ? "running" : "stopped";
  const base = mgr.status();
  const name = endpoint.docker?.container ?? "";
  return {
    ...base,
    managed: c.exists && c.owned,
    state: state === "missing" ? "not-installed" : state,
    running: c.running,
    installed: c.exists,
    message:
      message ??
      (state === "missing"
        ? `Docker container ${name} does not exist; run \`knowns qdrant setup\``
        : `Docker container ${name} is ${state}`),
    docker: { ...(endpoint.docker as NonNullable<MachineEndpoint["docker"]>), state },
  };
}

function renderStatus(ctx: CommandContext, status: DockerStatus): void {
  if (ctx.json) {
    const out = statusJson(status) as Record<string, unknown>;
    ctx.printJSON(status.docker ? { ...out, docker: status.docker } : out);
  } else if (ctx.plain && status.docker) {
    ctx.print(`${renderPlain(status)}docker\t${status.docker.container} ${status.docker.state}\n`);
  } else if (!ctx.plain && status.docker) {
    ctx.print(
      `${renderStyled(status)}  Docker: ${status.docker.container} (${status.docker.image}) ${status.docker.state}\n`,
    );
  } else if (ctx.plain) ctx.print(renderPlain(status));
  else ctx.print(renderStyled(status));
}

const install = defineCommand({
  use: "install",
  short: "Install the pinned managed Qdrant binary with checksum verification",
  async run(ctx) {
    const mgr = await managerForCommand(ctx);
    if (mgr.config.mode === "external")
      throw new Error("qdrant install applies only to managed mode");
    const { installQdrant } = await import("../../runtime/qdrant.ts");
    const paths = await installQdrant(mgr.paths().root, {
      mirror: ctx.env.KNOWNS_QDRANT_MIRROR ?? "",
    });
    ctx.print(`installed pinned Qdrant ${SUPPORTED_QDRANT_VERSION} at ${paths.binaryPath}\n`);
  },
});

const purge = defineCommand({
  use: "purge",
  short: "Immediately purge positively owned semantic collections",
  long: "Explicit privacy/hard purge. Retention is bypassed, but deletion fails closed unless pointer and generation history prove ownership.",
  async run(ctx) {
    const { optionalStorage } = await loadSupport();
    const storage = await optionalStorage(ctx.cwd);
    if (!storage) throw new Error("qdrant purge requires a Knowns store");
    const [{ buildSearchEnvironment }, { qdrantClientForStore }, { purgeQdrantCollections }] =
      await Promise.all([
        import("../../domain/searchenv/index.ts"),
        import("../../search/qdrant/store.ts"),
        import("../../runtime/index/reindex.ts"),
      ]);
    const env = buildSearchEnvironment({ env: ctx.env });
    const client = qdrantClientForStore(storage, env);
    const deleted = await purgeQdrantCollections(storage.store.root, client);
    ctx.print(`purged ${deleted.length} positively owned Qdrant collections\n`);
  },
});

const status = defineCommand({
  use: "status",
  short: "Show Qdrant runtime status and paths",
  async run(ctx) {
    const mgr = await managerForCommand(ctx);
    const docker = dockerOwnedEndpoint(mgr);
    renderStatus(ctx, docker ? await dockerStatus(mgr, docker) : mgr.status());
  },
});

const start = defineCommand({
  use: "start",
  short: "Start managed Qdrant when in managed mode",
  async run(ctx) {
    const mgr = await managerForCommand(ctx);
    const docker = dockerOwnedEndpoint(mgr);
    if (docker) {
      const [{ defaultDockerRunner, startContainer }, setup] = await Promise.all([
        import("../../runtime/qdrant-docker.ts"),
        import("../../runtime/qdrant-setup.ts"),
      ]);
      const seams = setup.qdrantSetupSeams();
      const outcome = await startContainer(seams.docker ?? defaultDockerRunner);
      const deadline = Date.now() + (seams.healthTimeoutMs ?? 60_000);
      while (!(await setup.probeQdrant(docker.url, "machine", { fetch: seams.fetch })).answering) {
        if (Date.now() > deadline) {
          throw new Error(
            `Qdrant in Docker did not answer at ${docker.url}; inspect it with \`knowns qdrant logs\``,
          );
        }
        await Bun.sleep(500);
      }
      renderStatus(
        ctx,
        await dockerStatus(
          mgr,
          docker,
          `Docker container ${docker.docker?.container} ${outcome === "running" ? "is already running" : "started"}`,
        ),
      );
      return;
    }
    try {
      renderStatus(ctx, await mgr.start());
    } catch (err) {
      renderStatus(ctx, (err as QdrantStartError).status ?? zeroStatus());
      throw err;
    }
  },
});

const stop = defineCommand({
  use: "stop",
  short: "Stop managed Qdrant when Knowns owns a local process",
  async run(ctx) {
    const mgr = await managerForCommand(ctx);
    const docker = dockerOwnedEndpoint(mgr);
    if (docker) {
      const [{ defaultDockerRunner, stopContainer }, setup] = await Promise.all([
        import("../../runtime/qdrant-docker.ts"),
        import("../../runtime/qdrant-setup.ts"),
      ]);
      const stopped = await stopContainer(setup.qdrantSetupSeams().docker ?? defaultDockerRunner);
      renderStatus(
        ctx,
        await dockerStatus(
          mgr,
          docker,
          `Docker container ${docker.docker?.container} ${stopped ? "stopped" : "was not running"}`,
        ),
      );
      return;
    }
    renderStatus(ctx, await mgr.stop());
  },
});

const logs = defineCommand({
  use: "logs",
  short: "Show managed Qdrant log lines",
  flags: [
    {
      type: "int",
      name: "tail",
      shorthand: "n",
      usage: "Number of trailing lines to show",
      default: 50,
    },
  ],
  async run(ctx) {
    const mgr = await managerForCommand(ctx);
    const docker = dockerOwnedEndpoint(mgr);
    if (docker) {
      const [{ defaultDockerRunner }, setup] = await Promise.all([
        import("../../runtime/qdrant-docker.ts"),
        import("../../runtime/qdrant-setup.ts"),
      ]);
      const run = setup.qdrantSetupSeams().docker ?? defaultDockerRunner;
      // The managed path treats a non-positive count as 50; so does this one.
      const tail = ctx.flags.int("tail") > 0 ? ctx.flags.int("tail") : 50;
      const r = await run(["logs", "--tail", String(tail), DOCKER_CONTAINER_NAME], 30_000);
      ctx.print(r.stdout + r.stderr);
      return;
    }
    ctx.print(mgr.tailLog(ctx.flags.int("tail")));
  },
});

const cleanup = defineCommand({
  use: "cleanup",
  short: "Remove stale managed Qdrant runtime metadata",
  long: "Remove stale managed Qdrant PID/status metadata. This does not delete vector data or collections.",
  async run(ctx) {
    const mgr = await managerForCommand(ctx);
    renderStatus(ctx, mgr.cleanup());
  },
});

export default defineCommand({
  use: "qdrant",
  short: "Inspect and control the semantic Qdrant runtime",
  long: `Inspect and control the Qdrant runtime used by semantic vector search.

Managed mode owns a local Qdrant process rooted at ~/.knowns/runtime/qdrant.
External URL mode reports the configured endpoint and bypasses local process
start/stop/cleanup ownership.`,
  subcommands: [install, purge, status, start, stop, logs, cleanup, setupCommand],
});
