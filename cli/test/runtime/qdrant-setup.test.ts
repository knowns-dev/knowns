// TSR-QDJ4CM and TSR-YGRPXA (spec qdrant-setup-wizard D1, D2, D6; rewrite spec D14): detection,
// choice and the Docker branch of `knowns qdrant setup`. The real Qdrant on 127.0.0.1:6333 and the
// real Docker are never touched: the loopback endpoint is a local fake server and docker is a
// scripted runner.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupQdrantAfterInit } from "../../src/cli/commands/qdrant-setup.ts";
import { setPrompterFactory } from "../../src/cli/tui/prompter.ts";
import {
  DOCKER_CONTAINER,
  DOCKER_IMAGE,
  DOCKER_LABEL,
  DOCKER_VOLUME,
  type DockerResult,
  type DockerRunner,
  defaultDockerRunner,
  ensureContainer,
  removeContainer,
  stopContainer,
} from "../../src/runtime/qdrant-docker.ts";
import {
  loadMachineEndpoint,
  machineEndpointPath,
  saveMachineEndpoint,
} from "../../src/runtime/qdrant-endpoint.ts";
import {
  compatibleQdrantVersion,
  detectQdrantSetup,
  nothingUsableMessage,
  setQdrantSetupSeams,
} from "../../src/runtime/qdrant-setup.ts";
import { runTs } from "../cli/oracle.ts";

const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setQdrantSetupSeams(undefined);
  setPrompterFactory(undefined);
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "knowns-qdrant-setup-"));
  dirs.push(d);
  return d;
}

/** A fake Qdrant: GET / answers only while `up()` is true. */
function fakeQdrant(version = "1.14.1", up: () => boolean = () => true) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (!up()) return new Response("down", { status: 503 });
      if (new URL(req.url).pathname === "/") {
        return Response.json({ title: "qdrant - vector search engine", version });
      }
      return new Response("ok");
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

/** A closed port: nothing answers. */
function deadURL(): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const url = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return url;
}

