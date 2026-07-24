package decisionmigration

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/howznguyen/knowns/internal/models"
)

var (
	migrationMemoryIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)
	inlineSourcePattern      = regexp.MustCompile(`@(doc|task|decision|memory)/[A-Za-z0-9._/-]+`)
)

func validMigrationMemoryID(id string) bool {
	return migrationMemoryIDPattern.MatchString(strings.TrimSpace(id))
}

// Preview classifies every readable legacy Decision Memory without writing to
// Memory, Decision, journal, or lock files.
func (s *Service) Preview() (*PreviewReport, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	entries, err := s.Store.Memory.List("")
	if err != nil {
		return nil, err
	}
	legacy := make([]*models.MemoryEntry, 0)
	for _, entry := range entries {
		if models.IsLegacyDecisionMemoryCategory(entry.Category) {
			legacy = append(legacy, entry)
		}
	}
	sort.Slice(legacy, func(i, j int) bool { return legacy[i].ID < legacy[j].ID })

	duplicateKeys := make(map[string][]string)
	for _, entry := range legacy {
		key := duplicateKey(entry)
		duplicateKeys[key] = append(duplicateKeys[key], entry.ID)
	}
	for key := range duplicateKeys {
		sort.Strings(duplicateKeys[key])
	}
	duplicateLeaders := make(map[string]string)
	for _, entry := range legacy {
		key := duplicateKey(entry)
		if len(duplicateKeys[key]) < 2 || duplicateLeaders[key] != "" {
			continue
		}
		noise, _ := classifyNoise(entry)
		if noise != NoiseHigh {
			duplicateLeaders[key] = entry.ID
		}
	}

	existingIDs := make(map[string]bool)
	decisions, err := s.Store.Decisions.List()
	if err != nil {
		return nil, err
	}
	for _, decision := range decisions {
		existingIDs[decision.ID] = true
	}
	reservedIDs := make(map[string]bool, len(existingIDs))
	for id := range existingIDs {
		reservedIDs[id] = true
	}

	report := &PreviewReport{Candidates: make([]Candidate, 0, len(legacy))}
	for _, entry := range legacy {
		key := duplicateKey(entry)
		candidate, err := s.previewCandidate(entry, duplicateKeys[key], duplicateLeaders[key], existingIDs, reservedIDs)
		if err != nil {
			return nil, err
		}
		report.Candidates = append(report.Candidates, candidate)
		report.Counts.Total++
		if candidate.NoiseLikelihood == NoiseHigh {
			report.Counts.HighNoise++
		}
		if candidate.DuplicateGroup != "" {
			report.Counts.Duplicate++
		}
		if len(candidate.SourceIssues) > 0 {
			report.Counts.WithIssue++
		}
	}
	return report, nil
}

func (s *Service) previewCandidate(entry *models.MemoryEntry, duplicateMembers []string, duplicateLeader string, existingIDs, reservedIDs map[string]bool) (Candidate, error) {
	sources := memorySources(entry)
	noise, reasons := classifyNoise(entry)
	sourceIssues := classifySourceIssues(entry, sources, existingIDs)
	candidate := Candidate{
		MemoryID:        entry.ID,
		Title:           entry.Title,
		Layer:           entry.Layer,
		Status:          entry.Status,
		Sources:         sources,
		SourceIssues:    sourceIssues,
		NoiseLikelihood: noise,
		NoiseReasons:    reasons,
	}

	if len(duplicateMembers) > 1 {
		candidate.DuplicateGroup = duplicateGroupID(entry)
		candidate.DuplicateMembers = append([]string(nil), duplicateMembers...)
	}
	journal, err := s.readJournal(entry.ID)
	if err != nil {
		return Candidate{}, err
	}
	if journal != nil {
		candidate.JournalState = journal.State
		candidate.LinkedDecisionID = journal.DecisionID
	}

	if noise == NoiseHigh {
		candidate.ProposedResolution = ResolutionArchiveNoise
		return candidate, nil
	}
	if duplicateLeader != "" && duplicateLeader != entry.ID {
		candidate.ProposedResolution = ResolutionConsolidateDuplicate
		candidate.ProposedTargetID = duplicateLeader
		return candidate, nil
	}
	if decisionID := linkedDecisionSource(sources, existingIDs); decisionID != "" {
		candidate.ProposedResolution = ResolutionLinkExisting
		candidate.ProposedDecisionID = decisionID
		return candidate, nil
	}
	if duplicateLeader == "" {
		if category := proposedMemoryCategory(entry); category != "" {
			candidate.ProposedResolution = ResolutionReclassify
			candidate.ProposedCategory = category
			return candidate, nil
		}
	}
	candidate.ProposedResolution = ResolutionCreateDecision
	candidate.ProposedDecisionID = models.NewDecisionID(entry.Title, entry.CreatedAt, func(id string) bool {
		return reservedIDs[id]
	})
	reservedIDs[candidate.ProposedDecisionID] = true
	return candidate, nil
}

