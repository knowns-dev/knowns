// Port of internal/models/time.go.
import { z } from "zod";
import { int, nilableArray, timestampSchema } from "./common.ts";

/** One interval of work, stored in .knowns/time-entries.json keyed by task id. */
export const timeEntrySchema = z.object({
  /** `te-{unix-ms}-{taskId}`. */
  id: z.string(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  /** Elapsed wall-clock seconds. */
  duration: int,
  note: z.string().optional(),
});
export type TimeEntry = z.infer<typeof timeEntrySchema>;

/** Contents of .knowns/time-entries.json. */
export const timeEntriesFileSchema = z.record(z.string(), z.array(timeEntrySchema));
export type TimeEntriesFile = z.infer<typeof timeEntriesFileSchema>;

/**
 * A running or paused timer in .knowns/time.json. Timestamps are ISO-8601 strings; `pausedAt` is
 * JSON `null` (not omitted) while the timer runs.
 */
export const activeTimerSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string().optional(),
  startedAt: z.string(),
  pausedAt: z.string().nullable(),
  totalPausedMs: int,
});
export type ActiveTimer = z.infer<typeof activeTimerSchema>;

/** Root of .knowns/time.json. */
export const timeStateSchema = z.object({
  active: nilableArray(activeTimerSchema),
});
export type TimeState = z.infer<typeof timeStateSchema>;

/**
 * models.ParseDuration: "2h", "30m", "1h30m", "90s", "1h30m45s" -> seconds. Mirrors the Go parser
 * exactly (including its quirks: the first `h`, then first `m`, then first `s` in the remainder).
 */
export function parseDuration(input: string): number {
  const s = input.trim();
  if (s === "") throw new Error("empty duration string");

  let total = 0;
  let rest = s;

  const take = (unit: string, seconds: number, label: string) => {
    const idx = rest.indexOf(unit);
    if (idx < 0) return;
    const text = rest.slice(0, idx);
    if (!/^[+-]?\d+$/.test(text)) throw new Error(`invalid ${label} in "${s}"`);
    total += Number.parseInt(text, 10) * seconds;
    rest = rest.slice(idx + 1);
  };
  take("h", 3600, "hours");
  take("m", 60, "minutes");
  take("s", 1, "seconds");

  if (rest !== "") {
    throw new Error(`unrecognised duration format: "${s}" (use e.g. "2h", "30m", "1h30m")`);
  }
  if (total === 0 && s !== "0s" && s !== "0m" && s !== "0h") {
    throw new Error(`duration parsed to zero from "${s}" - check the format`);
  }
  return total;
}
