// Port of internal/doctor/foundation.go: the project and validation checks that need no network.
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Project } from "../../models/config.ts";
import type { Storage } from "../../storage/adapters.ts";
import type { Store } from "../../storage/core/index.ts";
import {
  currentSchemaVersion,
  needsMigration,
  pendingMigrations,
} from "../../storage/stores/migrations.ts";
import { VERSION } from "../../version.ts";
import { run as runValidate } from "../validate/index.ts";
import { type Checker, type CheckOutcome, inactiveProject, type ProjectInfo } from "./model.ts";

/** What the checks read: the project (if any) and the storage over it. */
export interface DoctorProject {
  store: Store;
  storage: Storage;
}

/** fs.FileMode.Perm().String(): "-rwxr-xr-x". */
export function permString(mode: number): string {
  const chars = "rwxrwxrwx";
  let out = "-";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : "-";
  return out;
}

export function projectFromStore(project: DoctorProject | undefined): ProjectInfo {
  if (!project) return inactiveProject();
  const projectPath = project.store.projectRoot;
  const info: ProjectInfo = {
    active: true,
    name: basename(projectPath),
    path: projectPath,
    knownsVersion: VERSION,
  };
  try {
    const loaded = project.storage.config.load();
    if (loaded.name !== "") info.name = loaded.name;
  } catch {
    // keep the directory name
  }
  return info;
}

export const skippedForMissingProject = (): CheckOutcome => ({
  status: "skip",
  summary: "Check requires an active project",
  skipReason: "project_inactive",
});

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function foundationCheckers(project: DoctorProject | undefined): Checker[] {
  const load = (): Project => (project as DoctorProject).storage.config.load();
  return [
    {
      id: "project.active",
      scope: "project",
      check: (): CheckOutcome => {
        if (!project) {
          return {
            status: "fail",
            summary: "No active Knowns project",
            evidence: { active: false },
            remediation: {
              description: "Initialize a Knowns project in the current workspace.",
              command: "knowns init",
            },
          };
        }
        const info = projectFromStore(project);
        return {
          status: "pass",
          summary: "Active Knowns project detected",
          evidence: { active: true, name: info.name ?? "", path: info.path ?? "" },
        };
      },
    },
    {
      id: "project.config",
      scope: "project",
      check: (): CheckOutcome => {
        if (!project) return skippedForMissingProject();
        const configPath = join(project.store.root, "config.json");
        try {
          const loaded = load();
          return {
            status: "pass",
            summary: "Project configuration is readable and valid",
            evidence: { path: configPath, name: loaded.name },
          };
        } catch {
          return {
            status: "fail",
            summary: "Project configuration is unreadable or invalid",
            evidence: { path: configPath, errorCode: "config_invalid" },
            remediation: {
              description: "Repair .knowns/config.json or restore it from version control.",
            },
          };
        }
      },
    },
    {
      id: "project.migration",
      scope: "project",
      check: (): CheckOutcome => {
        if (!project) return skippedForMissingProject();
        const loaded = load();
        if (!needsMigration(loaded)) {
          return {
            status: "pass",
            summary: "Project configuration schema is current",
            evidence: { schemaVersion: loaded.schemaVersion ?? 0 },
          };
        }
        const pending = pendingMigrations(loaded.schemaVersion ?? 0);
        return {
          status: "warn",
          summary: "Project configuration needs migration",
          evidence: {
            schemaVersion: loaded.schemaVersion ?? 0,
            currentVersion: currentSchemaVersion(),
            pendingCount: pending.length,
          },
          remediation: {
            description:
              "Upgrade the project configuration to the current schema version. Preview with `knowns migrate`, then apply with `knowns migrate --write`.",
            command: "knowns migrate",
          },
        };
      },
    },
    {
      id: "project.storage",
      scope: "project",
      check: (): CheckOutcome => {
        if (!project) return skippedForMissingProject();
        const root = project.store.root;
        let st: ReturnType<typeof statSync> | undefined;
        try {
          st = statSync(root);
        } catch {
          st = undefined;
        }
        if (!st?.isDirectory()) {
          return {
            status: "fail",
            summary: "Knowns storage root is unavailable",
            evidence: { path: root, errorCode: "storage_root_unavailable" },
            remediation: {
              description: "Restore the .knowns directory or initialize the project again.",
              command: "knowns init",
            },
          };
        }
        // Windows reports no execute bits; Go gives a directory 0777 (0555 when read-only) there.
        const mode = permString(process.platform === "win32" ? st.mode | 0o111 : st.mode);
        try {
          readdirSync(root);
        } catch {
          return {
            status: "fail",
            summary: "Knowns storage root is not readable",
            evidence: { path: root, mode, errorCode: "storage_root_unreadable" },
            remediation: { description: "Restore read permissions for the .knowns directory." },
          };
        }
        const missing = ["tasks", "docs", "templates"].filter((n) => !isDir(join(root, n)));
        missing.sort();
        const evidence: CheckOutcome["evidence"] = { path: root, mode };
        if (missing.length > 0) {
          evidence.missingPaths = missing;
          return {
            status: "warn",
            summary: `${missing.length} Knowns storage directories are missing`,
            evidence,
            remediation: {
              description: "Recreate the missing Knowns storage directories.",
              command: "knowns init",
            },
          };
        }
        return { status: "pass", summary: "Knowns storage paths are readable", evidence };
      },
    },
    {
      id: "validation.summary",
      scope: "validation",
      check: (): CheckOutcome => {
        if (!project) return skippedForMissingProject();
        const r = runValidate(project.storage, { scope: "all", fix: false });
        const evidence = { errors: r.errorCount, warnings: r.warningCount, info: r.infoCount };
        if (r.errorCount > 0) {
          return {
            status: "fail",
            summary: `Validation found ${r.errorCount} errors and ${r.warningCount} warnings`,
            evidence,
            remediation: {
              description: "Inspect and resolve the detailed validation issues.",
              command: "knowns validate",
            },
          };
        }
        if (r.warningCount > 0) {
          return {
            status: "warn",
            summary: `Validation found ${r.warningCount} warnings`,
            evidence,
            remediation: {
              description: "Inspect the detailed validation warnings.",
              command: "knowns validate",
            },
          };
        }
        return { status: "pass", summary: "Validation passed", evidence };
      },
    },
  ];
}
