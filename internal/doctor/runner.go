package doctor

import (
	"context"
	"fmt"
	"sort"
	"time"
)

const defaultCheckTimeout = 2 * time.Second

type CheckFunc func(context.Context) (CheckResult, error)

type Checker struct {
	ID      string
	Scope   Scope
	Timeout time.Duration
	Check   CheckFunc
}

type RunOptions struct {
	Project        ProjectInfo
	Scopes         []Scope
	Strict         bool
	DefaultTimeout time.Duration
}

func Run(ctx context.Context, opts RunOptions, checkers []Checker) (Result, error) {
	selectedScopes, err := normalizeScopes(opts.Scopes)
	if err != nil {
		return Result{}, err
	}
	if err := validateRegistry(checkers); err != nil {
		return Result{}, err
	}

	selected := make([]Checker, 0, len(checkers))
	for _, checker := range checkers {
		if len(selectedScopes) == 0 || selectedScopes[checker.Scope] {
			selected = append(selected, checker)
		}
	}
	sort.SliceStable(selected, func(i, j int) bool {
		left, right := selected[i], selected[j]
		if scopeOrder[left.Scope] != scopeOrder[right.Scope] {
			return scopeOrder[left.Scope] < scopeOrder[right.Scope]
		}
		return left.ID < right.ID
	})

	result := Result{
		SchemaVersion: SchemaVersion,
		Strict:        opts.Strict,
		Project:       opts.Project,
		Checks:        make([]CheckResult, 0, len(selected)),
	}
	if result.Project.KnownsVersion == "" {
		result.Project.KnownsVersion = InactiveProject().KnownsVersion
	}

	timeout := opts.DefaultTimeout
	if timeout <= 0 {
		timeout = defaultCheckTimeout
	}
	for _, checker := range selected {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		checkResult, err := runChecker(ctx, checker, timeout)
		if err != nil {
			return Result{}, err
		}
		result.Checks = append(result.Checks, checkResult)
		addStatus(&result.Summary, checkResult.Status)
	}
	result.Verdict = deriveVerdict(result.Summary)
	return result, nil
}

func normalizeScopes(scopes []Scope) (map[Scope]bool, error) {
	if len(scopes) == 0 {
		return nil, nil
	}
	normalized := make(map[Scope]bool, len(scopes))
	for _, scope := range scopes {
		if !scope.Valid() {
			return nil, fmt.Errorf("unknown doctor scope %q", scope)
		}
		normalized[scope] = true
	}
	return normalized, nil
}

func validateRegistry(checkers []Checker) error {
	seen := make(map[string]bool, len(checkers))
	for _, checker := range checkers {
		if checker.ID == "" {
			return fmt.Errorf("doctor checker ID is required")
		}
		if !checker.Scope.Valid() {
			return fmt.Errorf("doctor checker %q has invalid scope %q", checker.ID, checker.Scope)
		}
		if checker.Check == nil {
			return fmt.Errorf("doctor checker %q has no implementation", checker.ID)
		}
		if seen[checker.ID] {
			return fmt.Errorf("duplicate doctor checker ID %q", checker.ID)
		}
		seen[checker.ID] = true
	}
	return nil
}

type checkerOutcome struct {
	result   CheckResult
	err      error
	panicked bool
}

func runChecker(parent context.Context, checker Checker, fallbackTimeout time.Duration) (CheckResult, error) {
	timeout := checker.Timeout
	if timeout <= 0 {
		timeout = fallbackTimeout
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	outcomes := make(chan checkerOutcome, 1)
	go func() {
		outcome := checkerOutcome{}
		defer func() {
			if recover() != nil {
				outcome = checkerOutcome{panicked: true}
			}
			outcomes <- outcome
		}()
		outcome.result, outcome.err = checker.Check(ctx)
	}()

	select {
	case <-parent.Done():
		return CheckResult{}, parent.Err()
	case <-ctx.Done():
		return normalizedFailure(checker, "Check timed out", "checker_timeout"), nil
	case outcome := <-outcomes:
		switch {
		case outcome.panicked:
			return normalizedFailure(checker, "Check failed unexpectedly", "checker_panic"), nil
		case outcome.err != nil:
			return normalizedFailure(checker, "Check could not complete", "checker_error"), nil
		default:
			return normalizeResult(checker, outcome.result), nil
		}
	}
}

func normalizeResult(checker Checker, result CheckResult) CheckResult {
	result.ID = checker.ID
	result.Scope = checker.Scope

	if !result.Status.Valid() {
		return normalizedFailure(checker, "Check returned an invalid status", "invalid_status")
	}
	if err := validateEvidence(result.Evidence); err != nil {
		return normalizedFailure(checker, "Check produced unsafe evidence", "unsafe_evidence")
	}
	if result.Summary == "" {
		result.Summary = "Check completed"
	}
	if result.Status == StatusSkip && result.SkipReason == "" {
		result.SkipReason = "not_applicable"
	}
	if (result.Status == StatusWarn || result.Status == StatusFail) && result.Remediation == nil {
		result.Remediation = &Remediation{
			Description: "Review this diagnostic and resolve the reported condition, then rerun knowns doctor.",
		}
	}
	return result
}

func normalizedFailure(checker Checker, summary, code string) CheckResult {
	return CheckResult{
		ID:      checker.ID,
		Scope:   checker.Scope,
		Status:  StatusFail,
		Summary: summary,
		Evidence: Evidence{
			"errorCode": code,
		},
		Remediation: &Remediation{
			Description: "Review the affected subsystem and rerun knowns doctor.",
		},
	}
}

func addStatus(summary *Summary, status Status) {
	switch status {
	case StatusPass:
		summary.Pass++
	case StatusWarn:
		summary.Warn++
	case StatusFail:
		summary.Fail++
	case StatusSkip:
		summary.Skip++
	}
}
