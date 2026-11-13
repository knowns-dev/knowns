import { codeCapabilityProfile } from "../capabilities.ts";
import type { Ctx } from "../context.ts";
import { errorMessage, WrappedError } from "../errors.ts";
import type {
  CapabilityProfile,
  DependencyResolution,
  DocumentSyncOptions,
  InstallSelector,
  PathCapabilityDecision,
  PathMatcher,
  RuntimeDependency,
} from "../types.ts";
import { checkBinary, installManaged, pathEscape, readLimited, SpecAdapter } from "./helpers.ts";
import type { FetchFn } from "./markdown.ts";

export const terraformLSRecommendedVersion = "0.38.8";
export const terraformLSRepositoryURL = "https://github.com/hashicorp/terraform-ls";
export const terraformLSGitHubReleasesAPI =
  "https://api.github.com/repos/hashicorp/terraform-ls/releases";
export const terraformLSReleasesBase = "https://releases.hashicorp.com/terraform-ls";
export const terraformPathPriority = 200;
export const terraformCompoundPathPriority = 300;

const terraformLSVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

export class TerraformLSAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "terraform",
      name: "Terraform",
      extensions: [".tf", ".tfvars", ".tf.json", ".tfvars.json"],
      binaries: [{ name: "terraform-ls", args: ["serve"], check_args: ["version"] }],
      prerequisites: [
        {
          name: "Terraform CLI",
          check_cmd: "terraform version",
          install_hint: "Install Terraform from https://developer.hashicorp.com/terraform/install",
        },
      ],
      installGuide: {
        knowns_cmd: "knowns lsp install terraform",
        url: terraformLSRepositoryURL,
        notes:
          "Requires Terraform CLI; existing PATH terraform-ls binaries take precedence over the managed release",
      },
      canInstall: true,
      defaultArgs: ["serve"],
      ignoredDirs: [".terraform"],
    });
  }
  pathMatchers(): PathMatcher[] {
    return [
      { kind: "suffix", pattern: ".tfvars.json", priority: terraformCompoundPathPriority },
      { kind: "suffix", pattern: ".tf.json", priority: terraformCompoundPathPriority },
      { kind: "suffix", pattern: ".tfvars", priority: terraformPathPriority },
      { kind: "suffix", pattern: ".tf", priority: terraformPathPriority },
    ];
  }
  lazyStart(): boolean {
    return true;
  }
  capabilityProfile(): CapabilityProfile {
    return codeCapabilityProfile();
  }
  documentSyncForPath(path: string): DocumentSyncOptions {
    const [languageID, jsonVariant] = terraformDocumentKind(path);
    return { languageID, suppress: jsonVariant };
  }
  pathCapabilityForAction(
    path: string,
    action: string,
    _capability: string,
  ): [PathCapabilityDecision, boolean] {
    const [, jsonVariant] = terraformDocumentKind(path);
    if (!jsonVariant) return [{ supported: false }, false];
    let explanation = "terraform-ls does not support Terraform JSON configuration documents";
    if (action !== "")
      explanation += `; action ${JSON.stringify(action)} is unavailable for ${path}`;
    return [{ supported: false, explanation }, true];
  }
  override checkPrerequisites(ctx: Ctx): Promise<void> {
    return checkBinary(ctx, "terraform", "version");
  }
  override supportsImplementation(): boolean {
    return false;
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [
      terraformLSRuntimeDependency(
        "darwin-amd64",
        "darwin_amd64",
        "34cfe6cbbb61da5b8fd21721e14be0f134417f249350872da1669454dc8762a4",
      ),
      terraformLSRuntimeDependency(
        "darwin-arm64",
        "darwin_arm64",
        "510a506f7bf1550294202347261961e52daa4664a795e2deffbf7df7296b1f6c",
      ),
      terraformLSRuntimeDependency(
        "linux-amd64",
        "linux_amd64",
        "d16077d9c83f13ac33501af49ea75f43218d3fa2437c6c1374550b2625edc3ef",
      ),
      terraformLSRuntimeDependency(
        "linux-arm64",
        "linux_arm64",
        "762db754428dd188b949533ca05437955e26f4b3fc699d4b93392668a24e7a10",
      ),
      terraformLSRuntimeDependency(
        "windows-amd64",
        "windows_amd64",
        "5152e76e45103ea2a31b8a8dadc43833ae559a4aba4cb12f57c1c006c11dda8c",
      ),
      terraformLSRuntimeDependency(
        "windows-arm64",
        "windows_arm64",
        "5cee26a3645487125bf65daee8cfc85c84d8c7e03bbb00662fb12225afe9d6cd",
      ),
    ];
  }
  resolveRuntimeDependency(
    ctx: Ctx,
    dep: RuntimeDependency,
    selector: InstallSelector,
  ): Promise<DependencyResolution> {
    return resolveTerraformLSRuntimeDependency(
      ctx,
      fetch,
      terraformLSGitHubReleasesAPI,
      terraformLSReleasesBase,
      dep,
      selector,
    );
  }
  install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir, "install terraform-ls");
  }
}

