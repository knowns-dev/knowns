// `knowns store` (internal/cli/store_cmd.go and store_status_cmd.go): keep project knowledge in a
// shared Git store instead of the repository. Heavy modules load inside the handlers so the
// command costs nothing at startup.
import { basename, join } from "node:path";
import { arbitraryArgs, exactArgs, noArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";

const goQuote = (s: string): string => JSON.stringify(s);

const link = defineCommand({
  use: "link <remote>",
  short: "Link this repository to a knowledge store",
  long: `Link the current code repository to a project folder in a store: a Git
repository that holds the knowledge of one or more projects.

The store is cloned into ~/.knowns/stores/<store>/ when it is not already
present, the project folder is created or adopted, and the link is recorded
in ~/.knowns/registry.json. No file is written into the code repository.

Git uses your existing ssh-agent or credential helper; Knowns never stores a
credential and never prompts.`,
  args: exactArgs(1),
  flags: [
    {
      type: "string",
      name: "as",
      usage: "Project folder name in the store (default: current directory name)",
      default: "",
    },
    {
      type: "string",
      name: "store",
      usage: "Store folder name under ~/.knowns/stores (default: derived from the remote)",
      default: "",
    },
    {
      type: "bool",
      name: "migrate",
      usage:
        "Copy this repository's .knowns/ into the store folder, keeping every ID; the repository is left untouched",
      default: false,
    },
  ],
  async run(ctx) {
    await runLink(ctx);
  },
});

async function runLink(ctx: CommandContext): Promise<void> {
  const sync = await import("../../domain/storesync/index.ts");
  const { Registry } = await import("../../storage/stores/registry.ts");
  const { Store } = await import("../../storage/core/store.ts");
  const { ensureStoreGitignore } = await import("../../storage/core/store-clone.ts");
  const { locateProjectAt } = await import("../../storage/core/project-location.ts");
  const { existsSync } = await import("node:fs");

  const remote = (ctx.args[0] as string).trim();
  const codeRoot = ctx.cwd;
  let project = ctx.flags.string("as");
  if (project === "") project = basename(codeRoot);
  let storeName = ctx.flags.string("store");
  if (storeName === "") storeName = sync.storeNameFromRemote(remote);
  const migrate = ctx.flags.bool("migrate");
  const inRepo = join(codeRoot, ".knowns");
  if (migrate && !sync.isInitializedFolder(inRepo)) {
    throw new Error(`--migrate needs an initialized ${inRepo} to move into the store`);
  }

  const reg = new Registry();
  try {
    reg.load();
  } catch (e) {
    throw new Error(`read registry: ${(e as Error).message}`);
  }
  const mapping = { name: storeName, project, remote };
  if (!sync.isStoreSegment(storeName) || !sync.isStoreSegment(project)) {
    throw new Error(
      `store name ${goQuote(storeName)} and project ${goQuote(project)} must each be a single folder name; use --store and --as to choose them`,
    );
  }

  const clone = join(reg.storesRoot(), storeName);
  const cloned = await sync.ensureStoreClone(undefined, clone, remote);

  ensureStoreGitignore(clone);

  const folder = join(clone, project);
  const adopted = sync.isInitializedFolder(folder);
  let migrated: ReturnType<typeof sync.copyKnowledge> | undefined;
  if (migrate) {
    if (sync.folderHasContent(folder)) {
      throw new Error(
        `store folder ${folder} already has content; migrate into another folder with --as`,
      );
    }
    try {
      migrated = sync.copyKnowledge(inRepo, folder);
    } catch (e) {
      throw new Error(`copy ${inRepo} into the store: ${(e as Error).message}`);
    }
  } else if (!adopted) {
    try {
      Store.open(folder).init(project);
      // Go's Init writes time.json through TimeStore.SaveState, which takes the task lifecycle
      // lock and so leaves .search/locks/tasks.lock behind; Store.init here writes it directly.
      const { withTaskLifecycleLock } = await import("../../storage/core/locks.ts");
      await withTaskLifecycleLock(folder, () => undefined);
    } catch (e) {
      throw new Error(`initialize project folder ${folder}: ${(e as Error).message}`);
    }
  }

  reg.addStoreLinked(codeRoot, mapping);
  if (migrated) {
    // Move personal and machine settings out of the team file before the first sync commits it (D13).
    let loc: ReturnType<typeof locateProjectAt> | undefined;
    try {
      loc = locateProjectAt(codeRoot);
    } catch {
      loc = undefined;
    }
    if (loc) {
      const { createStorage } = await import("../../storage/adapters.ts");
      const { config } = createStorage(Store.open(loc.knowledgeRoot));
      let loaded: ReturnType<typeof config.load> | undefined;
      try {
        loaded = config.load();
      } catch {
        loaded = undefined;
      }
      if (loaded) {
        try {
          config.save(loaded);
        } catch (e) {
          throw new Error(`split migrated configuration: ${(e as Error).message}`);
        }
      }
    }
  }
  // The shared runtime keeps the store in sync from now on.
  try {
    (await import("../../runtime/queue.ts")).ensureDaemon();
  } catch (e) {
    ctx.printErr(
      `Warning: could not start the runtime that syncs the store: ${(e as Error).message}\n`,
    );
  }

  let action = "Created";
  if (adopted) action = "Adopted";
  if (migrated) action = "Migrated into";
  if (cloned) ctx.print(`Cloned store ${remote} into ${clone}\n`);
  ctx.print(`${action} project folder ${folder}\n`);
  ctx.print(`Linked ${codeRoot} to store ${goQuote(storeName)} (project ${goQuote(project)})\n`);
  if (migrated) {
    ctx.print(sync.migrationReportText(migrated, inRepo));
    return;
  }
  if (existsSync(join(codeRoot, ".knowns"))) {
    ctx.printErr(
      `Warning: ${join(codeRoot, ".knowns")} is ignored from now on; move its contents into the store before removing it.\n`,
    );
  }
}

const unlink = defineCommand({
  use: "unlink",
  short: "Remove this repository's link to a knowledge store",
  long: `Remove the store link recorded for the current code repository. The store
clone and the code repository are left intact.`,
  args: noArgs,
  async run(ctx) {
    const { Registry } = await import("../../storage/stores/registry.ts");
    const { locateProject } = await import("../../storage/core/project-location.ts");
    const cwd = ctx.cwd;
    let loc: ReturnType<typeof locateProject> | undefined;
    try {
      loc = locateProject(cwd);
    } catch {
      loc = undefined;
    }
    if (!loc?.store) throw new Error(`no store is linked for ${cwd}`);
    const reg = new Registry();
    try {
      reg.load();
    } catch (e) {
      throw new Error(`read registry: ${(e as Error).message}`);
    }
    const p = reg.findStoreLinked(loc.projectRoot);
    if (!p) throw new Error(`no store is linked for ${loc.projectRoot}`);
    reg.clearStore(p.path);
    ctx.print(
      `Unlinked ${p.path} from store ${goQuote(loc.store.name)}; the store clone at ${loc.knowledgeRoot} was left in place\n`,
    );
  },
});

const status = defineCommand({
  use: "status",
  short: "Show sync state for every repository linked to a store",
  long: `Show, for every repository linked to a knowledge store on this machine, the
store and project folder, the last push and fetch, commits waiting to be pushed,
and whether sync is healthy or paused and why.`,
  args: noArgs,
  async run(ctx) {
    const support = await import("./store-support.ts");
    const rows = await support.collectStoreStatus(await support.storeStateDir());
    if (ctx.json) {
      ctx.print(`${rows.length === 0 ? "null" : support.rowsJson(rows)}\n`);
      return;
    }
    ctx.print(support.statusText(rows, Date.now()));
    if (rows.length > 0) {
      const q = await import("../../runtime/queue.ts");
      if (!q.isRunning() && !q.shouldBypassDaemon()) {
        ctx.print(
          "\nThe runtime that syncs stores is not running; any Knowns command that writes knowledge starts it, as does 'knowns store resolve'.\n",
        );
      }
    }
  },
});

const resolve = defineCommand({
  use: "resolve [project] [path...]",
  short: "Settle conflicting changes that paused a project's sync",
  long: `Without arguments, list projects paused by a conflict and their conflicting
entities. With a project, show the version in the store's history (remote) and
the version on this machine (local) for each conflicting path, or for the paths
given. With --keep, apply that choice to each of them and let sync resume:

  local   keep this machine's version; it is pushed once sync resumes
  remote  keep the version already in the store
  both    keep this machine's version in place and save the remote version
          beside the runtime state

Nothing is discarded without an explicit --keep.`,
  args: arbitraryArgs,
  flags: [
    {
      type: "string",
      name: "keep",
      usage: "Version to keep for each conflicting entity: local, remote or both",
      default: "",
    },
    {
      type: "string",
      name: "store",
      usage: "Store name, when the project folder name exists in more than one store",
      default: "",
    },
  ],
  async run(ctx) {
    const support = await import("./store-support.ts");
    await support.runResolve(ctx);
  },
});

export default defineCommand({
  use: "store",
  short: "Keep project knowledge in a shared Git store instead of the repository",
  subcommands: [link, unlink, status, resolve],
});
