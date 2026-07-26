package doctor

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRunOrdersChecksAndDerivesVerdict(t *testing.T) {
	checkers := []Checker{
		{
			ID:             "online.version",
			Scope:          ScopeOnline,
			RequiresOnline: true,
			Check: func(context.Context) (CheckResult, error) {
				t.Fatal("offline check was executed")
				return CheckResult{}, nil
			},
		},
		{
			ID:    "validation.summary",
			Scope: ScopeValidation,
			Check: func(context.Context) (CheckResult, error) {
				return CheckResult{Status: StatusPass, Summary: "clean"}, nil
			},
		},
		{
			ID:    "project.storage",
			Scope: ScopeProject,
			Check: func(context.Context) (CheckResult, error) {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "degraded",
					Remediation: &Remediation{
						Description: "repair storage",
					},
				}, nil
			},
		},
	}

	result, err := Run(context.Background(), RunOptions{}, checkers)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Verdict != VerdictDegraded {
		t.Fatalf("Verdict = %q, want %q", result.Verdict, VerdictDegraded)
	}
	if result.Summary != (Summary{Pass: 1, Warn: 1, Skip: 1}) {
		t.Fatalf("Summary = %#v", result.Summary)
	}
	gotOrder := []string{result.Checks[0].ID, result.Checks[1].ID, result.Checks[2].ID}
	wantOrder := []string{"project.storage", "validation.summary", "online.version"}
	for i := range wantOrder {
		if gotOrder[i] != wantOrder[i] {
			t.Fatalf("check order = %v, want %v", gotOrder, wantOrder)
		}
	}
	if result.Checks[2].SkipReason != "online_disabled" {
		t.Fatalf("online skip reason = %q", result.Checks[2].SkipReason)
	}
}

func TestRunIsolatesPanicAndTimeout(t *testing.T) {
	checkers := []Checker{
		{
			ID:    "project.panic",
			Scope: ScopeProject,
			Check: func(context.Context) (CheckResult, error) {
				panic("sensitive panic")
			},
		},
		{
			ID:      "project.timeout",
			Scope:   ScopeProject,
			Timeout: 5 * time.Millisecond,
			Check: func(context.Context) (CheckResult, error) {
				time.Sleep(25 * time.Millisecond)
				return CheckResult{Status: StatusPass}, nil
			},
		},
		{
			ID:    "project.working",
			Scope: ScopeProject,
			Check: func(context.Context) (CheckResult, error) {
				return CheckResult{Status: StatusPass, Summary: "working"}, nil
			},
		},
	}

	result, err := Run(context.Background(), RunOptions{}, checkers)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Verdict != VerdictUnhealthy {
		t.Fatalf("Verdict = %q, want %q", result.Verdict, VerdictUnhealthy)
	}
	if result.Summary.Fail != 2 || result.Summary.Pass != 1 {
		t.Fatalf("Summary = %#v", result.Summary)
	}
	if result.Checks[0].Evidence["errorCode"] != "checker_panic" {
		t.Fatalf("panic evidence = %#v", result.Checks[0].Evidence)
	}
	if result.Checks[1].Evidence["errorCode"] != "checker_timeout" {
		t.Fatalf("timeout evidence = %#v", result.Checks[1].Evidence)
	}
}

func TestRunRejectsUnsafeEvidenceAndRawErrors(t *testing.T) {
	checkers := []Checker{
		{
			ID:    "project.error",
			Scope: ScopeProject,
			Check: func(context.Context) (CheckResult, error) {
				return CheckResult{}, errors.New("token=super-secret")
			},
		},
		{
			ID:    "project.unsafe",
			Scope: ScopeProject,
			Check: func(context.Context) (CheckResult, error) {
				return CheckResult{
					Status:   StatusPass,
					Evidence: Evidence{"rawError": errors.New("password=super-secret")},
				}, nil
			},
		},
	}

	result, err := Run(context.Background(), RunOptions{}, checkers)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	for _, check := range result.Checks {
		if check.Status != StatusFail {
			t.Fatalf("%s status = %q", check.ID, check.Status)
		}
		for _, value := range check.Evidence {
			if value == "token=super-secret" || value == "password=super-secret" {
				t.Fatalf("%s leaked raw error: %#v", check.ID, check.Evidence)
			}
		}
	}
}

func TestResultExitCode(t *testing.T) {
	tests := []struct {
		result Result
		want   int
	}{
		{result: Result{Verdict: VerdictHealthy}, want: 0},
		{result: Result{Verdict: VerdictDegraded}, want: 0},
		{result: Result{Verdict: VerdictDegraded, Strict: true}, want: 1},
		{result: Result{Verdict: VerdictUnhealthy}, want: 1},
	}
	for _, tt := range tests {
		if got := tt.result.ExitCode(); got != tt.want {
			t.Fatalf("ExitCode() = %d, want %d for %#v", got, tt.want, tt.result)
		}
	}
}
