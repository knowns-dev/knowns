// Golden differential tests for `knowns decision ...` (see memory-commands.test.ts for the harness
// and what is masked). Legacy Decision Memories for the migration commands are written as the same
// bytes into both worlds.
import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanupWorlds,
  decisionId,
  expectParity,
  hasGoBin,
  makePair,
  type World,
  writeBoth,
} from "./memory-diff-helpers.ts";

afterAll(cleanupWorlds);

const suite = hasGoBin ? describe : describe.skip;

const BUN = "20261103-1337-use-bun-for-everything";
const MONO = "20261103-1337-adopt-a-monorepo";
const SCRIPTS = "20261103-1337-use-bun-for-scripts";

/** An argument vector that names generated decisions by slug: `@{slug}` or `@{slug:n}`. */
const named =
  (args: string[]) =>
  (w: World): string[] =>
    args.map((a) =>
      a.replace(/@\{([a-z0-9-]+)(?::(\d+))?\}/g, (_m, slug: string, n?: string) =>
        decisionId(w, slug, n ? Number(n) : 0),
      ),
    );

suite("decision read commands", () => {
  const pair = makePair();
  const steps: string[][] = [
    ["decision"],
    ["decision", "--help"],
    ["decision", "list"],
    ["decision", "list", "--plain"],
    ["decision", "list", "--json"],
    ["decision", "list", "--all-statuses"],
    ["decision", "list", "--all-statuses", "--json"],
    ["decision", "list", "--status", "draft", "--plain"],
    ["decision", "list", "--status", "superseded"],
    ["decision", "list", "--tag", "runtime", "--all-statuses", "--plain"],
    ["decision", "list", "--tag", "nomatch", "--json"],
    ["decision", "list", "--tag", "nomatch"],
    ["decision", "list", "--status", "bogus"],
    ["decision", MONO],
    ["decision", "get", BUN],
    ["decision", "get", BUN, "--plain"],
    ["decision", "get", BUN, "--json"],
    ["decision", "get", SCRIPTS, "--json"],
    ["decision", "get", MONO, "--plain", "--page", "1", "--page-size", "5"],
    ["decision", "get", "nope"],
    ["decision", "get"],
    ["decision", "inbox"],
    ["decision", "inbox", "--json"],
    ["decision", "inbox", "extra"],
    ["decision", "migrate"],
    ["decision", "migrate", "preview"],
    ["decision", "migrate", "preview", "--json"],
    ["decision", "migrate", "apply"],
    ["decision", "migrate", "apply", "--memory", "x"],
    ["decision", "migrate", "apply", "--memory", "x", "--resolution", "bogus"],
    ["decision", "migrate", "apply", "--memory", "nope", "--resolution", "archive_noise"],
    ["decision", "migrate", "rollback", "nope"],
    ["decision", "migrate", "rollback", "bad id"],
    ["decision", "migrate", "rollback"],
    ["decision", "link", "nope", "--source", "x"],
    ["decision", "supersede", "a", "b"],
    ["decision", "accept", "nope"],
    ["decision", "resolve", "reject_new", "nope"],
    ["decision", "resolve", "bogus", MONO],
    ["decision", "resolve", "link_as_related", MONO],
    ["decision", "resolve", "supersede_existing", MONO],
    ["decision", "resolve", "create_draft", BUN],
    ["decision", "create"],
  ];
  for (const args of steps) {
    test(args.join(" "), () => {
      expectParity(pair, args);
    });
  }
});

