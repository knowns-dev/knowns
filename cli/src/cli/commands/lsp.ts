// `knowns lsp` (internal/cli/lsp.go): list, install and clean up language servers.
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { runtimeStatusJSON } from "../../lsp/status.ts";
import { tabwrite } from "../../lsp/tabwriter.ts";
import type { LanguageAdapter, LanguageRuntimeStatus } from "../../lsp/types.ts";
import { exactArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { getStoreErr } from "../core/helpers.ts";
import { renderCmd, renderCount, renderDim, StyleWarning } from "../core/plainoutput.ts";

const lspListLogTemplate = ".knowns/logs/lsp/<language>.log";

const GroupProblem = 0;
const GroupReady = 1;
const GroupMissing = 2;
const GroupDisabled = 3;
const groupTitles = ["Problems", "Ready", "Not installed", "Disabled"];

function listGroup(row: LanguageRuntimeStatus): number {
  if ((row.install_error ?? "") !== "" || (row.update_error ?? "") !== "") return GroupProblem;
  switch (row.status) {
    case "crashed":
    case "degraded":
      return GroupProblem;
    case "disabled":
      return GroupDisabled;
    case "not_installed":
      return GroupMissing;
    default:
      return GroupReady;
  }
}

const versionToken = /\bv?\d+\.\d+(?:\.\d+)*\b|\b\d{4}-\d{2}-\d{2}\b/;

export function lspShortVersion(raw: string): string {
  const t = raw.trim();
  if (t === "") return "";
  return versionToken.exec(t)?.[0] ?? "";
}

function listProblem(row: LanguageRuntimeStatus): string {
  if ((row.install_error ?? "") !== "") return row.install_error as string;
  if ((row.update_error ?? "") !== "") return row.update_error as string;
  if ((row.missing_capabilities?.length ?? 0) > 0)
    return `degraded, missing ${row.missing_capabilities?.join(", ")}`;
  return row.status;
}

function listDetail(group: number, row: LanguageRuntimeStatus): string {
  switch (group) {
    case GroupMissing:
      return (row.install_cmd ?? "") !== ""
        ? renderCmd(row.install_cmd as string)
        : renderDim(row.install_state);
    case GroupDisabled:
      return renderDim("disabled in config");
    case GroupProblem:
      return StyleWarning.render(listProblem(row));
  }
  const server = (row.binary ?? "") === "" ? "-" : (row.binary as string);
  let origin = row.source ?? "";
  const v = lspShortVersion(row.version ?? "");
  if (v !== "") origin = `${origin} ${v}`.trim();
  let detail = `${server}\t${renderDim(origin)}`;
  if ((row.project_path ?? "") !== "")
    detail += `\t${renderDim(basename(row.project_path as string))}`;
  return detail;
}

function compactList(rows: LanguageRuntimeStatus[]): string {
  if (rows.length === 0) return `${renderDim("No LSP languages registered.")}\n`;
  const first = rows[0] as LanguageRuntimeStatus;
  let owner = first.owner ? first.owner : "local";
  if (first.daemon_state) owner += ` ${first.daemon_state}`;
  const out = `${renderDim(`${owner} · logs ${lspListLogTemplate}`)}\n`;
  const grouped: LanguageRuntimeStatus[][] = [[], [], [], []];
  for (const r of rows) (grouped[listGroup(r)] as LanguageRuntimeStatus[]).push(r);
  return out + groupedText(grouped);
}

function groupedText(grouped: LanguageRuntimeStatus[][]): string {
  let out = "";
  for (const group of [GroupProblem, GroupReady, GroupMissing, GroupDisabled]) {
    const members = grouped[group] as LanguageRuntimeStatus[];
    if (members.length === 0) continue;
    out += `\n${renderCount(groupTitles[group] as string, members.length)}\n`;
    out += tabwrite(members.map((r) => `  ${r.id}\t${listDetail(group, r)}`));
  }
  return out;
}

function verboseList(rows: LanguageRuntimeStatus[]): string {
  const lines = ["Language\tStatus\tOwner\tBackend\tRuntime\tInstall\tCapabilities\tLog"];
  for (const row of rows) {
    let owner = row.owner ? row.owner : "-";
    if (row.daemon_state) owner += ` (${row.daemon_state})`;
    let backend = "-";
    if (row.backend) {
      backend = row.backend;
      if (row.backend_source) backend += ` (${row.backend_source})`;
    }
    let runtime = "-";
    if (row.binary) {
      runtime = row.binary;
      if (row.source) runtime += ` (${row.source})`;
    }
    if (row.version && row.source === "knowns") runtime += ` ${row.version}`;
    if (row.readiness_state && row.readiness_state !== "not_applicable")
      runtime += ` readiness=${row.readiness_state}`;
    if (row.project_path) runtime += ` project=${basename(row.project_path)}`;
    const install = row.install_cmd ? row.install_cmd : row.install_state;
    const logPath = row.log_path ? row.log_path : "-";
    let capabilities = (row.capabilities ?? []).join(",");
    if ((row.missing_capabilities?.length ?? 0) > 0)
      capabilities = `missing:${row.missing_capabilities?.join(",")}`;
    if (capabilities === "") capabilities = "-";
    lines.push(
      [row.id, row.status, owner, backend, runtime, install, capabilities, logPath].join("\t"),
    );
  }
  return tabwrite(lines);
}

async function currentProjectRoot(ctx: CommandContext): Promise<string> {
  try {
    return (await getStoreErr(ctx.cmd)).projectRoot;
  } catch {
    return ctx.cwd;
  }
}

async function collectRows(ctx: CommandContext): Promise<LanguageRuntimeStatus[]> {
  const root = await currentProjectRoot(ctx);
  const daemon = await import("../../lspdaemon/index.ts");
  const { getLSPManagerForRoot } = await import("../../lsp/project.ts");
  const local = async (state: string): Promise<LanguageRuntimeStatus[]> => {
    const mgr = await getLSPManagerForRoot(root, (l) => ctx.printErr(l));
    return daemon.annotateLocalStatuses(await mgr.runtimeStatuses(), state);
  };
  if (daemon.disabledByEnv()) {
    ctx.printErr(`warn: ${daemon.disabledWarning()}\n`);
    return local(daemon.DaemonStateDisabledByEnv);
  }
  try {
    const client = await daemon.ensureClient(undefined, root);
    return await client.runtimeStatuses();
  } catch {
    return local(daemon.DaemonStateUnavailable);
  }
}

function firstBinaryName(a: LanguageAdapter): string {
  return a.binaries()[0]?.name ?? a.id();
}

function installGuideText(a: LanguageAdapter): string {
  const guide = a.installGuide();
  let out = `Cannot auto-install ${firstBinaryName(a)}. Install manually:\n`;
  if (guide.command) out += `  → ${guide.command}\n`;
  if (guide.url) out += `  → ${guide.url}\n`;
  if (guide.notes) out += `  ${guide.notes}\n`;
  return out;
}

async function confirmInstall(ctx: CommandContext, requested: string, yes: boolean): Promise<void> {
  ctx.printErr(`WARNING: ${requested} is not the recommended Knowns-verified LSP version.\n`);
  if (yes) return;
  if (!process.stdin.isTTY)
    throw new Error(`non-interactive installation of ${requested} requires --yes`);
  ctx.printErr(`Continue with ${requested}? [y/N] `);
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });
  const answer = await new Promise<string>((resolve, reject) => {
    rl.once("line", resolve);
    rl.once("close", () => reject(new Error("read confirmation: EOF")));
  }).finally(() => rl.close());
  const a = answer.trim().toLowerCase();
  if (a !== "y" && a !== "yes") throw new Error("installation cancelled");
}

