// Port of internal/lsp/capabilities.go (the profile and snapshot helpers; Server methods live in server.ts).
import {
  CapabilityCompletion,
  CapabilityDefinition,
  CapabilityDiagnostics,
  CapabilityDocumentLinks,
  CapabilityDocumentSymbols,
  CapabilityFormatting,
  CapabilityHover,
  CapabilityImplementation,
  type CapabilityProfile,
  CapabilityReferences,
  CapabilityRename,
  type CapabilitySnapshot,
  CapabilityWorkspaceSymbols,
  type LanguageAdapter,
} from "./types.ts";

export function codeCapabilityProfile(): CapabilityProfile {
  return {
    required: [CapabilityDocumentSymbols, CapabilityDefinition, CapabilityReferences],
    enforceAdvertised: true,
  };
}

export function documentConfigCapabilityProfile(): CapabilityProfile {
  return {
    required: [CapabilityDocumentSymbols, CapabilityDiagnostics],
    legacyPushDiagnostics: true,
    enforceAdvertised: true,
  };
}

export function normalizeCapabilities(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  for (const v of values) {
    const n = v.trim().toLowerCase();
    if (n !== "") seen.add(n);
  }
  return [...seen].sort();
}

export function capabilityProfileForAdapter(adapter: LanguageAdapter): CapabilityProfile {
  if (typeof adapter.capabilityProfile !== "function") return { required: [] };
  const profile = adapter.capabilityProfile();
  return { ...profile, required: normalizeCapabilities(profile.required) };
}

export function newCapabilitySnapshot(
  known: boolean,
  advertised: readonly string[],
  observed: readonly string[],
): Required<CapabilitySnapshot> {
  const adv = normalizeCapabilities(advertised);
  const obs = normalizeCapabilities(observed);
  return {
    known,
    capabilities: normalizeCapabilities([...adv, ...obs]),
    advertised_capabilities: adv,
    observed_capabilities: obs,
  };
}

export function missingCapabilities(
  required: readonly string[],
  available: readonly string[],
): string[] {
  const set = new Set(normalizeCapabilities(available));
  return normalizeCapabilities(required).filter((c) => !set.has(c));
}

export function hasCapability(capabilities: readonly string[], capability: string): boolean {
  const c = capability.trim().toLowerCase();
  return capabilities.includes(c);
}

function providerEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === false) return false;
  if (raw === true) return true;
  return typeof raw === "object" && !Array.isArray(raw);
}

export function normalizeInitializeCapabilities(
  raw: Record<string, unknown> | undefined,
): string[] {
  const providers: Record<string, string> = {
    documentSymbolProvider: CapabilityDocumentSymbols,
    workspaceSymbolProvider: CapabilityWorkspaceSymbols,
    definitionProvider: CapabilityDefinition,
    referencesProvider: CapabilityReferences,
    renameProvider: CapabilityRename,
    implementationProvider: CapabilityImplementation,
    diagnosticProvider: CapabilityDiagnostics,
    documentFormattingProvider: CapabilityFormatting,
    hoverProvider: CapabilityHover,
    completionProvider: CapabilityCompletion,
    documentLinkProvider: CapabilityDocumentLinks,
  };
  const out: string[] = [];
  for (const [provider, capability] of Object.entries(providers)) {
    if (providerEnabled(raw?.[provider])) out.push(capability);
  }
  return normalizeCapabilities(out);
}
