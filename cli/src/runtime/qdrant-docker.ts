// Not in Go (rewrite spec D14, @doc/specs/2026-11-07/qdrant-setup-wizard D2): Qdrant in a Docker
// container that Knowns creates and then owns. It is driven through the `docker` CLI on PATH (no
// socket client, no new dependency). The container publishes the HTTP port on loopback only and
// carries the dev.knowns.managed label, so a same-named container someone else made is never
// adopted, started, stopped or removed.

export const DOCKER_CONTAINER = "knowns-qdrant";
export const DOCKER_IMAGE = "qdrant/qdrant:v1.14.1";
export const DOCKER_VOLUME = "knowns-qdrant-data";
export const DOCKER_LABEL = "dev.knowns.managed";
export const DOCKER_ENDPOINT = "http://127.0.0.1:6333";

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `docker <args>`; code -1 means the binary could not be started at all. */
export type DockerRunner = (args: string[], timeoutMs: number) => Promise<DockerResult>;

export const defaultDockerRunner: DockerRunner = async (args, timeoutMs) => {
  // Bun.which alone reads the PATH the process started with; pass the current one explicitly.
  const bin = Bun.which("docker", { PATH: process.env.PATH ?? "" });
  if (!bin) return { code: -1, stdout: "", stderr: "docker not found on PATH" };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    return { code: -1, stdout: "", stderr: (err as Error).message };
  }
  // A grandchild (a credential helper during a pull) can hold the pipes open after the kill, so
  // the reads are bounded too: past the timeout the call returns whatever it has.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DockerResult>((resolve) => {
    timer = setTimeout(() => {
      proc.kill();
      resolve({
        code: 124,
        stdout: "",
        stderr: `docker ${args[0]} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });
  const finished = (async (): Promise<DockerResult> => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  })();
  try {
    return await Promise.race([finished, timedOut]);
  } finally {
    clearTimeout(timer);
  }
};

export interface DockerAvailability {
  available: boolean;
  /** The daemon's version when available. */
  serverVersion?: string;
  /** Why Docker cannot be used, for the setup report. */
  reason?: string;
}

/** `docker version`: the CLI must exist and its daemon must answer. */
export async function dockerAvailability(
  run: DockerRunner,
  timeoutMs = 2500,
): Promise<DockerAvailability> {
  const r = await run(["version", "--format", "{{.Server.Version}}"], timeoutMs);
  if (r.code === -1) return { available: false, reason: "docker not found on PATH" };
  const version = r.stdout.trim();
  if (r.code !== 0 || version === "") {
    return { available: false, reason: "the Docker daemon is not running" };
  }
  return { available: true, serverVersion: version };
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  /** True when the container carries the Knowns label. */
  owned: boolean;
  image?: string;
}

const INSPECT_FORMAT = `{{json .State.Running}}|{{json .Config.Image}}|{{json (index .Config.Labels "${DOCKER_LABEL}")}}`;

export async function inspectContainer(
  run: DockerRunner,
  name = DOCKER_CONTAINER,
): Promise<ContainerState> {
  const r = await run(["container", "inspect", "--format", INSPECT_FORMAT, name], 5000);
  if (r.code !== 0) return { exists: false, running: false, owned: false };
  const [running, image, label] = r.stdout.trim().split("|");
  return {
    exists: true,
    running: running === "true",
    owned: label === '"true"',
    image: image ? (JSON.parse(image) as string) : undefined,
  };
}

function dockerError(action: string, r: DockerResult): Error {
  const detail = (r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`).split("\n")[0];
  return new Error(`${action}: ${detail}`);
}

function notOwned(): Error {
  return new Error(
    `a container named ${DOCKER_CONTAINER} exists but was not created by Knowns (no ${DOCKER_LABEL} label); rename or remove it, or run \`knowns qdrant setup --url <endpoint>\``,
  );
}

export type EnsureOutcome = "created" | "started" | "running";

/**
 * Creates the container, starts a stopped one, or leaves a running one alone. Never a second
 * container: an existing name is reused when it is ours and refused when it is not.
 */
export async function ensureContainer(run: DockerRunner): Promise<EnsureOutcome> {
  const state = await inspectContainer(run);
  if (state.exists) {
    if (!state.owned) throw notOwned();
    if (state.running) return "running";
    const r = await run(["start", DOCKER_CONTAINER], 60_000);
    if (r.code !== 0) throw dockerError(`docker start ${DOCKER_CONTAINER}`, r);
    return "started";
  }
  const r = await run(
    [
      "run",
      "--detach",
      "--name",
      DOCKER_CONTAINER,
      "--label",
      `${DOCKER_LABEL}=true`,
      "--restart",
      "unless-stopped",
      "--publish",
      "127.0.0.1:6333:6333",
      "--volume",
      `${DOCKER_VOLUME}:/qdrant/storage`,
      DOCKER_IMAGE,
    ],
    // The first run pulls the image.
    10 * 60_000,
  );
  if (r.code !== 0) throw dockerError(`docker run ${DOCKER_IMAGE}`, r);
  return "created";
}

export async function startContainer(run: DockerRunner): Promise<EnsureOutcome> {
  const state = await inspectContainer(run);
  if (!state.exists) return ensureContainer(run);
  if (!state.owned) throw notOwned();
  if (state.running) return "running";
  const r = await run(["start", DOCKER_CONTAINER], 60_000);
  if (r.code !== 0) throw dockerError(`docker start ${DOCKER_CONTAINER}`, r);
  return "started";
}

/** Stops the container when it is ours; false when there was nothing running to stop. */
export async function stopContainer(run: DockerRunner): Promise<boolean> {
  const state = await inspectContainer(run);
  if (!state.exists || !state.running) return false;
  if (!state.owned) throw notOwned();
  const r = await run(["stop", DOCKER_CONTAINER], 60_000);
  if (r.code !== 0) throw dockerError(`docker stop ${DOCKER_CONTAINER}`, r);
  return true;
}

/** Removes the container (and, when asked, its volume, which holds every collection). */
export async function removeContainer(
  run: DockerRunner,
  opts: { volume: boolean },
): Promise<{ container: boolean; volume: boolean }> {
  const state = await inspectContainer(run);
  let container = false;
  if (state.exists) {
    if (!state.owned) throw notOwned();
    const r = await run(["rm", "--force", DOCKER_CONTAINER], 60_000);
    if (r.code !== 0) throw dockerError(`docker rm ${DOCKER_CONTAINER}`, r);
    container = true;
  }
  let volume = false;
  if (opts.volume) {
    const r = await run(["volume", "rm", DOCKER_VOLUME], 60_000);
    if (r.code === 0) volume = true;
    else if (!/no such volume/i.test(r.stderr))
      throw dockerError(`docker volume rm ${DOCKER_VOLUME}`, r);
  }
  return { container, volume };
}