suite("decision lifecycle", () => {
  const pair = makePair();
  test("create: plain, json, flags, rejects", () => {
    expectParity(pair, [
      "decision",
      "create",
      "Use esbuild for bundles",
      "--context",
      "c",
      "--decision",
      "d",
      "--alternatives",
      "a",
      "--consequences",
      "q",
      "--source",
      "@doc/architecture",
      "--task",
      "FX-3VT2SR",
      "--doc",
      "architecture",
      "-t",
      "build",
      "-t",
      "tools",
    ]);
    expectParity(pair, ["decision", "create", "Plain output", "--decision", "p", "--plain"]);
    expectParity(pair, ["decision", "create", "Json output", "--body", "free body text", "--json"]);
    expectParity(pair, ["decision", "create", "Explicit", "draft", "--status", "draft"]);
    expectParity(pair, ["decision", "create", "Direct accept", "--status", "accepted"]);
    expectParity(pair, ["decision", "create", "Bad status", "--status", "nope"]);
    expectParity(pair, ["decision", "list", "--all-statuses", "--plain"]);
    expectParity(pair, ["decision", "inbox"]);
    expectParity(pair, ["decision", "inbox", "--json"]);
  });
  test("a duplicate asks for review and persists a candidate", () => {
    const text = expectParity(pair, [
      "decision",
      "create",
      "Use bun for everything",
      "--decision",
      "Bun everywhere",
      "--source",
      "@doc/architecture",
      "--task",
      "FX-3VT2SR",
    ]);
    expect(text.stdout).toContain("Decision review required");
    const json = expectParity(pair, [
      "decision",
      "create",
      "Use bun for everything",
      "--decision",
      "Bun everywhere",
      "--source",
      "@doc/architecture",
      "--task",
      "FX-3VT2SR",
      "--json",
    ]);
    expect(JSON.parse(json.stdout).status).toBe("review_required");
    expectParity(pair, ["decision", "inbox"]);
  });
  test("a conflict (shared topic words) is reported as a conflict", () => {
    const r = expectParity(pair, [
      "decision",
      "create",
      "Bun runtime for scripts everywhere",
      "--decision",
      "other text entirely",
    ]);
    expect(r.code).toBe(0);
  });
  test("resolve: link, supersede, accept, reject, create_draft", () => {
    expectParity(
      pair,
      named([
        "decision",
        "resolve",
        "link_as_related",
        "@{use-bun-for-everything:1}",
        "--target",
        BUN,
      ]),
    );
    expectParity(
      pair,
      named([
        "decision",
        "resolve",
        "link_as_related",
        "@{use-bun-for-everything:1}",
        "--target",
        BUN,
      ]),
    );
    expectParity(
      pair,
      named([
        "decision",
        "resolve",
        "supersede_existing",
        "@{use-bun-for-everything-2}",
        "--target",
        BUN,
        "--json",
      ]),
    );
    expectParity(
      pair,
      named(["decision", "resolve", "accept_new", "@{use-esbuild-for-bundles}", "--plain"]),
    );
    expectParity(pair, named(["decision", "resolve", "reject_new", "@{plain-output}"]));
    expectParity(pair, named(["decision", "resolve", "reject_new", "@{plain-output}"]));
    expectParity(pair, named(["decision", "resolve", "create_draft", "@{json-output}", "--json"]));
    expectParity(pair, named(["decision", "resolve", "accept_new", "@{json-output}"]));
    expectParity(pair, ["decision", "list", "--all-statuses", "--plain"]);
  });
  test("link evidence, accept, supersede, and the plain/json shapes", () => {
    expectParity(pair, [
      "decision",
      "link",
      MONO,
      "--source",
      "@doc/architecture",
      "--task",
      "FX-3VT2SR",
      "--doc",
      "architecture",
    ]);
    expectParity(pair, ["decision", "link", MONO, "--source", "@doc/architecture", "--json"]);
    expectParity(pair, ["decision", "accept", MONO, "--json"]);
    expectParity(pair, ["decision", "accept", MONO]);
    expectParity(pair, ["decision", "supersede", SCRIPTS, MONO]);
    expectParity(pair, ["decision", "supersede", MONO, BUN, "--json"]);
    expectParity(pair, ["decision", "supersede", MONO, BUN]);
    expectParity(pair, ["decision", "supersede", BUN, BUN]);
    expectParity(pair, ["decision", "list", "--all-statuses", "--json"]);
    expectParity(pair, ["decision", "list"]);
  });
  test("accept --supersede replaces current guidance atomically", () => {
    expectParity(
      pair,
      named(["decision", "accept", "@{json-output}", "--supersede", BUN, "--json"]),
    );
    expectParity(pair, ["decision", "get", BUN, "--plain"]);
  });
  test("accept needs evidence and tasks", () => {
    // A fresh world: a decision accepted during a run carries a wall-clock verifiedAt, which feeds
    // the content hash a later review records for it, so those hashes cannot match across runs.
    const pair = makePair();
    expectParity(pair, ["decision", "create", "Needs work", "--decision", "later"]);
    expectParity(pair, named(["decision", "accept", "@{needs-work}"]));
    expectParity(
      pair,
      named(["decision", "link", "@{needs-work}", "--source", "@doc/missing-doc"]),
    );
    expectParity(pair, named(["decision", "accept", "@{needs-work}"]));
    expectParity(pair, named(["decision", "get", "@{needs-work}", "--plain"]));
    expectParity(pair, named(["decision", "inbox"]));
  });
});

