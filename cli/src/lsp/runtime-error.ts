// Port of internal/lsp/runtime_error.go.
import { join } from "node:path";
import { type BackendAttempt, CSharpLanguageID } from "./types.ts";

export interface RuntimeErrorInit {
  code: string;
  language: string;
  backend?: string;
  action?: string;
  message?: string;
  explanation?: string;
  capabilities?: string[];
  advertisedCapabilities?: string[];
  remediation?: string;
  logPath?: string;
  attempts?: BackendAttempt[];
  cause?: unknown;
}

/** An actionable LSP runtime failure suitable for MCP/CLI output. */
export class RuntimeError extends Error {
  readonly code: string;
  readonly language: string;
  readonly backend: string;
  readonly action: string;
  readonly explanation: string;
  readonly capabilities: string[];
  readonly advertisedCapabilities: string[];
  readonly remediation: string;
  readonly logPath: string;
  readonly attempts: BackendAttempt[];
  override readonly cause: unknown;
  /** The bare Message field (Error.message carries the rendered text, like Go's Error()). */
  readonly rawMessage: string;

  constructor(init: RuntimeErrorInit) {
    let msg = init.message ?? "";
    if (msg === "" && init.cause)
      msg = init.cause instanceof Error ? init.cause.message : String(init.cause);
    const remediation = init.remediation ?? "";
    super(remediation !== "" ? `${msg}. ${remediation}` : msg);
    this.name = "RuntimeError";
    this.code = init.code;
    this.language = init.language;
    this.backend = init.backend ?? "";
    this.action = init.action ?? "";
    this.rawMessage = init.message ?? "";
    this.explanation = init.explanation ?? "";
    this.capabilities = init.capabilities ?? [];
    this.advertisedCapabilities = init.advertisedCapabilities ?? [];
    this.remediation = remediation;
    this.logPath = init.logPath ?? "";
    this.attempts = init.attempts ?? [];
    this.cause = init.cause;
  }

  /** Payload(): the map the MCP and HTTP layers serialize. Key order matches Go's map when sorted. */
  payload(): Record<string, unknown> {
    const p: Record<string, unknown> = {
      error: this.code,
      language: this.language,
      message: this.rawMessage,
      remediation: this.remediation,
    };
    if (this.backend !== "") p.backend = this.backend;
    if (this.action !== "") p.action = this.action;
    if (this.explanation !== "") p.explanation = this.explanation;
    if (this.capabilities.length > 0) p.capabilities = this.capabilities;
    if (this.advertisedCapabilities.length > 0)
      p.advertised_capabilities = this.advertisedCapabilities;
    else if (this.code === "unsupported_capability") p.advertised_capabilities = [];
    if (this.logPath !== "") p.log_path = this.logPath;
    if (this.attempts.length > 0) p.attempts = this.attempts;
    if (this.cause) p.cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return p;
  }
}

export function csharpLogPath(root: string, backend: string): string {
  const b = backend === "" ? CSharpLanguageID : backend;
  return join(root, ".knowns", "logs", "lsp", `${CSharpLanguageID}-${b}.log`);
}
