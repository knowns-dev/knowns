// internal/server/routes/graph.go and embedding_models.go

import { storageReaders } from "../../cli/commands/resolve-support.ts";
import { extract } from "../../domain/references/index.ts";
import { resolveReference } from "../../storage/history/index.ts";
import { EmbeddingSettingsStore } from "../../storage/stores/embedding-settings-store.ts";
import { type App, requireStore } from "../app.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { type Obj, readStruct } from "./support.ts";
import { parseIncludeHistorical } from "./tasks.ts";

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  data?: Obj;
}

const nil = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v);

export function registerGraph(r: Router, app: App): void {
  r.get(
    "/api/graph",
    requireStore(app, async (c) => {
      const s = app.need();
      const inc = parseIncludeHistorical(c);
      if (typeof inc === "string") return respondError(400, inc);
      let tasks: import("../../models/task.ts").Task[];
      let docs: import("../../models/doc.ts").Doc[];
      try {
        tasks = inc ? s.tasks.listAll() : s.tasks.listActive();
        docs = s.docs.list();
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      const soft = <T>(fn: () => T[]): T[] => {
        try {
          return fn();
        } catch {
          return [];
        }
      };
      const memories = soft(() => s.memory.list(""));
      const decisions = soft(() => s.decisions.list());
      const templates = soft(() => s.templates.list());
      const taskIDs = new Set(tasks.map((t) => t.id));
      const docPaths = new Set(docs.map((d) => d.path));
      const nodes: Obj[] = [];
      const edges: GraphEdge[] = [];

      for (const t of tasks) {
        nodes.push({
          id: `task:${t.id}`,
          type: "task",
          label: t.title,
          data: {
            assignee: t.assignee ?? "",
            labels: nil(t.labels),
            priority: t.priority,
            status: t.status,
          },
        });
      }
      for (const d of docs) {
        nodes.push({
          id: `doc:${d.path}`,
          type: "doc",
          label: d.title,
          data: { description: d.description ?? "", tags: nil(d.tags) },
        });
      }
      for (const m of memories) {
        nodes.push({
          id: `memory:${m.id}`,
          type: "memory",
          label: m.title,
          data: { category: m.category ?? "", layer: m.layer, tags: nil(m.tags) },
        });
      }
      for (const d of decisions) {
        nodes.push({
          id: `decision:${d.id}`,
          type: "decision",
          label: d.title,
          data: { status: d.status, tags: nil(d.tags) },
        });
      }
      for (const t of templates) {
        const id = t.imported && t.importName ? `${t.importName}/${t.name}` : t.name;
        nodes.push({
          id: `template:${id}`,
          type: "template",
          label: t.name,
          data: {
            description: t.description ?? "",
            imported: t.imported === true,
            source: t.importName ?? "",
          },
        });
      }

      const readers = storageReaders(s);
      const mentions = async (src: string, content: string): Promise<GraphEdge[]> => {
        const out: GraphEdge[] = [];
        for (const ref of extract(content)) {
          if (!ref.validRelation) continue;
          const resolution = await resolveReference(readers, ref);
          if (!resolution.found || !resolution.entity) continue;
          const e = resolution.entity;
          let target: string;
          switch (e.type) {
            case "task":
            case "memory":
            case "decision":
            case "template":
              target = `${e.type}:${e.id}`;
              break;
            case "doc":
              target = `doc:${e.path ?? ""}`;
              break;
            default:
              continue;
          }
          if (target === src) continue;
          out.push({
            source: src,
            target,
            type: ref.relation,
            data: { explicitRelation: ref.explicitRelation, raw: ref.raw },
          });
        }
        return out;
      };

      for (const t of tasks) {
        const src = `task:${t.id}`;
        if (t.parent && taskIDs.has(t.parent))
          edges.push({ source: src, target: `task:${t.parent}`, type: "parent" });
        if (t.spec && docPaths.has(t.spec))
          edges.push({ source: src, target: `doc:${t.spec}`, type: "spec" });
        const content = [
          t.description ?? "",
          t.implementationPlan ?? "",
          t.implementationNotes ?? "",
        ].join("\n");
        edges.push(...(await mentions(src, content)));
      }
      for (const d of docs) edges.push(...(await mentions(`doc:${d.path}`, d.content ?? "")));
      for (const m of memories) {
        edges.push(
          ...(await mentions(`memory:${m.id}`, [m.content ?? "", ...(m.sources ?? [])].join("\n"))),
        );
      }
      for (const d of decisions) {
        const content = [
          d.context ?? "",
          d.decision ?? "",
          d.alternativesConsidered ?? "",
          d.consequences ?? "",
          d.content ?? "",
          (d.sources ?? []).join("\n"),
          (d.relatedDocs ?? []).join("\n"),
          (d.relatedTasks ?? []).join("\n"),
        ].join("\n");
        edges.push(...(await mentions(`decision:${d.id}`, content)));
      }
      const seen = new Set<string>();
      const unique: GraphEdge[] = [];
      for (const e of edges) {
        const k = JSON.stringify([e.source, e.target, e.type]);
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(e);
      }
      return jsonResponse(200, { edges: unique, nodes });
    }),
  );
}

// ---- embedding models -----------------------------------------------------------------------------

export function registerEmbeddingModels(r: Router, app: App): void {
  r.get(
    "/api/embedding-models",
    requireStore(app, async () => {
      let configured: Obj[];
      try {
        const settings = new EmbeddingSettingsStore().load();
        configured = Object.entries(settings.models ?? {})
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, m]) => {
            const o: Obj = { name: id, dimensions: m.dimensions ?? 0 };
            if (m.provider) o.provider = m.provider;
            o.id = id;
            if (m.model) o.model = m.model;
            return o;
          });
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      let api: Obj[] = [];
      try {
        const { OllamaDetector } = await import("../../search/ollama.ts");
        const models = await new OllamaDetector("").listEmbeddingModels();
        api = models
          .map((m) => ({ name: m.name, dimensions: m.dimensions, source: "ollama" }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch {
        api = [];
      }
      return jsonResponse(200, { api, configured });
    }),
  );

  r.post(
    "/api/embedding-models/test",
    requireStore(app, async (c) => {
      const body = await readStruct(
        c,
        "embeddingModelTestRequest",
        { apiBase: "string", apiKey: "string", model: "string" },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const apiBase = (body.v.apiBase as string | undefined) ?? "";
      const model = (body.v.model as string | undefined) ?? "";
      const apiKey = (body.v.apiKey as string | undefined) ?? "";
      if (apiBase === "" || model === "")
        return respondError(400, "apiBase and model are required");
      const url = `${apiBase.endsWith("/") ? apiBase : `${apiBase}/`}embeddings`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ input: ["test"], model }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        return jsonResponse(200, { success: false, error: errMessage(e) });
      }
      if (resp.status < 200 || resp.status >= 300) {
        return jsonResponse(200, {
          success: false,
          error: `HTTP ${resp.status} ${resp.statusText}`,
        });
      }
      let data: { data?: { embedding?: number[] }[] };
      try {
        data = (await resp.json()) as typeof data;
      } catch (e) {
        return jsonResponse(200, {
          success: false,
          error: `failed to parse response: ${errMessage(e)}`,
        });
      }
      const first = data.data?.[0]?.embedding;
      if (!first || first.length === 0)
        return jsonResponse(200, { success: false, error: "no embedding returned" });
      return jsonResponse(200, { success: true, dimensions: first.length, model });
    }),
  );
}
