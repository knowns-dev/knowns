// Port of internal/lsp/adapters/helpers.go plus the shared adapter scaffolding that Go repeats in
// every file (SpecAdapter). Language files only state their data and quirks.
import { homedir } from "node:os";
import { join } from "node:path";
import { goLookPathError } from "../../platform/goerror.ts";
import type { Ctx } from "../context.ts";
import { errorMessage, WrappedError } from "../errors.ts";
import { lookPath, runProcess } from "../exec.ts";
import { Installer } from "../installer.ts";
import {
  BaseAdapter,
  type BinaryCandidate,
  type InstallGuide,
  type LanguageAdapter,
  type Prerequisite,
  type RuntimeDependency,
} from "../types.ts";
import { fileURI } from "../uri.ts";

function combined(out: { stdout: string; stderr: string }): string {
  return out.stdout + out.stderr;
}

/** commandOutput: runs a PATH binary and returns trimmed combined output. */
export async function commandOutput(ctx: Ctx, name: string, ...args: string[]): Promise<string> {
  const path = lookPath(name);
  if (path === undefined) throw new Error(`${name} not found in PATH: ${goLookPathError(name)}`);
  const r = await runProcess(ctx, path, args);
  if (r.code !== 0) {
    throw new Error(
      `${name} ${args.join(" ")} failed: exit status ${r.code}: ${combined(r).trim()}`,
    );
  }
  return combined(r).trim();
}

/** checkBinary: PATH lookup, then a probe whose output is only used in the error. */
export async function checkBinary(ctx: Ctx, name: string, ...args: string[]): Promise<void> {
  const path = lookPath(name);
  if (path === undefined) throw new Error(`${name} not found in PATH: ${goLookPathError(name)}`);
  if (args.length === 0) return;
  const r = await runProcess(ctx, path, args);
  if (r.code !== 0) {
    throw new Error(
      `${name} ${args.join(" ")} failed: exit status ${r.code}: ${combined(r).trim()}`,
    );
  }
}

export function homeLSPDir(): string {
  try {
    const home = homedir();
    if (home === "") return join(".knowns", "lsp-servers");
    return join(home, ".knowns", "lsp-servers");
  } catch {
    return join(".knowns", "lsp-servers");
  }
}

export function installedPathFor(adapterID: string, deps: RuntimeDependency[]): string | undefined {
  return new Installer(homeLSPDir()).isInstalled(new StaticAdapter(adapterID, deps));
}

export function initializationOptions(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (settings === undefined || settings === null) return {};
  const options = settings.initializationOptions;
  if (typeof options === "object" && options !== null && !Array.isArray(options)) {
    return options as Record<string, unknown>;
  }
  return settings;
}

export function initializeParams(
  root: string,
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { rootUri: fileURI(root), initializationOptions: initializationOptions(settings) };
}

export function parseMajorMinor(output: string): [number, number] | undefined {
  const m = /(?:go|v|Python )?([0-9]+)\.([0-9]+)/.exec(output);
  if (!m) return undefined;
  const major = Number.parseInt(m[1] ?? "", 10);
  const minor = Number.parseInt(m[2] ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return undefined;
  return [major, minor];
}

export function requireMinVersion(
  output: string,
  name: string,
  minMajor: number,
  minMinor: number,
): void {
  const parsed = parseMajorMinor(output);
  if (!parsed) {
    throw new Error(`could not parse ${name} version from ${JSON.stringify(output)}`);
  }
  const [major, minor] = parsed;
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new Error(`${name} ${minMajor}.${minMinor}+ required, found ${major}.${minor}`);
  }
}

/** preferredCmd returns the first candidate found on PATH, else the last candidate. */
export function preferredCmd(...candidates: string[]): string {
  for (const c of candidates) if (lookPath(c) !== undefined) return c;
  return candidates[candidates.length - 1] ?? "";
}

