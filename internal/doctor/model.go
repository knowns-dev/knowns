// Package doctor provides the read-only diagnostic model and check runner used
// by the `knowns doctor` command.
package doctor

import (
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/howznguyen/knowns/internal/util"
)

const SchemaVersion = 1

type Status string

const (
	StatusPass Status = "pass"
	StatusWarn Status = "warn"
	StatusFail Status = "fail"
	StatusSkip Status = "skip"
)

func (s Status) Valid() bool {
	switch s {
	case StatusPass, StatusWarn, StatusFail, StatusSkip:
		return true
	default:
		return false
	}
}

type Verdict string

const (
	VerdictHealthy   Verdict = "healthy"
	VerdictDegraded  Verdict = "degraded"
	VerdictUnhealthy Verdict = "unhealthy"
)

type Scope string

const (
	ScopeProject    Scope = "project"
	ScopeValidation Scope = "validation"
	ScopeSearch     Scope = "search"
	ScopeRuntime    Scope = "runtime"
	ScopeLSP        Scope = "lsp"
	ScopeAI         Scope = "ai"
	ScopeOnline     Scope = "online"
)

var scopeOrder = map[Scope]int{
	ScopeProject:    0,
	ScopeValidation: 1,
	ScopeSearch:     2,
	ScopeRuntime:    3,
	ScopeLSP:        4,
	ScopeAI:         5,
	ScopeOnline:     6,
}

func (s Scope) Valid() bool {
	_, ok := scopeOrder[s]
	return ok
}

func AllScopes() []Scope {
	return []Scope{
		ScopeProject,
		ScopeValidation,
		ScopeSearch,
		ScopeRuntime,
		ScopeLSP,
		ScopeAI,
		ScopeOnline,
	}
}

type ProjectInfo struct {
	Active        bool   `json:"active"`
	Name          string `json:"name,omitempty"`
	Path          string `json:"path,omitempty"`
	KnownsVersion string `json:"knownsVersion"`
}

func InactiveProject() ProjectInfo {
	return ProjectInfo{KnownsVersion: util.Version}
}

type Summary struct {
	Pass int `json:"pass"`
	Warn int `json:"warn"`
	Fail int `json:"fail"`
	Skip int `json:"skip"`
}

type Remediation struct {
	Description string `json:"description"`
	Command     string `json:"command,omitempty"`
}

// Evidence is intentionally limited to safe scalar metadata and string lists.
// Checkers must never put raw config, log content, command output, or errors here.
type Evidence map[string]any

type CheckResult struct {
	ID          string       `json:"id"`
	Scope       Scope        `json:"scope"`
	Status      Status       `json:"status"`
	Summary     string       `json:"summary"`
	Evidence    Evidence     `json:"evidence,omitempty"`
	Remediation *Remediation `json:"remediation,omitempty"`
	SkipReason  string       `json:"skipReason,omitempty"`
}

type Result struct {
	SchemaVersion int           `json:"schemaVersion"`
	Verdict       Verdict       `json:"verdict"`
	Strict        bool          `json:"strict"`
	Online        bool          `json:"online"`
	Project       ProjectInfo   `json:"project"`
	Summary       Summary       `json:"summary"`
	Checks        []CheckResult `json:"checks"`
}

func (r Result) ExitCode() int {
	if r.Verdict == VerdictUnhealthy || (r.Strict && r.Verdict == VerdictDegraded) {
		return 1
	}
	return 0
}

func deriveVerdict(summary Summary) Verdict {
	switch {
	case summary.Fail > 0:
		return VerdictUnhealthy
	case summary.Warn > 0:
		return VerdictDegraded
	default:
		return VerdictHealthy
	}
}

var evidenceKeyPattern = regexp.MustCompile(`^[a-z][A-Za-z0-9]*$`)

func validateEvidence(evidence Evidence) error {
	for key, value := range evidence {
		if !evidenceKeyPattern.MatchString(key) {
			return fmt.Errorf("invalid evidence key %q", key)
		}
		switch value.(type) {
		case nil,
			bool,
			string,
			int, int8, int16, int32, int64,
			uint, uint8, uint16, uint32, uint64,
			float32, float64,
			json.Number,
			[]string:
		case Evidence:
			if err := validateEvidence(value.(Evidence)); err != nil {
				return err
			}
		case []Evidence:
			for _, item := range value.([]Evidence) {
				if err := validateEvidence(item); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unsupported evidence value for %q", key)
		}
	}
	return nil
}