const legacy = (
  id: string,
  title: string,
  content: string,
  opts: {
    status?: string;
    metadata?: string;
    created?: string;
    layer?: string;
    category?: string;
  } = {},
) => `---
id: ${id}
title: ${title}
layer: ${opts.layer ?? "project"}
category: ${opts.category ?? "decision"}
status: ${opts.status ?? "active"}
confidence: high
lastVerified: '${opts.created ?? "2026-10-01T10:00:00Z"}'
tags: []
${opts.metadata ?? ""}createdAt: '${opts.created ?? "2026-10-01T10:00:00Z"}'
updatedAt: '${opts.created ?? "2026-10-01T10:00:00Z"}'
---

${content}
`;

const FLAGS =
  "We adopt feature flags for risky rollouts across every service. See @doc/architecture for the rationale.";

suite("legacy Decision Memory migration", () => {
  const pair = makePair();
  writeBoth(pair, {
    "project/.knowns/memory/memory-leg1.md": legacy("leg1", "Adopt feature flags", FLAGS),
    "project/.knowns/memory/memory-leg2.md": legacy("leg2", "Adopt feature flags duplicate", FLAGS),
    "project/.knowns/memory/memory-leg3.md": legacy("leg3", "Project workflow decision", "Short."),
    "project/.knowns/memory/memory-leg4.md": legacy(
      "leg4",
      "Linked guidance",
      `Convention for logging: always use structured logs everywhere in services. @decision/${BUN}`,
    ),
    "project/.knowns/memory/memory-leg5.md": legacy(
      "leg5",
      "Prefer small PRs",
      "We prefer small pull requests for every change in this repository always.",
      { metadata: "metadata:\n  runtimeCapture: 'yes'\n" },
    ),
    "project/.knowns/memory/memory-leg6.md": legacy("leg6", "Odd one", "Tiny"),
    "project/.knowns/memory/memory-leg7.md": legacy(
      "leg7",
      "Pattern memo",
      "A pattern for retries that every client follows consistently. See @doc/architecture.",
    ),
    "home/.knowns/memory/memory-leg8.md": legacy(
      "leg8",
      "Global rule",
      "A global rule that every project in the workspace follows without exception today.",
      { layer: "global" },
    ),
    "project/.knowns/memory/memory-leg9.md": legacy(
      "leg9",
      "Archived old",
      "An archived legacy decision memory that nobody reads anymore at all today.",
      { status: "archived" },
    ),
  });
  const steps: string[][] = [
    ["decision", "migrate", "preview"],
    ["decision", "migrate", "preview", "--json"],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg1",
      "--resolution",
      "create_decision",
      "--doc",
      "architecture",
      "--task",
      "FX-3VT2SR",
    ],
    // idempotent re-apply of the same reviewed selection
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg1",
      "--resolution",
      "create_decision",
      "--doc",
      "architecture",
      "--task",
      "FX-3VT2SR",
    ],
    // a different selection for an already migrated memory is refused
    ["decision", "migrate", "apply", "--memory", "leg1", "--resolution", "archive_noise"],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg2",
      "--resolution",
      "consolidate_duplicate",
      "--target-memory",
      "leg1",
      "--json",
    ],
    ["decision", "migrate", "apply", "--memory", "leg3", "--resolution", "archive_noise"],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg5",
      "--resolution",
      "reject_noise",
      "--reason",
      "noise",
    ],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg4",
      "--resolution",
      "link_existing",
      "--decision-id",
      BUN,
      "--json",
    ],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg6",
      "--resolution",
      "reclassify",
      "--category",
      "pattern",
    ],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg6",
      "--resolution",
      "reclassify",
      "--category",
      "decision",
    ],
    ["decision", "migrate", "apply", "--memory", "leg7", "--resolution", "leave_unchanged"],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg8",
      "--resolution",
      "create_decision",
      "--decision-id",
      "20261001-1000-global-rule",
      "--json",
    ],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg9",
      "--resolution",
      "consolidate_duplicate",
      "--target-memory",
      "leg9",
    ],
    ["decision", "migrate", "apply", "--memory", "leg9", "--resolution", "link_existing"],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg9",
      "--resolution",
      "create_decision",
      "--accept-verified",
    ],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg9",
      "--resolution",
      "archive_noise",
      "--accept-verified",
    ],
    ["decision", "migrate", "apply", "--memory", "leg9", "--resolution", "reclassify"],
    ["decision", "migrate", "apply", "--memory", "nope", "--resolution", "archive_noise", "--json"],
    ["decision", "migrate", "apply", "--memory", "leg6", "--resolution", "bogus"],
    ["decision", "migrate", "preview"],
    ["decision", "migrate", "preview", "--json"],
    ["decision", "list", "--all-statuses", "--plain"],
    ["memory", "list", "--all-statuses", "--plain"],
    ["decision", "migrate", "rollback", "leg1"],
    ["decision", "migrate", "rollback", "leg1", "--json"],
    ["decision", "migrate", "rollback", "leg4"],
    ["decision", "migrate", "rollback", "leg3", "--json"],
    ["decision", "migrate", "rollback", "leg2"],
    ["decision", "migrate", "rollback", "nope"],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "leg1",
      "--resolution",
      "create_decision",
      "--doc",
      "architecture",
      "--task",
      "FX-3VT2SR",
    ],
    ["decision", "migrate", "preview"],
    ["decision", "list", "--all-statuses", "--plain"],
  ];
  for (const args of steps) {
    test(args.join(" "), () => {
      expectParity(pair, args);
    });
  }
});

