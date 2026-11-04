// A writable copy of the golden `full` fixture wired through createStorage, for the library tests.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStorage, type Storage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { fixtureRoot } from "../helpers/fixtures.ts";

export interface Lab {
  dir: string;
  root: string;
  home: string;
  storage: Storage;
  write(rel: string, content: string): void;
  cleanup(): void;
}

const dirs: string[] = [];

export function lab(): Lab {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knowns-domain-")));
  dirs.push(dir);
  const root = join(dir, "project", ".knowns");
  const home = join(dir, "home");
  cpSync(join(fixtureRoot("full"), ".knowns"), root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const fixtureHome = join(fixtureRoot("full"), "_home", ".knowns");
  if (existsSync(fixtureHome)) cpSync(fixtureHome, join(home, ".knowns"), { recursive: true });
  const storage = createStorage(Store.open(root), { globalRoot: join(home, ".knowns") });
  return {
    dir,
    root,
    home,
    storage,
    write(rel, content) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function cleanupLabs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const memoryFile = (
  id: string,
  title: string,
  content: string,
  o: {
    status?: string;
    category?: string;
    layer?: string;
    metadata?: string;
    created?: string;
  } = {},
): string => `---
id: ${id}
title: ${title}
layer: ${o.layer ?? "project"}
category: ${o.category ?? "pattern"}
status: ${o.status ?? "active"}
confidence: high
lastVerified: '${o.created ?? "2026-10-01T10:00:00Z"}'
tags: []
${o.metadata ?? ""}createdAt: '${o.created ?? "2026-10-01T10:00:00Z"}'
updatedAt: '${o.created ?? "2026-10-01T10:00:00Z"}'
---

${content}
`;
