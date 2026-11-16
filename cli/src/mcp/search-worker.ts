// Worker thread for the search tool (spec D4): keyword and semantic search are synchronous CPU work
// above 50 ms on a cold index, which would stall every other session on the daemon's event loop.
// The worker keeps one McpState per project, builds its own storage and index cache, and answers
// one request at a time.
import { parentPort, workerData } from "node:worker_threads";
import { McpLogger } from "./log.ts";
import type { SearchJob, SearchReply } from "./search-pool.ts";
import { McpState } from "./state.ts";

// Bun starts a worker with the environment the process began with, not the parent's current one
// (HOME and the runtime root are often set after start), so the parent sends its own.
if (workerData?.env) Object.assign(process.env, workerData.env);

const states = new Map<string, Promise<McpState>>();

async function stateFor(job: SearchJob): Promise<McpState> {
  const key = `${job.storeRoot}\0${job.projectRoot}`;
  let p = states.get(key);
  if (!p) {
    p = (async () => {
      const core = await import("../storage/core/index.ts");
      const state = new McpState(new McpLogger());
      await state.setProject(new core.Store(job.storeRoot, job.projectRoot), job.projectRoot);
      return state;
    })();
    states.set(key, p);
    if (states.size > 16) states.delete(states.keys().next().value as string);
  }
  return p;
}

parentPort?.on("message", async (job: SearchJob) => {
  let reply: SearchReply;
  try {
    const state = await stateFor(job);
    const { handle } = await import("./handlers/search.ts");
    const res = await handle(state, {}, job.req);
    reply = { id: job.id, text: res.text, isError: res.isError === true };
  } catch (e) {
    reply = { id: job.id, text: (e as Error).message, isError: true };
  }
  parentPort?.postMessage(reply);
});
