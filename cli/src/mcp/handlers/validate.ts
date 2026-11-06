// Port of internal/mcp/handlers/validate.go.
import { boolArg, noProjectError, stringArg } from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import type { McpState } from "../state.ts";
import { argsOf, type CallToolRequest, type CallToolResult, textResult } from "../tool.ts";

export async function handle(
  state: McpState,
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  let scope = "all";
  const [v, ok] = stringArg(args, "scope");
  if (ok && v !== "") scope = v;
  const [entity] = stringArg(args, "entity");
  const strict = boolArg(args, "strict");
  const fix = boolArg(args, "fix");

  const { run } = await import("../../domain/validate/index.ts");
  const result = run(project.storage, { scope, entity, strict, fix });
  const output = goMap({
    valid: result.valid,
    strict,
    scope,
    issues: result.issues,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    infoCount: result.infoCount,
    summary: `${result.errorCount} errors, ${result.warningCount} warnings, ${result.infoCount} info`,
  });
  return textResult(marshalIndent(output));
}
