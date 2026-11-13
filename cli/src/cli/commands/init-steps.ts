// The step runner of internal/cli/init_steps.go. Go animates a goroutine spinner on stderr; the
// frame count depends on how long a step takes, so only the stable parts are written here: the
// first frame, the clearing of the line, and the final "✓ label" or "✗ label error" line.
import type { CommandContext } from "../core/define.ts";
import { StyleDim, StyleSuccess, StyleWarning } from "../core/plainoutput.ts";

export interface InitStep {
  label: string;
  run: () => void | Promise<void>;
}

const FIRST_FRAME = "⠋";

async function runStep(ctx: CommandContext, step: InitStep): Promise<void> {
  ctx.printErr(`\r  ${StyleDim.render(FIRST_FRAME)} ${step.label}`);
  let err: Error | undefined;
  try {
    await step.run();
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
  }
  ctx.printErr(`\r  ${"  "} ${" ".repeat(step.label.length + 2)}`);
  if (err) {
    ctx.printErr(
      `\r  ${StyleWarning.render("✗")} ${step.label} ${StyleWarning.render(err.message)}\n`,
    );
    throw err;
  }
  ctx.printErr(`\r  ${StyleSuccess.render("✓")} ${step.label}\n`);
}

/** runInitSteps: run the steps in order; the first failure stops the run and is rethrown. */
export async function runInitSteps(ctx: CommandContext, steps: InitStep[]): Promise<void> {
  for (const step of steps) await runStep(ctx, step);
}
