// The interactive `knowns init` wizard on a pseudo-terminal: Go's huh form and the clack wizard get
// the same keystrokes; the questions they ask (titles, in order) and everything they write (project
// tree, HOME tree, exit code) must match. Ollama is absent from PATH, so the semantic group is
// hidden in both (huh hides the whole group when semantic search starts disabled).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { treeDiff } from "../cli/commands/init-harness.ts";
import { askedInOrder, hasGoBin, hasPty, KEY, type PtyStep, runBoth } from "./pty-harness.ts";

const cases = hasGoBin && hasPty ? describe : describe.skip;

const TITLES = [
  "Project name",
  "Default Task ID prefix",
  "Git tracking mode",
  "Knowns sections to track in git",
  "Project instruction files",
];

const norm = (m: Map<string, string>) => m;

function expectSame(r: ReturnType<typeof runBoth>, titles = TITLES): void {
  expect(r.ts.exit).toBe(r.go.exit);
  expect(askedInOrder(r.ts.transcript, titles)).toEqual(askedInOrder(r.go.transcript, titles));
  expect(treeDiff(norm(r.goTree), norm(r.tsTree))).toEqual([]);
  expect(treeDiff(norm(r.goHome), norm(r.tsHome))).toEqual([]);
}

const E = KEY.enter;
const step = (expect: string | null, keys: string): PtyStep => ({ expect, keys });
const SLOW = 180_000;

cases("init wizard matches Go on a terminal", () => {
  test(
    "every default accepted",
    () => {
      const r = runBoth(
        ["init"],
        [
          step("Project name", E),
          step("Default Task ID prefix", E),
          step("Git tracking mode", E),
          step("Knowns sections", E),
          step("Project instruction files", E),
        ],
      );
      expect(r.go.exit).toBe(0);
      expect([...r.goTree.keys()]).toContain(".knowns/config.json");
      expectSame(r);
    },
    SLOW,
  );

  test(
    "typed name and prefix, git ignored, toggled sections and files",
    () => {
      const r = runBoth(
        ["init"],
        [
          step("Project name", `-two${E}`),
          step("Default Task ID prefix", `kn${E}`),
          step("Git tracking mode", `${KEY.down}${E}`),
          // sections: toggle tasks off, memories on
          step(
            "Knowns sections",
            `{toggle}${KEY.down}${KEY.down}${KEY.down}${KEY.down}{toggle}${E}`,
          ),
          // files: toggle claude off, opencode on
          step("Project instruction files", `{toggle}${KEY.down}${KEY.down}{toggle}${E}`),
        ],
      );
      expect(r.go.exit).toBe(0);
      expectSame(r);
    },
    SLOW,
  );

  test(
    "git mode none skips the sections question",
    () => {
      const r = runBoth(
        ["init"],
        [
          step("Project name", E),
          step("Default Task ID prefix", E),
          step("Git tracking mode", `${KEY.down}${KEY.down}${E}`),
          step("Project instruction files", E),
        ],
      );
      expect(askedInOrder(r.go.transcript, TITLES)).not.toContain(
        "Knowns sections to track in git",
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "--git-tracked skips the mode question",
    () => {
      const r = runBoth(
        ["init", "--git-tracked"],
        [
          step("Project name", E),
          step("Default Task ID prefix", E),
          step("Knowns sections", E),
          step("Project instruction files", E),
        ],
      );
      expect(askedInOrder(r.go.transcript, TITLES)).not.toContain("Git tracking mode");
      expectSame(r);
    },
    SLOW,
  );

  test(
    "an invalid prefix is rejected, then corrected",
    () => {
      const r = runBoth(
        ["init"],
        [
          step("Project name", E),
          step("Default Task ID prefix", `k${E}`),
          step(null, `n${E}`),
          step("Git tracking mode", E),
          step("Knowns sections", E),
          step("Project instruction files", E),
        ],
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "at least one instruction file is required",
    () => {
      const r = runBoth(
        ["init"],
        [
          step("Project name", E),
          step("Default Task ID prefix", E),
          step("Git tracking mode", E),
          step("Knowns sections", E),
          // untoggle claude and agents, try to submit, then pick gemini
          step("Project instruction files", `{toggle}${KEY.down}{toggle}${E}`),
          step(null, `${KEY.down}${KEY.down}{toggle}${E}`),
        ],
      );
      expectSame(r);
    },
    SLOW,
  );

  test(
    "cancelling prints nothing written and exits like Go",
    () => {
      const r = runBoth(["init"], [step("Project name", KEY.ctrlC)]);
      expect([...r.goTree.keys()].some((k) => k.startsWith(".knowns"))).toBe(false);
      expectSame(r, []);
      expect(r.ts.transcript).toContain("Setup cancelled.");
      expect(r.go.transcript).toContain("Setup cancelled.");
    },
    SLOW,
  );

  test(
    "--force pre-fills from the existing config",
    () => {
      const setup = (p: { dir: string }) => {
        const cfg = join(p.dir, ".knowns", "config.json");
        mkdirSync(dirname(cfg), { recursive: true });
        writeFileSync(
          cfg,
          JSON.stringify({
            name: "existing",
            id: "existing",
            createdAt: "2026-01-01T00:00:00Z",
            settings: {
              defaultTaskIdPrefix: "EX",
              gitTrackingMode: "git-ignored",
              gitTracking: {
                tasks: false,
                docs: true,
                templates: false,
                memories: true,
                decisions: false,
              },
              platforms: ["opencode", "codex"],
            },
          }),
        );
      };
      const r = runBoth(
        ["init", "--force"],
        [
          step("Project name", E),
          step("Default Task ID prefix", E),
          step("Git tracking mode", E),
          step("Knowns sections", E),
          step("Project instruction files", E),
        ],
        { setup },
      );
      expectSame(r);
    },
    SLOW,
  );
});