export function terraformDocumentKind(path: string): [languageID: string, jsonVariant: boolean] {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (normalized.endsWith(".tfvars.json")) return ["terraform-vars", true];
  if (normalized.endsWith(".tf.json")) return ["terraform", true];
  if (normalized.endsWith(".tfvars")) return ["terraform-vars", false];
  return ["terraform", false];
}

export function terraformLSRuntimeDependency(
  platformID: string,
  archivePlatform: string,
  sha256: string,
): RuntimeDependency {
  const archiveName = `terraform-ls_${terraformLSRecommendedVersion}_${archivePlatform}.zip`;
  let extractPath = "terraform-ls";
  if (platformID.startsWith("windows-")) extractPath += ".exe";
  return {
    id: terraformLSRecommendedVersion,
    platform_id: platformID,
    version: terraformLSRecommendedVersion,
    recommended_version: terraformLSRecommendedVersion,
    recommended_integrity: `sha256:${sha256}`,
    source: "release",
    url: `${terraformLSReleasesBase}/${terraformLSRecommendedVersion}/${archiveName}`,
    sha256,
    package_source: terraformLSReleasesBase,
    archive_type: "zip",
    binary_name: "terraform-ls",
    extract_path: extractPath,
  };
}

export async function resolveTerraformLSRuntimeDependency(
  ctx: Ctx,
  client: FetchFn | undefined,
  githubAPI: string,
  releasesBase: string,
  dep: RuntimeDependency,
  selector: InstallSelector,
): Promise<DependencyResolution> {
  const explicitVersion = (selector.version ?? "").trim();
  if (selector.latest && explicitVersion !== "") {
    throw new Error("latest and explicit version selectors are mutually exclusive");
  }
  if (!selector.latest && explicitVersion === "") {
    const resolved: RuntimeDependency = { ...dep };
    if (resolved.recommended_version) resolved.version = resolved.recommended_version;
    return {
      dependency: resolved,
      requested_version: "recommended",
      resolved_version: resolved.version ?? "",
      source: resolved.url ?? "",
      integrity: `sha256:${resolved.sha256 ?? ""}`,
      verified: false,
    };
  }
  const doFetch = client ?? fetch;

  let requested = explicitVersion;
  let version = explicitVersion;
  if (selector.latest) {
    requested = "latest";
    const latestURL = `${githubAPI.replace(/\/+$/, "")}/latest`;
    let body: Uint8Array;
    try {
      body = await terraformLSGet(ctx, doFetch, latestURL, 4 << 20);
    } catch (e) {
      throw new WrappedError(`resolve latest terraform-ls release: ${errorMessage(e)}`, e);
    }
    try {
      version =
        (JSON.parse(new TextDecoder().decode(body)) as { tag_name?: string }).tag_name ?? "";
    } catch (e) {
      throw new WrappedError(`decode latest terraform-ls release: ${errorMessage(e)}`, e);
    }
  }

  version = normalizeTerraformLSVersion(version);
  const [archiveName, extractPath] = terraformLSArchive(version, dep.platform_id ?? "");
  const versionBase = `${releasesBase.replace(/\/+$/, "")}/${pathEscape(version)}`;
  const checksumsName = `terraform-ls_${version}_SHA256SUMS`;
  const checksumsURL = `${versionBase}/${pathEscape(checksumsName)}`;
  let manifest: Uint8Array;
  try {
    manifest = await terraformLSGet(ctx, doFetch, checksumsURL, 2 << 20);
  } catch (e) {
    throw new WrappedError(`fetch terraform-ls ${version} checksums: ${errorMessage(e)}`, e);
  }
  let sha256: string;
  try {
    sha256 = terraformLSChecksum(new TextDecoder().decode(manifest), archiveName);
  } catch (e) {
    throw new WrappedError(`resolve terraform-ls ${version} checksum: ${errorMessage(e)}`, e);
  }
  const archiveURL = `${versionBase}/${pathEscape(archiveName)}`;
  const resolved: RuntimeDependency = {
    ...dep,
    id: version,
    version,
    url: archiveURL,
    sha256,
    extract_path: extractPath,
  };
  return {
    dependency: resolved,
    requested_version: requested,
    resolved_version: version,
    source: archiveURL,
    integrity: `sha256:${sha256}`,
    verified: false,
  };
}

