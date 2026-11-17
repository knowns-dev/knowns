// Contracts the built-in skill sources must keep. Ported from the Go
// internal/instructions/skills/contracts_test.go (removed with the Go tree, KN-NDD5YY); the markers
// and their reasons are unchanged. Reads the embedded set, which sync-drift.test.ts proves equals
// cli/instructions/skills byte for byte.
import { describe, expect, test } from "bun:test";
import { skillFiles } from "../../src/domain/instructions/embedded.generated.ts";

function builtInSkills(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, content] of Object.entries(skillFiles)) {
    const m = /^(kn-[^/]+)\/SKILL\.md$/.exec(path);
    if (m?.[1]) out.set(m[1], content);
  }
  return out;
}

const skills = builtInSkills();

function skill(name: string): string {
  const content = skills.get(name);
  if (content === undefined) throw new Error(`no embedded ${name}/SKILL.md`);
  return content;
}

function expectAll(content: string, markers: string[], what: string): void {
  for (const marker of markers) expect(content.includes(marker), `${what}: ${marker}`).toBe(true);
}

function expectNone(content: string, markers: string[], what: string): void {
  for (const marker of markers) expect(content.includes(marker), `${what}: ${marker}`).toBe(false);
}

describe("built-in skill contracts", () => {
  test("there are 17 built-in skills", () => {
    expect(skills.size).toBe(17);
  });

  for (const [name, content] of skills) {
    test(`${name}: response order is Goal/result, Key details, Next action`, () => {
      let position = -1;
      for (const marker of ["Goal/result", "Key details", "Next action"]) {
        const next = content.indexOf(marker, position + 1);
        expect(next, `missing response marker ${marker}`).toBeGreaterThanOrEqual(0);
        position = next;
      }
    });

    test(`${name}: source is platform neutral`, () => {
      expectNone(content, ["In Codex", "Generated with Claude Code", ".claude/skills/*"], name);
    });
  }

  test("kn-research is portable and read-only by default", () => {
    const content = skill("kn-research");
    expectNone(
      content,
      ["Context7", "specialized MCP providers such as", "general web search only"],
      "provider-coupled guidance",
    );
    expectAll(
      content,
      [
        "Research is read-only by default",
        "explicitly requests persistence",
        "Select tools by capability and source quality, not by provider or tool name",
        "If no suitable search or retrieval capability is available",
        "answer only from verified available context",
      ],
      "kn-research contract",
    );
  });

  test("planning and template skill defects stay fixed", () => {
    expectAll(
      skill("kn-plan"),
      [
        "outcome-oriented, testable task ACs",
        "Implementation mechanics belong in the later task plan, not in task ACs",
        "WAIT FOR APPROVAL",
      ],
      "kn-plan contract",
    );
    const template = skill("kn-template");
    expect(template).toContain("path: src/components/{{pascalCase name}}.tsx");
    expectNone(template, ['destination: "src/components//.tsx"', "${{{"], "malformed example");
  });

  test("compacted skills preserve their workflow gates", () => {
    const gates: Record<string, string[]> = {
      "kn-plan": [
        "WAIT FOR APPROVAL",
        "Entity validation passed",
        "Every Spec Decision is reported",
      ],
      "kn-go": [
        "Commit remains the one mandatory user gate",
        "Never create Memory category `decision`",
        "Do not claim completion while validation or required verification fails",
      ],
      "kn-extract": [
        "Never create Memory category `decision`",
        "Never auto-accept it",
        "Require explicit user approval before destructive, archival, supersession, or broad rewrite actions",
      ],
    };
    for (const [name, markers] of Object.entries(gates)) expectAll(skill(name), markers, name);
  });

  // The roster sentence is duplicated across several skill sources and was maintained by hand, so
  // it silently fell three skills behind. Adding a skill without updating it fails here.
  test("every roster sentence lists every skill, and all carriers agree", () => {
    const marker =
      "All built-in skills in scope must end with the same user-facing information order:";
    const rosters = new Map<string, string>();
    for (const [name, content] of skills) {
      const idx = content.indexOf(marker);
      if (idx < 0) continue;
      const rest = content.slice(idx);
      const end = rest.indexOf("\n");
      rosters.set(name, end >= 0 ? rest.slice(0, end) : rest);
    }
    expect(rosters.size, "no skill carries the roster sentence").toBeGreaterThan(0);
    for (const [carrier, roster] of rosters) {
      for (const name of skills.keys()) {
        expect(roster.includes(`\`${name}\``), `${carrier} roster omits ${name}`).toBe(true);
      }
    }
    const [first] = [...rosters.values()];
    for (const [carrier, roster] of rosters) expect(roster, carrier).toBe(first as string);
  });

  // Across 35 tasks the project had one relation ref and zero blocked-by edges, because kn-plan
  // never emitted any while kn-flow leaned on `order`. A producer that writes edges and a consumer
  // that reads them must both stay.
  test("dependency edges are declared, not inferred", () => {
    expectAll(
      skill("kn-plan"),
      [
        "{blocked-by}",
        "order `NN * 10`, which carries display sequence only",
        "Create upstream tasks first so their IDs exist",
        "Never declare a cycle",
        "Prefer no edge over a speculative edge",
      ],
      "kn-plan dependency edges",
    );
    expectAll(
      skill("kn-flow"),
      [
        '"relationTypes": "blocked-by,depends"',
        "A task is runnable only when every task it declares `blocked-by` is done",
        "never on its own justifies serialising them",
      ],
      "kn-flow dependency edges",
    );
  });

  // The prompt used to ask for free text, so a reviewer approved because a worker said "done"
  // rather than because evidence existed.
  test("worker reports carry evidence", () => {
    expectAll(
      skill("kn-flow"),
      [
        "Worker Report Contract",
        '"test_evidence"',
        '"commands_run"',
        '"out_of_scope_edits"',
        "A worker report is evidence, not a status claim",
        "Integrate because the evidence holds, never because a worker reported completion",
        "Check the worker's report against that diff",
      ],
      "kn-flow worker report",
    );
  });
});
