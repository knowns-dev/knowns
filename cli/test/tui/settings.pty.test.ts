// `knowns settings` and `knowns settings --global` on a pseudo-terminal: Go's huh forms and the
// clack flows get the same keystrokes; menu and form titles (in order) and the files written
// (project tree, HOME tree) must match. Ollama is not on PATH and no case enables the Ollama
// provider, so nothing depends on the machine's Ollama.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type InitProject, treeDiff } from "../cli/commands/init-harness.ts";
import { GO_BIN, hasGoBin } from "../cli/oracle.ts";
import { askedInOrder, hasPty, KEY, type PtyStep, runBoth, sandboxPath } from "./pty-harness.ts";

const cases = hasGoBin && hasPty ? describe : describe.skip;
const E = KEY.enter;
const D = KEY.down;
// Not y/n: huh submits the field on those, clack waits for Enter. Left is Yes, right is No in both.
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const step = (expect: string | null, keys: string): PtyStep => ({ expect, keys });
const SLOW = 180_000;
const MENU = "Project Settings";
const GMENU = "Global Settings";

const TITLES = [
  MENU,
  GMENU,
  "Project name",
  "Default project name",
  "Default Task ID prefix",
  "Git tracking mode",
  "Knowns sections to track in git",
  "AI platforms",
  "Skill location",
  "Enable code intelligence",
  "Enable Semantic Search",
  "Enable semantic search by default",
  "Default provider",
  "Default model",
];

/** An initialized project, made by the Go binary on both sides so the start state is identical. */
function initialized(p: InitProject): void {
  mkdirSync(join(p.dir, ".git"), { recursive: true });
  const r = Bun.spawnSync([GO_BIN as string, "init", "--no-wizard"], {
    cwd: p.dir,
    env: {
      PATH: sandboxPath(false),
      HOME: p.home,
      USERPROFILE: p.home,
      NO_UPDATE_CHECK: "1",
      KNOWNS_RUNTIME_INLINE: "1",
      KNOWN_LSP_AUTO_INSTALL: "0",
    },
  });
  if (r.exitCode !== 0) throw new Error(`go init failed: ${r.stderr.toString()}`);
}

const projectOpts = { setup: initialized };

function expectSame(r: ReturnType<typeof runBoth>, titles = TITLES): void {
  expect(r.ts.exit).toBe(r.go.exit);
  expect(askedInOrder(r.ts.transcript, titles)).toEqual(askedInOrder(r.go.transcript, titles));
  // The tail the commands print themselves (not form chrome).
  for (const line of ["Settings saved.", "Global settings saved.", "Aborted."]) {
    expect(r.ts.transcript.includes(line)).toBe(r.go.transcript.includes(line));
  }
  expect(treeDiff(r.goTree, r.tsTree)).toEqual([]);
  expect(treeDiff(r.goHome, r.tsHome)).toEqual([]);
}

const DONE = `${D}${D}${D}${D}${D}${D}${E}`;