/** staticAdapter: the minimal adapter the installer needs to look up a managed dependency. */
export class StaticAdapter extends BaseAdapter implements LanguageAdapter {
  constructor(
    private readonly adapterID: string,
    private readonly deps: RuntimeDependency[],
  ) {
    super();
  }
  id(): string {
    return this.adapterID;
  }
  name(): string {
    return this.adapterID;
  }
  extensions(): string[] {
    return [];
  }
  binaries(): BinaryCandidate[] {
    return [];
  }
  prerequisites(): Prerequisite[] {
    return [];
  }
  async checkPrerequisites(): Promise<void> {}
  installGuide(): InstallGuide {
    return {};
  }
  canInstall(): boolean {
    return this.deps.length > 0;
  }
  runtimeDeps(): RuntimeDependency[] {
    return this.deps;
  }
  async install(): Promise<string> {
    return "";
  }
  installedPath(): string | undefined {
    return undefined;
  }
  defaultArgs(): string[] {
    return [];
  }
  initializeParams(): Record<string, unknown> | undefined {
    return undefined;
  }
  initializationOptions(): Record<string, unknown> | undefined {
    return undefined;
  }
}

export interface AdapterSpec {
  id: string;
  name: string;
  extensions: string[];
  binaries: BinaryCandidate[];
  prerequisites: Prerequisite[];
  installGuide: InstallGuide;
  canInstall: boolean;
  defaultArgs: string[];
  ignoredDirs: string[];
}

/**
 * SpecAdapter carries the table-shaped half of an adapter. Subclasses override runtimeDeps,
 * checkPrerequisites and install where Go does something other than the default.
 */
export abstract class SpecAdapter extends BaseAdapter implements LanguageAdapter {
  protected constructor(protected readonly spec: AdapterSpec) {
    super();
  }
  id(): string {
    return this.spec.id;
  }
  name(): string {
    return this.spec.name;
  }
  extensions(): string[] {
    return [...this.spec.extensions];
  }
  binaries(): BinaryCandidate[] {
    return this.spec.binaries.map((b) => ({
      ...b,
      ...(b.args ? { args: [...b.args] } : {}),
      ...(b.check_args ? { check_args: [...b.check_args] } : {}),
    }));
  }
  prerequisites(): Prerequisite[] {
    return this.spec.prerequisites.map((p) => ({ ...p }));
  }
  async checkPrerequisites(_ctx: Ctx): Promise<void> {}
  installGuide(): InstallGuide {
    return { ...this.spec.installGuide };
  }
  canInstall(): boolean {
    return this.spec.canInstall;
  }
  runtimeDeps(): RuntimeDependency[] {
    return [];
  }
  abstract install(ctx: Ctx, targetDir: string): Promise<string>;
  installedPath(): string | undefined {
    return installedPathFor(this.id(), this.runtimeDeps());
  }
  defaultArgs(): string[] {
    return [...this.spec.defaultArgs];
  }
  initializeParams(root: string, settings: Record<string, unknown> | undefined) {
    return initializeParams(root, settings);
  }
  initializationOptions(settings: Record<string, unknown> | undefined) {
    return initializationOptions(settings);
  }
  override isIgnoredDir(name: string): boolean {
    return this.spec.ignoredDirs.includes(name);
  }
}

/** Install through the shared Installer (the Go `lsp.NewInstaller(targetDir).Install(ctx, a)`). */
export function installManaged(
  adapter: LanguageAdapter,
  ctx: Ctx,
  targetDir: string,
  wrap?: string,
): Promise<string> {
  const p = new Installer(targetDir).install(ctx, adapter);
  if (!wrap) return p;
  return p.catch((e: unknown) => {
    throw new WrappedError(`${wrap}: ${errorMessage(e)}`, e);
  });
}

/** A not-installable adapter's Install. */
export function refuseInstall(message: string): Promise<string> {
  return Promise.reject(new Error(message));
}

/** Go %q for the plain ASCII strings used in messages. */
export function quote(s: string): string {
  return JSON.stringify(s);
}

/** Reads at most max bytes of a response body (io.LimitReader semantics). */
export async function readLimited(resp: Response, max: number): Promise<Uint8Array> {
  const reader = resp.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = max - total;
    const slice = value.length > room ? value.subarray(0, room) : value;
    chunks.push(slice);
    total += slice.length;
    if (value.length > room) break;
  }
  try {
    await reader.cancel();
  } catch {
    // body already drained
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** url.PathEscape. */
export function pathEscape(s: string): string {
  const keep = /[A-Za-z0-9\-_.~$&+=:@]/;
  let out = "";
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    out +=
      byte < 0x80 && keep.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
