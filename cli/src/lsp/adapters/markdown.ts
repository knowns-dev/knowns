import { documentConfigCapabilityProfile } from "../capabilities.ts";
import type { Ctx } from "../context.ts";
import { errorMessage, WrappedError } from "../errors.ts";
import type {
  CapabilityProfile,
  DependencyResolution,
  InstallSelector,
  PathMatcher,
  RuntimeDependency,
} from "../types.ts";
import { installManaged, pathEscape, readLimited, SpecAdapter } from "./helpers.ts";

export const marksmanRecommendedVersion = "2026-02-08";
export const marksmanRepositoryURL = "https://github.com/artempyanykh/marksman";
export const marksmanReleasesAPI = "https://api.github.com/repos/artempyanykh/marksman/releases";

export type FetchFn = typeof fetch;

export class MarksmanAdapter extends SpecAdapter {
  constructor() {
    super({
      id: "markdown",
      name: "Markdown",
      extensions: [".md", ".markdown"],
      binaries: [{ name: "marksman", args: ["server"], check_args: ["--version"] }],
      prerequisites: [],
      installGuide: {
        knowns_cmd: "knowns lsp install markdown",
        url: marksmanRepositoryURL,
        notes:
          "Standalone Marksman binaries are installed on demand; existing PATH binaries take precedence",
      },
      canInstall: true,
      defaultArgs: ["server"],
      ignoredDirs: [],
    });
  }
  pathMatchers(): PathMatcher[] {
    return [
      { kind: "suffix", pattern: ".markdown", priority: 100 },
      { kind: "suffix", pattern: ".md", priority: 100 },
    ];
  }
  lazyStart(): boolean {
    return true;
  }
  capabilityProfile(): CapabilityProfile {
    return documentConfigCapabilityProfile();
  }
  override supportsImplementation(): boolean {
    return false;
  }
  override runtimeDeps(): RuntimeDependency[] {
    return [
      marksmanRuntimeDependency(
        "darwin-arm64",
        "marksman-macos",
        "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
      ),
      marksmanRuntimeDependency(
        "darwin-amd64",
        "marksman-macos",
        "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
      ),
      marksmanRuntimeDependency(
        "linux-arm64",
        "marksman-linux-arm64",
        "db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb",
      ),
      marksmanRuntimeDependency(
        "linux-amd64",
        "marksman-linux-x64",
        "be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087",
      ),
      marksmanRuntimeDependency(
        "windows-amd64",
        "marksman.exe",
        "a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705",
      ),
    ];
  }
  resolveRuntimeDependency(
    ctx: Ctx,
    dep: RuntimeDependency,
    selector: InstallSelector,
  ): Promise<DependencyResolution> {
    return resolveMarksmanRuntimeDependency(ctx, fetch, marksmanReleasesAPI, dep, selector);
  }
  async install(ctx: Ctx, targetDir: string): Promise<string> {
    return installManaged(this, ctx, targetDir, "install Marksman");
  }
}

export function marksmanRuntimeDependency(
  platformID: string,
  assetName: string,
  sha256: string,
): RuntimeDependency {
  return {
    id: marksmanRecommendedVersion,
    platform_id: platformID,
    version: marksmanRecommendedVersion,
    recommended_version: marksmanRecommendedVersion,
    recommended_integrity: `sha256:${sha256}`,
    source: "release",
    package_source: marksmanRepositoryURL,
    url: `${marksmanRepositoryURL}/releases/download/${marksmanRecommendedVersion}/${assetName}`,
    sha256,
    archive_type: "binary",
    binary_name: "marksman",
  };
}

interface MarksmanRelease {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string; digest?: string }[];
}

export async function resolveMarksmanRuntimeDependency(
  ctx: Ctx,
  client: FetchFn | undefined,
  apiBase: string,
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

  const assetName = marksmanAssetName(dep.platform_id ?? "");
  const doFetch = client ?? fetch;
  let releasePath = "/latest";
  let requested = "latest";
  if (explicitVersion !== "") {
    releasePath = `/tags/${pathEscape(explicitVersion)}`;
    requested = explicitVersion;
  }
  let resp: Response;
  try {
    resp = await doFetch(apiBase.replace(/\/+$/, "") + releasePath, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "knowns-lsp-installer",
      },
      signal: ctx,
    });
  } catch (e) {
    throw new WrappedError(`resolve Marksman release: ${errorMessage(e)}`, e);
  }
  if (resp.status !== 200) {
    const detail = new TextDecoder().decode(await readLimited(resp, 8 << 10)).trim();
    throw new Error(`resolve Marksman release: HTTP ${resp.status}: ${detail}`);
  }
  let release: MarksmanRelease;
  try {
    release = JSON.parse(
      new TextDecoder().decode(await readLimited(resp, 4 << 20)),
    ) as MarksmanRelease;
  } catch (e) {
    throw new WrappedError(`decode Marksman release: ${errorMessage(e)}`, e);
  }
  const tag = release.tag_name ?? "";
  if (tag.trim() === "") throw new Error("Marksman release response did not include a tag");
  if (explicitVersion !== "" && tag !== explicitVersion) {
    throw new Error(`Marksman release tag mismatch: requested ${explicitVersion}, got ${tag}`);
  }
  for (const asset of release.assets ?? []) {
    if (asset.name !== assetName) continue;
    let sha256: string;
    try {
      sha256 = parseGitHubSHA256Digest(asset.digest ?? "");
    } catch (e) {
      throw new WrappedError(`Marksman release ${tag} asset ${assetName}: ${errorMessage(e)}`, e);
    }
    const url = asset.browser_download_url ?? "";
    if (url.trim() === "") {
      throw new Error(`Marksman release ${tag} asset ${assetName} has no download URL`);
    }
    const resolved: RuntimeDependency = { ...dep, id: tag, version: tag, url, sha256 };
    return {
      dependency: resolved,
      requested_version: requested,
      resolved_version: tag,
      source: url,
      integrity: `sha256:${sha256}`,
      verified: false,
    };
  }
  throw new Error(`Marksman release ${tag} has no ${assetName} asset`);
}

export function marksmanAssetName(platformID: string): string {
  switch (platformID) {
    case "darwin-arm64":
    case "darwin-amd64":
      return "marksman-macos";
    case "linux-arm64":
      return "marksman-linux-arm64";
    case "linux-amd64":
      return "marksman-linux-x64";
    case "windows-amd64":
      return "marksman.exe";
    default:
      throw new Error(`Marksman has no managed release asset for platform ${platformID}`);
  }
}

export function parseGitHubSHA256Digest(digest: string): string {
  const trimmed = digest.trim();
  const idx = trimmed.indexOf(":");
  if (idx < 0 || trimmed.slice(0, idx).toLowerCase() !== "sha256") {
    throw new Error("missing published SHA-256 digest");
  }
  const value = trimmed.slice(idx + 1);
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(value)) throw new Error("invalid published SHA-256 digest");
  return value.toLowerCase();
}

export function newMarksmanAdapter(): MarksmanAdapter {
  return new MarksmanAdapter();
}
