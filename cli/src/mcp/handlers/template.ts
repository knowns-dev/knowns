// Port of internal/mcp/handlers/template.go.
import { goQuote } from "../../cli/core/gofmt.ts";
import { errFailed, errNotFound, noProjectError, stringArg } from "../args.ts";
import { goMap, goSprintV, marshalIndent } from "../gojson.ts";
import type { McpState } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";

const MsgDryRunTemplate = "Dry run: no files were written. Set dryRun: false to generate files.";
const MsgTemplateNotImpl =
  "Template execution (non-dry-run) is not yet implemented in the Go MCP server. Use the TypeScript CLI for template generation.";

export async function handle(
  state: McpState,
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  const project = state.getProject();
  switch (a.value) {
    case "list": {
      if (!project) return noProjectError();
      try {
        return textResult(marshalIndent(project.storage.templates.list()));
      } catch (e) {
        return errFailed("list templates", e);
      }
    }
    case "get": {
      if (!project) return noProjectError();
      const n = requireString(req, "name");
      if (!n.ok) return errorResult(n.error);
      try {
        return textResult(marshalIndent(project.storage.templates.get(n.value)));
      } catch (e) {
        return errNotFound("Template", e);
      }
    }
    case "run": {
      if (!project) return noProjectError();
      const n = requireString(req, "name");
      if (!n.ok) return errorResult(n.error);
      const args = argsOf(req);
      let dryRun = true;
      if (Object.hasOwn(args, "dryRun") && typeof args.dryRun === "boolean") dryRun = args.dryRun;
      const variables: Record<string, string> = {};
      const v = args.variables;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v)) {
          variables[k] = typeof val === "string" ? val : goSprintV(val);
        }
      }
      let tmpl: ReturnType<typeof project.storage.templates.get>;
      try {
        tmpl = project.storage.templates.get(n.value);
      } catch (e) {
        return errNotFound("Template", e);
      }
      if (dryRun) {
        const files: string[] = [];
        for (const action of tmpl.actions ?? []) if (action.path) files.push(action.path);
        return textResult(
          marshalIndent(
            goMap({
              dryRun: true,
              template: tmpl.name,
              variables: goMap(variables),
              actions: tmpl.actions ?? null,
              files: files.length === 0 ? null : files,
              message: MsgDryRunTemplate,
            }),
          ),
        );
      }
      return textResult(
        marshalIndent(
          goMap({
            success: false,
            template: tmpl.name,
            variables: goMap(variables),
            message: MsgTemplateNotImpl,
          }),
        ),
      );
    }
    case "create": {
      if (!project) return noProjectError();
      const n = requireString(req, "name");
      if (!n.ok) return errorResult(n.error);
      const [description] = stringArg(argsOf(req), "description");
      try {
        project.storage.templates.create(n.value, description);
      } catch (e) {
        return errFailed("create template", e);
      }
      try {
        return textResult(marshalIndent(project.storage.templates.get(n.value)));
      } catch {
        return textResult(
          marshalIndent(
            goMap({
              success: true,
              name: n.value,
              message: `Template '${n.value}' created successfully`,
            }),
          ),
        );
      }
    }
    default:
      return errorResult(`unknown templates action: ${a.value}`);
  }
}

void goQuote;
