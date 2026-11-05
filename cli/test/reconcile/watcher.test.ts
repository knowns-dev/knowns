// The knowledge watcher on a real filesystem: it reports Markdown writes under tasks/ and docs/,
// ignores the source tree (macOS kqueue holds a descriptor per watched file), and keeps watching a
// docs subdirectory that is deleted and recreated (what `git stash -u` then `pop` does). The
// scheduler's 3 s quiet window makes each wait a few seconds.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReconcileHint } from "../../src/domain/reconcile/types.ts";
import { startKnowledgeWatcher } from "../../src/domain/reconcile/watcher.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function store(): { project: string; root: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "knowns-watch-")));
  dirs.push(project);
  const root = join(project, ".knowns");
  mkdirSync(join(root, "docs", "guides"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  return { project, root };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(paths: () => string[], want: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (paths().some((p) => p.endsWith(want))) return true;
    await sleep(100);
  }
  return false;
}

test("reports knowledge writes, ignores the source tree, survives a deleted and recreated docs dir", async () => {
  const { project, root } = store();
  const seen: ReconcileHint[] = [];
  const ac = new AbortController();
  const errors: unknown[] = [];
  const running = startKnowledgeWatcher(root, {
    signal: ac.signal,
    enqueue: (hints) => seen.push(...hints),
    onError: (e) => errors.push(e),
  });
  const paths = () => seen.map((h) => h.path.split("\\").join("/"));
  try {
    await sleep(200);
    writeFileSync(join(project, "src", "main.ts"), "x");
    writeFileSync(join(root, "docs", "guides", "a.md"), "# a\n");
    expect(await waitFor(paths, "docs/guides/a.md")).toBe(true);
    expect(paths().some((p) => p.includes("/src/"))).toBe(false);

    // Bun on Linux never delivers events to a second watch of the same path, so this is the case
    // that needs the polling fallback; three rounds prove it is not a one-off.
    const guides = join(root, "docs", "guides");
    for (let round = 1; round <= 3; round++) {
      rmSync(guides, { recursive: true, force: true });
      await sleep(300);
      mkdirSync(guides);
      await sleep(300);
      writeFileSync(join(guides, `b${round}.md`), `# b${round}\n`);
      expect(await waitFor(paths, `docs/guides/b${round}.md`), `round ${round}`).toBe(true);
    }

    // `git stash pop` recreates the directory with its files already in it.
    rmSync(guides, { recursive: true, force: true });
    await sleep(300);
    mkdirSync(join(root, "tmp-pop"));
    writeFileSync(join(root, "tmp-pop", "popped.md"), "# popped\n");
    renameSync(join(root, "tmp-pop"), guides);
    expect(await waitFor(paths, "docs/guides/popped.md")).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    ac.abort();
    await running;
  }
}, 60_000);
