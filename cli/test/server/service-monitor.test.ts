// The service monitor (storesync tick review, P3-3): after a gap in which nobody watched it starts
// from a fresh baseline instead of reporting stale differences, and it looks at once when watching
// starts instead of after the idle interval.
import { describe, expect, test } from "bun:test";
import { ServiceMonitor, type ServiceStatusLike } from "../../src/server/service-monitor.ts";

const svc = (status: string): ServiceStatusLike => ({
  name: "qdrant",
  type: "vector",
  status,
  enabledInConfig: true,
  details: {},
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ServiceMonitor", () => {
  test("a change seen while watched is emitted once", async () => {
    let status = "running";
    const emitted: Record<string, unknown>[][] = [];
    const m = new ServiceMonitor({
      snapshot: async () => [svc(status)],
      emit: (c) => emitted.push(c),
      watchWindowMs: 5000,
      statusIntervalMs: 20,
      idleIntervalMs: 500,
    });
    m.watch();
    m.start();
    await sleep(60);
    status = "stopped";
    await sleep(120);
    m.stop();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.[0]).toMatchObject({ previousStatus: "running", status: "stopped" });
  });

  test("after a gap nobody watched, the first snapshot is a baseline, not a diff", async () => {
    let status = "running";
    const emitted: Record<string, unknown>[][] = [];
    const m = new ServiceMonitor({
      snapshot: async () => [svc(status)],
      emit: (c) => emitted.push(c),
      watchWindowMs: 80,
      statusIntervalMs: 20,
      idleIntervalMs: 40,
    });
    m.start(); // baseline: running; nobody watching
    await sleep(60);
    status = "stopped"; // changes while nobody looks
    await sleep(120);
    m.watch(); // somebody opens the Runtime page
    await sleep(120);
    m.stop();
    expect(emitted).toEqual([]); // the old difference is not reported as news
  });

  test("watching that starts after a long idle interval looks at once", async () => {
    let calls = 0;
    const m = new ServiceMonitor({
      snapshot: async () => {
        calls++;
        return [svc("running")];
      },
      emit: () => undefined,
      watchWindowMs: 50,
      statusIntervalMs: 5000,
      idleIntervalMs: 5000,
    });
    m.start();
    await sleep(30);
    const before = calls;
    m.watch(); // resumes (nobody had watched): the next look must not wait 5 s
    await sleep(100);
    m.stop();
    expect(calls).toBeGreaterThan(before);
  });
});