cases("settings (project) matches Go on a terminal", () => {
  test(
    "done straight away",
    () => {
      const r = runBoth(["settings"], [step(MENU, DONE)], projectOpts);
      expect(r.go.exit).toBe(0);
      expectSame(r);
    },
    SLOW,
  );

  test(
    "cancel at the menu",
    () => {
      const r = runBoth(["settings"], [step(MENU, KEY.ctrlC)], projectOpts);
      expect(r.go.transcript).toContain("Aborted.");
      expectSame(r);
    },
    SLOW,
  );

  test(
    "project name and prefix",
    () => {
      const r = runBoth(
        ["settings"],
        [
          step(MENU, E),
          step("Project name", `-x${E}`),
          step("Default Task ID prefix", `ab${E}`),
          step(MENU, DONE),
        ],
        projectOpts,
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "project name must not be blank",
    () => {
      const r = runBoth(
        ["settings"],
        [
          step(MENU, E),
          step("Project name", `${"\x7f".repeat(40)}${E}`),
          step(null, `z${E}`),
          step("Default Task ID prefix", E),
          step(MENU, DONE),
        ],
        projectOpts,
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "git tracking: ignored, a section toggled",
    () => {
      const r = runBoth(
        ["settings"],
        [
          step(MENU, `${D}${E}`),
          step("Git tracking mode", `${D}${E}`),
          step("Knowns sections", `{toggle}${D}${D}${D}${D}{toggle}${E}`),
          step(MENU, DONE),
        ],
        projectOpts,
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "git tracking: none skips the sections",
    () => {
      const r = runBoth(
        ["settings"],
        [step(MENU, `${D}${E}`), step("Git tracking mode", `${D}${D}${E}`), step(MENU, DONE)],
        projectOpts,
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "platforms and skill location",
    () => {
      const r = runBoth(
        ["settings"],
        [
          step(MENU, `${D}${D}${E}`),
          step("AI platforms", `${D}{toggle}${E}`),
          step("Skill location", `${D}${D}${E}`),
          step(MENU, DONE),
        ],
        projectOpts,
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "code intelligence on",
    () => {
      const r = runBoth(
        ["settings"],
        [
          step(MENU, `${D}${D}${D}${D}${E}`),
          step("Enable code intelligence", `${LEFT}${E}`),
          step(MENU, DONE),
        ],
        projectOpts,
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "search stays off",
    () => {
      const r = runBoth(
        ["settings"],
        [
          step(MENU, `${D}${D}${D}${E}`),
          step("Enable Semantic Search", `${RIGHT}${E}`),
          step(MENU, DONE),
        ],
        projectOpts,
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "maintenance prints its hints",
    () => {
      const r = runBoth(
        ["settings"],
        [step(MENU, `${D}${D}${D}${D}${D}${E}`), step(MENU, DONE)],
        projectOpts,
      );
      expect(r.go.transcript).toContain("Run: knowns sync to apply generated files");
      expectSame(r);
    },
    SLOW,
  );

  test(
    "cancelling a sub-form returns to the menu",
    () => {
      const r = runBoth(
        ["settings"],
        [step(MENU, E), step("Project name", KEY.ctrlC), step(MENU, DONE)],
        projectOpts,
      );
      // huh draws both inputs of a group at once, so only the first title is compared.
      expectSame(
        r,
        TITLES.filter((t) => t !== "Default Task ID prefix"),
      );
    },
    SLOW,
  );
});

cases("settings --global matches Go on a terminal", () => {
  const GDONE = `${D}${D}${D}${D}${D}${E}`;

  test(
    "done straight away writes the defaults file",
    () => {
      const r = runBoth(["settings", "--global"], [step(GMENU, GDONE)]);
      expect(r.go.exit).toBe(0);
      expectSame(r);
    },
    SLOW,
  );

  test(
    "cancel at the menu",
    () => {
      const r = runBoth(["settings", "--global"], [step(GMENU, KEY.ctrlC)]);
      expectSame(r);
    },
    SLOW,
  );

  test(
    "project defaults",
    () => {
      const r = runBoth(
        ["settings", "--global"],
        [
          step(GMENU, E),
          step("Default project name", `Mine${E}`),
          step("Default Task ID prefix", `KN${E}`),
          step(GMENU, GDONE),
        ],
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "default git tracking and platforms",
    () => {
      const r = runBoth(
        ["settings", "--global"],
        [
          step(GMENU, `${D}${E}`),
          step("Git tracking mode", `${D}${E}`),
          step("Knowns sections", `{toggle}${E}`),
          step(GMENU, `${D}${D}${E}`),
          step("AI platforms", `${D}{toggle}${E}`),
          step("Skill location", `${D}${D}${E}`),
          step(GMENU, GDONE),
        ],
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "default search with the api provider, and code intelligence",
    () => {
      const r = runBoth(
        ["settings", "--global"],
        [
          step(GMENU, `${D}${D}${D}${E}`),
          step("Enable semantic search by default", `${LEFT}${E}`),
          step("Default provider", `${D}${E}`),
          step("Default model", `-v2${E}`),
          step(GMENU, `${D}${D}${D}${D}${E}`),
          step("Enable code intelligence", `${LEFT}${E}`),
          step(GMENU, GDONE),
        ],
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "existing defaults are kept and re-saved",
    () => {
      const setup = (p: InitProject) => {
        mkdirSync(join(p.home, ".knowns"), { recursive: true });
        writeFileSync(
          join(p.home, ".knowns", "settings.json"),
          JSON.stringify({
            projectDefaults: {
              projectName: "kept",
              settings: { defaultPriority: "high", defaultTaskIdPrefix: "KP", platforms: ["kiro"] },
            },
          }),
        );
      };
      const r = runBoth(["settings", "--global"], [step(GMENU, GDONE)], { setup });
      expectSame(r);
    },
    SLOW,
  );
});
