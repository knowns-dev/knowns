// `knowns qdrant setup` (not in Go; rewrite spec D14, @doc/specs/2026-11-07/qdrant-setup-wizard):
// detect what can serve Qdrant on this machine, pick by priority (an answering Qdrant, managed,
// Docker), ask only when there is a real choice, and record the choice per machine (D6). The
// project's .knowns/config.json is never written.

import { type CommandContext, defineCommand } from "../core/define.ts";
import { isTTY } from "../core/pager.ts";
import { StyleDim, StyleSuccess, StyleWarning } from "../core/plainoutput.ts";

export interface SetupReport {
  choice: "existing" | "managed" | "docker";
  endpoint: string;
  /** The machine file written, or "" when nothing was recorded. */
  recorded: string;
  removedRecord: boolean;
  container?: "created" | "started" | "running";
  installed?: boolean;
  started?: boolean;
  message: string;
  detected: {
    platform: string;
    existing: { url: string; version: string; origin: string } | null;
    managed: { available: boolean; reason?: string };
    docker: { available: boolean; reason?: string; serverVersion?: string };
  };
}

const CHOICE_LABEL = {
  existing: "Use the Qdrant that is already running",
  managed: "Managed Qdrant (Knowns downloads and runs the pinned binary)",
  docker: "Docker (Knowns runs container knowns-qdrant)",
} as const;

async function waitHealthy(
  probe: () => Promise<{ answering: boolean; version?: string }>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await probe()).answering) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Qdrant in Docker did not answer on 127.0.0.1:6333 within ${Math.round(timeoutMs / 1000)}s; inspect it with \`docker logs knowns-qdrant\``,
      );
    }
    await Bun.sleep(500);
  }
}

export interface SetupOptions {
  yes?: boolean;
  url?: string;
  docker?: boolean;
  managed?: boolean;
  now?: boolean;
  /**
   * The init hook: a managed platform with nothing else in use stays managed without a question,
   * and a recorded endpoint is never dropped.
   */
  fromInit?: boolean;
}

function setupOptionsFromFlags(ctx: CommandContext): SetupOptions {
  return {
    yes: ctx.flags.bool("yes"),
    url: ctx.flags.string("url"),
    docker: ctx.flags.bool("docker"),
    managed: ctx.flags.bool("managed"),
    now: ctx.flags.bool("now"),
  };
}

