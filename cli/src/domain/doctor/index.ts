// The doctor library: run the same diagnostics as `knowns doctor` from any layer.
import { findProjectRoot } from "../../storage/core/project-location.ts";
import { foundationCheckers } from "./foundation.ts";
import { type LocalDeps, localCheckers } from "./local.ts";
import type { Checker } from "./model.ts";
import { defaultOnlineDeps, type OnlineDeps, onlineCheckers } from "./online.ts";

export * from "./foundation.ts";
export { importsRemovedChecker } from "./imports.ts";
export * from "./local.ts";
export * from "./model.ts";
export * from "./online.ts";
export * from "./qdrant-checks.ts";

import { importsRemovedChecker } from "./imports.ts";

export { findProjectRoot };

/** FoundationCheckers + LocalCheckers (when a project is active) + NetworkCheckers. */
export function allCheckers(
  project: import("./foundation.ts").DoctorProject | undefined,
  local: LocalDeps,
  online: OnlineDeps = defaultOnlineDeps(project, local.env),
  extra: Checker[] = [],
): Checker[] {
  const checkers = foundationCheckers(project);
  if (project) checkers.push(...localCheckers(local));
  checkers.push(...onlineCheckers(online));
  const imports = importsRemovedChecker(project);
  if (imports) checkers.push(imports);
  checkers.push(...extra);
  return checkers;
}
