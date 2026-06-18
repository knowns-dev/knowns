package models

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Decision lifecycle statuses.
const (
	DecisionStatusDraft      = "draft"
	DecisionStatusAccepted   = "accepted"
	DecisionStatusSuperseded = "superseded"
	DecisionStatusRejected   = "rejected"
	DecisionStatusArchived   = "archived"
)

// DecisionEntry represents a first-class architecture/product decision stored
// as markdown with YAML frontmatter.
type DecisionEntry struct {
	ID           string    `json:"id"                     yaml:"id"`
	Title        string    `json:"title"                  yaml:"title"`
	Status       string    `json:"status"                 yaml:"status"`
	Supersedes   []string  `json:"supersedes,omitempty"   yaml:"supersedes,omitempty"`
	SupersededBy []string  `json:"supersededBy,omitempty" yaml:"supersededBy,omitempty"`
	Tags         []string  `json:"tags,omitempty"         yaml:"tags,omitempty"`
	Sources      []string  `json:"sources,omitempty"      yaml:"sources,omitempty"`
	RelatedDocs  []string  `json:"relatedDocs,omitempty"  yaml:"relatedDocs,omitempty"`
	RelatedTasks []string  `json:"relatedTasks,omitempty" yaml:"relatedTasks,omitempty"`
	CreatedAt    time.Time `json:"createdAt"              yaml:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"              yaml:"updatedAt"`

	Context                string `json:"context,omitempty"                 yaml:"-"`
	Decision               string `json:"decision,omitempty"                yaml:"-"`
	AlternativesConsidered string `json:"alternativesConsidered,omitempty"  yaml:"-"`
	Consequences           string `json:"consequences,omitempty"            yaml:"-"`
	Content                string `json:"content,omitempty"                 yaml:"-"`
}

// DecisionIDExists reports whether a candidate decision ID is already in use.
type DecisionIDExists func(id string) bool

var decisionSlugNonAlnum = regexp.MustCompile(`[^a-z0-9]+`)
var decisionIDPattern = regexp.MustCompile(`^\d{8}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$`)

// ValidDecisionStatus reports whether status is one of the supported Decision
// lifecycle states.
func ValidDecisionStatus(status string) bool {
	switch status {
	case DecisionStatusDraft, DecisionStatusAccepted, DecisionStatusSuperseded,
		DecisionStatusRejected, DecisionStatusArchived:
		return true
	default:
		return false
	}
}

// ValidDecisionID reports whether id follows the canonical
// YYYYMMDD-HHMM-slug decision ID format.
func ValidDecisionID(id string) bool {
	return decisionIDPattern.MatchString(id)
}

// ApplyDecisionDefaults fills the create-time status default required by the
// Decision lifecycle: sourced or related decisions become accepted, otherwise draft.
func (d *DecisionEntry) ApplyDecisionDefaults() {
	if d.Status != "" {
		return
	}
	if len(d.Sources) > 0 || len(d.RelatedDocs) > 0 || len(d.RelatedTasks) > 0 {
		d.Status = DecisionStatusAccepted
		return
	}
	d.Status = DecisionStatusDraft
}

// CurrentForDefaultRetrieval reports whether a decision is current guidance.
func (d *DecisionEntry) CurrentForDefaultRetrieval() bool {
	if d == nil {
		return false
	}
	return d.Status == DecisionStatusAccepted && len(d.SupersededBy) == 0
}

// DecisionRef returns the canonical semantic reference for a decision.
func DecisionRef(id string) string {
	return "@decision/" + id
}

// DecisionFileName returns the canonical file name for a decision.
func DecisionFileName(id string) string {
	return id + ".md"
}

// DecisionIDPrefix formats the date-time prefix used in decision IDs.
func DecisionIDPrefix(createdAt time.Time) string {
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	return createdAt.Format("20060102-1504")
}

// DecisionSlug returns the path-safe slug portion of a decision ID.
func DecisionSlug(title string) string {
	title = strings.ToLower(strings.TrimSpace(title))
	title = decisionSlugNonAlnum.ReplaceAllString(title, "-")
	title = strings.Trim(title, "-")
	if title == "" {
		return "decision"
	}
	return title
}

// NewDecisionID generates a decision ID and applies deterministic numeric
// suffixes when a candidate already exists.
func NewDecisionID(title string, createdAt time.Time, exists DecisionIDExists) string {
	base := fmt.Sprintf("%s-%s", DecisionIDPrefix(createdAt), DecisionSlug(title))
	if exists == nil || !exists(base) {
		return base
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !exists(candidate) {
			return candidate
		}
	}
}
