// `knowns runtime` (internal/cli/runtime.go): runtime hook installation state, the shared runtime
// daemon's processes and queue, and dead-letter retry. The hidden `__runtime` group is the daemon
// itself (`__runtime run`) and its raw status.

import { arbitraryArgs, exactArgs } from "../core/args.ts";
import { defineCommand } from "../core/define.ts";
import { getStoreErr } from "../core/helpers.ts";
import {
  StyleBold,
  StyleDim,
  StyleError,
  StyleSuccess,
  StyleWarning,
} from "../core/plainoutput.ts";
import {
  projectDisplayName,
  renderBox,
  runtimeLogsCommand,
  runtimePsCommand,
  runtimeReloadCommand,
  shorten,
} from "./runtime-ps.ts";

const install = defineCommand({
  use: "install <runtime>",
  short: "Install a runtime memory adapter",
  args: exactArgs(1),
  async run(ctx) {
    const ri = await import("../../domain/setup/runtimeinstall.ts");
    ri.install(ctx.args[0] as string, ri.defaultOptions(ctx.env, ctx.cwd));
    ctx.print(`Installed ${ctx.args[0]} runtime adapter.\n`);
  },
});

const uninstall = defineCommand({
  use: "uninstall <runtime>",
  short: "Remove a runtime memory adapter",
  args: exactArgs(1),
  async run(ctx) {
    const ri = await import("../../domain/setup/runtimeinstall.ts");
    ri.uninstall(ctx.args[0] as string, ri.defaultOptions(ctx.env, ctx.cwd));
    ctx.print(`Removed ${ctx.args[0]} runtime adapter.\n`);
  },
});

const status = defineCommand({
  use: "status",
  short: "Show runtime hook and integration installation state",
  async run(ctx) {
    const ri = await import("../../domain/setup/runtimeinstall.ts");
    const statuses = ri.statusAll(ri.defaultOptions(ctx.env, ctx.cwd));
    ri.sortStatuses(statuses);
    if (ctx.json) {
      ctx.printJSON(
        statuses.map((s) => ({
          runtime: s.runtime,
          displayName: s.displayName,
          hookKind: s.hookKind,
          available: s.available,
          installed: s.installed,
          state: s.state,
          summary: s.summary,
          ...(s.paths && s.paths.length > 0 ? { paths: s.paths } : {}),
          ...(s.details && s.details.length > 0 ? { details: s.details } : {}),
        })),
      );
      return;
    }
    if (ctx.plain) {
      for (const s of statuses) {
        ctx.print(`${s.runtime}\t${s.hookKind}\t${s.state}\tavailable=${s.available}\n`);
      }
      return;
    }
    for (const s of statuses) {
      ctx.print(`${s.displayName}\n`);
      ctx.print(`  Kind: ${s.hookKind}\n`);
      ctx.print(`  State: ${s.state}\n`);
      ctx.print(`  Available: ${s.available}\n`);
      if (s.details && s.details.length > 0) ctx.print(`  Details: ${s.details.join("; ")}\n`);
    }
  },
});

interface RetryRefusal {
  jobId: string;
  error: string;
}

interface RetryResult {
  root: string;
  released: unknown[];
  refused: RetryRefusal[];
  error: string;
}

type RetryJob = import("../../runtime/queue.ts").Job;

function retryExplicitJobs(
  q: typeof import("../../runtime/queue.ts"),
  root: string,
  ids: string[],
  dryRun: boolean,
): { released: RetryJob[]; refused: RetryRefusal[] } {
  const released: RetryJob[] = [];
  const refused: RetryRefusal[] = [];
  if (!dryRun) {
    for (const id of ids) {
      try {
        released.push(q.retryJob(root, id));
      } catch (err) {
        refused.push({ jobId: id, error: (err as Error).message });
      }
    }
    return { released, refused };
  }
  let jobs: RetryJob[];
  try {
    jobs = q.loadQueue(root).jobs;
  } catch (err) {
    for (const id of ids) refused.push({ jobId: id, error: (err as Error).message });
    return { released, refused };
  }
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const id of ids) {
    const job = byId.get(id);
    if (!job) refused.push({ jobId: id, error: "job not found" });
    else if (!q.isReleasableDeadLetter(job)) {
      refused.push({ jobId: id, error: "not a qdrant dead letter" });
    } else released.push(job);
  }
  return { released, refused };
}

function retryError(results: RetryResult[]): Error | undefined {
  const problems: string[] = [];
  for (const r of results) {
    if (r.error !== "") problems.push(`${projectDisplayName(r.root)}: ${r.error}`);
    for (const f of r.refused) problems.push(`${f.jobId}: ${f.error}`);
  }
  return problems.length === 0 ? undefined : new Error(`runtime retry: ${problems.join("; ")}`);
}