export async function runQdrantSetup(
  ctx: Pick<CommandContext, "env" | "json" | "cwd">,
  opts: SetupOptions,
): Promise<SetupReport> {
  const [endpointMod, setupMod, dockerMod, rt, models] = await Promise.all([
    import("../../runtime/qdrant-endpoint.ts"),
    import("../../runtime/qdrant-setup.ts"),
    import("../../runtime/qdrant-docker.ts"),
    import("../../runtime/qdrant.ts"),
    import("../../models/config.ts"),
  ]);
  const env = ctx.env;
  const yes = opts.yes === true;
  const url = (opts.url ?? "").trim();
  const forceDocker = opts.docker === true;
  const forceManaged = opts.managed === true;
  const now = opts.now === true;
  if ([url !== "", forceDocker, forceManaged].filter(Boolean).length > 1) {
    throw new Error("--url, --docker and --managed cannot be combined");
  }
  const seams = setupMod.qdrantSetupSeams();
  const interactive =
    !yes && !ctx.json && (seams.interactive ?? (isTTY() && process.stdin.isTTY === true));
  const docker = seams.docker ?? dockerMod.defaultDockerRunner;
  const localURL = seams.localURL ?? setupMod.SETUP_LOCAL_URL;
  const dockerEndpoint = seams.localURL ?? dockerMod.DOCKER_ENDPOINT;
  const machine = endpointMod.readMachineEndpoint(env);
  const recordedDocker = machine.endpoint?.source === "docker";
  // Every URL shown or thrown goes through this: never credentials or a query.
  const show = (u: string) => rt.sanitizedEndpoint(u);
  const envURL =
    (env.KNOWNS_QDRANT_URL ?? "").trim() || (env.KNOWNS_SEMANTIC_QDRANT_URL ?? "").trim();

  // The managed runtime as project and global settings define it, without the machine file, so a
  // managedRoot set in settings still identifies Knowns' own process on 127.0.0.1:6333.
  const base = await settingsResolution(ctx, models);
  const managedCfg = rt.configFromResolution({
    ...base,
    enabled: true,
    backend: models.SEMANTIC_VECTOR_BACKEND_QDRANT,
    mode: models.SEMANTIC_VECTOR_STORE_MODE_MANAGED,
    externalURL: "",
  });
  const managedRunning = () => new rt.QdrantManager(managedCfg).status().running;

  const detection = await setupMod.detectQdrantSetup({
    env,
    machineURL: machine.endpoint?.url,
    recordedDocker,
    docker,
    fetch: seams.fetch,
    localURL,
    goos: seams.goos,
    goarch: seams.goarch,
    managedRunning,
  });
  const detected: SetupReport["detected"] = {
    platform: detection.platform,
    existing: detection.existing
      ? {
          url: show(detection.existing.url),
          version: detection.existing.version ?? "",
          origin: detection.existing.origin,
        }
      : null,
    managed: detection.managed,
    docker: detection.docker,
  };

  // Moving off a recorded Docker setup would leave its container running (Docker restarts it)
  // with nothing tracking it, holding 127.0.0.1:6333 against a managed Qdrant.
  const dockerRecordedError = () =>
    new Error(
      "a Docker setup is recorded for this machine; run `knowns qdrant setup --remove` first",
    );

  let choice: SetupReport["choice"];
  let existing = detection.existing;
  if (url !== "") {
    if (recordedDocker) throw dockerRecordedError();
    const invalid = endpointMod.endpointURLError(url);
    if (invalid !== undefined) throw new Error(`--url ${show(url)}: ${invalid}`);
    const p = await setupMod.probeQdrant(url, "env", {
      fetch: seams.fetch,
      apiKey: (env.KNOWNS_QDRANT_API_KEY ?? "").trim(),
    });
    if (!p.answering || p.error)
      throw new Error(`Qdrant at ${show(url)} is not usable: ${p.error ?? "no answer"}`);
    if (!p.compatible) {
      throw new Error(
        `Qdrant ${p.version} at ${show(url)} is older than ${setupMod.MIN_COMPATIBLE_QDRANT}; upgrade it or pick another endpoint`,
      );
    }
    existing = { ...p, origin: "machine" };
    choice = "existing";
  } else if (forceDocker) {
    if (!detection.docker.available)
      throw new Error(`cannot use Docker: ${detection.docker.reason}`);
    choice = "docker";
  } else if (forceManaged) {
    if (recordedDocker) throw dockerRecordedError();
    if (!detection.managed.available) {
      throw new Error(`cannot use managed Qdrant: ${detection.managed.reason}`);
    }
    choice = "managed";
  } else if (envURL !== "" && detection.existing?.origin !== "env") {
    // The env wins over anything setup could record, so a broken env URL is the problem to fix.
    const probe = detection.probes.find((p) => p.origin === "env");
    throw new Error(
      `KNOWNS_QDRANT_URL is set to ${show(envURL)} but it is not usable (${probe?.error ?? (probe?.compatible === false ? `Qdrant ${probe.version} is older than ${setupMod.MIN_COMPATIBLE_QDRANT}` : "no answer")}); it overrides any setup, so fix or unset it`,
    );
  } else if (recordedDocker) {
    // The recorded Docker setup keeps priority whatever state the container is in: ensureContainer
    // starts a stopped one and recreates a removed one.
    if (!detection.docker.available) {
      throw new Error(
        `a Docker setup is recorded for this machine but Docker is not usable (${detection.docker.reason}); start Docker and rerun, or run \`knowns qdrant setup --remove\``,
      );
    }
    choice = "docker";
  } else {
    // What already runs here keeps priority: re-running setup must not move a working Docker or
    // managed Qdrant somewhere else.
    const options = [...detection.options];
    const prefer = detection.localIsDocker ? "docker" : detection.localIsManaged ? "managed" : "";
    if (prefer !== "" && options.includes(prefer)) {
      options.splice(options.indexOf(prefer), 1);
      options.unshift(prefer);
    }
    const first = options[0];
    if (first === undefined) throw new Error(setupMod.nothingUsableMessage(detection));
    choice = first;
    const quietManaged = opts.fromInit === true && first === "managed";
    if (interactive && options.length > 1 && !quietManaged) {
      const { createPrompter } = await import("../tui/prompter.ts");
      choice = (await createPrompter().select({
        title: "Where should semantic search keep its vectors?",
        options: options.map((o) => ({
          label:
            o === "existing" && existing
              ? `${CHOICE_LABEL.existing} (${show(existing.url)}, ${existing.version})`
              : CHOICE_LABEL[o],
          value: o,
        })),
        value: first,
      })) as SetupReport["choice"];
    }
  }

  const report: SetupReport = {
    choice,
    endpoint: "",
    recorded: "",
    removedRecord: false,
    message: "",
    detected,
  };
  const recordedAt = new Date().toISOString();

  if (choice === "existing") {
    const target = existing as NonNullable<typeof existing>;
    report.endpoint = show(target.url);
    if (target.origin === "env") {
      report.message = "KNOWNS_QDRANT_URL already selects this Qdrant; nothing recorded";
    } else {
      report.recorded = endpointMod.saveMachineEndpoint(
        { version: 1, url: target.url, source: "existing", recordedAt },
        env,
      );
      report.message = `using the Qdrant ${target.version} at ${show(target.url)}`;
    }
  } else if (choice === "managed") {
    report.endpoint = localURL;
    report.removedRecord = opts.fromInit === true ? false : endpointMod.removeMachineEndpoint(env);
    if (now) {
      const paths = await rt.installQdrant(new rt.QdrantManager(managedCfg).paths().root, {
        mirror: env.KNOWNS_QDRANT_MIRROR ?? "",
      });
      report.installed = paths.binaryPath !== "";
      const status = await new rt.QdrantManager(managedCfg).start();
      report.started = status.running;
      report.message = "managed Qdrant installed and started";
    } else if (detection.localIsManaged) {
      report.message = "managed Qdrant is already running";
    } else {
      report.message =
        "managed Qdrant is installed and started on first semantic use (or run `knowns qdrant start`)";
    }
  } else {
    if (interactive) {
      const { createPrompter } = await import("../tui/prompter.ts");
      const ok = await createPrompter().confirm({
        title: "Run Qdrant in Docker?",
        description: `Knowns runs container ${dockerMod.DOCKER_CONTAINER} from ${dockerMod.DOCKER_IMAGE} on 127.0.0.1:6333 with volume ${dockerMod.DOCKER_VOLUME}; Docker restarts it unless you stop it.`,
        value: true,
      });
      if (!ok) throw new Error("setup cancelled; nothing changed");
    }
    report.container = await dockerMod.ensureContainer(docker);
    await waitHealthy(
      () => setupMod.probeQdrant(dockerEndpoint, "local", { fetch: seams.fetch }),
      seams.healthTimeoutMs ?? 120_000,
    );
    report.endpoint = dockerEndpoint;
    report.recorded = endpointMod.saveMachineEndpoint(
      {
        version: 1,
        url: dockerEndpoint,
        source: "docker",
        docker: {
          container: dockerMod.DOCKER_CONTAINER,
          image: dockerMod.DOCKER_IMAGE,
          volume: dockerMod.DOCKER_VOLUME,
        },
        recordedAt,
      },
      env,
    );
    report.message = `Qdrant runs in Docker container ${dockerMod.DOCKER_CONTAINER} (${report.container})`;
  }
  if (envURL !== "" && report.recorded !== "") {
    report.message += `; KNOWNS_QDRANT_URL (${show(envURL)}) still overrides it until you unset it`;
  }
  return report;
}

