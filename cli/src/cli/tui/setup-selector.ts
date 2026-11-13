// The platform multi-select of `knowns setup` without a target (runSetupSelector in
// internal/cli/setup.go): at least one platform, claude-code, opencode and agents preselected.
import type { Env } from "../../domain/setup/env.ts";
import { platformOptions } from "./labels.ts";
import type { Prompter } from "./prompter.ts";

export async function runSetupSelector(
  prompter: Prompter,
  env: Env,
  cwd: string,
): Promise<string[]> {
  return prompter.multiselect({
    title: "AI platforms to integrate",
    description:
      "Choose which platforms to generate config and instruction files for.\n" +
      "At least one platform must be selected.",
    options: platformOptions(["claude-code", "opencode", "agents"], env, cwd),
    validate: (s) => (s.length === 0 ? "select at least one platform" : undefined),
  });
}
