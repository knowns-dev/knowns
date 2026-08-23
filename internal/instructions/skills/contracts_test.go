package skills

import (
	"fmt"
	"io/fs"
	"strings"
	"testing"
)

func TestBuiltInSkillContracts(t *testing.T) {
	skills := readBuiltInSkills(t)

	if len(skills) != 15 {
		t.Fatalf("expected 15 built-in skills, got %d", len(skills))
	}

	for name, content := range skills {
		t.Run(name+"/response-order", func(t *testing.T) {
			assertMarkersInOrder(t, content, "Goal/result", "Key details", "Next action")
		})
		t.Run(name+"/platform-neutral-source", func(t *testing.T) {
			for _, marker := range []string{"In Codex", "Generated with Claude Code", ".claude/skills/*"} {
				if strings.Contains(content, marker) {
					t.Fatalf("contains platform-specific source marker %q", marker)
				}
			}
		})
	}
}

func TestResearchSkillIsPortableAndReadOnlyByDefault(t *testing.T) {
	content := readBuiltInSkill(t, "kn-research")

	for _, forbidden := range []string{"Context7", "specialized MCP providers such as", "general web search only"} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("research skill contains provider-coupled guidance %q", forbidden)
		}
	}
	for _, required := range []string{
		"Research is read-only by default",
		"explicitly requests persistence",
		"Select tools by capability and source quality, not by provider or tool name",
		"If no suitable search or retrieval capability is available",
		"answer only from verified available context",
	} {
		if !strings.Contains(content, required) {
			t.Fatalf("research skill is missing contract marker %q", required)
		}
	}
}

func TestPlanningAndTemplateSkillDefectsStayFixed(t *testing.T) {
	plan := readBuiltInSkill(t, "kn-plan")
	for _, required := range []string{
		"outcome-oriented, testable task ACs",
		"Implementation mechanics belong in the later task plan, not in task ACs",
		"WAIT FOR APPROVAL",
	} {
		if !strings.Contains(plan, required) {
			t.Fatalf("planning skill is missing contract marker %q", required)
		}
	}

	template := readBuiltInSkill(t, "kn-template")
	if !strings.Contains(template, "path: src/components/{{pascalCase name}}.tsx") {
		t.Fatal("template skill is missing the valid helper expression example")
	}
	for _, malformed := range []string{"destination: \"src/components//.tsx\"", "${{{"} {
		if strings.Contains(template, malformed) {
			t.Fatalf("template skill contains malformed example %q", malformed)
		}
	}
}

func TestCompactedSkillsPreserveWorkflowGates(t *testing.T) {
	tests := map[string][]string{
		"kn-plan": {
			"WAIT FOR APPROVAL",
			"Entity validation passed",
			"Every Spec Decision is reported",
		},
		"kn-go": {
			"Commit remains the one mandatory user gate",
			"Never create Memory category `decision`",
			"Do not claim completion while validation or required verification fails",
		},
		"kn-extract": {
			"Never create Memory category `decision`",
			"Never auto-accept it",
			"Require explicit user approval before destructive, archival, supersession, or broad rewrite actions",
		},
	}

	for name, markers := range tests {
		content := readBuiltInSkill(t, name)
		for _, marker := range markers {
			if !strings.Contains(content, marker) {
				t.Errorf("%s is missing workflow gate %q", name, marker)
			}
		}
	}
}

func readBuiltInSkills(t *testing.T) map[string]string {
	t.Helper()

	entries, err := fs.ReadDir(Files, ".")
	if err != nil {
		t.Fatalf("read embedded skills: %v", err)
	}

	skills := make(map[string]string)
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "kn-") {
			continue
		}
		skills[entry.Name()] = readBuiltInSkill(t, entry.Name())
	}
	return skills
}

func readBuiltInSkill(t *testing.T, name string) string {
	t.Helper()

	data, err := Files.ReadFile(fmt.Sprintf("%s/SKILL.md", name))
	if err != nil {
		t.Fatalf("read embedded %s: %v", name, err)
	}
	return string(data)
}

func assertMarkersInOrder(t *testing.T, content string, markers ...string) {
	t.Helper()

	position := -1
	for _, marker := range markers {
		next := strings.Index(content[position+1:], marker)
		if next < 0 {
			t.Fatalf("missing response marker %q", marker)
		}
		position += next + 1
	}
}
