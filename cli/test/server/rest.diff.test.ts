// One sequence of HTTP requests against the Go server and the TS server; every reply must match
// after masking (status, the headers that matter, and the raw body).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  hasGoBin,
  mask,
  maskHeaders,
  type Reply,
  type Side,
  seedTemplate,
  send,
  startSide,
  stopSide,
} from "./harness.ts";

type Vars = Record<string, string>;

interface Step {
  name: string;
  method: string;
  path: string | ((v: Record<string, string>) => string);
  body?: unknown | ((v: Record<string, string>) => unknown);
  raw?: string;
  headers?: Record<string, string>;
  /** extract per-side values from the (unmasked) JSON reply */
  capture?: (
    json: Record<string, unknown> & { id?: string; candidate?: { id?: string } },
  ) => Record<string, string | undefined>;
  /** do not compare these (nondeterministic by nature) */
  skipBody?: boolean;
}

// Starting two servers (and the Go init) is slow on Windows; hooks get the same budget as tests.
setDefaultTimeout(120_000);

const J = { "Content-Type": "application/json" };

const steps: Step[] = [
  { name: "config", method: "GET", path: "/api/config" },
  { name: "tasks empty", method: "GET", path: "/api/tasks" },
  { name: "docs empty", method: "GET", path: "/api/docs" },
  { name: "templates", method: "GET", path: "/api/templates" },
  { name: "workspaces", method: "GET", path: "/api/workspaces" },
  { name: "user prefs", method: "GET", path: "/api/user-preferences" },
  { name: "memories", method: "GET", path: "/api/memories" },
  { name: "decisions", method: "GET", path: "/api/decisions" },
  { name: "graph", method: "GET", path: "/api/graph" },
  { name: "validate sdd", method: "GET", path: "/api/validate/sdd" },
  { name: "activities", method: "GET", path: "/api/activities" },
  { name: "imports", method: "GET", path: "/api/imports" },
  { name: "time status", method: "GET", path: "/api/time/status" },
  { name: "auth status", method: "GET", path: "/api/auth/status" },
  { name: "search", method: "GET", path: "/api/search?q=hello" },
  { name: "retrieve", method: "GET", path: "/api/retrieve?q=hello" },
  { name: "resolve missing", method: "GET", path: "/api/resolve" },
  { name: "skills", method: "GET", path: "/api/skills" },
  { name: "audit stats", method: "GET", path: "/api/audit/stats" },
  { name: "404 api", method: "GET", path: "/api/nope" },
  { name: "405", method: "DELETE", path: "/api/tasks" },
  { name: "404 trailing", method: "GET", path: "/api/tasks/" },
  { name: "bad json", method: "POST", path: "/api/tasks", raw: "{nope", headers: J },
  { name: "empty body", method: "POST", path: "/api/tasks", raw: "", headers: J },
  {
    name: "create task",
    method: "POST",
    path: "/api/tasks",
    headers: J,
    body: {
      id: "aaaaaa",
      title: "First task",
      description: "hello <world> & co",
      labels: ["a", "b"],
      status: "in-progress",
    },
    capture: (j) => ({ t1: j.id }),
  },
  {
    name: "create task 2",
    method: "POST",
    path: "/api/tasks",
    headers: J,
    body: {
      id: "bbbbbb",
      title: "Second",
      acceptanceCriteria: [{ text: "ac one", completed: false }],
    },
    capture: (j) => ({ t2: j.id }),
  },
  { name: "list tasks", method: "GET", path: "/api/tasks" },
  { name: "get task", method: "GET", path: (v) => `/api/tasks/${v.t1}` },
  { name: "get missing task", method: "GET", path: "/api/tasks/zzzzzz" },
  {
    name: "update task",
    method: "PUT",
    path: (v) => `/api/tasks/${v.t1}`,
    headers: J,
    body: { title: "Renamed", priority: "high", order: 3, labels: null },
  },
  {
    name: "update bad type",
    method: "PUT",
    path: (v) => `/api/tasks/${v.t1}`,
    headers: J,
    body: { title: 5 },
  },
  { name: "task history", method: "GET", path: (v) => `/api/tasks/${v.t1}/history` },
  {
    name: "task history meta",
    method: "GET",
    path: (v) => `/api/tasks/${v.t1}/history?metadata=true`,
  },
  {
    name: "time start",
    method: "POST",
    path: "/api/time/start",
    headers: J,
    body: (v: Vars) => ({ taskId: v.t1 }),
  },
  { name: "time status 2", method: "GET", path: "/api/time/status" },
  {
    name: "time pause",
    method: "POST",
    path: "/api/time/pause",
    headers: J,
    body: (v: Vars) => ({ taskId: v.t1 }),
  },
  {
    name: "time resume",
    method: "POST",
    path: "/api/time/resume",
    headers: J,
    body: (v: Vars) => ({ taskId: v.t1 }),
  },
  {
    name: "time stop",
    method: "POST",
    path: "/api/time/stop",
    headers: J,
    body: (v: Vars) => ({ taskId: v.t1 }),
  },
  {
    name: "time add",
    method: "POST",
    path: "/api/time/add",
    headers: J,
    body: (v: Vars) => ({ taskId: v.t2, duration: 90, note: "n" }),
  },
  {
    name: "time start missing",
    method: "POST",
    path: "/api/time/start",
    headers: J,
    body: { taskId: "nope" },
  },
  {
    name: "reorder",
    method: "POST",
    path: "/api/tasks/reorder",
    headers: J,
    body: (v: Vars) => ({
      orders: [
        { id: v.t1, order: 1 },
        { id: v.t2, order: 2 },
      ],
    }),
  },
  {
    name: "archive preview",
    method: "POST",
    path: (v) => `/api/tasks/${v.t2}/archive`,
    headers: J,
    body: {},
  },
  {
    name: "archive",
    method: "POST",
    path: (v) => `/api/tasks/${v.t2}/archive`,
    headers: J,
    body: { execute: true },
  },
  {
    name: "unarchive",
    method: "POST",
    path: (v) => `/api/tasks/${v.t2}/unarchive`,
    headers: J,
    body: { execute: true },
  },
  {
    name: "hard delete denied",
    method: "POST",
    path: (v) => `/api/tasks/${v.t2}/hard-delete`,
    headers: J,
    body: { confirmed: true },
  },
  { name: "sync spec acs", method: "POST", path: "/api/tasks/sync-spec-acs" },
  {
    name: "create doc",
    method: "POST",
    path: "/api/docs",
    headers: J,
    body: { title: "My Guide", folder: "guides", content: "# Hi\n\nBody <b>", tags: ["x"] },
  },
  { name: "doc get", method: "GET", path: "/api/docs/guides/my-guide" },
  { name: "doc get encoded", method: "GET", path: "/api/docs/guides%2Fmy-guide.md" },
  { name: "docs list", method: "GET", path: "/api/docs" },
  {
    name: "doc update",
    method: "PUT",
    path: "/api/docs/guides/my-guide",
    headers: J,
    body: { content: "# Hi\n\nNew", title: "My Guide 2" },
  },
  { name: "doc history", method: "GET", path: "/api/docs/guides/my-guide/history" },
  {
    name: "doc history meta",
    method: "GET",
    path: "/api/docs/guides/my-guide/history?metadata=true",
  },
  { name: "doc missing", method: "GET", path: "/api/docs/nope/nothing" },
  {
    name: "doc bad action",
    method: "POST",
    path: "/api/docs/guides/my-guide/zzz",
    headers: J,
    body: {},
  },
  {
    name: "create template",
    method: "POST",
    path: "/api/templates",
    headers: J,
    body: { name: "tpl", description: "d" },
  },
  { name: "template get", method: "GET", path: "/api/templates/tpl" },
  {
    name: "template run",
    method: "POST",
    path: "/api/templates/tpl/run",
    headers: J,
    body: { variables: { name: "Foo" }, dryRun: true },
  },
  { name: "templates list", method: "GET", path: "/api/templates" },
  {
    name: "create memory",
    method: "POST",
    path: "/api/memories",
    headers: J,
    body: {
      title: "A memory",
      content: "details",
      category: "pattern",
      tags: ["t"],
      skipReview: true,
    },
    capture: (j) => ({ m1: j.id }),
  },
  { name: "memories list", method: "GET", path: "/api/memories" },
  { name: "memory get", method: "GET", path: (v) => `/api/memories/${v.m1}` },
  { name: "memory review", method: "GET", path: "/api/memories/review" },
  {
    name: "memory action",
    method: "POST",
    path: (v) => `/api/memories/${v.m1}/action`,
    headers: J,
    body: { action: "archive" },
  },
  {
    name: "memory update",
    method: "PUT",
    path: (v) => `/api/memories/${v.m1}`,
    headers: J,
    body: { title: "Changed" },
  },
  { name: "memory delete", method: "DELETE", path: (v) => `/api/memories/${v.m1}` },
  {
    name: "create decision",
    method: "POST",
    path: "/api/decisions",
    headers: J,
    body: { title: "Use bun", status: "draft", context: "c", decision: "d", consequences: "q" },
    capture: (j) => ({ d1: j.id ?? j.candidate?.id ?? "" }),
  },
  { name: "decisions list", method: "GET", path: "/api/decisions?includeAll=true" },
  { name: "decision inbox", method: "GET", path: "/api/decisions/review/inbox" },
  {
    name: "config patch",
    method: "PATCH",
    path: "/api/config",
    headers: J,
    body: { defaultPriority: "high", statuses: ["todo", "done"] },
  },
  {
    name: "config patch bad",
    method: "PATCH",
    path: "/api/config",
    headers: J,
    body: { defaultPriority: 5 },
  },
  {
    name: "config post",
    method: "POST",
    path: "/api/config",
    headers: J,
    body: { name: "Renamed" },
  },
  { name: "config final", method: "GET", path: "/api/config" },
  { name: "graph 2", method: "GET", path: "/api/graph" },
  { name: "validate 2", method: "GET", path: "/api/validate/sdd" },
  { name: "activities 2", method: "GET", path: "/api/activities" },
  { name: "search 2", method: "GET", path: "/api/search?q=guide&type=doc" },
  { name: "search tasks", method: "GET", path: "/api/search?q=First" },
  { name: "retrieve 2", method: "GET", path: "/api/retrieve?q=guide&expandReferences=true" },
  {
    name: "resolve",
    method: "GET",
    path: (v) => `/api/resolve?ref=${encodeURIComponent(`@task-${v.t1}`)}`,
  },
  {
    name: "import add local",
    method: "POST",
    path: "/api/imports",
    headers: J,
    body: { source: "/some/dir", name: "loc" },
  },
  { name: "imports list 2", method: "GET", path: "/api/imports" },
  { name: "import get", method: "GET", path: "/api/imports/loc" },
  { name: "import bad name", method: "GET", path: "/api/imports/..%2Fx" },
  { name: "import sync one", method: "POST", path: "/api/imports/loc/sync" },
  { name: "import remove", method: "DELETE", path: "/api/imports/loc" },
  { name: "notify refresh", method: "POST", path: "/api/notify/refresh" },
  { name: "notify doc", method: "POST", path: "/api/notify/doc/guides/my-guide" },
  { name: "notify task", method: "POST", path: (v) => `/api/notify/task/${v.t1}` },
  { name: "notify time", method: "POST", path: "/api/notify/time" },
  {
    name: "workspaces browse bad",
    method: "GET",
    path: "/api/workspaces/browse?path=/definitely/not/here",
  },
  {
    name: "workspaces switch bad",
    method: "POST",
    path: "/api/workspaces/switch",
    headers: J,
    body: {},
  },
  {
    name: "workspaces scan bad",
    method: "POST",
    path: "/api/workspaces/scan",
    headers: J,
    body: {},
  },
  {
    name: "user prefs post",
    method: "POST",
    path: "/api/user-preferences",
    headers: J,
    body: { a: 1 },
  },
  { name: "audit recent", method: "GET", path: "/api/audit/recent" },
  { name: "audit analytics bad", method: "GET", path: "/api/audit/analytics?days=5" },
  { name: "audit analytics", method: "GET", path: "/api/audit/analytics?days=7", skipBody: true },
  { name: "tunnel status", method: "GET", path: "/api/tunnel/status" },
  { name: "tunnel start no pw", method: "POST", path: "/api/tunnel/start" },
  {
    name: "runtime retry bad",
    method: "POST",
    path: "/api/runtime/retry",
    headers: J,
    body: { scope: "x" },
  },
  {
    name: "cors get",
    method: "GET",
    path: "/api/config",
    headers: { Origin: "http://localhost:5173" },
  },
  {
    name: "cors evil",
    method: "GET",
    path: "/api/config",
    headers: { Origin: "http://evil.example" },
  },
  {
    name: "preflight",
    method: "OPTIONS",
    path: "/api/tasks",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  },
  { name: "ui root", method: "GET", path: "/" },
  { name: "ui spa", method: "GET", path: "/kanban" },
  { name: "ui index", method: "GET", path: "/index.html" },
  { name: "ui asset dir", method: "GET", path: "/assets" },
  { name: "ui favicon", method: "GET", path: "/favicon-32.png" },
  { name: "ui range", method: "GET", path: "/favicon-32.png", headers: { Range: "bytes=0-9" } },
  { name: "ui post", method: "POST", path: "/kanban" },
  {
    name: "auth set password",
    method: "POST",
    path: "/api/auth/password",
    headers: J,
    body: { password: "secret" },
    skipBody: true,
  },
];