export function normalizeTerraformLSVersion(versionIn: string): string {
  let version = versionIn.trim();
  if (version.startsWith("v")) version = version.slice(1);
  if (!terraformLSVersionPattern.test(version)) {
    throw new Error(`invalid terraform-ls release version ${JSON.stringify(version)}`);
  }
  return version;
}

export function terraformLSArchive(version: string, platformID: string): [string, string] {
  const platforms: Record<string, string> = {
    "darwin-amd64": "darwin_amd64",
    "darwin-arm64": "darwin_arm64",
    "linux-amd64": "linux_amd64",
    "linux-arm64": "linux_arm64",
    "windows-amd64": "windows_amd64",
    "windows-arm64": "windows_arm64",
  };
  const platform = platforms[platformID];
  if (platform === undefined) {
    throw new Error(`terraform-ls has no managed release asset for platform ${platformID}`);
  }
  let extractPath = "terraform-ls";
  if (platformID.startsWith("windows-")) extractPath += ".exe";
  return [`terraform-ls_${version}_${platform}.zip`, extractPath];
}

async function terraformLSGet(
  ctx: Ctx,
  doFetch: FetchFn,
  requestURL: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const resp = await doFetch(requestURL, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "knowns-lsp-installer",
    },
    signal: ctx,
  });
  if (resp.status !== 200) {
    const detail = new TextDecoder().decode(await readLimited(resp, 8 << 10)).trim();
    throw new Error(`HTTP ${resp.status}: ${detail}`);
  }
  const body = await readLimited(resp, maxBytes + 1);
  if (body.length > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  return body;
}

export function terraformLSChecksum(manifest: string, archiveName: string): string {
  let checksum = "";
  for (const line of manifest.split("\n")) {
    const fields = line
      .trim()
      .split(/\s+/)
      .filter((f) => f !== "");
    if (fields.length !== 2 || fields[1] !== archiveName) continue;
    const hex = fields[0] ?? "";
    if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(hex))
      throw new Error(`invalid SHA-256 for ${archiveName}`);
    const candidate = hex.toLowerCase();
    if (checksum !== "" && checksum !== candidate) {
      throw new Error(`conflicting SHA-256 entries for ${archiveName}`);
    }
    checksum = candidate;
  }
  if (checksum === "") throw new Error(`published SHA-256 for ${archiveName} was not found`);
  return checksum;
}

export function newTerraformLSAdapter(): TerraformLSAdapter {
  return new TerraformLSAdapter();
}
