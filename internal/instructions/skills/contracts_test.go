package skills

import (
	"fmt"
	"io/fs"
	"strings"
	"testing"
)

func TestBuiltInSkillContracts(t *testing.T) {
	skills := readBuiltInSkills(t)

	if len(skills) != 17 {
		t.Fatalf("expected 17 built-in skills, got %d", len(skills))
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

// TestRosterSentenceListsEverySkill keeps the shared roster sentence in step with
// the embedded set. The sentence is duplicated across several skill sources and was
// maintained by hand, so it silently fell three skills behind. Adding a skill without
// updating the roster now fails here instead of shipping.
func TestRosterSentenceListsEverySkill(t *testing.T) {
	const rosterMarker = "All built-in skills in scope must end with the same user-facing information order:"

	skills := readBuiltInSkills(t)

	var carriers []string
	for name, content := range skills {
		if strings.Contains(content, rosterMarker) {
			carriers = append(carriers, name)
		}
	}
	if len(carriers) == 0 {
		t.Fatalf("no skill carries the roster sentence; the marker may have been reworded")
	}

	for _, carrier := range carriers {
		t.Run(carrier+"/roster-complete", func(t *testing.T) {
			roster := rosterSentence(t, skills[carrier], rosterMarker)
			for name := range skills {
				if !strings.Contains(roster, "`"+name+"`") {
					t.Errorf("roster sentence omits %q", name)
				}
			}
		})
	}

	t.Run("carriers-agree", func(t *testing.T) {
		want := rosterSentence(t, skills[carriers[0]], rosterMarker)
		for _, carrier := range carriers[1:] {
			if got := rosterSentence(t, skills[carrier], rosterMarker); got != want {
				t.Errorf("%s roster differs from %s:\n got: %s\nwant: %s", carrier, carriers[0], got, want)
			}
		}
	})
}

func rosterSentence(t *testing.T, content, marker string) string {
	t.Helper()

	idx := strings.Index(content, marker)
	if idx < 0 {
		t.Fatalf("roster marker not found")
	}
	rest := content[idx:]
	if end := strings.Index(rest, "\n"); end >= 0 {
		rest = rest[:end]
	}
	return rest
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