const enabled = hasGoBin;
let go: Side;
let ts: Side;

beforeAll(async () => {
  if (!enabled) return;
  const tpl = seedTemplate();
  // sequential: two concurrent freePort() calls can hand out the same port on Windows
  go = await startSide("go", tpl);
  ts = await startSide("ts", tpl);
});
afterAll(() => {
  if (go) stopSide(go);
  if (ts) stopSide(ts);
});

describe.skipIf(!enabled)("REST parity with the Go server", () => {
  test("every step matches", async () => {
    const vars = { go: {} as Record<string, string>, ts: {} as Record<string, string> };
    const failures: string[] = [];
    for (const step of steps) {
      const replies: Reply[] = [];
      for (const side of [go, ts]) {
        const v = vars[side.name];
        const path = typeof step.path === "function" ? step.path(v) : step.path;
        const bodyVal =
          typeof step.body === "function" ? (step.body as (v: Vars) => unknown)(v) : step.body;
        const body =
          step.raw !== undefined
            ? step.raw
            : bodyVal === undefined
              ? undefined
              : JSON.stringify(bodyVal);
        const r = await send(side, step.method, path, { body, headers: step.headers });
        if (step.capture) {
          try {
            const caught = step.capture(JSON.parse(r.text));
            for (const [k, val] of Object.entries(caught)) {
              v[k] = val ?? "";
              if (val) side.subs.push([val, `<${k}>`]);
            }
          } catch {
            // body not JSON: nothing to capture
          }
        }
        replies.push(r);
      }
      const [a, b] = replies as [Reply, Reply];
      const idMask = (t: string) => {
        if (step.name === "workspaces") return t.replace(/"id":"[a-z0-9]{6}"/g, '"id":"<WS>"');
        // Go builds these lists from map iteration, so their order is random in Go itself.
        if (step.name.startsWith("graph")) {
          const j = JSON.parse(t);
          j.nodes.sort((x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1));
          return JSON.stringify(j);
        }
        if (step.name.startsWith("validate")) {
          const j = JSON.parse(t);
          j.warnings.sort((x: { entity: string }, y: { entity: string }) =>
            x.entity < y.entity ? -1 : 1,
          );
          return JSON.stringify(j);
        }
        return t;
      };
      const am = {
        s: a.status,
        h: maskHeaders(a.headers, go),
        b: step.skipBody ? "" : idMask(mask(a.text, go)),
      };
      const bm = {
        s: b.status,
        h: maskHeaders(b.headers, ts),
        b: step.skipBody ? "" : idMask(mask(b.text, ts)),
      };
      if (JSON.stringify(am) !== JSON.stringify(bm)) {
        failures.push(
          `### ${step.name} ${step.method} ${typeof step.path === "function" ? "(fn)" : step.path}\n go: ${JSON.stringify(am).slice(0, 1500)}\n ts: ${JSON.stringify(bm).slice(0, 1500)}`,
        );
      }
    }
    expect(failures.join("\n\n")).toBe("");
  }, 300_000);
});
