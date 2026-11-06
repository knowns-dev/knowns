// Runs one runtime `reindex` job in this process, the way the daemon does (executeRuntimeJob), for
// tests that compare the index it writes. Spawned with a temporary HOME; never imported.
//   bun test/cli/commands/run-reindex-job.ts <storeRoot>
import { executeRuntimeJob } from "../../../src/runtime/executor.ts";

const storeRoot = process.argv[2];
if (!storeRoot) throw new Error("usage: run-reindex-job.ts <storeRoot>");
const now = new Date().toISOString();
await executeRuntimeJob(storeRoot, {
  id: "test-reindex",
  key: "reindex-search",
  kind: "reindex-search",
  requestedAt: now,
  runAfter: now,
});
