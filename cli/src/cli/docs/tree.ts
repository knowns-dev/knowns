/**
 * The full TypeScript command tree for the CLI reference generator and the docs lint
 * (scripts/gen-cli-docs.ts). Root commands are lazy placeholders until a run selects them, so this
 * builds every one of them first.
 */
import type { Command } from "../core/command.ts";
import { createRoot } from "../core/root.ts";

/** Materializes every lazy command, depth first, so the tree is complete. */
async function materializeAll(cmd: Command): Promise<void> {
  for (const child of [...cmd.commands()]) {
    await child.materialize();
  }
  for (const child of cmd.commands()) await materializeAll(child);
}

/** The root command with every command built, as `knowns` would see it. */
export async function loadCommandTree(): Promise<Command> {
  const root = createRoot();
  await materializeAll(root);
  return root;
}