const retry = defineCommand({
  use: "retry [jobID...]",
  short: "Release retained Qdrant dead-letter jobs back to the scheduler",
  long: `Release retained Qdrant dead-letter jobs so the runtime schedules them again.

A job is dead-lettered once it exhausts its 8-attempt retry budget. During an
extended Qdrant outage every pending reconcile job can exhaust that budget at
the same time, stranding a whole backlog: nothing else clears the flag, and
the entity is never indexed unless it happens to be edited again.

Pass explicit job IDs to release specific jobs, --all to release every dead
letter in the current project, or --all-projects to sweep every project
registered with the shared runtime. --dry-run reports what would be released
without acquiring the queue lock or mutating anything.`,
  args: arbitraryArgs,
  flags: [
    {
      type: "bool",
      name: "all",
      usage: "Release every retained Qdrant dead letter in the current project",
      default: false,
    },
    {
      type: "bool",
      name: "all-projects",
      usage: "Release every retained Qdrant dead letter across all registered projects",
      default: false,
    },
    {
      type: "bool",
      name: "dry-run",
      usage: "Report what would be released without mutating the queue",
      default: false,
    },
  ],
  async run(ctx) {
    const all = ctx.flags.bool("all");
    const allProjects = ctx.flags.bool("all-projects");
    const dryRun = ctx.flags.bool("dry-run");
    const args = ctx.args;
    if (args.length > 0 && (all || allProjects)) {
      throw new Error("cannot combine explicit job IDs with --all or --all-projects");
    }
    if (args.length === 0 && !all && !allProjects) {
      throw new Error("specify job IDs, or use --all / --all-projects");
    }
    const q = await import("../../runtime/queue.ts");
    let roots: string[];
    if (allProjects) {
      roots = q.loadStatus().projects.map((p) => p.projectRoot);
    } else {
      const store = await getStoreErr(ctx.cmd);
      roots = [store.root];
    }
    const results: RetryResult[] = [];
    for (const root of roots) {
      const result: RetryResult = { root, released: [], refused: [], error: "" };
      try {
        if (args.length > 0) {
          const r = retryExplicitJobs(q, root, args, dryRun);
          result.released = r.released;
          result.refused = r.refused;
        } else if (dryRun) {
          result.released = q.listDeadLetters(root);
        } else {
          result.released = q.retryDeadLetters(root);
        }
      } catch (err) {
        result.error = (err as Error).message;
      }
      results.push(result);
    }
    if (ctx.json) {
      ctx.printJSON({
        dryRun,
        results: results.map((r) => ({
          root: r.root,
          released: (r.released as RetryJob[]).map(q.jobJson),
          ...(r.refused.length > 0 ? { refused: r.refused } : {}),
          ...(r.error ? { error: r.error } : {}),
        })),
      });
    } else {
      ctx.print(
        renderRetry(results as (RetryResult & { released: RetryJob[] })[], dryRun, ctx.plain),
      );
    }
    const err = retryError(results);
    if (err) throw err;
  },
});

function renderRetry(
  results: (RetryResult & { released: RetryJob[] })[],
  dryRun: boolean,
  plain: boolean,
): string {
  let out = "";
  const mode = dryRun ? "preview" : "release";
  if (plain) {
    for (const r of results) {
      const project = projectDisplayName(r.root);
      if (r.error !== "") {
        out += `retry-error\t${project}\terror=${r.error}\n`;
        continue;
      }
      out += `retry\t${project}\tmode=${mode}\treleased=${r.released.length}\trefused=${r.refused.length}\n`;
      for (const job of r.released) {
        out += `retry-job\t${project}\t${job.id}\t${job.kind}\t${shorten(job.target ?? "")}\n`;
      }
      for (const f of r.refused) out += `retry-refused\t${project}\t${f.jobId}\terror=${f.error}\n`;
    }
    return out;
  }
  const verb = dryRun ? "Would release" : "Released";
  let totalReleased = 0;
  let totalRefused = 0;
  for (const r of results) {
    totalReleased += r.released.length;
    totalRefused += r.refused.length;
  }
  out += `${StyleBold.render("Runtime retry")}  ${StyleDim.render(`${mode} · ${results.length} project(s)`)}\n\n`;
  for (const r of results) {
    const project = projectDisplayName(r.root);
    if (r.error !== "") {
      out += `${renderBox(project, [StyleError.render(`✗ ${r.error}`)])}\n\n`;
      continue;
    }
    const lines: string[] = [StyleSuccess.render(`${verb} ${r.released.length} dead letter(s)`)];
    for (const job of r.released) lines.push(`  ${job.id}  ${shorten(job.target ?? "")}`);
    for (const f of r.refused) lines.push(StyleWarning.render(`  ${f.jobId} refused: ${f.error}`));
    out += `${renderBox(project, lines)}\n\n`;
  }
  let summary = `${verb} ${totalReleased} job(s) across ${results.length} project(s)`;
  if (totalRefused > 0) summary += `  ${StyleWarning.render(`${totalRefused} refused`)}`;
  out += `${StyleDim.render(summary)}\n`;
  return out;
}

const stop = defineCommand({
  use: "stop",
  short: "Request the shared runtime to shut down gracefully",
  async run(ctx) {
    const q = await import("../../runtime/queue.ts");
    if (!q.isRunning()) {
      ctx.print("Runtime is not running.\n");
      return;
    }
    q.requestShutdown(10_000);
    ctx.print("Runtime stopped.\n");
  },
});

export default defineCommand({
  use: "runtime",
  short: "Install and inspect runtime hooks and status integrations",
  subcommands: [
    install,
    uninstall,
    status,
    runtimePsCommand,
    runtimeReloadCommand,
    stop,
    runtimeLogsCommand,
    retry,
  ],
});