function countVersionDirs(path: string): number {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

const list = defineCommand<LanguageRuntimeStatus[]>({
  use: "list",
  short: "List supported LSP language servers",
  flags: [
    {
      type: "bool",
      name: "verbose",
      shorthand: "v",
      usage: "Show daemon owner, backend selection, and log paths",
      default: false,
    },
  ],
  async run(ctx) {
    return collectRows(ctx);
  },
  render: {
    json: (rows) => rows.map(runtimeStatusJSON),
    styled: (rows, ctx) => (ctx.flags.bool("verbose") ? verboseList(rows) : compactList(rows)),
  },
});

const install = defineCommand({
  use: "install <language>",
  short: "Install an LSP language server",
  args: exactArgs(1),
  flags: [
    {
      type: "bool",
      name: "latest",
      usage: "Install the latest upstream version (requires confirmation)",
      default: false,
    },
    {
      type: "string",
      name: "version",
      usage: "Install an explicit upstream version or tag (requires confirmation)",
      default: "",
    },
    {
      type: "bool",
      name: "yes",
      shorthand: "y",
      usage: "Confirm a non-recommended version selection",
      default: false,
    },
  ],
  flagGroups: { mutuallyExclusive: [["latest", "version"]] },
  async run(ctx) {
    const { find } = await import("../../lsp/adapters/index.ts");
    const id = ctx.args[0] as string;
    const adapter = find(id);
    if (!adapter) throw new Error(`unsupported language ${JSON.stringify(id)}`);
    if (!adapter.canInstall()) {
      ctx.print(installGuideText(adapter));
      return;
    }
    const latest = ctx.flags.bool("latest");
    const version = ctx.flags.string("version").trim();
    const yes = ctx.flags.bool("yes");
    const selector = { latest, version };
    if (latest || version !== "") await confirmInstall(ctx, latest ? "latest" : version, yes);
    try {
      await adapter.checkPrerequisites(undefined);
    } catch (e) {
      ctx.print(`Prerequisite check failed: ${(e as Error).message}\n\n`);
      ctx.print(installGuideText(adapter));
      const prereqs = adapter.prerequisites();
      if (prereqs.length > 0) {
        ctx.print("\nRequired prerequisites:\n");
        for (const p of prereqs) {
          ctx.print(`  • ${p.name}\n`);
          if (p.install_hint) ctx.print(`    ${p.install_hint}\n`);
        }
      }
      throw new Error(`prerequisites not met for ${adapter.id()}`);
    }
    ctx.print(`Installing ${firstBinaryName(adapter)} for ${adapter.name()}...\n`);
    const { defaultLSPBaseDir } = await import("../../lsp/dependency-adapter.ts");
    let path: string;
    if (adapter.runtimeDeps().length === 0) {
      if (latest || version !== "") {
        throw new Error(
          `language ${JSON.stringify(adapter.id())} does not support managed version selection`,
        );
      }
      try {
        path = await adapter.install(undefined, defaultLSPBaseDir());
      } catch (e) {
        throw new Error(`install ${adapter.id()}: ${(e as Error).message}`);
      }
    } else {
      for (const dep of adapter.runtimeDeps()) {
        const src = (dep.source ?? "").toLowerCase();
        const at = (dep.archive_type ?? "").toLowerCase();
        if (src === "nuget" || at === "nupkg" || src === "npm" || at === "npm") continue;
        if (!dep.sha256 || dep.sha256.toLowerCase() === "todo") {
          ctx.print(installGuideText(adapter));
          throw new Error(
            `auto-install metadata for ${adapter.id()} is incomplete: missing SHA-256 for ${dep.platform_id ?? ""}`,
          );
        }
      }
      const { Installer } = await import("../../lsp/installer.ts");
      try {
        path = await new Installer(defaultLSPBaseDir()).installWithOptions(undefined, adapter, {
          selector,
        });
      } catch (e) {
        throw new Error(`install ${adapter.id()}: ${(e as Error).message}`);
      }
    }
    ctx.print(`✓ Installed ${basename(path)} to ${path}\n`);
  },
});

const cleanup = defineCommand<string[]>({
  use: "cleanup",
  short: "Remove old LSP server versions",
  async run() {
    const { all } = await import("../../lsp/adapters/index.ts");
    const { Installer } = await import("../../lsp/installer.ts");
    const { defaultLSPBaseDir } = await import("../../lsp/dependency-adapter.ts");
    const base = defaultLSPBaseDir();
    const installer = new Installer(base);
    const cleaned: string[] = [];
    for (const adapter of all()) {
      if (!installer.status(adapter).cleanup_eligible) continue;
      const langDir = join(base, adapter.id());
      const before = countVersionDirs(langDir);
      try {
        installer.cleanup(adapter.id());
      } catch (e) {
        throw new Error(`cleanup ${adapter.id()}: ${(e as Error).message}`);
      }
      const after = countVersionDirs(langDir);
      if (before > after) cleaned.push(`${adapter.id()}: removed ${before - after} old version(s)`);
    }
    return cleaned;
  },
  render: {
    json: (c) => (c.length === 0 ? null : c),
    styled: (c) =>
      c.length === 0 ? "No old LSP server versions found.\n" : c.map((l) => `${l}\n`).join(""),
  },
});

export default defineCommand({
  use: "lsp",
  short: "Manage LSP language servers",
  subcommands: [list, install, cleanup],
});
