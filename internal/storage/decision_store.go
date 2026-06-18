package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"gopkg.in/yaml.v3"
)

// DecisionStore reads and writes decision files from .knowns/decisions/.
type DecisionStore struct {
	root string
}

func (ds *DecisionStore) decisionsDir() string { return filepath.Join(ds.root, "decisions") }

type decisionFrontmatter struct {
	ID           string   `yaml:"id"`
	Title        string   `yaml:"title"`
	Status       string   `yaml:"status"`
	Supersedes   []string `yaml:"supersedes,omitempty"`
	SupersededBy []string `yaml:"supersededBy,omitempty"`
	Tags         []string `yaml:"tags,omitempty"`
	Sources      []string `yaml:"sources,omitempty"`
	RelatedDocs  []string `yaml:"relatedDocs,omitempty"`
	RelatedTasks []string `yaml:"relatedTasks,omitempty"`
	CreatedAt    string   `yaml:"createdAt"`
	UpdatedAt    string   `yaml:"updatedAt"`
}

type DecisionCreateOptions struct {
	Now time.Time
}

// List returns all decisions.
func (ds *DecisionStore) List() ([]*models.DecisionEntry, error) {
	entries, err := os.ReadDir(ds.decisionsDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list decisions: %w", err)
	}

	var decisions []*models.DecisionEntry
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		decision, err := ds.parseFile(filepath.Join(ds.decisionsDir(), entry.Name()))
		if err != nil {
			continue
		}
		decisions = append(decisions, decision)
	}
	sort.Slice(decisions, func(i, j int) bool {
		if decisions[i].CreatedAt.Equal(decisions[j].CreatedAt) {
			return decisions[i].ID < decisions[j].ID
		}
		return decisions[i].CreatedAt.After(decisions[j].CreatedAt)
	})
	return decisions, nil
}

// Get retrieves a decision by ID.
func (ds *DecisionStore) Get(id string) (*models.DecisionEntry, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("decision ID is required")
	}
	if !models.ValidDecisionID(id) {
		return nil, fmt.Errorf("invalid decision ID: %q", id)
	}
	absPath := filepath.Join(ds.decisionsDir(), models.DecisionFileName(id))
	if _, err := os.Stat(absPath); err != nil {
		return nil, fmt.Errorf("decision %q not found", id)
	}
	return ds.parseFile(absPath)
}

// Create writes a new decision.
func (ds *DecisionStore) Create(decision *models.DecisionEntry, opts DecisionCreateOptions) error {
	if decision == nil {
		return fmt.Errorf("decision is required")
	}
	if strings.TrimSpace(decision.Title) == "" {
		return fmt.Errorf("decision title is required")
	}

	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	idTime := decision.CreatedAt
	if idTime.IsZero() {
		idTime = now
	}
	persistedNow := now.UTC()
	if decision.CreatedAt.IsZero() {
		decision.CreatedAt = persistedNow
	}
	if decision.UpdatedAt.IsZero() {
		decision.UpdatedAt = persistedNow
	}
	decision.ApplyDecisionDefaults()
	if !models.ValidDecisionStatus(decision.Status) {
		return fmt.Errorf("invalid decision status: %q", decision.Status)
	}
	if decision.ID == "" {
		decision.ID = models.NewDecisionID(decision.Title, idTime, func(id string) bool {
			_, err := os.Stat(filepath.Join(ds.decisionsDir(), models.DecisionFileName(id)))
			return err == nil
		})
	}
	if !models.ValidDecisionID(decision.ID) {
		return fmt.Errorf("invalid decision ID: %q", decision.ID)
	}
	absPath := filepath.Join(ds.decisionsDir(), models.DecisionFileName(decision.ID))
	if _, err := os.Stat(absPath); err == nil {
		return fmt.Errorf("decision %q already exists", decision.ID)
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("check decision %q: %w", decision.ID, err)
	}

	if err := os.MkdirAll(ds.decisionsDir(), 0o755); err != nil {
		return fmt.Errorf("create decisions dir: %w", err)
	}
	return atomicWrite(absPath, []byte(renderDecision(decision)))
}

