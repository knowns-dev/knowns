// A larger synthetic project written by the real Go CLI, so the differential tests exercise
// BM25 statistics, tie-breaking and floating-point accumulation on more than a handful of documents.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goBinary } from "../history/helpers.ts";

const VOCAB = (
  "login auth session token password reset email user account profile search index query vector " +
  "embedding model runtime queue worker retry dead letter storage history lifecycle archive task doc " +
  "memory decision template config server client render layout theme button form table chart graph " +
  "deploy build release version rollback migrate schema cache lock timer time entry report export " +
  "import sync branch commit merge review comment label status priority assignee owner team"
).split(" ");

/** mulberry32: a tiny deterministic PRNG so the corpus is identical on every run. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GoProject {
  /** Project directory (cwd for the CLI). */
  project: string;
  home: string;
  run(
    args: string[],
    extraEnv?: Record<string, string>,
  ): { code: number; stdout: string; stderr: string };
  /** For tests that serve HTTP from this process: a synchronous spawn would block the server. */
  runAsync(
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function goEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    TZ: "UTC",
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    CI: "1",
    KNOWN_LSP_AUTO_INSTALL: "0",
    KNOWNS_RUNTIME_INLINE: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...extra,
  };
}

export function newGoProject(name = "diff"): GoProject {
  const bin = goBinary();
  if (!bin) throw new Error("go binary unavailable");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-search-go-")));
  const home = join(root, "home");
  const project = join(root, name);
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "."], { cwd: project });
  const run: GoProject["run"] = (args, extraEnv = {}) => {
    const res = Bun.spawnSync([bin, ...args], {
      cwd: project,
      env: goEnv(home, extraEnv),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  };
  const runAsync: GoProject["runAsync"] = async (args, extraEnv = {}) => {
    const child = Bun.spawn([bin, ...args], {
      cwd: project,
      env: goEnv(home, extraEnv),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };
  return { project, home, run, runAsync };
}

function must(p: GoProject, args: string[]) {
  const r = p.run([...args, "--plain"], { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1" });
  if (r.code !== 0) throw new Error(`knowns ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

/** Builds the corpus: tasks (all lifecycle states), docs, memories and decisions. */
export function buildCorpus(p: GoProject, seed = 7): void {
  const rnd = prng(seed);
  const words = (n: number) =>
    Array.from({ length: n }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]);
  must(p, ["init", "diff", "--no-wizard", "--no-open", "--task-prefix", "DF"]);

  const taskIds: string[] = [];
  for (let i = 0; i < 24; i++) {
    const args = ["task", "create", `${words(3).join(" ")} ${i}`, "-d", words(18).join(" ")];
    args.push("-l", words(1).join(""), "-l", words(1).join(""));
    if (i % 3 === 0) args.push("--ac", words(5).join(" "), "--ac", words(4).join(" "));
    if (i % 4 === 0) args.push("--priority", "high");
    const out = must(p, args);
    const id = /Created task (\S+):/.exec(out)?.[1];
    if (!id) throw new Error(`no task id in: ${out}`);
    taskIds.push(id);
    if (i % 5 === 0) must(p, ["task", "edit", id, "--plan", words(12).join(" ")]);
    if (i % 6 === 0) must(p, ["task", "edit", id, "--notes", words(10).join(" ")]);
  }
  // Lifecycle: a few done, a few archived, one in progress.
  for (const id of taskIds.slice(0, 4)) must(p, ["task", "edit", id, "-s", "done"]);
  for (const id of taskIds.slice(4, 7)) {
    must(p, ["task", "edit", id, "-s", "done"]);
    must(p, ["task", "archive", id, "--yes"]);
  }
  must(p, ["task", "edit", taskIds[8] as string, "-s", "in-progress"]);

  const docIds: string[] = [];
  for (let i = 0; i < 18; i++) {
    const sections = [
      `# ${words(2).join(" ")}`,
      words(14).join(" "),
      `## ${words(2).join(" ")}`,
      words(30).join(" "),
      `## ${words(3).join(" ")}`,
      words(22).join(" "),
    ].join("\n\n");
    const args = [
      "doc",
      "create",
      `${words(3).join(" ")} ${i}`,
      "-d",
      words(9).join(" "),
      "-c",
      sections,
    ];
    if (i % 2 === 0) args.push("-t", words(1).join(""));
    if (i % 3 === 0) args.push("-f", "guides");
    const out = must(p, args);
    const docId = /Created doc: (\S+)/.exec(out)?.[1];
    if (!docId) throw new Error(`no doc id in: ${out}`);
    docIds.push(docId);
  }
  // Cross references, for retrieval with reference expansion.
  for (let i = 8; i < 14; i++) {
    must(p, [
      "task",
      "edit",
      taskIds[i] as string,
      "-d",
      `${words(6).join(" ")} see @doc/${docIds[i] as string} and @task-${taskIds[(i + 1) % 24] as string}`,
    ]);
  }

  for (let i = 0; i < 8; i++) {
    must(p, [
      "memory",
      "create",
      `${words(3).join(" ")} ${i}`,
      "-c",
      words(20).join(" "),
      "--category",
      i % 2 === 0 ? "pattern" : "context",
    ]);
  }

  for (let i = 0; i < 5; i++) {
    const out = must(p, [
      "decision",
      "create",
      `${words(3).join(" ")} ${i}`,
      "--context",
      words(12).join(" "),
      "--decision",
      words(10).join(" "),
      "--tag",
      words(1).join(""),
      "--source",
      `task:${taskIds[1] as string}`,
      "--task",
      taskIds[1] as string,
    ]);
    const id = /@decision\/(\S+)/.exec(out)?.[1];
    if (id && i % 2 === 0) must(p, ["decision", "accept", id]);
  }
}

export const QUERIES = [
  "login",
  "auth session",
  "password reset email",
  "vector embedding model",
  "runtime queue worker retry",
  "deploy",
  "nonexistentterm",
  "login login auth",
  "Task Lifecycle",
  "config schema migrate cache",
  "user",
  "git-ops: merge/review",
];
