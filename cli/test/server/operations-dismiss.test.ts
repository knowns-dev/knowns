// KN-726E8A: what the Activity Tray lists and what a dismissal does, without an event stream open.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as real from "../../src/runtime/job-operations.ts";
import type { JobOperationSource, Operation } from "../../src/runtime/operation-types.ts";
import * as q from "../../src/runtime/queue.ts";
import { DISMISSED_KEEP_MS, fileDismissals } from "../../src/server/dismissed-operations.ts";
import { OperationRegistry } from "../../src/server/operations.ts";
import { setProcessHome } from "../helpers/process-env.ts";

const HOUR = 3_600_000;
const home = mkdtempSync(join(tmpdir(), "knowns-tray-dismiss-"));
const root = join(home, "proj", ".knowns");
let restoreHome: () => void = () => {};
beforeAll(() => {
  restoreHome = setProcessHome(home);
  mkdirSync(root, { recursive: true });
});
afterAll(() => {
  restoreHome();
  rmSync(home, { recursive: true, force: true });
});

function failedJob(id: string, ageMs: number, project = "p"): Operation {
  const t = Date.now() - ageMs;
  return {
    id: `job:${id}`,
    source: "daemon",
    kind: "reindex-search",
    title: "Rebuilding the search index",
    project,
    projectRoot: `/${project}`,
    state: "failed",
    progress: null,
    cancellable: false,
    retryable: true,
    error: "boom",
    message: null,
    startedAt: t,
    updatedAt: t,
    finishedAt: t,
  };
}

/** A job source with a fixed list and no subscription use: nothing here opens an event stream. */
function source(list: Operation[]): JobOperationSource {
  return {
    listJobOperations: () => list,
    onJobOperation: () => () => {},
    cancelJobOperation: async () => "gone",
    retryJobOperation: async () => true,
  };
}

const registryOver = (list: Operation[], file: string) =>
  new OperationRegistry({
    emit: () => {},
    jobs: async () => source(list),
    dismissals: fileDismissals(file),
  });

describe("tray without an event stream", () => {
  test("the snapshot lists failed daemon jobs and a dismiss works with no stream", async () => {
    const file = join(home, "d1.json");
    const reg = registryOver([failedJob("a", HOUR)], file);
    await reg.load();
    expect(reg.snapshot().operations.map((o) => o.id)).toEqual(["job:a"]);
    expect(reg.dismiss("job:a").status).toBe("ok");
    expect(reg.snapshot().operations).toEqual([]);
  });

  test("a dismiss of a job this server never listed is idempotent; an unfinished one conflicts; a web id is unknown", async () => {
    const running: Operation = {
      ...failedJob("r", 0),
      state: "running",
      finishedAt: null,
      error: null,
    };
    const reg = registryOver([running], join(home, "d2.json"));
    await reg.load();
    expect(reg.dismiss("job:never-seen").status).toBe("ok");
    expect(reg.dismiss("job:r").status).toBe("conflict");
    expect(reg.dismiss("op_unknown_1").status).toBe("unknown");
  });

  test("a dismissal survives a new registry (a restart of the UI server) and a new store handle", async () => {
    const file = join(home, "d3.json");
    const first = registryOver([failedJob("a", HOUR), failedJob("b", HOUR)], file);
    await first.load();
    first.dismiss("job:a");
    first.close();
    const second = registryOver([failedJob("a", HOUR), failedJob("b", HOUR)], file);
    await second.load();
    expect(second.snapshot().operations.map((o) => o.id)).toEqual(["job:b"]);
  });

  test("dismissals older than 30 days are forgotten", () => {
    const file = join(home, "d4.json");
    let now = 1_000_000_000_000;
    const store = fileDismissals(file, () => now);
    store.add(["job:x"]);
    expect(store.has("job:x")).toBe(true);
    now += DISMISSED_KEEP_MS + 1;
    expect(store.has("job:x")).toBe(false);
  });

  test("a corrupt dismissal file reads as nothing dismissed", () => {
    const file = join(home, "d5.json");
    Bun.write(file, "{not json");
    expect(fileDismissals(file).has("job:x")).toBe(false);
  });
});