// Update overwrites an existing decision in place.
func (ds *DecisionStore) Update(decision *models.DecisionEntry) error {
	if decision == nil || strings.TrimSpace(decision.ID) == "" {
		return fmt.Errorf("decision ID is required")
	}
	if !models.ValidDecisionID(decision.ID) {
		return fmt.Errorf("invalid decision ID: %q", decision.ID)
	}
	existing, err := ds.Get(decision.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(decision.Title) == "" {
		return fmt.Errorf("decision title is required")
	}
	if decision.CreatedAt.IsZero() {
		decision.CreatedAt = existing.CreatedAt
	}
	decision.UpdatedAt = time.Now().UTC()
	if decision.Status == "" {
		decision.Status = existing.Status
	}
	if !models.ValidDecisionStatus(decision.Status) {
		return fmt.Errorf("invalid decision status: %q", decision.Status)
	}
	return atomicWrite(filepath.Join(ds.decisionsDir(), models.DecisionFileName(decision.ID)), []byte(renderDecision(decision)))
}

// Link appends related references to a decision.
func (ds *DecisionStore) Link(id string, docs, tasks, sources []string) (*models.DecisionEntry, error) {
	decision, err := ds.Get(id)
	if err != nil {
		return nil, err
	}
	decision.RelatedDocs = appendUniqueStrings(decision.RelatedDocs, docs...)
	decision.RelatedTasks = appendUniqueStrings(decision.RelatedTasks, tasks...)
	decision.Sources = appendUniqueStrings(decision.Sources, sources...)
	if decision.Status == models.DecisionStatusDraft && (len(decision.Sources) > 0 || len(decision.RelatedDocs) > 0 || len(decision.RelatedTasks) > 0) {
		decision.Status = models.DecisionStatusAccepted
	}
	if err := ds.Update(decision); err != nil {
		return nil, err
	}
	return ds.Get(id)
}

// Supersede updates both sides of a decision supersession relationship.
func (ds *DecisionStore) Supersede(oldID, newID string) (*models.DecisionEntry, *models.DecisionEntry, error) {
	if oldID == "" || newID == "" {
		return nil, nil, fmt.Errorf("old and new decision IDs are required")
	}
	if oldID == newID {
		return nil, nil, fmt.Errorf("a decision cannot supersede itself")
	}
	oldDecision, err := ds.Get(oldID)
	if err != nil {
		return nil, nil, err
	}
	newDecision, err := ds.Get(newID)
	if err != nil {
		return nil, nil, err
	}

	oldDecision.Status = models.DecisionStatusSuperseded
	oldDecision.SupersededBy = appendUniqueStrings(oldDecision.SupersededBy, newID)
	newDecision.Supersedes = appendUniqueStrings(newDecision.Supersedes, oldID)
	if newDecision.Status == models.DecisionStatusDraft {
		newDecision.Status = models.DecisionStatusAccepted
	}

	now := time.Now().UTC()
	oldDecision.UpdatedAt = now
	newDecision.UpdatedAt = now

	if err := ds.updateWithTimestamp(oldDecision, now); err != nil {
		return nil, nil, err
	}
	if err := ds.updateWithTimestamp(newDecision, now); err != nil {
		return nil, nil, err
	}
	updatedOld, err := ds.Get(oldID)
	if err != nil {
		return nil, nil, err
	}
	updatedNew, err := ds.Get(newID)
	if err != nil {
		return nil, nil, err
	}
	return updatedOld, updatedNew, nil
}

func (ds *DecisionStore) updateWithTimestamp(decision *models.DecisionEntry, updatedAt time.Time) error {
	if !models.ValidDecisionStatus(decision.Status) {
		return fmt.Errorf("invalid decision status: %q", decision.Status)
	}
	decision.UpdatedAt = updatedAt.UTC()
	return atomicWrite(filepath.Join(ds.decisionsDir(), models.DecisionFileName(decision.ID)), []byte(renderDecision(decision)))
}

func (ds *DecisionStore) parseFile(absPath string) (*models.DecisionEntry, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("parse decision %s: %w", absPath, err)
	}
	return parseDecisionContent(string(data))
}

