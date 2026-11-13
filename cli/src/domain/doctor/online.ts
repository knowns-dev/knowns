// Port of internal/doctor/online.go: the checks that probe a network endpoint. They run in every
// doctor invocation, every probe is bounded, and an unreachable network is a warning so offline
// and air-gapped runs stay usable.
import { join } from "node:path";
import {
  OllamaState,
  ollamaStateGuidance,
} from "../../storage/stores/embedding-registry-defaults.ts";
import {
  EmbeddingSettingsStore,
  getModel,
  getProvider,
  providerWithDefaults,
} from "../../storage/stores/embedding-settings-store.ts";
import { VERSION } from "../../version.ts";
import { lookPath as lookPathEnv, userHomeDir } from "../setup/env.ts";
import { compareVersions } from "../update/version.ts";
import type { DoctorProject } from "./foundation.ts";
import type { Checker, CheckOutcome, Evidence } from "./model.ts";

export const DEFAULT_VERSION_ENDPOINT = "https://registry.npmjs.org/knowns/latest";
const ONLINE_CHECK_TIMEOUT_MS = 3000;
/** Bounds the /api/tags round trip well inside the runner's 2s default budget (NFR-5, AC-20). */
const OLLAMA_PROBE_TIMEOUT_MS = 1000;
const CLIENT_TIMEOUT_MS = 2500;

export interface ProviderTarget {
  id: string;
  kind: string;
  model: string;
  apiBase: string;
  apiKey: string;
}

export interface OnlineDeps {
  fetch: typeof fetch;
  versionUrl: string;
  /** undefined: not configured. Throws: settings incomplete. */
  loadProvider: () => ProviderTarget | undefined;
  lookPath: (name: string) => string | undefined;
}

export function defaultOnlineDeps(
  project: DoctorProject | undefined,
  env: Record<string, string | undefined>,
): OnlineDeps {
  return {
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, init)) as typeof fetch,
    versionUrl: DEFAULT_VERSION_ENDPOINT,
    lookPath: (name) => lookPathEnv(name, env),
    loadProvider: () => {
      if (!project) return undefined;
      const semantic = project.storage.config.load().settings.semanticSearch;
      if (!semantic?.enabled || (semantic.provider !== "api" && semantic.provider !== "ollama")) {
        return undefined;
      }
      const settings = new EmbeddingSettingsStore(
        join(userHomeDir(env), ".knowns", "settings.json"),
      ).load();
      const model = getModel(settings, semantic.model);
      const provider = getProvider(settings, model.provider);
      return {
        id: model.provider,
        kind: semantic.provider,
        model: model.model,
        apiBase: providerWithDefaults(provider).apiBase,
        apiKey: provider.apiKey ?? "",
      };
    },
  };
}

/** One request bounded by its own timer (and the runner's signal); the caller classifies failures. */
async function request(
  deps: OnlineDeps,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<{ res: Response } | { code: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.min(timeoutMs, CLIENT_TIMEOUT_MS),
  );
  const onParent = () => controller.abort();
  parent.addEventListener("abort", onParent, { once: true });
  try {
    const res = await deps.fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    return { res };
  } catch {
    if (timedOut) return { code: "network_timeout" };
    if (parent.aborted) return { code: "network_timeout" };
    return { code: "network_request_failed" };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParent);
  }
}

const onlineWarning = (
  summary: string,
  code: string,
  description: string,
  command: string,
): CheckOutcome => ({
  status: "warn",
  summary,
  evidence: { errorCode: code },
  remediation: { description, command },
});

const SAFE_PROVIDER_ID = /^[A-Za-z0-9._-]+$/;
const SENSITIVE_ID = /(secret|token|password|credential|bearer|api[_-]?key|sk[_-])/i;
const SAFE_VERSION = /^v?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

function providerRemediation(id: string): CheckOutcome["remediation"] {
  const r: NonNullable<CheckOutcome["remediation"]> = {
    description: "Verify the configured embedding provider and its credentials.",
  };
  if (SAFE_PROVIDER_ID.test(id) && !SENSITIVE_ID.test(id)) r.command = `knowns provider test ${id}`;
  return r;
}

