// internal/server/routes/time.go
import { findError } from "../../domain/tasklifecycle/errors.ts";
import { activeTimerToWire, timeEntryToWire } from "../../domain/tasklifecycle/wire.ts";
import type { ActiveTimer, TimeEntry } from "../../models/time.ts";
import { goNow } from "../../storage/history/go-json.ts";
import { HistoryConflictError, MutationConflictError } from "../../storage/history/index.ts";
import { type App, requireStore } from "../app.ts";
import { timeField } from "../gojson.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { type Obj, readStruct } from "./support.ts";
import { lifecycleService } from "./tasks.ts";

const isConflict = (e: Error): e is HistoryConflictError | MutationConflictError =>
  e instanceof HistoryConflictError || e instanceof MutationConflictError;

export function timeStateWire(active: ActiveTimer[] | null | undefined): Obj {
  return { active: (active ?? []).map(activeTimerToWire) };
}

export function registerTime(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);
  const state = () => app.need().time.getState();

  r.get(
    "/api/time/status",
    guard(() => {
      try {
        return jsonResponse(200, timeStateWire(state().active));
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  const stateOrEmpty = (): ActiveTimer[] => {
    try {
      return state().active ?? [];
    } catch {
      return [];
    }
  };
  const broadcast = (): ActiveTimer[] => {
    const active = stateOrEmpty();
    app.sse.broadcast({ type: "time:updated", data: timeStateWire(active) });
    return active;
  };

  r.post(
    "/api/time/start",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "startRequest", { taskId: "string" });
      if (!body.ok) return body.res;
      const taskId = (body.v.taskId as string | undefined) ?? "";
      if (taskId === "") return respondError(400, "taskId is required");
      let title: string;
      try {
        title = s.tasks.get(taskId).title;
      } catch (e) {
        return respondError(404, `task not found: ${errMessage(e)}`);
      }
      try {
        await s.time.start(taskId, title);
      } catch (e) {
        return respondError(409, errMessage(e));
      }
      const active = broadcast();
      return jsonResponse(200, {
        active: active.map(activeTimerToWire),
        status: "started",
        taskId,
      });
    }),
  );

  r.post(
    "/api/time/stop",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "stopRequest", {
        taskId: "string",
        all: "bool",
        expectedHash: "string",
        expectedHashes: "stringMap",
      });
      if (!body.ok) return body.res;
      const v = body.v;
      const svc = lifecycleService(app, s);
      if (v.all === true) {
        let st: ActiveTimer[];
        try {
          st = state().active ?? [];
        } catch (e) {
          return respondError(500, errMessage(e));
        }
        const ids = st.map((a) => a.taskId);
        if (ids.length === 0) {
          return jsonResponse(200, { active: st.map(activeTimerToWire), stopped: [] });
        }
        try {
          await svc.stopTimers(ids, {
            actor: "api",
            expectedHashes: v.expectedHashes as Record<string, string> | undefined,
          });
        } catch (e) {
          return respondError(findError(e, isConflict) ? 409 : 500, errMessage(e));
        }
        const active = broadcast();
        return jsonResponse(200, { active: active.map(activeTimerToWire), stopped: ids });
      }
      const taskId = (v.taskId as string | undefined) ?? "";
      if (taskId === "") return respondError(400, "taskId is required (or set all:true)");
      let entry: TimeEntry;
      try {
        entry = await svc.stopTimer(taskId, {
          actor: "api",
          expectedHash: (v.expectedHash as string | undefined) ?? "",
        });
      } catch (e) {
        return respondError(findError(e, isConflict) ? 409 : 404, errMessage(e));
      }
      const active = broadcast();
      return jsonResponse(200, {
        active: active.map(activeTimerToWire),
        stopped: [timeEntryToWire(entry)],
      });
    }),
  );

  r.post(
    "/api/time/add",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "addTimeRequest", {
        taskId: "string",
        duration: "int",
        note: "string",
        startedAt: timeField,
        expectedHash: "string",
      });
      if (!body.ok) return body.res;
      const v = body.v;
      const taskId = (v.taskId as string | undefined) ?? "";
      if (taskId === "") return respondError(400, "taskId is required");
      const duration = (v.duration as number | undefined) ?? 0;
      if (duration < 0) return respondError(400, "duration must be non-negative");
      const startedMs = v.startedAt !== undefined ? Date.parse(v.startedAt as string) : Date.now();
      const startedAt = goNow(new Date(startedMs));
      const entry: TimeEntry = {
        id: `te-${BigInt(startedMs) * 1_000_000n}-${taskId}`,
        startedAt,
        endedAt: goNow(new Date(startedMs + duration * 1000)),
        duration,
      };
      if (v.note !== undefined && v.note !== "") entry.note = v.note as string;
      let recorded: TimeEntry;
      try {
        recorded = await lifecycleService(app, s).addTimeEntry(taskId, {
          actor: "api",
          expectedHash: (v.expectedHash as string | undefined) ?? "",
          entry,
        });
      } catch (e) {
        return respondError(409, errMessage(e));
      }
      broadcast();
      return jsonResponse(200, { duration, entry: timeEntryToWire(recorded), taskId });
    }),
  );

  for (const [name, status] of [
    ["pause", "paused"],
    ["resume", "resumed"],
  ] as const) {
    r.post(
      `/api/time/${name}`,
      guard(async (c) => {
        const s = app.need();
        const body = await readStruct(c, "pauseResumeRequest", { taskId: "string" });
        if (!body.ok) return body.res;
        const taskId = (body.v.taskId as string | undefined) ?? "";
        if (taskId === "") return respondError(400, "taskId is required");
        try {
          if (name === "pause") await s.time.pause(taskId);
          else await s.time.resume(taskId);
        } catch (e) {
          return respondError(409, errMessage(e));
        }
        const active = broadcast();
        return jsonResponse(200, { active: active.map(activeTimerToWire), status, taskId });
      }),
    );
  }
}
