package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/search"
	"github.com/spf13/cobra"
)

func TestEvalRetrievalCommandSurface(t *testing.T) {
	if evalCmd.Commands()[0] != evalRetrievalCmd {
		t.Fatal("expected eval retrieval subcommand")
	}
	for _, flag := range []string{
		"cases",
		"baseline",
		"mode",
		"runtime-id",
		"update-baseline",
		"reason",
		"output",
	} {
		if evalRetrievalCmd.Flags().Lookup(flag) == nil {
			t.Fatalf("missing eval retrieval --%s flag", flag)
		}
	}
}

func TestValidateEvalRetrievalFlagsProtectsProjectLocalAndUpdates(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{
			name: "local baseline",
			err:  validateEvalRetrievalFlags("keyword", "local.json", "baseline.json", false, "", ""),
			want: "cannot use",
		},
		{
			name: "local update",
			err:  validateEvalRetrievalFlags("keyword", "local.json", "", true, "reason", ""),
			want: "report-only",
		},
		{
			name: "missing reason",
			err:  validateEvalRetrievalFlags("keyword", "", "", true, "", ""),
			want: "--reason",
		},
		{
			name: "unpinned semantic",
			err:  validateEvalRetrievalFlags("semantic", "", "", false, "", ""),
			want: "--runtime-id",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.err == nil || !strings.Contains(tt.err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", tt.err, tt.want)
			}
		})
	}
	if err := validateEvalRetrievalFlags("keyword", "", "", false, "", ""); err != nil {
		t.Fatalf("canonical keyword flags: %v", err)
	}
}

func TestEmitEvaluationReportHumanAndJSONUseSameReport(t *testing.T) {
	report := &search.RetrievalEvaluationReport{
		SchemaVersion:   search.EvaluationReportSchemaVersion,
		Mode:            "keyword",
		RuntimeIdentity: "keyword",
		Scope:           "canonical",
		Outcome:         search.EvaluationOutcomePass,
	}

	humanCmd := &cobra.Command{}
	var human bytes.Buffer
	humanCmd.SetOut(&human)
	if err := emitEvaluationReport(humanCmd, report, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(human.String(), "Retrieval evaluation: pass") {
		t.Fatalf("human output = %q", human.String())
	}

	jsonCmd := &cobra.Command{}
	jsonCmd.Flags().Bool("json", true, "")
	var machine bytes.Buffer
	jsonCmd.SetOut(&machine)
	if err := emitEvaluationReport(jsonCmd, report, ""); err != nil {
		t.Fatal(err)
	}
	var decoded search.RetrievalEvaluationReport
	if err := json.Unmarshal(machine.Bytes(), &decoded); err != nil {
		t.Fatalf("decode JSON output: %v\n%s", err, machine.String())
	}
	if decoded.Outcome != report.Outcome || decoded.Mode != report.Mode {
		t.Fatalf("decoded report = %+v", decoded)
	}
}
