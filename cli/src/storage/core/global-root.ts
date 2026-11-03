import { homedir } from "node:os";
import { join } from "node:path";

/** GlobalRootPath: the machine-level Knowns root (~/.knowns). HOME wins, then the OS home. */
export function globalRootPath(): string {
  const home = process.env.HOME;
  if (home) return join(home, ".knowns");
  return join(homedir(), ".knowns");
}
