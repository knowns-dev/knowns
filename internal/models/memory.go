package models

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var memoryIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Memory layer constants.
const (
	MemoryLayerProject = "project"
	MemoryLayerGlobal  = "global"
)

// MemoryEntry represents a single memory entry stored as a markdown file
// with YAML frontmatter. Content is free-form markdown.
type MemoryEntry struct {
	ID       string `json:"id"                    yaml:"id"`
	Title    string `json:"title"                 yaml:"title"`
	Layer    string `json:"layer"                 yaml:"layer"`              // "project", "global"
	Category string `json:"category,omitempty"    yaml:"category,omitempty"` // "pattern", "convention", "preference", etc.; "decision" is legacy.

	// Content holds the markdown body. Not persisted in frontmatter.
	Content string `json:"content,omitempty" yaml:"-"`

	Status         string            `json:"status,omitempty"         yaml:"status,omitempty"`
	Confidence     string            `json:"confidence,omitempty"     yaml:"confidence,omitempty"`
	LastVerified   time.Time         `json:"lastVerified,omitempty"   yaml:"lastVerified,omitempty"`
	TTLDays        int               `json:"ttlDays,omitempty"        yaml:"ttlDays,omitempty"`
	Sources        []string          `json:"sources,omitempty"        yaml:"sources,omitempty"`
	MergedInto     string            `json:"mergedInto,omitempty"     yaml:"mergedInto,omitempty"`
	RejectedReason string            `json:"rejectedReason,omitempty" yaml:"rejectedReason,omitempty"`
	Tags           []string          `json:"tags,omitempty"           yaml:"tags,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"       yaml:"metadata,omitempty"`
	CreatedAt      time.Time         `json:"createdAt"                yaml:"createdAt"`
	UpdatedAt      time.Time         `json:"updatedAt"                yaml:"updatedAt"`

	// LifecycleMetadataMissing tracks absent lifecycle frontmatter on legacy files.
	// It is not persisted; validators use it to warn while loading legacy entries as active.
	LifecycleMetadataMissing []string `json:"lifecycleMetadataMissing,omitempty" yaml:"-"`
}

const (
	MemoryStatusProposed   = "proposed"
	MemoryStatusActive     = "active"
	MemoryStatusStale      = "stale"
	MemoryStatusDeprecated = "deprecated"
	MemoryStatusArchived   = "archived"
	MemoryStatusRejected   = "rejected"
	MemoryStatusMerged     = "merged"
)

const (
	MemoryConfidenceLow    = "low"
	MemoryConfidenceMedium = "medium"
	MemoryConfidenceHigh   = "high"
)

const LegacyDecisionMemoryCategory = "decision"

const (
	LegacyDecisionMigrationIDKey         = "decisionMigration.id"
	LegacyDecisionMigrationResolutionKey = "decisionMigration.resolution"
	LegacyDecisionMigrationDecisionKey   = "decisionMigration.decisionId"
)

var ErrLegacyDecisionMemoryWrite = errors.New("memory category \"decision\" is legacy and read-only; archive, reject, reclassify, or migrate existing entries, and create new durable guidance as a first-class System Decision with `knowns decision create` or the Decision MCP/API")

// IsLegacyDecisionMemoryCategory normalizes user input before applying the
// legacy category policy at every Memory write boundary.
func IsLegacyDecisionMemoryCategory(category string) bool {
	return strings.EqualFold(strings.TrimSpace(category), LegacyDecisionMemoryCategory)
}

// ValidateNewMemoryCategory rejects all new Decision Memory writes. Historical
// files remain readable and are handled by ValidateLegacyDecisionMemoryUpdate.
func ValidateNewMemoryCategory(category string) error {
	if IsLegacyDecisionMemoryCategory(category) {
		return ErrLegacyDecisionMemoryWrite
	}
	return nil
}

