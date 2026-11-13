// `knowns runtime memory hook` and `knowns runtime-memory hook` against the Go 0.34.1 oracle,
// for every runtime and event `knowns setup` installs (domain/setup/runtimeinstall.ts), fed the
// way the adapters feed it: a JSON envelope or bare text on stdin, or the prompt in the
// environment. Each run gets a fresh copy of the same project and temporary HOME; the memory
// files are compared afterwards because the hook retires abandoned proposals.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGoBin } from "../oracle.ts";
import {
  goInTemplate,
  makeSandbox,
  type RunOptions,
  runGoIn,
  runTsIn,
  type Sandbox,
} from "./subprocess-diff.ts";

const t = test.skipIf(!hasGoBin);
const WATCH = ["proj/.knowns/memory", "home/.knowns/global/memory"];

let box: Sandbox;

beforeAll(() => {
  if (!hasGoBin) return;
  box = makeSandbox("knowns-hook-");
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.proj, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
  goInTemplate(box, ["init", "hooks", "--no-wizard"]);
  const create = (title: string, ...rest: string[]) =>
    goInTemplate(box, ["memory", "create", title, ...rest]);
  create(
    "Use uv for Python",
    "--category",
    "preference",
    "--status",
    "active",
    "-c",
    "Always run Python through uv, never pip directly.",
    "-t",
    "style",
  );
  create(
    "Retry flaky qdrant tests",
    "--category",
    "failure",
    "-c",
    "Qdrant integration tests flake on cold start; retry once before failing.",
  );
  create(
    "Commit messages are conventional",
    "--category",
    "convention",
    "--status",
    "active",
    "-c",
    "Use conventional commit prefixes.\n\n<!--memory:detail-->\n\nfeat, fix, chore, docs, refactor.",
  );
  create(
    "Global note about embeddings",
    "--category",
    "pattern",
    "--status",
    "active",
    "--layer",
    "global",
    "-c",
    "Embedding model qwen3 needs recalibration of the semantic floor.",
  );
  create(
    "Qdrant cold start failure",
    "--category",
    "failure",
    "--status",
    "active",
    "-c",
    "Qdrant takes 20 seconds on cold start; wait for readiness before running integration tests.",
  );
  create(
    "Old abandoned proposal about pnpm",
    "--category",
    "pattern",
    "-c",
    "Prefer pnpm workspaces for the monorepo build.",
  );
  // Age the proposal past the 30-day review TTL so the hook's capture step retires it.
  const dir = join(box.proj, ".knowns", "memory");
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const text = readFileSync(file, "utf8");
    if (!text.includes("Old abandoned proposal")) continue;
    writeFileSync(
      file,
      text
        .replace(/^updatedAt: .*$/m, "updatedAt: '2026-09-01T00:00:00Z'")
        .replace(/^createdAt: .*$/m, "createdAt: '2026-09-01T00:00:00Z'"),
    );
  }
}, 60_000);

afterAll(() => {
  if (box) rmSync(box.root, { recursive: true, force: true });
});

async function same(args: string[], opts: RunOptions = {}): Promise<void> {
  const o = { ...opts, watch: WATCH };
  const go = await runGoIn(box, args, o);
  const ts = await runTsIn(box, args, o);
  expect(ts).toEqual(go);
}

const PROMPT = (p: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: p });

describe("every installed runtime and event matches Go", () => {
  const runtimes = ["claude-code", "codex", "kiro", "opencode", "antigravity"];
  const events = [
    "session-start",
    "user-prompt-submit",
    "promptsubmit",
    "session.created",
    "agentspawn",
  ];
  for (const runtime of runtimes) {
    for (const event of events) {
      t(`runtime-memory hook --runtime ${runtime} --event ${event} (session envelope)`, () =>
        same(["runtime-memory", "hook", "--runtime", runtime, "--event", event], {
          stdin: JSON.stringify({ hook_event_name: "SessionStart", cwd: "/x" }),
        }),
      );
      t(`runtime memory hook --runtime ${runtime} --event ${event} (prompt)`, () =>
        same(["runtime", "memory", "hook", "--runtime", runtime, "--event", event], {
          stdin: PROMPT("qdrant integration tests fail on cold start"),
        }),
      );
    }
  }
});

