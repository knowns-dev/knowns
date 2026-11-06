// Port of internal/mcp/audit.go: every completed tool call becomes one audit event in
// ~/.knowns/audit.jsonl, written before the response leaves the process.
import type { AuditEvent } from "../models/audit.ts";
import { type Args, goSprintV } from "./gojson.ts";
import { classifyAction, isDryRun, lifecyclePreview } from "./permissions.ts";
import type { CallToolRequest, CallToolResult } from "./tool.ts";

export interface PendingCall {
  startedAt: Date;
  toolName: string;
  action: string;
}

const CONTENT_FIELDS = new Set([
  "content",
  "appendcontent",
  "description",
  "notes",
  "appendnotes",
  "plan",
  "note",
]);

/** extractEntityRefs: lightweight entity references from the arguments. */
export function extractEntityRefs(tool: string, args: Args): string[] {
  const refs: string[] = [];
  const s = (k: string): string => (typeof args[k] === "string" ? (args[k] as string) : "");
  if (s("taskId")) refs.push(`task:${s("taskId")}`);
  if (s("path")) refs.push(`doc:${s("path")}`);
  if (s("id") && tool === "memory") refs.push(`memory:${s("id")}`);
  if (s("name") && tool === "templates") refs.push(`template:${s("name")}`);
  if (s("spec")) refs.push(`spec:${s("spec")}`);
  return refs;
}

/** Go slices strings by byte; cut at a UTF-8 boundary the way s[:n] would on ASCII. */
function byteSlice(s: string, n: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return s;
  return buf.subarray(0, n).toString("utf8");
}
const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** summarizeArgs: a privacy-safe summary; large content fields log their size only. */
export function summarizeArgs(args: Args): Record<string, string> | undefined {
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  const summary: Record<string, string> = {};
  for (const k of keys) {
    if (k === "action") continue;
    const v = args[k];
    if (CONTENT_FIELDS.has(k.toLowerCase())) {
      if (typeof v === "string") summary[k] = `[${byteLen(v)} chars]`;
      continue;
    }
    let s = goSprintV(v);
    if (byteLen(s) > 100) s = `${byteSlice(s, 97)}...`;
    summary[k] = s;
  }
  return Object.keys(summary).length === 0 ? undefined : summary;
}

export function auditEventFor(
  pc: PendingCall,
  req: CallToolRequest,
  result: CallToolResult,
  root: string,
  now: Date = new Date(),
): AuditEvent {
  const args = req.args ?? {};
  let resultStatus = "success";
  let errorMsg = "";
  if (result.isError) {
    resultStatus = "error";
    errorMsg = result.text;
    if (
      (errorMsg.includes('"denied":') && errorMsg.includes('"policyRef":')) ||
      errorMsg.includes('"code": "permission_required"')
    ) {
      resultStatus = "denied";
    }
    if (byteLen(errorMsg) > 200) errorMsg = `${byteSlice(errorMsg, 197)}...`;
  }
  const event: AuditEvent = {
    timestamp: pc.startedAt.toISOString(),
    toolName: pc.toolName,
    actionClass: classifyAction(pc.toolName, pc.action).capability,
    result: resultStatus,
    durationMs: now.getTime() - pc.startedAt.getTime(),
  };
  if (pc.action) event.action = pc.action;
  if (root) event.projectRoot = root;
  if (isDryRun(args) || lifecyclePreview(pc.action, args)) event.dryRun = true;
  if (errorMsg) event.errorMessage = errorMsg;
  const refs = extractEntityRefs(pc.toolName, args);
  if (refs.length > 0) event.entityRefs = refs;
  const summary = summarizeArgs(args);
  if (summary) event.argumentSummary = summary;
  return event;
}
