// Child process for lock tests: holds a TypeScript file lock for N ms. Prints HELD / RELEASED.
// Usage: bun hold-lock.ts <lockPath> <holdMs>
import { withFileLock } from "../../src/storage/core/file-lock.ts";

const [lockPath, holdMs] = process.argv.slice(2);
if (!lockPath || !holdMs) throw new Error("usage: hold-lock.ts <lockPath> <holdMs>");

await withFileLock(lockPath, async () => {
  console.log("HELD");
  await Bun.sleep(Number(holdMs));
  console.log("RELEASED");
});