suite("legacy migration with verified acceptance", () => {
  const pair = makePair();
  writeBoth(pair, {
    "project/.knowns/memory/memory-ver1.md": legacy("ver1", "Verified guidance", FLAGS),
    "project/.knowns/memory/memory-ver2.md": legacy("ver2", "Verified duplicate", FLAGS),
    "project/.knowns/memory/memory-ver3.md": legacy(
      "ver3",
      "Unverifiable guidance",
      "A legacy guidance without any readable evidence at all to accept here.",
    ),
  });
  for (const args of [
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "ver1",
      "--resolution",
      "create_decision",
      "--doc",
      "architecture",
      "--task",
      "FX-3VT2SR",
      "--accept-verified",
      "--json",
    ],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "ver2",
      "--resolution",
      "consolidate_duplicate",
      "--target-memory",
      "ver1",
      "--accept-verified",
    ],
    [
      "decision",
      "migrate",
      "apply",
      "--memory",
      "ver3",
      "--resolution",
      "create_decision",
      "--accept-verified",
      "--json",
    ],
    ["decision", "migrate", "preview"],
    ["memory", "list", "--all-statuses", "--plain"],
    ["decision", "list", "--all-statuses", "--plain"],
    ["decision", "migrate", "rollback", "ver1"],
    ["decision", "migrate", "rollback", "ver3"],
    ["decision", "list", "--all-statuses", "--plain"],
    ["memory", "list", "--all-statuses", "--plain"],
  ]) {
    test(args.join(" "), () => {
      expectParity(pair, args);
    });
  }
});
