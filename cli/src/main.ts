import { cliArgsSchema, parseBoundary } from "./schema/index.ts";
import { getUiAsset } from "./ui.ts";

export function parseArgs(argv: string[]) {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "-v") raw.version = true;
    else if (a === "--debug-ui-asset") raw.debugUiAsset = argv[++i];
  }
  return parseBoundary(cliArgsSchema, raw, "arguments");
}

/**
 * Entry point. `--debug-ui-asset <path>` is a build-proof flag (not a command, not in help) that
 * checks an asset is readable from the compiled binary; everything else goes to the CLI framework.
 * The framework is imported lazily so the debug path and `--version` do not pay for modules
 * they do not use.
 */
export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "--debug-ui-asset") {
    const args = parseArgs(argv);
    const asset = getUiAsset(args.debugUiAsset ?? "");
    if (!asset) {
      process.stderr.write(`ui asset not found: ${args.debugUiAsset}\n`);
      return 1;
    }
    process.stdout.write(`${asset.size} ${asset.type}\n`);
    return 0;
  }
  const { execute } = await import("./cli/core/root.ts");
  return execute(argv);
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
