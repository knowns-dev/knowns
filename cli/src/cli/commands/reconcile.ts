// `knowns reconcile` (internal/cli/reconcile.go).
//
// Spec decision D7: the manual preview and apply modes are removed. In 0.34.1 they were the bare
// command (preview) and `--execute` (apply); a word after `reconcile` such as `preview` or `apply`
// was ignored and ran the preview. All of those now fail with a removal message. The reconciler
// itself runs automatically (runtime watcher, store sync, hard-delete), and `reconcile restore`
// stays as the one user-facing recovery operation (decision a-briefly-missing-file-is-not-a-deletion).
import { NotTombstonedError } from "../../domain/reconcile/fs-util.ts";
import { planTombstoneRestore, restoreTombstoned } from "../../domain/reconcile/restore.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { arbitraryArgs, exactArgs } from "../core/args.ts";
import type { Command } from "../core/command.ts";
import { defineCommand } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import { getStoreErr } from "../core/helpers.ts";
import { docHooks } from "./doc-hooks.ts";
import { cliLifecycleActor, taskLifecycleSeams } from "./task-lifecycle.ts";

export const RECONCILE_REMOVED_MESSAGE =
  "'knowns reconcile' preview and apply were removed. The reconciler now runs automatically in the runtime, so there is nothing to preview or apply by hand. Use 'knowns reconcile restore <task|doc> <id-or-path>' to undo a recorded deletion.";

const restoreCmd = defineCommand({
  use: "restore <task|doc> <id-or-path>",
  short: "Preview or reactivate a Task or Doc whose history records a deletion",
  long: `Reactivate a Task or Doc whose history head is a delete tombstone.

A Task is named by its ID and a Doc by its path. Without --execute the command
only reports what it would do. It refuses when the file on disk holds content
the tombstone did not record, so it never adopts bytes the entity did not own.

This is not "task unarchive": unarchive reopens an archived Task, restore undoes
a recorded deletion.`,
  args: exactArgs(2),
  flags: [
    {
      type: "bool",
      name: "execute",
      usage: "reactivate the entity (default is preview)",
      default: false,
    },
  ],
  async run(ctx) {
    const execute = ctx.flags.bool("execute");
    const rawKind = ctx.args[0] ?? "";
    const ref = ctx.args[1] ?? "";
    const kind = goTrimSpace(rawKind).toLowerCase();
    if (kind !== "task" && kind !== "doc") {
      throw new Error(`unknown entity type ${goQuote(rawKind)}: use task or doc`);
    }
    const { createStorage } = await import("../../storage/adapters.ts");
    const storage = createStorage(await getStoreErr(ctx.cmd as Command));
    const plan = await planTombstoneRestore(storage, kind, ref);
    if (!plan.tombstoned) {
      if (execute) throw new NotTombstonedError(`${plan.entityType} ${ref}`);
      ctx.print(
        `not-tombstoned type=${plan.entityType} id=${plan.entityId} path=${plan.path} revision=${plan.revision}\n`,
      );
      return;
    }
    if (!execute) {
      ctx.print(
        `would-restore type=${plan.entityType} id=${plan.entityId} path=${plan.path} revision=${plan.revision} file-present=${plan.filePresent}\n`,
      );
      return;
    }
    const result = await restoreTombstoned(storage, plan, cliLifecycleActor(ctx.env));
    if (plan.entityType === "task") {
      try {
        await taskLifecycleSeams.indexTask?.(storage, plan.entityId);
      } catch {
        // Best effort, as search.BestEffortIndexTask.
      }
    } else {
      docHooks.indexDoc(storage, plan.docPath ?? "");
    }
    ctx.print(
      `restored type=${plan.entityType} id=${plan.entityId} path=${plan.path} revision=${result.revision} hash=${result.newHash}\n`,
    );
  },
});

export default defineCommand({
  use: "reconcile",
  short: "Preview or apply canonical Task/Doc filesystem reconciliation",
  args: arbitraryArgs,
  silenceUsage: true,
  flags: [
    {
      type: "bool",
      name: "execute",
      usage: "apply revisions and manifest updates (default is preview)",
      default: false,
    },
    {
      type: "bool",
      name: "wait",
      usage: "wait for the reconciliation job to complete",
      default: false,
    },
  ],
  run() {
    throw new Error(RECONCILE_REMOVED_MESSAGE);
  },
  subcommands: [restoreCmd],
});