describe("what the tray lists", () => {
  test("a failed daemon job older than 24 hours is not shown, a fresher one is", async () => {
    const reg = registryOver(
      [failedJob("old", 25 * HOUR), failedJob("fresh", 2 * HOUR)],
      join(home, "a1.json"),
    );
    await reg.load();
    expect(reg.snapshot().operations.map((o) => o.id)).toEqual(["job:fresh"]);
  });

  test("a failed row that ages past 24 hours while the server runs leaves the list", async () => {
    let now = Date.now();
    const list = [failedJob("a", 23 * HOUR)];
    const reg = new OperationRegistry({
      emit: () => {},
      jobs: async () => source(list),
      dismissals: fileDismissals(join(home, "a2.json")),
      now: () => now,
    });
    await reg.load();
    expect(reg.snapshot().operations).toHaveLength(1);
    now += 2 * HOUR;
    list.length = 0; // the queue still holds it; the registry's own entry is what ages out
    list.push(failedJob("a", 23 * HOUR));
    expect(reg.snapshot().operations).toHaveLength(0);
  });

  test("Dismiss all removes finished rows only, of one project when asked", async () => {
    const running: Operation = {
      ...failedJob("run", 0, "p"),
      state: "running",
      finishedAt: null,
      error: null,
    };
    const reg = registryOver(
      [failedJob("a", HOUR, "p"), failedJob("b", HOUR, "other"), running],
      join(home, "a3.json"),
    );
    await reg.load();
    expect(reg.snapshot().operations).toHaveLength(3);
    expect(reg.dismissFinished("/p")).toEqual(["job:a"]);
    expect(
      reg
        .snapshot()
        .operations.map((o) => o.id)
        .sort(),
    ).toEqual(["job:b", "job:run"]);
    expect(reg.dismissFinished()).toEqual(["job:b"]);
    expect(reg.snapshot().operations.map((o) => o.id)).toEqual(["job:run"]);
  });
});

describe("a failure a later success answered (real queue)", () => {
  const dead = (id: string, key: string, runAfterAgo: number): q.Job =>
    ({
      id,
      key,
      kind: "reconcile-qdrant",
      target: "x",
      requestedAt: new Date(Date.now() - 48 * HOUR).toISOString(),
      runAfter: new Date(Date.now() + 24 * HOUR - runAfterAgo).toISOString(),
      startedAt: null,
      lastError: "ownership mismatch",
      deadLetter: true,
    }) as q.Job;

  test("a dead letter is listed with its failure time; a later success of the same key hides it", () => {
    q.updateQueue(root, (s) => {
      s.jobs = [dead("d1", "reconcile-qdrant:x", HOUR)];
      s.recent = [];
    });
    const [listed] = real.listJobOperations([root]);
    expect(listed?.state).toBe("failed");
    // runAfter is the death plus the 24 h hold, so it died about an hour ago
    expect(Date.now() - (listed?.finishedAt ?? 0)).toBeGreaterThan(HOUR - 5000);
    expect(Date.now() - (listed?.finishedAt ?? 0)).toBeLessThan(HOUR + 5000);

    q.updateQueue(root, (s) => {
      s.recent = [
        {
          jobId: "later",
          key: "reconcile-qdrant:x",
          kind: "reconcile-qdrant",
          success: true,
          completedAt: new Date().toISOString(),
          requestedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          attemptCount: 1,
        },
      ];
    });
    expect(real.listJobOperations([root])).toEqual([]);

    q.updateQueue(root, (s) => {
      s.recent = [
        {
          jobId: "other",
          key: "reconcile-qdrant:other",
          kind: "reconcile-qdrant",
          success: true,
          completedAt: new Date().toISOString(),
          requestedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          attemptCount: 1,
        },
      ];
    });
    expect(real.listJobOperations([root])).toHaveLength(1); // a success of another key does not count
  });
});
