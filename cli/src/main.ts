import { cliArgsSchema, parseBoundary } from "./schema/index.ts";
import { getUiAsset } from "./ui.ts";
import { VERSION } from "./version.ts";

export function parseArgs(argv: string[]) {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "-v") raw.version = true;
    else if (a === "--debug-ui-asset") raw.debugUiAsset = argv[++i];
  }
  return parseBoundary(cliArgsSchema, raw, "arguments");
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.version) {
    // Matches the Go binary (cobra): "knowns version X.Y.Z"
    process.stdout.write(`knowns version ${VERSION}\n`);
    return 0;
  }
  if (args.debugUiAsset !== undefined) {
    const asset = getUiAsset(args.debugUiAsset);
    if (!asset) {
      process.stderr.write(`ui asset not found: ${args.debugUiAsset}\n`);
      return 1;
    }
    process.stdout.write(`${asset.size} ${asset.type}\n`);
    return 0;
  }
  process.stderr.write("knowns (typescript stub): only --version is implemented\n");
  return 1;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