func duplicateKey(entry *models.MemoryEntry) string {
	value := normalizeMigrationText(entry.Content)
	if value == "" {
		value = normalizeMigrationText(entry.Title)
	}
	return value
}

func duplicateGroupID(entry *models.MemoryEntry) string {
	sum := sha256.Sum256([]byte(duplicateKey(entry)))
	return "dup-" + hex.EncodeToString(sum[:6])
}

func normalizeMigrationText(value string) string {
	return strings.Join(strings.FieldsFunc(strings.ToLower(strings.TrimSpace(value)), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}), " ")
}

func memorySources(entry *models.MemoryEntry) []string {
	seen := make(map[string]bool)
	for _, source := range entry.Sources {
		if source = strings.TrimSpace(source); source != "" {
			seen[source] = true
		}
	}
	for _, source := range inlineSourcePattern.FindAllString(entry.Content, -1) {
		source = strings.TrimRight(source, ".,;:!?)]}")
		seen[source] = true
	}
	result := make([]string, 0, len(seen))
	for source := range seen {
		result = append(result, source)
	}
	sort.Strings(result)
	return result
}

func classifySourceIssues(entry *models.MemoryEntry, sources []string, existingIDs map[string]bool) []string {
	issues := make([]string, 0)
	if len(sources) == 0 {
		issues = append(issues, "missing_source")
	}
	if !validMigrationMemoryID(entry.ID) {
		issues = append(issues, "invalid_memory_id")
	}
	for _, source := range sources {
		if strings.HasPrefix(source, "@decision/") {
			id := strings.TrimPrefix(source, "@decision/")
			if !models.ValidDecisionID(id) || !existingIDs[id] {
				issues = append(issues, fmt.Sprintf("decision_source_not_found:%s", id))
			}
		}
	}
	sort.Strings(issues)
	return issues
}

func linkedDecisionSource(sources []string, existingIDs map[string]bool) string {
	for _, source := range sources {
		if !strings.HasPrefix(source, "@decision/") {
			continue
		}
		id := strings.TrimPrefix(source, "@decision/")
		if models.ValidDecisionID(id) && existingIDs[id] {
			return id
		}
	}
	return ""
}

func classifyNoise(entry *models.MemoryEntry) (string, []string) {
	title := normalizeMigrationText(entry.Title)
	if title == "project workflow decision" || title == "instruction source of truth" {
		return NoiseHigh, []string{"generic_runtime_capture_title"}
	}
	for key, value := range entry.Metadata {
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.ToLower(strings.TrimSpace(value))
		if (strings.Contains(key, "runtime") || strings.Contains(key, "prompt") || strings.Contains(key, "instruction")) && value != "" && value != "false" && value != "0" {
			return NoiseHigh, []string{"runtime_capture_metadata"}
		}
	}
	if len(strings.Fields(entry.Content)) < 8 || strings.Contains(title, "instruction") {
		return NoiseMedium, []string{"low_context_candidate"}
	}
	return NoiseLow, nil
}

func proposedMemoryCategory(entry *models.MemoryEntry) string {
	text := normalizeMigrationText(entry.Title + " " + entry.Content)
	switch {
	case strings.Contains(text, " convention ") || strings.HasPrefix(text, "convention "):
		return "convention"
	case strings.Contains(text, " pattern ") || strings.HasPrefix(text, "pattern "):
		return "pattern"
	case strings.Contains(text, " prefer ") || strings.Contains(text, " preference ") || strings.HasPrefix(text, "prefer "):
		return "preference"
	default:
		return ""
	}
}
