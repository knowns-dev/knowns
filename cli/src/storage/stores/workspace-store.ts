// Port of internal/storage/workspace_store.go: .knowns/workspaces.json (a JSON array).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Workspace, workspacesFileSchema } from "../../models/workspace.ts";
import { parseBoundary } from "../../schema/index.ts";
import { parseJsonPreservingNumbers, writeJson } from "../core/util.ts";
import { isNotFound } from "./internal.ts";

export class WorkspaceStore {
  readonly root: string;
  constructor(store: { root: string }) {
    this.root = store.root;
  }

  filePath(): string {
    return join(this.root, "workspaces.json");
  }

  list(): Workspace[] {
    let data: string;
    try {
      data = readFileSync(this.filePath(), "utf8");
    } catch (e) {
      if (isNotFound(e)) return [];
      throw new Error(`read workspaces.json: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonPreservingNumbers(data);
    } catch (e) {
      throw new Error(`parse workspaces.json: ${(e as Error).message}`);
    }
    if (parsed === null) return [];
    return parseBoundary(workspacesFileSchema, parsed, "workspaces.json");
  }

  get(id: string): Workspace {
    const found = this.list().find((w) => w.id === id);
    if (!found) throw new Error(`workspace "${id}" not found`);
    return found;
  }

  /** Save: replace the workspace with the same ID, or append. */
  save(workspace: Workspace): void {
    if (workspace.id === "") throw new Error("workspace ID is required");
    const all = this.list();
    const i = all.findIndex((w) => w.id === workspace.id);
    if (i >= 0) all[i] = workspace;
    else all.push(workspace);
    writeJson(this.filePath(), all);
  }

  delete(id: string): void {
    const all = this.list();
    const filtered = all.filter((w) => w.id !== id);
    if (filtered.length === all.length) throw new Error(`workspace "${id}" not found`);
    writeJson(this.filePath(), filtered);
  }

  /** MarkAllStopped: crash recovery; every running workspace becomes stopped. */
  markAllStopped(): void {
    const all = this.list();
    let changed = false;
    for (const w of all) {
      if (w.status === "running") {
        w.status = "stopped";
        changed = true;
      }
    }
    if (changed) writeJson(this.filePath(), all);
  }
}