/** Vector-store resolution from env plus project and global settings, without the machine file. */
async function settingsResolution(
  ctx: Pick<CommandContext, "env" | "cwd">,
  models: typeof import("../../models/config.ts"),
) {
  type Settings = import("../../models/config.ts").SemanticSearchSettings;
  let project: Settings | undefined;
  let global: Settings | undefined;
  try {
    const [{ locateProject, Store }, { createStorage }] = await Promise.all([
      import("../../storage/core/index.ts"),
      import("../../storage/adapters.ts"),
    ]);
    const loc = locateProject(ctx.cwd);
    project = createStorage(new Store(loc.knowledgeRoot, loc.projectRoot)).config.load().settings
      .semanticSearch;
  } catch {
    project = undefined;
  }
  try {
    const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
    const raw = buildSearchEnvironment({ env: ctx.env }).embeddingRegistry().projectDefaults
      ?.settings.semanticSearch;
    const parsed = models.semanticSearchSettingsSchema.safeParse(raw);
    if (parsed.success) global = parsed.data;
  } catch {
    global = undefined;
  }
  return models.resolveSemanticVectorStore(project, global, (k) => ctx.env[k]);
}

function renderDetected(r: SetupReport): string {
  const d = r.detected;
  const lines = [
    `  Platform: ${d.platform}`,
    `  Running Qdrant: ${d.existing ? `${d.existing.version} at ${d.existing.url}` : "none found"}`,
    `  Managed: ${d.managed.available ? "available" : `not available (${d.managed.reason})`}`,
    `  Docker: ${d.docker.available ? `available (${d.docker.serverVersion})` : `not available (${d.docker.reason})`}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderSetupPlain(r: SetupReport): string {
  let out = `choice\t${r.choice}\n`;
  out += `endpoint\t${r.endpoint}\n`;
  out += `recorded\t${r.recorded === "" ? "-" : r.recorded}\n`;
  if (r.container) out += `container\t${r.container}\n`;
  out += `message\t${r.message}\n`;
  return out;
}

export function renderSetupStyled(r: SetupReport): string {
  let out = "Qdrant setup\n";
  out += StyleDim.render(renderDetected(r));
  out += `\n${StyleSuccess.render("✓")} ${r.message}\n`;
  if (r.recorded !== "") out += StyleDim.render(`  Recorded for this machine: ${r.recorded}\n`);
  if (r.removedRecord) out += StyleDim.render("  Removed the previously recorded endpoint\n");
  out += StyleDim.render("  Next: knowns search index --wait\n");
  return out;
}

export interface RemoveReport {
  removed: "docker" | "existing" | "none";
  container: boolean;
  volume: boolean;
  recordRemoved: boolean;
  message: string;
}

/**
 * `setup --remove`: undo what setup recorded for this machine. A Docker setup loses its container
 * and, only when asked (--volume, or yes at the prompt), the volume that holds every project's
 * vectors. An existing endpoint is only forgotten; the Qdrant behind it is not touched.
 */
export async function runQdrantRemove(ctx: CommandContext): Promise<RemoveReport> {
  const [endpointMod, setupMod, dockerMod] = await Promise.all([
    import("../../runtime/qdrant-endpoint.ts"),
    import("../../runtime/qdrant-setup.ts"),
    import("../../runtime/qdrant-docker.ts"),
  ]);
  if (
    ctx.flags.string("url").trim() !== "" ||
    ctx.flags.bool("docker") ||
    ctx.flags.bool("managed")
  ) {
    throw new Error("--remove cannot be combined with --url, --docker or --managed");
  }
  const seams = setupMod.qdrantSetupSeams();
  const interactive =
    !ctx.flags.bool("yes") &&
    !ctx.json &&
    (seams.interactive ?? (isTTY() && process.stdin.isTTY === true));
  const machine = endpointMod.readMachineEndpoint(ctx.env);
  const endpoint = machine.endpoint;
  if (!endpoint) {
    const recordRemoved = machine.error !== undefined && endpointMod.removeMachineEndpoint(ctx.env);
    return {
      removed: "none",
      container: false,
      volume: false,
      recordRemoved,
      message: recordRemoved
        ? "removed an unreadable endpoint file"
        : "nothing is recorded for this machine",
    };
  }
  if (endpoint.source === "existing" || !endpoint.docker) {
    endpointMod.removeMachineEndpoint(ctx.env);
    return {
      removed: "existing",
      container: false,
      volume: false,
      recordRemoved: true,
      message: `forgot ${endpoint.url}; the Qdrant there was not touched`,
    };
  }
  let volume = ctx.flags.bool("volume");
  if (!volume && interactive) {
    const { createPrompter } = await import("../tui/prompter.ts");
    volume = await createPrompter().confirm({
      title: `Also remove volume ${endpoint.docker.volume}?`,
      description:
        "It holds the vectors of every project on this machine; they are rebuilt by reindexing.",
      value: false,
    });
  }
  const run = seams.docker ?? dockerMod.defaultDockerRunner;
  const result = await dockerMod.removeContainer(run, { volume });
  endpointMod.removeMachineEndpoint(ctx.env);
  const parts = [
    result.container
      ? `removed container ${endpoint.docker.container}`
      : `container ${endpoint.docker.container} was already gone`,
    volume
      ? result.volume
        ? `removed volume ${endpoint.docker.volume}`
        : `volume ${endpoint.docker.volume} was already gone`
      : `kept volume ${endpoint.docker.volume}`,
  ];
  return {
    removed: "docker",
    container: result.container,
    volume: result.volume,
    recordRemoved: true,
    message: parts.join("; "),
  };
}

export const setupCommand = defineCommand({
  use: "setup",
  short: "Detect and set up a Qdrant for semantic search on this machine",
  long: `Detect what can serve Qdrant on this machine and set it up.

In priority order: a Qdrant that already answers (KNOWNS_QDRANT_URL, the endpoint
recorded for this machine, or 127.0.0.1:6333), managed Qdrant when this platform
has a pinned build, then Docker. It asks only when more than one option works;
--yes, --json or a non-interactive terminal take the first one.

The choice is recorded for this machine under ~/.knowns/runtime/qdrant and
outranks the project config; the project's .knowns/config.json is not changed.`,
  example: `  knowns qdrant setup
  knowns qdrant setup --yes
  knowns qdrant setup --url http://qdrant.internal:6333
  knowns qdrant setup --docker --yes
  knowns qdrant setup --remove`,
  flags: [
    {
      type: "bool",
      name: "yes",
      shorthand: "y",
      usage: "Take the first valid option without asking",
      default: false,
    },
    { type: "string", name: "url", usage: "Use the Qdrant at this endpoint", default: "" },
    {
      type: "bool",
      name: "docker",
      usage: "Run Qdrant in Docker (container knowns-qdrant)",
      default: false,
    },
    { type: "bool", name: "managed", usage: "Use managed Qdrant", default: false },
    {
      type: "bool",
      name: "now",
      usage: "With managed Qdrant, install and start it now",
      default: false,
    },
    {
      type: "bool",
      name: "remove",
      usage: "Remove what setup recorded for this machine (and its Docker container)",
      default: false,
    },
    {
      type: "bool",
      name: "volume",
      usage: "With --remove, also remove the Docker volume holding the vectors",
      default: false,
    },
  ],
  async run(ctx) {
    if (ctx.flags.bool("remove")) {
      const removed = await runQdrantRemove(ctx);
      if (ctx.json) ctx.printJSON(removed);
      else if (ctx.plain) ctx.print(`removed\t${removed.removed}\nmessage\t${removed.message}\n`);
      else ctx.print(`${StyleSuccess.render("✓")} ${removed.message}\n`);
      return;
    }
    if (ctx.flags.bool("volume")) throw new Error("--volume applies only with --remove");
    const report = await runQdrantSetup(ctx, setupOptionsFromFlags(ctx));
    if (ctx.json) ctx.printJSON(report);
    else if (ctx.plain) ctx.print(renderSetupPlain(report));
    else ctx.print(renderSetupStyled(report));
  },
});

/**
 * The `knowns init` hook (D3): after the wizard enables semantic search on a real terminal, run
 * the same detection. A managed platform stays lazy (nothing is downloaded at init); elsewhere the
 * user is offered what works (Docker, a running Qdrant). A failure never fails init: semantic
 * search then stays keyword-only and init says how to finish later.
 */
export async function setupQdrantAfterInit(
  ctx: Pick<CommandContext, "env" | "json" | "print" | "cwd">,
) {
  const { qdrantSetupSeams } = await import("../../runtime/qdrant-setup.ts");
  const interactive = qdrantSetupSeams().interactive ?? (isTTY() && process.stdin.isTTY === true);
  if (!interactive) return;
  ctx.print("\n");
  try {
    const report = await runQdrantSetup(ctx, { fromInit: true });
    ctx.print(renderSetupStyled(report));
  } catch (err) {
    ctx.print(
      `${StyleWarning.render("Qdrant is not set up yet; semantic search stays keyword-only.")}\n`,
    );
    ctx.print(StyleDim.render(`  ${(err as Error).message.split("\n")[0]}\n`));
    ctx.print(StyleDim.render("  Finish later with: knowns qdrant setup\n"));
  }
}
