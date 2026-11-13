// `knowns memory migrate`: port of internal/cli/memory_migrate.go.
import {
  insertMemoryDetailMarker,
  inspectMemoryClaim,
  MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH,
  MEMORY_DETAIL_MARKER,
  MEMORY_LAYER_GLOBAL,
  MEMORY_LAYER_PROJECT,
  type MemoryEntry,
  memoryCurrentForDefaultRetrieval,
  validPersistentMemoryLayer,
} from "../../models/memory.ts";
import { defineCommand } from "../core/define.ts";
import { bestEffortIndexMemory, openStorage } from "./memory-support.ts";

/** One entry whose claim boundary is being guessed. */
interface MigrateCandidate {
  id: string;
  title: string;
  layer: string;
  claim: string;
  claimBytes: number;
  detailBytes: number;
  migrated?: boolean;
}

const pluralMemories = (n: number): string => (n === 1 ? "memory" : "memories");

function migratePlain(candidates: MigrateCandidate[], write: boolean): string {
  if (candidates.length === 0) return "No memories are guessing at their claim boundary\n";
  const verb = write ? "Inserted" : "Would insert";
  let pb = `${verb} ${MEMORY_DETAIL_MARKER} in ${candidates.length} ${pluralMemories(candidates.length)}:\n\n`;
  for (const c of candidates) {
    pb += `MEMORY: ${c.id}\n`;
    pb += `  TITLE: ${c.title}\n`;
    pb += `  LAYER: ${c.layer}\n`;
    pb += `  CLAIM (${c.claimBytes}b shown, ${c.detailBytes}b hidden): ${c.claim}\n\n`;
  }
  if (!write) pb += "Nothing was written. Re-run with --write to freeze these boundaries.\n";
  return pb;
}

export default defineCommand({
  use: "migrate",
  short: "Freeze the claim boundary of memories the system is guessing at",
  long:
    `Injection shows only a memory's claim. When an entry carries no ${MEMORY_DETAIL_MARKER} the claim is taken from the first paragraph, ` +
    "which is a guess nobody made deliberately and which a later edit to the " +
    "opening paragraph can move without anyone noticing.\n\n" +
    "Without flags this previews the entries in that state. --write inserts the " +
    "marker exactly where the split happens today, so what gets injected does " +
    "not change; only who decided it does.",
  flags: [
    {
      type: "bool",
      name: "write",
      usage: "Insert the marker instead of only previewing",
      default: false,
    },
    {
      type: "string",
      name: "layer",
      usage: "Limit to one layer: project or global (default: both)",
      default: "",
    },
    {
      type: "bool",
      name: "all-statuses",
      usage: "Include non-active memory statuses",
      default: false,
    },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    const write = ctx.flags.bool("write");
    const layer = ctx.flags.string("layer");
    const allStatuses = ctx.flags.bool("all-statuses");

    let layers = [MEMORY_LAYER_PROJECT, MEMORY_LAYER_GLOBAL];
    if (layer !== "") {
      if (!validPersistentMemoryLayer(layer))
        throw new Error("layer must be 'project' or 'global'");
      // Both layers are scanned by default: the entries that need this are split across the two.
      layers = [layer];
    }

    const candidates: MigrateCandidate[] = [];
    for (const l of layers) {
      let entries: MemoryEntry[];
      try {
        entries = storage.memory.listPersistent(l);
      } catch (e) {
        throw new Error(`list ${l} memories: ${(e as Error).message}`, { cause: e });
      }
      for (const entry of entries) {
        // Default to what can actually be injected; --all-statuses covers bringing one back.
        if (!allStatuses && !memoryCurrentForDefaultRetrieval(entry)) continue;
        const info = inspectMemoryClaim(entry.content ?? "");
        if (info.claimSource !== MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH) continue;
        const candidate: MigrateCandidate = {
          id: entry.id,
          title: entry.title,
          layer: entry.layer,
          claim: info.claim,
          claimBytes: Buffer.byteLength(info.claim),
          detailBytes: info.detailBytes ?? 0,
        };
        if (write) {
          const { content, changed } = insertMemoryDetailMarker(entry.content ?? "");
          if (changed) {
            entry.content = content;
            // UpdatedAt is preserved: this is a reformat, and bumping it would raise the recency
            // bonus on every migrated entry and reorder retrieval as a side effect of a cleanup.
            try {
              await storage.memory.updateContentPreservingTimestamp(entry);
            } catch (e) {
              throw new Error(`update memory ${entry.id}: ${(e as Error).message}`, { cause: e });
            }
            await bestEffortIndexMemory(storage, entry.id);
            candidate.migrated = true;
          }
        }
        candidates.push(candidate);
      }
    }

    if (ctx.json) {
      ctx.printJSON({ count: candidates.length, memories: candidates, write });
      return;
    }
    ctx.printPaged(migratePlain(candidates, write));
  },
});
