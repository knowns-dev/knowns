// `knowns settings` (runSettings in internal/cli/config.go): the interactive project settings
// menu, or with --global the defaults future `knowns init` runs start from. The menus live in
// tui/settings-flow.ts and are written against the Prompter seam.
import { defineCommand } from "../core/define.ts";

export default defineCommand({
  use: "settings",
  short: "Open interactive project settings",
  flags: [
    {
      type: "bool",
      name: "global",
      usage: "Edit global defaults for future knowns init runs",
      default: false,
    },
  ],
  async run(ctx) {
    const { createPrompter } = await import("../tui/prompter.ts");
    const flow = await import("../tui/settings-flow.ts");
    const deps = {
      prompter: createPrompter(),
      print: (t: string) => ctx.print(t),
      env: ctx.env,
      cwd: ctx.cwd,
    };
    if (ctx.flags.bool("global")) {
      await flow.runGlobalSettings(deps);
      return;
    }
    const store = await ctx.getStore();
    const { createStorage } = await import("../../storage/adapters.ts");
    await flow.runProjectSettings(deps, createStorage(store).config);
  },
});
