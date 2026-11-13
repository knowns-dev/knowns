// The per-section git tracking toggles shared by the init wizard and the settings flows.
import { type GitTracking, gitTrackingDefaults } from "../../models/config.ts";

const SECTIONS = ["tasks", "docs", "templates", "memories", "decisions"] as const;

/** gitTrackingSelectedSections: the sections a tracking config commits (unset = the default). */
export function gitTrackingSelectedSections(tracking: GitTracking | undefined): string[] {
  const defaults = gitTrackingDefaults();
  const gt = tracking ?? defaults;
  // Go checks in this order; membership is what matters.
  return SECTIONS.filter((s) => gt[s] ?? defaults[s]);
}

/** gitTrackingFromSelectedSections: every section explicit. */
export function gitTrackingFromSelectedSections(
  selected: readonly string[],
): Required<GitTracking> {
  return {
    tasks: selected.includes("tasks"),
    docs: selected.includes("docs"),
    templates: selected.includes("templates"),
    memories: selected.includes("memories"),
    decisions: selected.includes("decisions"),
  };
}