describe("payloads match Go", () => {
  const hook = [
    "runtime-memory",
    "hook",
    "--runtime",
    "claude-code",
    "--event",
    "user-prompt-submit",
  ];
  t("--json pack with a keyword match", () =>
    same([...hook, "--json"], { stdin: PROMPT("qdrant integration tests fail on cold start") }),
  );
  t("--json session baseline", () =>
    same(["runtime-memory", "hook", "--runtime", "codex", "--event", "session-start", "--json"]),
  );
  t("bare-text prompt on stdin", () =>
    same([...hook], { stdin: "commit message conventional prefixes please" }),
  );
  t("JSON without a prompt field is no prompt", () =>
    same([...hook, "--json"], { stdin: JSON.stringify({ cwd: "/x" }) }),
  );
  t("text and message keys", async () => {
    await same([...hook, "--json"], { stdin: JSON.stringify({ text: "python uv scripts" }) });
    await same([...hook, "--json"], { stdin: JSON.stringify({ message: "python uv scripts" }) });
  });
  t("a JSON array is bare text", () =>
    same([...hook, "--json"], { stdin: '["qdrant cold start"]' }),
  );
  t("KNOWNS_RUNTIME_PROMPT wins over stdin", () =>
    same([...hook], {
      stdin: PROMPT("ignored"),
      env: { KNOWNS_RUNTIME_PROMPT: "qdrant cold start readiness" },
    }),
  );
  t("USER_PROMPT", () => same([...hook], { env: { USER_PROMPT: "commit prefixes conventional" } }));
  t("a low-signal prompt", () => same([...hook, "--json"], { stdin: PROMPT("ok") }));
  t("below the keyword floor", () =>
    same([...hook, "--json"], { stdin: PROMPT("embedding database pool sizing") }),
  );
  t("no match at all", () =>
    same([...hook, "--json"], { stdin: PROMPT("kubernetes ingress nginx") }),
  );
  t("--mode debug", () =>
    same([...hook, "--json", "--mode", "debug"], { stdin: PROMPT("qdrant cold start") }),
  );
  t("--mode off", () =>
    same([...hook, "--json", "--mode", "off"], { stdin: PROMPT("qdrant cold start") }),
  );
  t("--mode manual", () =>
    same([...hook, "--mode", "manual"], { stdin: PROMPT("qdrant cold start") }),
  );
  t("--capture disabled", () =>
    same([...hook, "--json", "--capture", "disabled"], { stdin: PROMPT("qdrant cold start") }),
  );
  t("--max-bytes squeezes the summary and elides", () =>
    same([...hook, "--max-bytes", "300"], {
      stdin: PROMPT("qdrant integration cold start tests python uv"),
    }),
  );
  t("--max-bytes too small for any entry", () =>
    same([...hook, "--json", "--max-bytes", "60"], { stdin: PROMPT("qdrant cold start") }),
  );
  t("--max-items 1 at session start", () =>
    same([
      "runtime-memory",
      "hook",
      "--runtime",
      "kiro",
      "--event",
      "agentspawn",
      "--max-items",
      "1",
      "--json",
    ]),
  );
  t("--project that is not a project", () =>
    same([...hook, "--json", "--project", "/nonexistent/dir"], {
      stdin: PROMPT("qdrant cold start"),
    }),
  );
  t("--cwd outside any project prints nothing", () =>
    same([...hook, "--cwd", "/"], { stdin: PROMPT("qdrant cold start") }),
  );
});

describe("the capture step retires abandoned proposals like Go", () => {
  t("an expired proposal is rejected on prompt submit", async () => {
    const args = [
      "runtime-memory",
      "hook",
      "--runtime",
      "codex",
      "--event",
      "user-prompt-submit",
      "--json",
    ];
    const opts = { stdin: PROMPT("qdrant cold start readiness"), watch: WATCH };
    const go = await runGoIn(box, args, opts);
    const ts = await runTsIn(box, args, opts);
    expect(ts).toEqual(go);
    expect(ts.stdout).toContain('"expiredProposals": 1');
    expect(Object.values(ts.files).join("\n")).toContain("rejectedReason: expired_unreviewed");
  });
});

describe("errors and help match Go", () => {
  t("unsupported runtime", () =>
    same(["runtime-memory", "hook", "--runtime", "nope", "--event", "session-start"]),
  );
  t("--runtime missing", () => same(["runtime-memory", "hook", "--event", "session-start"]));
  t("--event missing", () => same(["runtime", "memory", "hook", "--runtime", "codex"]));
  t("bad --max-items", () =>
    same(["runtime-memory", "hook", "--runtime", "codex", "--event", "x", "--max-items", "z"]),
  );
  for (const args of [
    ["runtime-memory"],
    ["runtime-memory", "--help"],
    ["runtime-memory", "hook", "--help"],
    ["runtime", "memory"],
    ["runtime", "memory", "--help"],
    ["runtime", "memory", "hook", "--help"],
    ["runtime", "--help"],
    ["help", "runtime", "memory", "hook"],
  ]) {
    t(args.join(" "), () => same(args));
  }
});
