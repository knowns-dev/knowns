// Package decisionmigration provides a reviewed, reversible bridge from the
// legacy Memory category "decision" to first-class System Decisions.
package decisionmigration

import (
	"fmt"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

const (
	ResolutionCreateDecision       = "create_decision"
	ResolutionLinkExisting         = "link_existing"
	ResolutionConsolidateDuplicate = "consolidate_duplicate"
	ResolutionReclassify           = "reclassify"
	ResolutionArchiveNoise         = "archive_noise"
	ResolutionRejectNoise          = "reject_noise"
	ResolutionLeaveUnchanged       = "leave_unchanged"
)

const (
	NoiseLow    = "low"
	NoiseMedium = "medium"
	NoiseHigh   = "high"
)

const (
	JournalPending    = "pending"
	JournalApplied    = "applied"
	JournalRolledBack = "rolled_back"
	JournalFailed     = "failed"
)

var AllowedResolutions = []string{
	ResolutionCreateDecision,
	ResolutionLinkExisting,
	ResolutionConsolidateDuplicate,
	ResolutionReclassify,
	ResolutionArchiveNoise,
	ResolutionRejectNoise,
	ResolutionLeaveUnchanged,
}

// Candidate is one deterministic row in a dry-run migration report.
type Candidate struct {
	MemoryID           string   `json:"memoryId"`
	Title              string   `json:"title"`
	Layer              string   `json:"layer"`
	Status             string   `json:"status"`
	Sources            []string `json:"sources"`
	SourceIssues       []string `json:"sourceIssues,omitempty"`
	NoiseLikelihood    string   `json:"noiseLikelihood"`
	NoiseReasons       []string `json:"noiseReasons,omitempty"`
	DuplicateGroup     string   `json:"duplicateGroup,omitempty"`
	DuplicateMembers   []string `json:"duplicateMembers,omitempty"`
	ProposedResolution string   `json:"proposedResolution"`
	ProposedDecisionID string   `json:"proposedDecisionId,omitempty"`
	ProposedTargetID   string   `json:"proposedTargetId,omitempty"`
	ProposedCategory   string   `json:"proposedCategory,omitempty"`
	JournalState       string   `json:"journalState,omitempty"`
	LinkedDecisionID   string   `json:"linkedDecisionId,omitempty"`
}

// PreviewReport is read-only. Calling Preview never creates migration files.
type PreviewReport struct {
	Candidates []Candidate   `json:"candidates"`
	Counts     PreviewCounts `json:"counts"`
}

type PreviewCounts struct {
	Total     int `json:"total"`
	HighNoise int `json:"highNoise"`
	Duplicate int `json:"duplicate"`
	WithIssue int `json:"withIssue"`
}

// Selection is an explicit, reviewed resolution. Apply never resolves
// unselected candidates and never performs an implicit bulk migration.
type Selection struct {
	MemoryID       string   `json:"memoryId"`
	Resolution     string   `json:"resolution"`
	DecisionID     string   `json:"decisionId,omitempty"`
	TargetMemoryID string   `json:"targetMemoryId,omitempty"`
	Category       string   `json:"category,omitempty"`
	Reason         string   `json:"reason,omitempty"`
	RelatedDocs    []string `json:"relatedDocs,omitempty"`
	RelatedTasks   []string `json:"relatedTasks,omitempty"`
	AcceptVerified bool     `json:"acceptVerified,omitempty"`
}

func (selection Selection) validate() error {
	selection.MemoryID = strings.TrimSpace(selection.MemoryID)
	selection.Resolution = strings.TrimSpace(selection.Resolution)
	if selection.MemoryID == "" {
		return fmt.Errorf("memoryId is required")
	}
	if !validMigrationMemoryID(selection.MemoryID) {
		return fmt.Errorf("invalid migration memory ID %q", selection.MemoryID)
	}
	switch selection.Resolution {
	case ResolutionCreateDecision, ResolutionArchiveNoise, ResolutionRejectNoise, ResolutionLeaveUnchanged:
	case ResolutionLinkExisting:
		if strings.TrimSpace(selection.DecisionID) == "" {
			return fmt.Errorf("decisionId is required for %s", selection.Resolution)
		}
	case ResolutionConsolidateDuplicate:
		if strings.TrimSpace(selection.TargetMemoryID) == "" {
			return fmt.Errorf("targetMemoryId is required for %s", selection.Resolution)
		}
		if selection.TargetMemoryID == selection.MemoryID {
			return fmt.Errorf("duplicate memory cannot target itself")
		}
	case ResolutionReclassify:
		if strings.TrimSpace(selection.Category) == "" {
			return fmt.Errorf("category is required for %s", selection.Resolution)
		}
		if err := models.ValidateNewMemoryCategory(selection.Category); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported migration resolution %q", selection.Resolution)
	}
	if selection.AcceptVerified && selection.Resolution != ResolutionCreateDecision && selection.Resolution != ResolutionLinkExisting && selection.Resolution != ResolutionConsolidateDuplicate {
		return fmt.Errorf("acceptVerified requires a Decision-backed migration resolution")
	}
	return nil
}

type ApplyResult struct {
	Results []ItemResult `json:"results"`
}

type ItemResult struct {
	MemoryID       string `json:"memoryId"`
	Resolution     string `json:"resolution"`
	State          string `json:"state"`
	DecisionID     string `json:"decisionId,omitempty"`
	LegacyExcluded bool   `json:"legacyExcluded"`
	Idempotent     bool   `json:"idempotent,omitempty"`
	Error          string `json:"error,omitempty"`
}

type RollbackResult struct {
	MemoryID   string `json:"memoryId"`
	State      string `json:"state"`
	DecisionID string `json:"decisionId,omitempty"`
}

type Journal struct {
	Version         int                 `json:"version"`
	MigrationID     string              `json:"migrationId"`
	MemoryID        string              `json:"memoryId"`
	Selection       Selection           `json:"selection"`
	OriginalMemory  *models.MemoryEntry `json:"originalMemory"`
	DecisionID      string              `json:"decisionId,omitempty"`
	DecisionCreated bool                `json:"decisionCreated,omitempty"`
	AddedSources    []string            `json:"addedSources,omitempty"`
	AddedDocs       []string            `json:"addedDocs,omitempty"`
	AddedTasks      []string            `json:"addedTasks,omitempty"`
	State           string              `json:"state"`
	LegacyExcluded  bool                `json:"legacyExcluded"`
	Error           string              `json:"error,omitempty"`
	CreatedAt       time.Time           `json:"createdAt"`
	UpdatedAt       time.Time           `json:"updatedAt"`
}
