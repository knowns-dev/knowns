// Port of internal/storage/manager.go: runtime project switching.
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadMachineRegistry, type ProjectRegistry } from "./machine-registry.ts";
import { locateProjectAt } from "./project-location.ts";
import { Store } from "./store.ts";

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Coordinates runtime project switching; route handlers call `getStore()`. */
export class Manager {
  private active: Store | undefined;

  constructor(
    initialStore: Store | undefined,
    private readonly registry: ProjectRegistry | undefined,
  ) {
    this.active = initialStore;
  }

  getStore(): Store | undefined {
    return this.active;
  }

  getRegistry(): ProjectRegistry | undefined {
    return this.registry;
  }

  /**
   * Switch: make projectPath the active project. A project linked to a store opens its store
   * folder; otherwise the project must have an in-repo .knowns/ directory. When the registry can
   * register and activate projects (the stores Registry), it is updated; a registry failure is
   * ignored, as in Go.
   */
  switch(projectPath: string): Store {
    const abs = resolve(projectPath);

    let next: Store | undefined;
    const linked = this.registry?.findStoreLinked(abs);
    if (this.registry && linked && this.registry.isValid(linked)) {
      next = new Store(this.registry.knowledgeRoot(linked), linked.path);
    }
    if (!next) {
      // The manager's registry was loaded at startup; a store link made since then is only in
      // the machine registry on disk.
      try {
        const loc = locateProjectAt(abs);
        if (loc.store) next = new Store(loc.knowledgeRoot, loc.projectRoot);
      } catch {
        // fall through to the in-repo check
      }
    }
    if (!next) {
      const knDir = join(abs, ".knowns");
      if (!isDir(knDir)) throw new Error(`no .knowns/ directory at ${abs}`);
      next = Store.open(knDir);
    }

    // Update registry: add if new, then set active. Go ignores a registry failure here (Add now
    // returns an error for a project that is not registrable); the switch itself still succeeds.
    const reg = this.registry;
    if (reg?.add && reg.setActive) {
      try {
        const p = reg.add(abs);
        if (p) {
          try {
            reg.setActive(p.id);
          } catch {
            // best effort, like `_ = m.reg.SetActive(p.ID)`
          }
        }
      } catch {
        // best effort: a registry write failure must not abort the switch
      }
    }

    this.active = next;
    return next;
  }

  /** ActiveProjectRoot: the code repository root of the active store, or "". */
  activeProjectRoot(): string {
    return this.active?.projectRoot ?? "";
  }
}

export { loadMachineRegistry };
