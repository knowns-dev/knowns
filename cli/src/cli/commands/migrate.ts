// `knowns migrate` (internal/cli/migrate.go): preview or apply the registered project config
// schema migrations. Preview (no flag) changes nothing; --write applies and stamps the version.
import { noArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { getStoreErr } from "../core/helpers.ts";
import { renderCmd, renderHint, renderSuccess, StyleBold } from "../core/plainoutput.ts";

async function printPostMigrationSteps(ctx: CommandContext, heading: string): Promise<void> {
  const { recommendedModels, OLLAMA_INSTALL_URL, OLLAMA_GUIDANCE_DOCS_URL } = await import(
    "../../storage/stores/embedding-registry-defaults.ts"
  );
  let pull = "";
  for (const m of recommendedModels()) {
    if (m.default) {
      pull = m.pullCommand;
      break;
    }
    if (pull === "") pull = m.pullCommand;
  }
  ctx.print(`${StyleBold.render(heading)}\n`);
  ctx.print(`  1. Install Ollama: ${OLLAMA_INSTALL_URL}\n`);
  ctx.print(`  2. Pull the model: ${pull}\n`);
  ctx.print(`  3. Reindex: ${renderCmd("knowns search index --wait")}\n`);
  ctx.print(`${renderHint(`  Read more: ${OLLAMA_GUIDANCE_DOCS_URL}`)}\n`);
}

export default defineCommand({
  use: "migrate",
  short: "Apply pending project config schema migrations",
  long:
    "Preview or apply registered project config schema migrations.\n\n" +
    "Preview (no flags) reports what is pending and changes nothing. " +
    "--write applies every pending migration in order and stamps the new " +
    "schema version. There is no rollback subcommand: the config is in " +
    "git, and git is the rollback.",
  args: noArgs,
  flags: [
    {
      type: "bool",
      name: "write",
      usage: "Apply pending migrations and write the config",
      default: false,
    },
  ],
  async run(ctx) {
    const write = ctx.flags.bool("write");
    const mig = await import("../../storage/stores/migrations.ts");
    const { createStorage } = await import("../../storage/adapters.ts");
    const store = await getStoreErr(ctx.cmd);
    const { config } = createStorage(store);
    let project: ReturnType<typeof config.load>;
    try {
      project = config.load();
    } catch (e) {
      throw new Error(`load config: ${(e as Error).message}`);
    }

    if (write) {
      const from = project.schemaVersion ?? 0;
      const result = mig.applyMigrations(project);
      if (!mig.migrationPending(result)) {
        if (ctx.json) ctx.printJSON(mig.migrationResultJson(result));
        else
          ctx.print(
            `${renderSuccess(`Nothing to migrate. Config is at schema version ${from}.`)}\n`,
          );
        return;
      }
      try {
        config.save(project);
      } catch (e) {
        throw new Error(`save migrated config: ${(e as Error).message}`);
      }
      if (ctx.json) {
        ctx.printJSON(mig.migrationResultJson(result));
        return;
      }
      ctx.print(
        `${renderSuccess(
          `Applied ${result.applied.length} migration(s). Config is now at schema version ${result.toVersion}.`,
        )}\n`,
      );
      for (const line of result.changes) ctx.print(`  ${line}\n`);
      if (result.changes.length === 0) {
        ctx.print(
          `${renderHint("Only the schema version was recorded; no further action is needed.")}\n`,
        );
        return;
      }
      ctx.print("\n");
      await printPostMigrationSteps(ctx, "Next steps:");
      ctx.print("\n");
      ctx.print(`${renderHint("Review and commit the updated .knowns/config.json.")}\n`);
      return;
    }

    const result = mig.previewMigrations(project);
    if (ctx.json) {
      ctx.printJSON(mig.migrationResultJson(result));
      return;
    }
    if (!mig.migrationPending(result)) {
      ctx.print(
        `${renderSuccess(
          `Nothing to migrate. Config is at schema version ${project.schemaVersion ?? 0}.`,
        )}\n`,
      );
      return;
    }
    ctx.print(
      `${StyleBold.render(
        `${result.applied.length} pending migration(s) (schema version ${result.fromVersion} -> ${result.toVersion}):`,
      )}\n`,
    );
    for (const m of mig.pendingMigrations(project.schemaVersion ?? 0)) {
      ctx.print(`  v${m.version}  ${m.description}\n`);
    }
    for (const line of result.changes) ctx.print(`    ${line}\n`);
    if (result.changes.length === 0) {
      ctx.print(`${renderHint("    No field changes; this records the schema version.")}\n`);
    }
    ctx.print("\n");
    ctx.print(
      `${renderHint(`No files were changed. Run ${renderCmd("knowns migrate --write")} to apply.`)}\n`,
    );
    if (result.changes.length > 0) {
      ctx.print("\n");
      await printPostMigrationSteps(ctx, "After applying, you will need:");
    }
  },
});