func parseDecisionContent(content string) (*models.DecisionEntry, error) {
	yamlBlock, body := splitFrontmatter(content)
	if yamlBlock == "" {
		return nil, fmt.Errorf("missing decision frontmatter")
	}
	var fm decisionFrontmatter
	if err := yaml.Unmarshal([]byte(yamlBlock), &fm); err != nil {
		return nil, fmt.Errorf("parse decision frontmatter: %w", err)
	}
	decision := &models.DecisionEntry{
		ID:           fm.ID,
		Title:        fm.Title,
		Status:       fm.Status,
		Supersedes:   normalizeStringSlice(fm.Supersedes),
		SupersededBy: normalizeStringSlice(fm.SupersededBy),
		Tags:         normalizeStringSlice(fm.Tags),
		Sources:      normalizeStringSlice(fm.Sources),
		RelatedDocs:  normalizeStringSlice(fm.RelatedDocs),
		RelatedTasks: normalizeStringSlice(fm.RelatedTasks),
		Content:      strings.TrimSpace(body),
	}
	decision.CreatedAt, _ = parseISO(fm.CreatedAt)
	decision.UpdatedAt, _ = parseISO(fm.UpdatedAt)
	applyDecisionSections(decision)
	return decision, nil
}

func applyDecisionSections(decision *models.DecisionEntry) {
	for _, section := range markdownSections(decision.Content) {
		switch strings.ToLower(section.title) {
		case "context":
			decision.Context = section.content
		case "decision":
			decision.Decision = section.content
		case "alternatives considered":
			decision.AlternativesConsidered = section.content
		case "consequences":
			decision.Consequences = section.content
		}
	}
}

type markdownSection struct {
	title   string
	content string
}

func markdownSections(body string) []markdownSection {
	lines := strings.Split(body, "\n")
	var sections []markdownSection
	var current *markdownSection
	var content []string
	flush := func() {
		if current == nil {
			return
		}
		current.content = strings.TrimSpace(strings.Join(content, "\n"))
		sections = append(sections, *current)
		content = nil
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			flush()
			current = &markdownSection{title: strings.TrimSpace(strings.TrimPrefix(trimmed, "## "))}
			continue
		}
		if current != nil {
			content = append(content, line)
		}
	}
	flush()
	return sections
}

func renderDecision(decision *models.DecisionEntry) string {
	var b strings.Builder
	now := time.Now().UTC()
	createdAt := decision.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	updatedAt := decision.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = now
	}

	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", yamlScalar(decision.ID))
	fmt.Fprintf(&b, "title: %s\n", yamlScalar(decision.Title))
	fmt.Fprintf(&b, "status: %s\n", yamlScalar(decision.Status))
	writeYAMLStringList(&b, "supersedes", decision.Supersedes)
	writeYAMLStringList(&b, "supersededBy", decision.SupersededBy)
	writeYAMLStringList(&b, "tags", decision.Tags)
	writeYAMLStringList(&b, "sources", decision.Sources)
	writeYAMLStringList(&b, "relatedDocs", decision.RelatedDocs)
	writeYAMLStringList(&b, "relatedTasks", decision.RelatedTasks)
	fmt.Fprintf(&b, "createdAt: '%s'\n", formatISO(createdAt))
	fmt.Fprintf(&b, "updatedAt: '%s'\n", formatISO(updatedAt))
	b.WriteString("---\n\n")
	b.WriteString(renderDecisionBody(decision))
	if !strings.HasSuffix(b.String(), "\n") {
		b.WriteString("\n")
	}
	return b.String()
}

func renderDecisionBody(decision *models.DecisionEntry) string {
	content := strings.TrimSpace(decision.Content)
	if content != "" {
		return content + "\n"
	}
	var b strings.Builder
	writeDecisionSection(&b, "Context", decision.Context)
	writeDecisionSection(&b, "Decision", decision.Decision)
	writeDecisionSection(&b, "Alternatives Considered", decision.AlternativesConsidered)
	writeDecisionSection(&b, "Consequences", decision.Consequences)
	return strings.TrimRight(b.String(), "\n") + "\n"
}

func writeDecisionSection(b *strings.Builder, title, content string) {
	if b.Len() > 0 {
		b.WriteString("\n")
	}
	fmt.Fprintf(b, "## %s\n\n", title)
	if strings.TrimSpace(content) != "" {
		b.WriteString(strings.TrimSpace(content))
		b.WriteString("\n")
	}
}

func writeYAMLStringList(b *strings.Builder, key string, values []string) {
	if len(values) == 0 {
		fmt.Fprintf(b, "%s: []\n", key)
		return
	}
	fmt.Fprintf(b, "%s:\n", key)
	for _, value := range values {
		fmt.Fprintf(b, "  - %s\n", yamlScalar(value))
	}
}

func appendUniqueStrings(existing []string, values ...string) []string {
	seen := make(map[string]bool, len(existing)+len(values))
	result := make([]string, 0, len(existing)+len(values))
	for _, value := range existing {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}