/** Scripted docker CLI: one optional container, recorded calls. */
class FakeDocker {
  calls: string[][] = [];
  daemon: "up" | "down" | "missing" = "up";
  container: { running: boolean; owned: boolean } | undefined;
  volume = false;
  runner: DockerRunner = async (args) => {
    this.calls.push(args);
    const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
    if (this.daemon === "missing") return { code: -1, stdout: "", stderr: "docker not found" };
    if (args[0] === "version") {
      return this.daemon === "up"
        ? ok("27.3.1\n")
        : { code: 1, stdout: "\n", stderr: "Cannot connect to the Docker daemon" };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (!this.container) return { code: 1, stdout: "", stderr: "No such container" };
      const label = this.container.owned ? '"true"' : "null";
      return ok(`${this.container.running}|"${DOCKER_IMAGE}"|${label}\n`);
    }
    if (args[0] === "run") {
      this.container = { running: true, owned: true };
      this.volume = true;
      return ok("abc123\n");
    }
    if (args[0] === "start" && this.container) {
      this.container.running = true;
      return ok();
    }
    if (args[0] === "stop" && this.container) {
      this.container.running = false;
      return ok();
    }
    if (args[0] === "rm") {
      this.container = undefined;
      return ok();
    }
    if (args[0] === "volume" && args[1] === "rm") {
      if (!this.volume) return { code: 1, stdout: "", stderr: "Error: No such volume" };
      this.volume = false;
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected docker ${args.join(" ")}` };
  };
  runs(): string[][] {
    return this.calls.filter((c) => c[0] === "run");
  }
}

const base = (docker: FakeDocker, localURL: string) => ({
  env: {},
  docker: docker.runner,
  localURL,
  managedRunning: () => false,
  goos: "darwin",
  goarch: "arm64",
});

describe("detection", () => {
  test("version compatibility: 1.x at or above 1.14.0", () => {
    expect(compatibleQdrantVersion("1.14.0")).toBe(true);
    expect(compatibleQdrantVersion("1.14.1")).toBe(true);
    expect(compatibleQdrantVersion("1.15.3")).toBe(true);
    expect(compatibleQdrantVersion("1.13.6")).toBe(false);
    expect(compatibleQdrantVersion("2.0.0")).toBe(false);
  });

  test("an answering Qdrant comes first, then managed, then Docker", async () => {
    const d = await detectQdrantSetup(base(new FakeDocker(), fakeQdrant()));
    expect(d.options).toEqual(["existing", "managed", "docker"]);
    expect(d.existing).toMatchObject({ origin: "local", version: "1.14.1", compatible: true });
  });

  test("the managed process Knowns runs is not an existing endpoint", async () => {
    const d = await detectQdrantSetup({
      ...base(new FakeDocker(), fakeQdrant()),
      managedRunning: () => true,
    });
    expect(d.localIsManaged).toBe(true);
    expect(d.existing).toBeUndefined();
    expect(d.options).toEqual(["managed", "docker"]);
  });

  test("the knowns-qdrant container is not an existing endpoint", async () => {
    const docker = new FakeDocker();
    docker.container = { running: true, owned: true };
    const d = await detectQdrantSetup(base(docker, fakeQdrant()));
    expect(d.localIsDocker).toBe(true);
    expect(d.existing).toBeUndefined();
  });

  test("an old Qdrant is reported, not used", async () => {
    const d = await detectQdrantSetup({
      ...base(new FakeDocker(), fakeQdrant("1.13.6")),
      goos: "windows",
      goarch: "arm64",
    });
    d.docker = { available: false, reason: "docker not found on PATH" };
    expect(d.existing).toBeUndefined();
    expect(nothingUsableMessage(d)).toContain("older than 1.14.0");
  });

  test("no managed build and no Docker: nothing usable, with the reasons and ways forward", async () => {
    const docker = new FakeDocker();
    docker.daemon = "missing";
    const d = await detectQdrantSetup({
      ...base(docker, deadURL()),
      goos: "windows",
      goarch: "arm64",
    });
    expect(d.options).toEqual([]);
    const msg = nothingUsableMessage(d);
    expect(msg).toContain("no managed Qdrant build for windows/arm64");
    expect(msg).toContain("docker not found on PATH");
    expect(msg).toContain("knowns qdrant setup --url <endpoint>");
  });

  test("a Docker CLI whose daemon is down is not usable", async () => {
    const docker = new FakeDocker();
    docker.daemon = "down";
    const d = await detectQdrantSetup({ ...base(docker, deadURL()), goos: "plan9", goarch: "386" });
    expect(d.docker).toEqual({ available: false, reason: "the Docker daemon is not running" });
  });

  test("musl linux/amd64 has no usable managed build", async () => {
    const d = await detectQdrantSetup({
      ...base(new FakeDocker(), deadURL()),
      goos: "linux",
      goarch: "amd64",
      isMusl: () => true,
    });
    expect(d.managed.available).toBe(false);
    expect(d.managed.reason).toContain("musl");
  });

  test("windows/amd64 now has a managed build", async () => {
    const d = await detectQdrantSetup({
      ...base(new FakeDocker(), deadURL()),
      goos: "windows",
      goarch: "amd64",
    });
    expect(d.managed.available).toBe(true);
  });

  test("KNOWNS_QDRANT_URL is the only candidate when set", async () => {
    const seen: string[] = [];
    const url = fakeQdrant();
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input));
      return fetch(input, init);
    }) as typeof fetch;
    const d = await detectQdrantSetup({
      ...base(new FakeDocker(), deadURL()),
      env: { KNOWNS_QDRANT_URL: url },
      fetch: spy,
    });
    expect(seen).toEqual([`${url}/`]);
    expect(d.existing?.origin).toBe("env");
  });

  test("finishes within 3 seconds when nothing answers", async () => {
    const slow: DockerRunner = () =>
      new Promise((r) => setTimeout(() => r({ code: 1, stdout: "", stderr: "" }), 2000));
    const started = Date.now();
    // 10.255.255.1 is unroutable: the probe times out instead of being refused.
    await detectQdrantSetup({
      ...base(new FakeDocker(), "http://10.255.255.1:6333"),
      docker: slow,
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("docker container lifecycle", () => {
  test("creates the container once, from the pinned image, on loopback only", async () => {
    const docker = new FakeDocker();
    expect(await ensureContainer(docker.runner)).toBe("created");
    expect(docker.runs()).toEqual([
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
    ]);
    expect(await ensureContainer(docker.runner)).toBe("running");
    docker.container = { running: false, owned: true };
    expect(await ensureContainer(docker.runner)).toBe("started");
    expect(docker.runs()).toHaveLength(1);
  });

  test("a same-named container without the Knowns label is never adopted or touched", async () => {
    const docker = new FakeDocker();
    docker.container = { running: true, owned: false };
    await expect(ensureContainer(docker.runner)).rejects.toThrow("was not created by Knowns");
    await expect(stopContainer(docker.runner)).rejects.toThrow("was not created by Knowns");
    await expect(removeContainer(docker.runner, { volume: true })).rejects.toThrow(
      "was not created by Knowns",
    );
    expect(
      docker.calls.filter((c) => ["run", "start", "stop", "rm", "volume"].includes(c[0] ?? "")),
    ).toEqual([]);
  });

  test("remove takes the container, and the volume only when asked", async () => {
    const docker = new FakeDocker();
    await ensureContainer(docker.runner);
    expect(await removeContainer(docker.runner, { volume: false })).toEqual({
      container: true,
      volume: false,
    });
    expect(docker.volume).toBe(true);
    expect(await removeContainer(docker.runner, { volume: true })).toEqual({
      container: false,
      volume: true,
    });
  });
});

describe("knowns qdrant setup", () => {
  let home = "";
  let project = "";
  let configBefore = "";
  beforeEach(() => {
    const root = tmp();
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".knowns"), { recursive: true });
    writeFileSync(
      join(project, ".knowns", "config.json"),
      `${JSON.stringify({ name: "p", settings: { semanticSearch: { enabled: true, model: "m", vectorStore: { backend: "qdrant", mode: "managed" } } } }, null, 2)}\n`,
    );
    configBefore = readFileSync(join(project, ".knowns", "config.json"), "utf8");
  });
  const run = (args: string[], env: Record<string, string> = {}) =>
    runTs(["qdrant", "setup", ...args], {
      cwd: project,
      env: { HOME: home, USERPROFILE: home, ...env },
    });
  const json = (out: string) => JSON.parse(out) as Record<string, unknown>;
  afterEach(() => {
    // AC-8: setup never writes the project.
    expect(readFileSync(join(project, ".knowns", "config.json"), "utf8")).toBe(configBefore);
  });

  test("AC-1: an answering Qdrant is recorded as existing; nothing installed or started", async () => {
    const docker = new FakeDocker();
    const url = fakeQdrant();
    setQdrantSetupSeams({ docker: docker.runner, localURL: url, interactive: false });
    const r = await run(["--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ choice: "existing", endpoint: url });
    expect(loadMachineEndpoint({ HOME: home })).toMatchObject({ url, source: "existing" });
    expect(docker.runs()).toEqual([]);
    expect(existsSync(join(home, ".knowns", "runtime", "qdrant", "bin"))).toBe(false);
  });

  test("AC-2: on a managed platform with nothing running, managed is chosen and nothing recorded", async () => {
    const docker = new FakeDocker();
    docker.daemon = "missing";
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
    });
    const r = await run(["--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ choice: "managed", recorded: "" });
    expect(existsSync(join(home, ".knowns", "runtime", "qdrant", "endpoint.json"))).toBe(false);
    expect(existsSync(join(home, ".knowns", "runtime", "qdrant", "bin"))).toBe(false);
  });

  test("choosing managed drops an endpoint recorded earlier", async () => {
    saveMachineEndpoint(
      { version: 1, url: "https://old.example:6333", source: "existing", recordedAt: "x" },
      { HOME: home },
    );
    const docker = new FakeDocker();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
    });
    const r = await run(["--managed", "--json"]);
    expect(json(r.stdout)).toMatchObject({ choice: "managed", removedRecord: true });
    expect(loadMachineEndpoint({ HOME: home })).toBeUndefined();
  });

  test("AC-3: without a managed build, Docker runs the container and records it", async () => {
    const docker = new FakeDocker();
    const url = fakeQdrant("1.14.1", () => docker.container?.running === true);
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: url,
      interactive: false,
      goos: "plan9",
      goarch: "386",
      healthTimeoutMs: 5000,
    });
    const r = await run(["--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ choice: "docker", container: "created", endpoint: url });
    expect(docker.runs()).toHaveLength(1);
    expect(loadMachineEndpoint({ HOME: home })).toMatchObject({
      source: "docker",
      docker: { container: DOCKER_CONTAINER, image: DOCKER_IMAGE, volume: DOCKER_VOLUME },
    });
  });

  test("AC-4: running setup twice keeps one container; a stopped one is started", async () => {
    const docker = new FakeDocker();
    const url = fakeQdrant("1.14.1", () => docker.container?.running === true);
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: url,
      interactive: false,
      goos: "plan9",
      goarch: "386",
      healthTimeoutMs: 5000,
    });
    expect((await run(["--yes"])).code).toBe(0);
    const again = await run(["--yes", "--json"]);
    expect(json(again.stdout)).toMatchObject({ choice: "docker", container: "running" });
    docker.container = { running: false, owned: true };
    const third = await run(["--yes", "--json"]);
    expect(json(third.stdout)).toMatchObject({ choice: "docker", container: "started" });
    expect(docker.runs()).toHaveLength(1);
  });

  test("an existing Docker setup keeps priority over managed on rerun", async () => {
    const docker = new FakeDocker();
    docker.container = { running: true, owned: true };
    const url = fakeQdrant();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: url,
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
    });
    const r = await run(["--yes", "--json"]);
    expect(json(r.stdout)).toMatchObject({ choice: "docker", container: "running" });
  });

  test("AC-5: nothing usable exits non-zero naming what is missing", async () => {
    const docker = new FakeDocker();
    docker.daemon = "missing";
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: false,
      goos: "windows",
      goarch: "arm64",
    });
    const r = await run(["--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no managed Qdrant build for windows/arm64");
    expect(r.stderr).toContain("docker not found on PATH");
    expect(loadMachineEndpoint({ HOME: home })).toBeUndefined();
  });

  test("AC-6: a non-interactive run never prompts, even with several options", async () => {
    setPrompterFactory(() => {
      throw new Error("prompted");
    });
    const docker = new FakeDocker();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: fakeQdrant(),
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
    });
    const r = await run(["--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toMatchObject({ choice: "existing" });
  });

  test("interactive: the user picks among the valid options, and Docker asks once", async () => {
    const asked: string[] = [];
    setPrompterFactory(() => ({
      input: async () => "",
      multiselect: async () => [],
      select: async (q) => {
        asked.push(`select:${q.value}:${q.options.map((o) => o.value).join(",")}`);
        return "docker";
      },
      confirm: async (q) => {
        asked.push(`confirm:${q.title}`);
        return true;
      },
    }));
    const docker = new FakeDocker();
    const url = fakeQdrant("1.14.1", () => docker.container?.running === true);
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: url,
      interactive: true,
      goos: "darwin",
      goarch: "arm64",
      healthTimeoutMs: 5000,
    });
    const r = await run(["--plain"]);
    expect(r.code).toBe(0);
    expect(asked).toEqual(["select:managed:managed,docker", "confirm:Run Qdrant in Docker?"]);
    expect(r.stdout).toContain("choice\tdocker\n");
  });

  test("interactive: declining Docker changes nothing", async () => {
    setPrompterFactory(() => ({
      input: async () => "",
      multiselect: async () => [],
      select: async () => "docker",
      confirm: async () => false,
    }));
    const docker = new FakeDocker();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: true,
      goos: "plan9",
      goarch: "386",
    });
    const r = await run([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("setup cancelled; nothing changed");
    expect(docker.runs()).toEqual([]);
    expect(loadMachineEndpoint({ HOME: home })).toBeUndefined();
  });

  test("KNOWNS_QDRANT_URL: reports the env endpoint and records nothing", async () => {
    const docker = new FakeDocker();
    const url = fakeQdrant();
    setQdrantSetupSeams({ docker: docker.runner, localURL: deadURL(), interactive: false });
    const r = await run(["--json"], { KNOWNS_QDRANT_URL: url });
    expect(json(r.stdout)).toMatchObject({ choice: "existing", endpoint: url, recorded: "" });
    expect(loadMachineEndpoint({ HOME: home })).toBeUndefined();
  });

  test("--url validates the endpoint before recording it", async () => {
    const docker = new FakeDocker();
    setQdrantSetupSeams({ docker: docker.runner, localURL: deadURL(), interactive: false });
    const old = await run(["--url", fakeQdrant("1.12.0")]);
    expect(old.code).not.toBe(0);
    expect(old.stderr).toContain("older than 1.14.0");
    const dead = await run(["--url", deadURL()]);
    expect(dead.code).not.toBe(0);
    const good = fakeQdrant();
    const ok = await run(["--url", good, "--json"]);
    expect(json(ok.stdout)).toMatchObject({ choice: "existing", endpoint: good });
    expect(loadMachineEndpoint({ HOME: home })).toMatchObject({ url: good, source: "existing" });
  });

  test("forcing a branch that is not available fails clearly", async () => {
    const docker = new FakeDocker();
    docker.daemon = "down";
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: false,
      goos: "windows",
      goarch: "arm64",
    });
    expect((await run(["--docker"])).stderr).toContain(
      "cannot use Docker: the Docker daemon is not running",
    );
    expect((await run(["--managed"])).stderr).toContain(
      "no managed Qdrant build for windows/arm64",
    );
    expect((await run(["--docker", "--managed"])).stderr).toContain("cannot be combined");
  });
});

describe("qdrant status, start, stop, logs and setup --remove on a recorded endpoint", () => {
  let home = "";
  let project = "";
  beforeEach(() => {
    const root = tmp();
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".knowns"), { recursive: true });
    writeFileSync(
      join(project, ".knowns", "config.json"),
      `${JSON.stringify({ name: "p", settings: { semanticSearch: { enabled: true, model: "m" } } })}\n`,
    );
  });
  const run = (args: string[]) =>
    runTs(["qdrant", ...args], { cwd: project, env: { HOME: home, USERPROFILE: home } });
  const recordDocker = (url: string) =>
    saveMachineEndpoint(
      {
        version: 1,
        url,
        source: "docker",
        docker: { container: DOCKER_CONTAINER, image: DOCKER_IMAGE, volume: DOCKER_VOLUME },
        recordedAt: "2026-11-07T00:00:00.000Z",
      },
      { HOME: home },
    );

  test("AC-9: status, stop and start act on a Docker-owned endpoint", async () => {
    const docker = new FakeDocker();
    docker.container = { running: true, owned: true };
    const url = fakeQdrant("1.14.1", () => docker.container?.running === true);
    recordDocker(url);
    setQdrantSetupSeams({ docker: docker.runner, healthTimeoutMs: 5000 });

    const status = JSON.parse((await run(["status", "--json"])).stdout);
    expect(status).toMatchObject({
      mode: "external",
      state: "running",
      running: true,
      endpoint: url,
      docker: { container: DOCKER_CONTAINER, state: "running" },
    });
    const stopped = JSON.parse((await run(["stop", "--json"])).stdout);
    expect(stopped).toMatchObject({ state: "stopped", running: false });
    expect(docker.container?.running).toBe(false);
    const plain = (await run(["status", "--plain"])).stdout;
    expect(plain).toContain(`docker\t${DOCKER_CONTAINER} stopped\n`);
    const started = await run(["start", "--json"]);
    expect(started.code).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ state: "running", running: true });
    expect(docker.runs()).toEqual([]);
  });

  test("logs come from the container", async () => {
    const docker = new FakeDocker();
    docker.container = { running: true, owned: true };
    const runner: DockerRunner = async (args, t) =>
      args[0] === "logs"
        ? { code: 0, stdout: "qdrant log line\n", stderr: "" }
        : docker.runner(args, t);
    recordDocker(fakeQdrant());
    setQdrantSetupSeams({ docker: runner });
    const r = await run(["logs", "-n", "5"]);
    expect(r.stdout).toBe("qdrant log line\n");
  });

  test("an existing endpoint is never started, stopped or removed", async () => {
    const docker = new FakeDocker();
    const url = fakeQdrant();
    saveMachineEndpoint({ version: 1, url, source: "existing", recordedAt: "x" }, { HOME: home });
    setQdrantSetupSeams({ docker: docker.runner });
    for (const cmd of ["status", "start", "stop"]) {
      const r = await run([cmd, "--json"]);
      expect(JSON.parse(r.stdout)).toMatchObject({ mode: "external", state: "external" });
    }
    const removed = JSON.parse((await run(["setup", "--remove", "--json"])).stdout);
    expect(removed).toMatchObject({ removed: "existing", container: false, recordRemoved: true });
    expect(docker.calls).toEqual([]);
    expect(loadMachineEndpoint({ HOME: home })).toBeUndefined();
  });

  test("AC-10: setup --remove takes the container, keeps the volume unless asked", async () => {
    const docker = new FakeDocker();
    await ensureContainer(docker.runner);
    recordDocker(fakeQdrant());
    setQdrantSetupSeams({ docker: docker.runner, interactive: false });
    const kept = JSON.parse((await run(["setup", "--remove", "--yes", "--json"])).stdout);
    expect(kept).toMatchObject({ removed: "docker", container: true, volume: false });
    expect(docker.container).toBeUndefined();
    expect(docker.volume).toBe(true);
    expect(loadMachineEndpoint({ HOME: home })).toBeUndefined();

    recordDocker(fakeQdrant());
    const gone = JSON.parse((await run(["setup", "--remove", "--volume", "--json"])).stdout);
    expect(gone).toMatchObject({ removed: "docker", container: false, volume: true });
    expect(docker.volume).toBe(false);
  });

  test("setup --remove asks about the volume interactively, defaulting to keep", async () => {
    const asked: Array<{ title: string; value: boolean }> = [];
    setPrompterFactory(() => ({
      input: async () => "",
      multiselect: async () => [],
      select: async () => "",
      confirm: async (q) => {
        asked.push({ title: q.title, value: q.value });
        return false;
      },
    }));
    const docker = new FakeDocker();
    await ensureContainer(docker.runner);
    recordDocker(fakeQdrant());
    setQdrantSetupSeams({ docker: docker.runner, interactive: true });
    const r = await run(["setup", "--remove", "--plain"]);
    expect(r.code).toBe(0);
    expect(asked).toEqual([{ title: `Also remove volume ${DOCKER_VOLUME}?`, value: false }]);
    expect(docker.volume).toBe(true);
  });

  test("setup --remove with nothing recorded is a no-op; purge is not involved", async () => {
    const docker = new FakeDocker();
    setQdrantSetupSeams({ docker: docker.runner });
    const r = JSON.parse((await run(["setup", "--remove", "--json"])).stdout);
    expect(r).toMatchObject({ removed: "none", message: "nothing is recorded for this machine" });
    expect(docker.calls).toEqual([]);
    expect((await run(["setup", "--volume"])).stderr).toContain(
      "--volume applies only with --remove",
    );
  });
});

describe("knowns init hook (D3)", () => {
  function ctx(home: string) {
    let out = "";
    return {
      c: {
        env: { HOME: home, USERPROFILE: home },
        cwd: home,
        json: false,
        print: (t: string) => {
          out += t;
        },
      },
      out: () => out,
    };
  }
  const neverAsked = () => {
    setPrompterFactory(() => {
      throw new Error("prompted");
    });
  };

  test("a managed platform stays lazy and asks nothing, even when Docker also works", async () => {
    neverAsked();
    const docker = new FakeDocker();
    const home = tmp();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: true,
      goos: "darwin",
      goarch: "arm64",
    });
    const { c, out } = ctx(home);
    await setupQdrantAfterInit(c);
    expect(out()).toContain("managed Qdrant is installed and started on first semantic use");
    expect(docker.runs()).toEqual([]);
    expect(existsSync(join(home, ".knowns", "runtime", "qdrant"))).toBe(false);
  });

  test("without a managed build it offers Docker and records it", async () => {
    const asked: string[] = [];
    setPrompterFactory(() => ({
      input: async () => "",
      multiselect: async () => [],
      select: async () => "",
      confirm: async (q) => {
        asked.push(q.title);
        return true;
      },
    }));
    const docker = new FakeDocker();
    const url = fakeQdrant("1.14.1", () => docker.container?.running === true);
    const home = tmp();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: url,
      interactive: true,
      goos: "windows",
      goarch: "arm64",
      healthTimeoutMs: 5000,
    });
    const { c, out } = ctx(home);
    await setupQdrantAfterInit(c);
    expect(asked).toEqual(["Run Qdrant in Docker?"]);
    expect(out()).toContain("Qdrant runs in Docker container knowns-qdrant (created)");
    expect(loadMachineEndpoint({ HOME: home })?.source).toBe("docker");
  });

  test("nothing usable never fails init; it says how to finish later", async () => {
    const docker = new FakeDocker();
    docker.daemon = "missing";
    const home = tmp();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: true,
      goos: "windows",
      goarch: "arm64",
    });
    const { c, out } = ctx(home);
    await setupQdrantAfterInit(c);
    expect(out()).toContain("semantic search stays keyword-only");
    expect(out()).toContain("Finish later with: knowns qdrant setup");
  });

  test("a non-interactive init (no TTY) runs no detection at all", async () => {
    neverAsked();
    const docker = new FakeDocker();
    setQdrantSetupSeams({ docker: docker.runner, localURL: deadURL(), interactive: false });
    const { c, out } = ctx(tmp());
    await setupQdrantAfterInit(c);
    expect(out()).toBe("");
    expect(docker.calls).toEqual([]);
  });
});

// Fixes from the TSR-QDJ4CM / TSR-YGRPXA review.
describe("review fixes", () => {
  let home = "";
  let project = "";
  beforeEach(() => {
    const root = tmp();
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".knowns"), { recursive: true });
    writeFileSync(
      join(project, ".knowns", "config.json"),
      `${JSON.stringify({ name: "p", settings: { semanticSearch: { enabled: true, model: "m" } } })}\n`,
    );
  });
  const run = (args: string[], env: Record<string, string> = {}) =>
    runTs(["qdrant", ...args], { cwd: project, env: { HOME: home, USERPROFILE: home, ...env } });
  const recordDocker = () =>
    saveMachineEndpoint(
      {
        version: 1,
        url: "http://127.0.0.1:6333",
        source: "docker",
        docker: { container: DOCKER_CONTAINER, image: DOCKER_IMAGE, volume: DOCKER_VOLUME },
        recordedAt: "x",
      },
      { HOME: home },
    );

  test("credentials in a URL are never printed or recorded", async () => {
    const docker = new FakeDocker();
    setQdrantSetupSeams({ docker: docker.runner, localURL: deadURL(), interactive: false });
    const secret = "https://user:s3cret@q.example:6333/?api-key=tok";
    const viaEnv = await run(["setup", "--json"], { KNOWNS_QDRANT_URL: secret });
    const viaFlag = await run(["setup", "--url", secret]);
    for (const r of [viaEnv, viaFlag]) {
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).not.toContain("s3cret");
      expect(r.stdout + r.stderr).not.toContain("tok");
    }
    expect(viaFlag.stderr).toContain("must not carry credentials");
    expect(loadMachineEndpoint({ HOME: home })).toBeUndefined();
    expect(() =>
      saveMachineEndpoint(
        { version: 1, url: secret, source: "existing", recordedAt: "x" },
        { HOME: home },
      ),
    ).toThrow("must not carry credentials");
  });

  test("an unusable KNOWNS_QDRANT_URL is reported and nothing recorded is dropped", async () => {
    saveMachineEndpoint(
      { version: 1, url: "https://old.example:6333", source: "existing", recordedAt: "x" },
      { HOME: home },
    );
    const docker = new FakeDocker();
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: deadURL(),
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
    });
    const r = await run(["setup", "--yes"], { KNOWNS_QDRANT_URL: deadURL() });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("KNOWNS_QDRANT_URL is set to");
    expect(r.stderr).toContain("fix or unset it");
    expect(loadMachineEndpoint({ HOME: home })?.url).toBe("https://old.example:6333");
  });

  test("a recorded Docker setup stays Docker when the daemon is slow or down", async () => {
    recordDocker();
    const docker = new FakeDocker();
    docker.daemon = "down";
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: fakeQdrant(),
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
    });
    const r = await run(["setup", "--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(
      "a Docker setup is recorded for this machine but Docker is not usable",
    );
    expect(loadMachineEndpoint({ HOME: home })?.source).toBe("docker");
  });

  test("a recorded Docker setup with a stopped container restarts it instead of switching to managed", async () => {
    recordDocker();
    const docker = new FakeDocker();
    docker.container = { running: false, owned: true };
    const url = fakeQdrant("1.14.1", () => docker.container?.running === true);
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: url,
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
      healthTimeoutMs: 5000,
    });
    const r = await run(["setup", "--yes", "--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ choice: "docker", container: "started" });
    expect(docker.runs()).toEqual([]);
  });

  test("--managed and --url refuse to orphan a recorded Docker setup", async () => {
    recordDocker();
    const docker = new FakeDocker();
    docker.container = { running: true, owned: true };
    setQdrantSetupSeams({
      docker: docker.runner,
      localURL: fakeQdrant(),
      interactive: false,
      goos: "darwin",
      goarch: "arm64",
    });
    for (const args of [["--managed"], ["--url", fakeQdrant()]]) {
      const r = await run(["setup", ...args]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("run `knowns qdrant setup --remove` first");
    }
    expect(loadMachineEndpoint({ HOME: home })?.source).toBe("docker");
  });

  test("qdrant logs -n 0 asks Docker for 50 lines, like the managed log", async () => {
    recordDocker();
    const docker = new FakeDocker();
    docker.container = { running: true, owned: true };
    const seen: string[][] = [];
    const runner: DockerRunner = async (args, t) => {
      if (args[0] === "logs") {
        seen.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
      return docker.runner(args, t);
    };
    setQdrantSetupSeams({ docker: runner });
    await run(["logs", "-n", "0"]);
    expect(seen).toEqual([["logs", "--tail", "50", DOCKER_CONTAINER]]);
  });

  test("the machine file follows KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT", () => {
    const root = join(tmp(), "managed");
    expect(machineEndpointPath({ HOME: home, KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT: root })).toBe(
      join(root, "endpoint.json"),
    );
    expect(machineEndpointPath({ HOME: home, KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT: "~/m" })).toBe(
      join(home, "m", "endpoint.json"),
    );
  });

  test.skipIf(process.platform === "win32")(
    "the docker runner returns at its timeout even when a grandchild holds the pipes",
    async () => {
      const bin = tmp();
      writeFileSync(join(bin, "docker"), "#!/bin/sh\n(sleep 5) &\nsleep 5\n", { mode: 0o755 });
      const prev = process.env.PATH;
      process.env.PATH = `${bin}:${prev}`;
      try {
        const started = Date.now();
        const r = await defaultDockerRunner(["version"], 300);
        expect(r.code).toBe(124);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        process.env.PATH = prev;
      }
    },
  );
});
