// Root commands the spec removed (D8: `knowns import`). The help manifest is captured from Go,
// which still describes them as working; root help and the command itself use these lines
// instead. They are the only intended differences from Go's root help.
export const REMOVED_COMMAND_SHORT: Readonly<Record<string, string>> = {
  import: "Removed (imported content stays readable)",
};

/** The root help line Go 0.34.1 prints for each removed command, for parity tests. */
export const GO_SHORT_OF_REMOVED: Readonly<Record<string, string>> = {
  import: "Manage imported Knowns packages",
};