function providerFailure(
  id: string,
  summary: string,
  code: string,
  statusCode: number,
): CheckOutcome {
  const evidence: Evidence = { configured: true, errorCode: code, reachable: false };
  if (statusCode > 0) {
    evidence.statusCode = statusCode;
    evidence.reachable = true;
  }
  return { status: "fail", summary, evidence, remediation: providerRemediation(id) };
}
const providerWarning = (
  id: string,
  summary: string,
  code: string,
  statusCode: number,
): CheckOutcome => ({
  ...providerFailure(id, summary, code, statusCode),
  status: "warn",
});

function ollamaGuidanceResult(
  state: OllamaState,
  target: ProviderTarget,
  evidence: Evidence,
): CheckOutcome {
  const g = ollamaStateGuidance(state, target.model);
  const summary =
    state === OllamaState.NotInstalled
      ? "Ollama is not installed"
      : state === OllamaState.NotRunning
        ? "Ollama is not serving the configured endpoint"
        : state === OllamaState.ModelMissing
          ? "Configured Ollama model is not pulled"
          : "Ollama state could not be determined";
  return {
    status: "warn",
    summary,
    evidence,
    remediation: { description: g.description, command: g.command },
  };
}

const canonicalTag = (name: string): string =>
  name.includes(":") ? name.replace(/:latest$/, "") : name;
function ollamaModelMatches(served: string, configured: string): boolean {
  const s = served.trim().toLowerCase();
  const c = configured.trim().toLowerCase();
  return s !== "" && c !== "" && canonicalTag(s) === canonicalTag(c);
}

async function ollamaEndpointResult(
  deps: OnlineDeps,
  target: ProviderTarget,
  base: URL,
  signal: AbortSignal,
): Promise<CheckOutcome> {
  if (deps.lookPath("ollama") === undefined) {
    return ollamaGuidanceResult(OllamaState.NotInstalled, target, {
      provider: "ollama",
      model: target.model,
      installed: false,
    });
  }
  const endpoint = `${base.protocol}//${base.host}/api/tags`;
  const r = await request(deps, endpoint, { method: "GET" }, OLLAMA_PROBE_TIMEOUT_MS, signal);
  if ("code" in r) {
    return ollamaGuidanceResult(OllamaState.NotRunning, target, {
      provider: "ollama",
      model: target.model,
      installed: true,
      reachable: false,
      errorCode: r.code,
    });
  }
  const resp = r.res;
  if (resp.status !== 200) {
    return providerWarning(
      target.id,
      "Ollama returned an unexpected response",
      "provider_unexpected_status",
      resp.status,
    );
  }
  let tags: { models?: Array<{ name?: string }> | null };
  try {
    tags = (await resp.json()) as typeof tags;
  } catch {
    return providerWarning(
      target.id,
      "Ollama returned an invalid model listing",
      "provider_invalid_response",
      resp.status,
    );
  }
  for (const m of tags.models ?? []) {
    if (ollamaModelMatches(m.name ?? "", target.model)) {
      return {
        status: "pass",
        summary: ollamaStateGuidance(OllamaState.Ready, target.model).description,
        evidence: { provider: "ollama", model: target.model, pulled: true, reachable: true },
      };
    }
  }
  return ollamaGuidanceResult(OllamaState.ModelMissing, target, {
    provider: "ollama",
    model: target.model,
    pulled: false,
    reachable: true,
  });
}

function parseHttpUrl(raw: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.host === "" || (u.protocol !== "http:" && u.protocol !== "https:")) return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  return u;
}

