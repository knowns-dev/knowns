// Port of internal/lsp/plugin_adapter.go: user-contributed, metadata-only LSP adapters.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import type { Ctx } from "./context.ts";
import { runProcess } from "./exec.ts";
import { Installer } from "./installer.ts";
import {
  BaseAdapter,
  type BinaryCandidate,
  type InstallGuide,
  type LanguageAdapter,
  type Prerequisite,
  type RuntimeDependency,
} from "./types.ts";
import { fileURI } from "./uri.ts";

const binaryCandidateSchema = z.strictObject({
  name: z.string().optional(),
  args: z.array(z.string()).nullable().optional(),
  check_args: z.array(z.string()).nullable().optional(),
});
const prerequisiteSchema = z.strictObject({
  name: z.string().optional(),
  check_cmd: z.string().optional(),
  install_hint: z.string().optional(),
});
const installGuideSchema = z.strictObject({
  command: z.string().optional(),
  url: z.string().optional(),
  knowns_cmd: z.string().optional(),
  notes: z.string().optional(),
});
const runtimeDependencySchema = z.strictObject({
  id: z.string().optional(),
  platform_id: z.string().optional(),
  version: z.string().optional(),
  recommended_version: z.string().optional(),
  recommended_integrity: z.string().optional(),
  source: z.string().optional(),
  url: z.string().optional(),
  sha256: z.string().optional(),
  sha512: z.string().optional(),
  package_source: z.string().optional(),
  archive_type: z.string().optional(),
  binary_name: z.string().optional(),
  extract_path: z.string().optional(),
  package_name: z.string().optional(),
  packages: z.array(z.string()).nullable().optional(),
});

export const pluginAdapterManifestSchema = z.strictObject({
  id: z.string().optional(),
  language_id: z.string().optional(),
  backend_id: z.string().optional(),
  name: z.string().optional(),
  extensions: z.array(z.string()).nullable().optional(),
  binaries: z.array(binaryCandidateSchema).nullable().optional(),
  binary_candidates: z.array(binaryCandidateSchema).nullable().optional(),
  default_args: z.array(z.string()).nullable().optional(),
  prerequisites: z.array(prerequisiteSchema).nullable().optional(),
  install_guide: installGuideSchema.optional(),
  runtime_dependencies: z.array(runtimeDependencySchema).nullable().optional(),
  runtime_deps: z.array(runtimeDependencySchema).nullable().optional(),
  initialization_options: z.record(z.string(), z.unknown()).nullable().optional(),
  ignored_dirs: z.array(z.string()).nullable().optional(),
  capabilities: z
    .strictObject({
      implementation: z.boolean().nullable().optional(),
      references: z.boolean().nullable().optional(),
    })
    .optional(),
  supports_implementation: z.boolean().nullable().optional(),
  supports_references: z.boolean().nullable().optional(),
});
export type PluginAdapterManifest = z.infer<typeof pluginAdapterManifestSchema>;

export interface PluginAdapterLoadOptions {
  dir?: string;
}

export class PluginAdapterLoadError extends Error {
  readonly path: string;
  override readonly cause: unknown;
  constructor(path: string, err: unknown) {
    const inner = err instanceof Error ? err.message : String(err);
    super(path === "" ? inner : `${path}: ${inner}`);
    this.name = "PluginAdapterLoadError";
    this.path = path;
    this.cause = err;
  }
}

export interface PluginAdapterLoadResult {
  adapters: LanguageAdapter[];
  errors: PluginAdapterLoadError[];
}

function cloneBinaryCandidates(
  inp: {
    name?: string | undefined;
    args?: string[] | null | undefined;
    check_args?: string[] | null | undefined;
  }[],
): BinaryCandidate[] {
  return inp.map((c) => {
    const out: BinaryCandidate = { name: c.name ?? "" };
    if (c.args && c.args.length > 0) out.args = [...c.args];
    if (c.check_args && c.check_args.length > 0) out.check_args = [...c.check_args];
    return out;
  });
}

function cloneRuntimeDependencies(
  inp: (Omit<RuntimeDependency, "packages"> & { packages?: string[] | null | undefined })[],
): RuntimeDependency[] {
  return inp.map((d) => {
    const { packages, ...rest } = d;
    const out: RuntimeDependency = { ...rest };
    if (packages && packages.length > 0) out.packages = [...packages];
    return out;
  });
}

