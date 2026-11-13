// Port of protocol.go: the JSON wire format. One request object and one response object per
// connection, each terminated by a newline, exactly like Go's json.Encoder.
import { RuntimeError } from "../lsp/runtime-error.ts";
import type {
  BackendAttempt,
  Diagnostic,
  DocumentSymbol,
  LanguageRuntimeStatus,
  Location,
  WorkspaceEdit,
  WorkspaceSymbolResult,
} from "../lsp/types.ts";

export type Operation =
  | "ping"
  | "definition"
  | "references"
  | "implementations"
  | "diagnostics"
  | "document_symbols"
  | "workspace_symbol"
  | "rename"
  | "did_change"
  | "status"
  | "start_language"
  | "stop_language"
  | "restart_language"
  | "apply_config"
  | "lease_acquire"
  | "lease_release";

export const OperationPing: Operation = "ping";
export const OperationDefinition: Operation = "definition";
export const OperationReferences: Operation = "references";
export const OperationImplementations: Operation = "implementations";
export const OperationDiagnostics: Operation = "diagnostics";
export const OperationDocumentSymbols: Operation = "document_symbols";
export const OperationWorkspaceSymbol: Operation = "workspace_symbol";
export const OperationRename: Operation = "rename";
export const OperationDidChange: Operation = "did_change";
export const OperationStatus: Operation = "status";
export const OperationStartLanguage: Operation = "start_language";
export const OperationStopLanguage: Operation = "stop_language";
export const OperationRestartLanguage: Operation = "restart_language";
export const OperationApplyConfig: Operation = "apply_config";
export const OperationAcquireLease: Operation = "lease_acquire";
export const OperationReleaseLease: Operation = "lease_release";

/** Request fields as Go's json tags name them; Handshake is embedded (inlined). */
export interface Request {
  project_root?: string;
  token?: string;
  operation: Operation | string;
  path?: string;
  language?: string;
  query?: string;
  text?: string;
  line?: number;
  character?: number;
  newName?: string;
  owner?: string;
  ttlMillis?: number;
}

export interface RuntimeErrorPayload {
  code?: string;
  language?: string;
  backend?: string;
  action?: string;
  message?: string;
  explanation?: string;
  capabilities?: string[];
  advertised_capabilities?: string[];
  remediation?: string;
  log_path?: string;
  attempts?: BackendAttempt[];
  cause?: string;
}

export interface Response {
  error?: string;
  runtime_error?: RuntimeErrorPayload;
  location?: Location;
  locations?: Location[];
  diagnostics?: Diagnostic[];
  document_symbols?: DocumentSymbol[];
  workspace_symbol_results?: WorkspaceSymbolResult[];
  workspace_edit?: WorkspaceEdit;
  statuses?: LanguageRuntimeStatus[];
}

/** Go's zero lsp.Location, which json omitempty does not drop for a struct. */
export const zeroLocation: Location = {
  uri: "",
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
};

export function runtimeErrorPayload(err: RuntimeError): RuntimeErrorPayload {
  const p: RuntimeErrorPayload = {};
  if (err.code) p.code = err.code;
  if (err.language) p.language = err.language;
  if (err.backend) p.backend = err.backend;
  if (err.action) p.action = err.action;
  if (err.rawMessage) p.message = err.rawMessage;
  if (err.explanation) p.explanation = err.explanation;
  if (err.capabilities.length > 0) p.capabilities = [...err.capabilities];
  if (err.advertisedCapabilities.length > 0)
    p.advertised_capabilities = [...err.advertisedCapabilities];
  if (err.remediation) p.remediation = err.remediation;
  if (err.logPath) p.log_path = err.logPath;
  if (err.attempts.length > 0) p.attempts = [...err.attempts];
  if (err.cause) p.cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
  return p;
}

export function payloadToError(p: RuntimeErrorPayload): RuntimeError {
  return new RuntimeError({
    code: p.code ?? "",
    language: p.language ?? "",
    backend: p.backend ?? "",
    action: p.action ?? "",
    message: p.message ?? "",
    explanation: p.explanation ?? "",
    capabilities: [...(p.capabilities ?? [])],
    advertisedCapabilities: [...(p.advertised_capabilities ?? [])],
    remediation: p.remediation ?? "",
    logPath: p.log_path ?? "",
    attempts: [...(p.attempts ?? [])],
    ...(p.cause ? { cause: new Error(p.cause) } : {}),
  });
}

/** Response.err(): the error a response carries, if any. */
export function responseError(r: Response): Error | undefined {
  if (r.runtime_error) return payloadToError(r.runtime_error);
  if (r.error) return new Error(r.error);
  return undefined;
}