export function onlineCheckers(deps: OnlineDeps): Checker[] {
  return [
    {
      id: "search.provider-endpoint",
      scope: "search",
      timeoutMs: 2 * ONLINE_CHECK_TIMEOUT_MS,
      check: async (signal): Promise<CheckOutcome> => {
        let target: ProviderTarget | undefined;
        try {
          target = deps.loadProvider();
        } catch {
          return {
            status: "warn",
            summary: "Configured embedding provider settings are incomplete",
            evidence: { configured: true, errorCode: "provider_settings_incomplete" },
            remediation: {
              description:
                "Register the configured embedding model and provider in Knowns settings.",
              command: "knowns settings",
            },
          };
        }
        if (!target) {
          return {
            status: "skip",
            summary: "No external embedding provider is configured",
            skipReason: "not_configured",
          };
        }
        const base = parseHttpUrl(target.apiBase);
        if (!base) {
          return providerWarning(
            target.id,
            "Configured embedding provider URL is invalid",
            "provider_url_invalid",
            0,
          );
        }
        if (target.kind === "ollama") return ollamaEndpointResult(deps, target, base, signal);

        const probe = new URL(base.toString());
        probe.search = "";
        probe.hash = "";
        probe.pathname = `${probe.pathname.replace(/\/+$/, "")}/embeddings`;
        const headers: Record<string, string> = {};
        if (target.apiKey !== "") headers.Authorization = `Bearer ${target.apiKey}`;
        const r = await request(
          deps,
          probe.toString(),
          { method: "HEAD", headers },
          CLIENT_TIMEOUT_MS,
          signal,
        );
        if ("code" in r) {
          return providerWarning(
            target.id,
            "Configured embedding provider is unreachable",
            r.code,
            0,
          );
        }
        const code = r.res.status;
        if (code === 401 || code === 403) {
          return providerFailure(
            target.id,
            "Configured embedding provider rejected authentication",
            "provider_auth_rejected",
            code,
          );
        }
        if (code === 408) {
          return providerWarning(
            target.id,
            "Configured embedding provider timed out",
            "provider_timeout",
            code,
          );
        }
        if (code === 429) {
          return providerWarning(
            target.id,
            "Configured embedding provider is rate limited",
            "provider_rate_limited",
            code,
          );
        }
        if (code === 404) {
          return providerFailure(
            target.id,
            "Configured embedding provider endpoint is unavailable",
            "provider_endpoint_missing",
            code,
          );
        }
        if (code >= 500) {
          return providerFailure(
            target.id,
            "Configured embedding provider is unhealthy",
            "provider_server_error",
            code,
          );
        }
        if (code >= 300 && code < 400) {
          return providerWarning(
            target.id,
            "Configured embedding provider requires a redirect",
            "provider_redirect",
            code,
          );
        }
        return {
          status: "pass",
          summary: "Configured embedding provider is reachable",
          evidence: { provider: target.kind, reachable: true, statusCode: code },
        };
      },
    },
    {
      id: "online.version",
      scope: "online",
      timeoutMs: ONLINE_CHECK_TIMEOUT_MS,
      check: async (signal): Promise<CheckOutcome> => {
        const r = await request(
          deps,
          deps.versionUrl,
          { method: "GET", headers: { Accept: "application/json" } },
          CLIENT_TIMEOUT_MS,
          signal,
        );
        if ("code" in r) {
          return onlineWarning(
            "Version service is unreachable",
            r.code,
            "Retry the online diagnostic or run `knowns update` directly.",
            "knowns update",
          );
        }
        if (r.res.status !== 200) {
          const result = onlineWarning(
            "Version service returned an unexpected response",
            "version_unexpected_status",
            "Retry the online diagnostic or run `knowns update` directly.",
            "knowns update",
          );
          (result.evidence as Evidence).statusCode = r.res.status;
          return result;
        }
        const invalid = () =>
          onlineWarning(
            "Version service returned an invalid response",
            "version_invalid_response",
            "Run `knowns update` directly to check for an available release.",
            "knowns update",
          );
        let latest = "";
        try {
          const text = (await r.res.text()).slice(0, 64 * 1024);
          const payload = JSON.parse(text) as { version?: unknown };
          latest = typeof payload.version === "string" ? payload.version.trim() : "";
        } catch {
          return invalid();
        }
        if (latest === "" || latest.length > 64 || !SAFE_VERSION.test(latest)) return invalid();
        const evidence: Evidence = { currentVersion: VERSION, latestVersion: latest };
        if (compareVersions(latest, VERSION) > 0) {
          return {
            status: "warn",
            summary: "A newer Knowns version is available",
            evidence,
            remediation: {
              description: "Update Knowns to the latest available version.",
              command: "knowns update",
            },
          };
        }
        return { status: "pass", summary: "Knowns is up to date", evidence };
      },
    },
  ];
}