function validPluginID(id: string): boolean {
  return id !== "" && !/[ \t\r\n/\\]/.test(id);
}

function manifestID(m: PluginAdapterManifest): string {
  let id = (m.id ?? "").trim();
  const languageID = (m.language_id ?? "").trim();
  if (id !== "" && languageID !== "" && id !== languageID) {
    throw new Error(
      `id ${JSON.stringify(id)} and language_id ${JSON.stringify(languageID)} must match`,
    );
  }
  if (id === "") id = languageID;
  if (id === "") throw new Error("id or language_id is required");
  return id;
}

function normalizeManifestExtensions(extensions: string[]): string[] {
  if (extensions.length === 0) throw new Error("at least one extension is required");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of extensions) {
    const ext = raw.trim().toLowerCase();
    if (ext === "") throw new Error("extension cannot be empty");
    if (!ext.startsWith("."))
      throw new Error(`extension ${JSON.stringify(ext)} must start with '.'`);
    if (/[/\\]/.test(ext)) {
      throw new Error(`extension ${JSON.stringify(ext)} cannot contain path separators`);
    }
    if (seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

export function defaultPluginAdapterDir(): string {
  let home = "";
  try {
    home = homedir();
  } catch {
    home = "";
  }
  if (home === "") return join(".knowns", "lsp-adapters");
  return join(home, ".knowns", "lsp-adapters");
}

function defaultBaseDir(): string {
  let home = "";
  try {
    home = homedir();
  } catch {
    home = "";
  }
  if (home === "") return join(".knowns", "lsp-servers");
  return join(home, ".knowns", "lsp-servers");
}

/** PluginAdapter implements LanguageAdapter from a manifest. */
export class PluginAdapter extends BaseAdapter implements LanguageAdapter {
  readonly manifest: PluginAdapterManifest;
  source = "";
  private ignored = new Set<string>();
  private adapterID = "";
  private binaryList: BinaryCandidate[] = [];
  private runtime: RuntimeDependency[] = [];
  private extension: string[] = [];

  constructor(manifest: PluginAdapterManifest) {
    super();
    this.manifest = manifest;
    this.normalize();
  }

  sourcePath(): string {
    return this.source;
  }
  id(): string {
    return this.adapterID;
  }
  name(): string {
    return (this.manifest.name ?? "").trim();
  }
  extensions(): string[] {
    return [...this.extension];
  }

  binaries(): BinaryCandidate[] {
    const out = this.binaryList.map((b) => ({
      ...b,
      ...(b.args ? { args: [...b.args] } : {}),
      ...(b.check_args ? { check_args: [...b.check_args] } : {}),
    }));
    const defaultArgs = this.defaultArgs();
    for (const b of out) {
      if ((b.args?.length ?? 0) === 0 && defaultArgs.length > 0) b.args = [...defaultArgs];
    }
    return out;
  }

  prerequisites(): Prerequisite[] {
    return [...(this.manifest.prerequisites ?? [])];
  }

  async checkPrerequisites(ctx: Ctx): Promise<void> {
    for (const prereq of this.manifest.prerequisites ?? []) {
      const fields = (prereq.check_cmd ?? "").split(/\s+/).filter((f) => f !== "");
      const first = fields[0];
      if (first === undefined) continue;
      let ok = true;
      let output = "";
      let cause: unknown;
      try {
        const r = await runProcess(ctx, first, fields.slice(1));
        output = r.stdout + r.stderr;
        ok = r.code === 0;
        if (!ok) cause = new Error(`exit status ${r.code}`);
      } catch (e) {
        ok = false;
        cause = e;
      }
      if (!ok) {
        const name = prereq.name && prereq.name !== "" ? prereq.name : (prereq.check_cmd ?? "");
        const msg = cause instanceof Error ? cause.message : String(cause);
        const err = new Error(`${name} prerequisite failed: ${msg}: ${output.trim()}`);
        (err as Error & { cause?: unknown }).cause = cause;
        throw err;
      }
    }
  }

  installGuide(): InstallGuide {
    return { ...(this.manifest.install_guide ?? {}) };
  }

  canInstall(): boolean {
    return this.runtime.length > 0;
  }

  runtimeDeps(): RuntimeDependency[] {
    return cloneRuntimeDependencies(this.runtime);
  }

  async install(ctx: Ctx, targetDir: string): Promise<string> {
    if (this.runtime.length === 0) {
      throw new Error(`plugin adapter ${JSON.stringify(this.id())} has no runtime dependencies`);
    }
    return new Installer(targetDir).install(ctx, this);
  }

  installedPath(): string | undefined {
    if (this.runtime.length === 0) return undefined;
    return new Installer(defaultBaseDir()).isInstalled(this) || undefined;
  }

  defaultArgs(): string[] {
    return [...(this.manifest.default_args ?? [])];
  }

  initializeParams(
    root: string,
    settings: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = { rootUri: fileURI(root) };
    const options = this.initializationOptions(settings);
    if (options && Object.keys(options).length > 0) params.initializationOptions = options;
    return params;
  }

  initializationOptions(settings: Record<string, unknown> | undefined): Record<string, unknown> {
    let options: Record<string, unknown> | undefined = this.manifest.initialization_options
      ? { ...this.manifest.initialization_options }
      : undefined;
    if (settings) {
      let overlay: Record<string, unknown> = settings;
      const nested = settings.initializationOptions;
      if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
        overlay = nested as Record<string, unknown>;
      }
      if (Object.keys(overlay).length > 0) options = { ...(options ?? {}), ...overlay };
    }
    return options ?? {};
  }

  override isIgnoredDir(name: string): boolean {
    return this.ignored.has(name);
  }

  override supportsImplementation(): boolean {
    const m = this.manifest;
    if (m.supports_implementation != null) return m.supports_implementation;
    if (m.capabilities?.implementation != null) return m.capabilities.implementation;
    return true;
  }

  override supportsReferences(): boolean {
    const m = this.manifest;
    if (m.supports_references != null) return m.supports_references;
    if (m.capabilities?.references != null) return m.capabilities.references;
    return true;
  }

  private normalize(): void {
    const id = manifestID(this.manifest);
    if (!validPluginID(id)) throw new Error(`invalid adapter id ${JSON.stringify(id)}`);
    if ((this.manifest.name ?? "").trim() === "") throw new Error("name is required");

    const extensions = normalizeManifestExtensions(this.manifest.extensions ?? []);
    let binaries = this.manifest.binaries ?? [];
    if (binaries.length === 0) binaries = this.manifest.binary_candidates ?? [];
    if (binaries.length === 0) throw new Error("at least one binary candidate is required");
    const cloned = cloneBinaryCandidates(binaries);
    for (const [i, b] of cloned.entries()) {
      b.name = b.name.trim();
      if (b.name === "") throw new Error(`binary candidate ${i} name is required`);
    }

    let deps = this.manifest.runtime_dependencies ?? [];
    if (deps.length === 0) deps = this.manifest.runtime_deps ?? [];
    const runtimeDeps = cloneRuntimeDependencies(deps);
    for (const [i, dep] of runtimeDeps.entries()) {
      if ((dep.id ?? "").trim() === "") throw new Error(`runtime dependency ${i} id is required`);
    }

    this.adapterID = id;
    this.extension = extensions;
    this.binaryList = cloned;
    this.runtime = runtimeDeps;
    this.ignored = new Set(
      (this.manifest.ignored_dirs ?? []).map((d) => d.trim()).filter((d) => d !== ""),
    );
  }
}

export function newPluginAdapter(manifest: PluginAdapterManifest): PluginAdapter {
  return new PluginAdapter(manifest);
}

function loadPluginAdapterFile(path: string): PluginAdapter {
  const data = readFileSync(path, "utf8");
  const parsed = pluginAdapterManifestSchema.parse(JSON.parse(data));
  const adapter = newPluginAdapter(parsed);
  adapter.source = path;
  return adapter;
}

export function loadPluginAdapters(opts: PluginAdapterLoadOptions = {}): PluginAdapterLoadResult {
  const dir = opts.dir && opts.dir !== "" ? opts.dir : defaultPluginAdapterDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { adapters: [], errors: [] };
    return { adapters: [], errors: [new PluginAdapterLoadError(dir, e)] };
  }
  const paths = entries
    .filter((e) => !e.isDirectory() && extname(e.name).toLowerCase() === ".json")
    .map((e) => join(dir, e.name))
    .sort();
  const result: PluginAdapterLoadResult = { adapters: [], errors: [] };
  for (const path of paths) {
    try {
      result.adapters.push(loadPluginAdapterFile(path));
    } catch (e) {
      result.errors.push(new PluginAdapterLoadError(path, e));
    }
  }
  return result;
}
