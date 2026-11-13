// Which agent instruction files exist (internal/cli/agents.go runAgentsStatus), without rendering.
import { statSync } from "node:fs";
import { join } from "node:path";
import { knownAgentPlatforms } from "./platforms.ts";

/** One platform's row; field order is Go's JSON order. */
export interface PlatformStatus {
  name: string;
  label: string;
  fileName: string;
  exists: boolean;
  /** Omitted when zero, like Go's omitempty. */
  sizeBytes?: number;
}

/** agentStatuses: stat each known instruction file under projectRoot. */
export function agentStatuses(projectRoot: string): PlatformStatus[] {
  return knownAgentPlatforms.map((p) => {
    const ps: PlatformStatus = {
      name: p.name,
      label: p.label,
      fileName: p.fileName,
      exists: false,
    };
    try {
      const info = statSync(join(projectRoot, p.fileName));
      ps.exists = true;
      if (info.size !== 0) ps.sizeBytes = info.size;
    } catch {
      // missing
    }
    return ps;
  });
}