// ValidateLegacyDecisionMemoryUpdate constrains historical Decision Memories
// to terminal lifecycle changes or reclassification. Migration records use an
// archived legacy entry plus provenance rather than mutating current guidance.
func ValidateLegacyDecisionMemoryUpdate(existing, updated *MemoryEntry) error {
	if existing == nil || updated == nil {
		return nil
	}
	wasLegacy := IsLegacyDecisionMemoryCategory(existing.Category)
	isLegacy := IsLegacyDecisionMemoryCategory(updated.Category)
	if !wasLegacy {
		return ValidateNewMemoryCategory(updated.Category)
	}
	if !isLegacy {
		return nil
	}
	if updated.Status == MemoryStatusArchived || updated.Status == MemoryStatusRejected {
		return nil
	}
	return ErrLegacyDecisionMemoryWrite
}

func ValidMemoryStatus(status string) bool {
	switch status {
	case MemoryStatusProposed, MemoryStatusActive, MemoryStatusStale,
		MemoryStatusDeprecated, MemoryStatusArchived, MemoryStatusRejected,
		MemoryStatusMerged:
		return true
	default:
		return false
	}
}

func ValidMemoryConfidence(confidence string) bool {
	switch confidence {
	case MemoryConfidenceLow, MemoryConfidenceMedium, MemoryConfidenceHigh:
		return true
	default:
		return false
	}
}

func (m *MemoryEntry) ApplyLifecycleDefaults() {
	if m.Status == "" {
		m.Status = MemoryStatusActive
	}
}

func (m *MemoryEntry) MissingTrustMetadata() []string {
	seen := make(map[string]bool)
	var missing []string
	add := func(field string) {
		if field == "" || seen[field] {
			return
		}
		seen[field] = true
		missing = append(missing, field)
	}
	for _, field := range m.LifecycleMetadataMissing {
		add(field)
	}
	if m.Status == "" {
		add("status")
	}
	if m.Confidence == "" {
		add("confidence")
	}
	if m.LastVerified.IsZero() {
		add("lastVerified")
	}
	if m.TTLDays <= 0 {
		add("ttlDays")
	}
	if len(m.Sources) == 0 {
		add("sources")
	}
	return missing
}

func (m *MemoryEntry) CurrentForDefaultRetrieval() bool {
	if m == nil {
		return false
	}
	status := m.Status
	if status == "" {
		status = MemoryStatusActive
	}
	return status == MemoryStatusActive
}

// MemoryFileName returns the canonical file name for a memory entry.
//
// Format: "memory-{id}.md"
func MemoryFileName(id string) string {
	return "memory-" + id + ".md"
}

// ValidateMemoryID rejects IDs that can change the canonical memory filename
// or use platform-specific alternate path syntax.
func ValidateMemoryID(id string) error {
	if !memoryIDPattern.MatchString(id) || strings.HasSuffix(id, ".") {
		return fmt.Errorf("invalid memory ID %q", id)
	}
	return nil
}

// ValidMemoryLayer reports whether layer is a recognised memory layer.
func ValidMemoryLayer(layer string) bool {
	return layer == MemoryLayerProject || layer == MemoryLayerGlobal
}

// ValidPersistentMemoryLayer reports whether layer is a persistent memory layer.
func ValidPersistentMemoryLayer(layer string) bool {
	return layer == MemoryLayerProject || layer == MemoryLayerGlobal
}

// PromoteLayer returns the next layer up, or an error string if already at top.
func PromoteLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerProject:
		return MemoryLayerGlobal, true
	default:
		return "", false
	}
}

// DemoteLayer returns the next layer down, or an error string if already at bottom.
func DemoteLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerGlobal:
		return MemoryLayerProject, true
	default:
		return "", false
	}
}

// PromotePersistentMemoryLayer returns the next persistent layer up.
func PromotePersistentMemoryLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerProject:
		return MemoryLayerGlobal, true
	default:
		return "", false
	}
}

// DemotePersistentMemoryLayer returns the next persistent layer down.
func DemotePersistentMemoryLayer(layer string) (string, bool) {
	switch layer {
	case MemoryLayerGlobal:
		return MemoryLayerProject, true
	default:
		return "", false
	}
}
