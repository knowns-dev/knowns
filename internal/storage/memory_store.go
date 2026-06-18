package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"gopkg.in/yaml.v3"
)

// MemoryStore reads and writes memory files from .knowns/memory/ (project),
// .knowns/.working-memory/ (working), and ~/.knowns/memory/ (global).
type MemoryStore struct {
	root       string // .knowns/ directory (project)
	globalRoot string // ~/.knowns/ directory
}

func (ms *MemoryStore) projectDir() string { return filepath.Join(ms.root, "memory") }
func (ms *MemoryStore) globalDir() string  { return filepath.Join(ms.globalRoot, "memory") }

// ListLocal returns project memories without global entries.
func (ms *MemoryStore) ListLocal() ([]*models.MemoryEntry, error) {
	return ms.listLayers([]string{models.MemoryLayerProject})
}

// ListGlobalOnly returns only global memories.
func (ms *MemoryStore) ListGlobalOnly() ([]*models.MemoryEntry, error) {
	return ms.listLayers([]string{models.MemoryLayerGlobal})
}

// dirForLayer returns the directory for a given memory layer.
func (ms *MemoryStore) dirForLayer(layer string) (string, error) {
	switch layer {
	case models.MemoryLayerProject:
		return ms.projectDir(), nil
	case models.MemoryLayerGlobal:
		return ms.globalDir(), nil
	default:
		return "", fmt.Errorf("invalid memory layer: %q", layer)
	}
}

// memoryFrontmatter mirrors the YAML frontmatter in every memory file.
type memoryFrontmatter struct {
	ID             string            `yaml:"id"`
	Title          string            `yaml:"title"`
	Layer          string            `yaml:"layer"`
	Category       string            `yaml:"category,omitempty"`
	Status         string            `yaml:"status,omitempty"`
	Confidence     string            `yaml:"confidence,omitempty"`
	LastVerified   string            `yaml:"lastVerified,omitempty"`
	TTLDays        int               `yaml:"ttlDays,omitempty"`
	Sources        []string          `yaml:"sources,omitempty"`
	MergedInto     string            `yaml:"mergedInto,omitempty"`
	RejectedReason string            `yaml:"rejectedReason,omitempty"`
	Tags           []string          `yaml:"tags,omitempty"`
	Metadata       map[string]string `yaml:"metadata,omitempty"`
	CreatedAt      string            `yaml:"createdAt"`
	UpdatedAt      string            `yaml:"updatedAt"`
}

// List returns memory entries, optionally filtered by layer.
// If layer is empty, returns entries from all layers.
func (ms *MemoryStore) List(layer string) ([]*models.MemoryEntry, error) {
	layers := []string{models.MemoryLayerProject, models.MemoryLayerGlobal}
	if layer != "" {
		if !models.ValidMemoryLayer(layer) {
			return nil, fmt.Errorf("invalid memory layer: %q", layer)
		}
		layers = []string{layer}
	}
	return ms.listLayers(layers)
}

// ListPersistent returns persistent memory entries, optionally filtered by layer.
func (ms *MemoryStore) ListPersistent(layer string) ([]*models.MemoryEntry, error) {
	layers := []string{models.MemoryLayerProject, models.MemoryLayerGlobal}
	if layer != "" {
		if !models.ValidPersistentMemoryLayer(layer) {
			return nil, fmt.Errorf("invalid persistent memory layer: %q", layer)
		}
		layers = []string{layer}
	}
	return ms.listLayers(layers)
}

func (ms *MemoryStore) listLayers(layers []string) ([]*models.MemoryEntry, error) {
	var entries []*models.MemoryEntry

	for _, l := range layers {
		dir, _ := ms.dirForLayer(l)
		found, err := ms.listDir(dir, l)
		if err != nil {
			continue // non-fatal
		}
		entries = append(entries, found...)
	}

	return entries, nil
}

// listDir reads all memory files from a directory.
func (ms *MemoryStore) listDir(dir, layer string) ([]*models.MemoryEntry, error) {
	dirEntries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("listDir %s: %w", dir, err)
	}

	var entries []*models.MemoryEntry
	for _, e := range dirEntries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		if !strings.HasPrefix(e.Name(), "memory-") {
			continue
		}
		absPath := filepath.Join(dir, e.Name())
		entry, err := ms.parseFile(absPath, layer)
		if err != nil {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// Get retrieves a memory entry by ID. Searches project, then global.
func (ms *MemoryStore) Get(id string) (*models.MemoryEntry, error) {
	for _, layer := range []string{models.MemoryLayerProject, models.MemoryLayerGlobal} {
		entry, err := ms.GetInLayer(id, layer)
		if err == nil {
			return entry, nil
		}
	}
	return nil, fmt.Errorf("memory %q not found", id)
}

// ResolveReferenceTarget resolves a semantic memory target.
//
// Semantic refs prefer the real memory ID, but also accept a title slug fallback
// so inline refs like @memory-security-pattern can resolve the entry created from
// the title "Security Pattern".
func (ms *MemoryStore) ResolveReferenceTarget(target string) (*models.MemoryEntry, error) {
	if entry, err := ms.Get(target); err == nil {
		return entry, nil
	}

	target = strings.TrimSpace(target)
	if target == "" {
		return nil, fmt.Errorf("memory %q not found", target)
	}

	var match *models.MemoryEntry
	for _, layer := range []string{models.MemoryLayerProject, models.MemoryLayerGlobal} {
		entries, err := ms.List(layer)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if slugifyMemoryReferenceTitle(entry.Title) != target {
				continue
			}
			if match != nil {
				return nil, fmt.Errorf("memory ref %q is ambiguous", target)
			}
			match = entry
		}
	}

	if match == nil {
		return nil, fmt.Errorf("memory %q not found", target)
	}

	return match, nil
}

func slugifyMemoryReferenceTitle(title string) string {
	title = strings.ToLower(title)
	var b strings.Builder
	prevHyphen := false
	for _, r := range title {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevHyphen = false
		} else if r == '-' || r == ' ' || r == '_' {
			if !prevHyphen {
				b.WriteRune('-')
				prevHyphen = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// GetInLayer retrieves a memory entry by ID from a specific layer only.
func (ms *MemoryStore) GetInLayer(id, layer string) (*models.MemoryEntry, error) {
	if !models.ValidMemoryLayer(layer) {
		return nil, fmt.Errorf("invalid memory layer: %q", layer)
	}
	dir, err := ms.dirForLayer(layer)
	if err != nil {
		return nil, err
	}
	absPath := filepath.Join(dir, models.MemoryFileName(id))
	if _, err := os.Stat(absPath); err != nil {
		return nil, fmt.Errorf("memory %q not found in %s layer", id, layer)
	}
	return ms.parseFile(absPath, layer)
}

// Create writes a new memory entry to the appropriate layer directory.
func (ms *MemoryStore) Create(entry *models.MemoryEntry) error {
	if entry.Layer == "" {
		entry.Layer = models.MemoryLayerProject
	}
	if !models.ValidMemoryLayer(entry.Layer) {
		return fmt.Errorf("invalid memory layer: %q", entry.Layer)
	}
	if entry.ID == "" {
		entry.ID = models.NewTaskID()
	}
	entry.ApplyLifecycleDefaults()

	now := time.Now().UTC()
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = now
	}
	if entry.UpdatedAt.IsZero() {
		entry.UpdatedAt = now
	}

	dir, err := ms.dirForLayer(entry.Layer)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create memory dir: %w", err)
	}

	absPath := filepath.Join(dir, models.MemoryFileName(entry.ID))
	return atomicWrite(absPath, []byte(renderMemory(entry)))
}

// Update overwrites an existing memory entry.
func (ms *MemoryStore) Update(entry *models.MemoryEntry) error {
	if entry.ID == "" {
		return fmt.Errorf("memory ID is required")
	}

	// Find the existing file to determine its current location.
	existing, err := ms.Get(entry.ID)
	if err != nil {
		return err
	}

	entry.UpdatedAt = time.Now().UTC()
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = existing.CreatedAt
	}
	entry.ApplyLifecycleDefaults()

	dir, err := ms.dirForLayer(existing.Layer)
	if err != nil {
		return err
	}

	absPath := filepath.Join(dir, models.MemoryFileName(entry.ID))
	return atomicWrite(absPath, []byte(renderMemory(entry)))
}

// Delete removes a memory entry by ID.
func (ms *MemoryStore) Delete(id string) error {
	filename := models.MemoryFileName(id)

	dirs := []string{ms.projectDir(), ms.globalDir()}
	for _, dir := range dirs {
		absPath := filepath.Join(dir, filename)
		if _, err := os.Stat(absPath); err == nil {
			return os.Remove(absPath)
		}
	}

	return fmt.Errorf("memory %q not found", id)
}

// Promote moves a memory entry up one layer (working→project→global).
func (ms *MemoryStore) Promote(id string) (*models.MemoryEntry, error) {
	entry, err := ms.Get(id)
	if err != nil {
		return nil, err
	}

	newLayer, ok := models.PromoteLayer(entry.Layer)
	if !ok {
		return nil, fmt.Errorf("cannot promote: already at top layer (%s)", entry.Layer)
	}

	return ms.moveLayer(entry, newLayer)
}

// Demote moves a memory entry down one layer (global→project→working).
func (ms *MemoryStore) Demote(id string) (*models.MemoryEntry, error) {
	entry, err := ms.Get(id)
	if err != nil {
		return nil, err
	}

	newLayer, ok := models.DemoteLayer(entry.Layer)
	if !ok {
		return nil, fmt.Errorf("cannot demote: already at bottom layer (%s)", entry.Layer)
	}

	return ms.moveLayer(entry, newLayer)
}

// PromotePersistent moves a persistent memory entry up one layer (project→global).
func (ms *MemoryStore) PromotePersistent(id string) (*models.MemoryEntry, error) {
	entry, err := ms.Get(id)
	if err != nil {
		return nil, err
	}
	if !models.ValidPersistentMemoryLayer(entry.Layer) {
		return nil, fmt.Errorf("cannot promote: memory %q is not persistent", id)
	}

	newLayer, ok := models.PromotePersistentMemoryLayer(entry.Layer)
	if !ok {
		return nil, fmt.Errorf("cannot promote: already at top persistent layer (%s)", entry.Layer)
	}

	return ms.moveLayer(entry, newLayer)
}

// DemotePersistent moves a persistent memory entry down one layer (global→project).
func (ms *MemoryStore) DemotePersistent(id string) (*models.MemoryEntry, error) {
	entry, err := ms.Get(id)
	if err != nil {
		return nil, err
	}
	if !models.ValidPersistentMemoryLayer(entry.Layer) {
		return nil, fmt.Errorf("cannot demote: memory %q is not persistent", id)
	}

	newLayer, ok := models.DemotePersistentMemoryLayer(entry.Layer)
	if !ok {
		return nil, fmt.Errorf("cannot demote: already at bottom persistent layer (%s)", entry.Layer)
	}

	return ms.moveLayer(entry, newLayer)
}

// moveLayer moves a memory entry from its current layer to a new layer.
func (ms *MemoryStore) moveLayer(entry *models.MemoryEntry, newLayer string) (*models.MemoryEntry, error) {
	oldDir, err := ms.dirForLayer(entry.Layer)
	if err != nil {
		return nil, err
	}
	newDir, err := ms.dirForLayer(newLayer)
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(newDir, 0755); err != nil {
		return nil, fmt.Errorf("create memory dir: %w", err)
	}

	filename := models.MemoryFileName(entry.ID)
	oldPath := filepath.Join(oldDir, filename)
	newPath := filepath.Join(newDir, filename)

	// Update layer and timestamp.
	entry.Layer = newLayer
	entry.UpdatedAt = time.Now().UTC()

	// Write to new location first, then remove old.
	if err := atomicWrite(newPath, []byte(renderMemory(entry))); err != nil {
		return nil, err
	}
	_ = os.Remove(oldPath)

	return entry, nil
}

// CountByLayer returns the number of entries in a given layer.
func (ms *MemoryStore) CountByLayer(layer string) (int, error) {
	dir, err := ms.dirForLayer(layer)
	if err != nil {
		return 0, err
	}
	dirEntries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	count := 0
	for _, e := range dirEntries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "memory-") && strings.HasSuffix(e.Name(), ".md") {
			count++
		}
	}
	return count, nil
}

// parseFile reads and parses a single memory markdown file.
func (ms *MemoryStore) parseFile(absPath, layer string) (*models.MemoryEntry, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("parseFile %s: %w", absPath, err)
	}
	return parseMemoryContent(string(data), layer)
}

// parseMemoryContent parses the content of a memory markdown file.
func parseMemoryContent(content, layer string) (*models.MemoryEntry, error) {
	yamlBlock, body := splitFrontmatter(content)

	entry := &models.MemoryEntry{
		Layer:   layer,
		Content: strings.TrimSpace(body),
	}

	if yamlBlock == "" {
		entry.LifecycleMetadataMissing = missingMemoryLifecycleFields(nil)
		entry.ApplyLifecycleDefaults()
		return entry, nil
	}

	var fm memoryFrontmatter
	if err := yaml.Unmarshal([]byte(yamlBlock), &fm); err != nil {
		return nil, fmt.Errorf("parse memory frontmatter: %w", err)
	}
	var raw map[string]any
	_ = yaml.Unmarshal([]byte(yamlBlock), &raw)

	entry.ID = fm.ID
	entry.Title = fm.Title
	entry.Category = fm.Category
	entry.Status = fm.Status
	entry.Confidence = fm.Confidence
	entry.LastVerified, _ = parseISO(fm.LastVerified)
	entry.TTLDays = fm.TTLDays
	entry.Sources = fm.Sources
	if entry.Sources == nil {
		entry.Sources = []string{}
	}
	entry.MergedInto = fm.MergedInto
	entry.RejectedReason = fm.RejectedReason
	entry.Tags = fm.Tags
	if entry.Tags == nil {
		entry.Tags = []string{}
	}
	entry.Metadata = fm.Metadata
	entry.CreatedAt, _ = parseISO(fm.CreatedAt)
	entry.UpdatedAt, _ = parseISO(fm.UpdatedAt)

	// Layer from frontmatter takes precedence if set.
	if fm.Layer != "" {
		entry.Layer = fm.Layer
	}
	entry.LifecycleMetadataMissing = missingMemoryLifecycleFields(raw)
	entry.ApplyLifecycleDefaults()

	return entry, nil
}

func missingMemoryLifecycleFields(raw map[string]any) []string {
	if raw == nil {
		return []string{"status", "confidence", "lastVerified", "ttlDays", "sources"}
	}
	var missing []string
	for _, field := range []string{"status", "confidence", "lastVerified", "ttlDays", "sources"} {
		if _, ok := raw[field]; !ok {
			missing = append(missing, field)
		}
	}
	return missing
}

// renderMemory produces the canonical markdown content for a memory file.
func renderMemory(entry *models.MemoryEntry) string {
	var b strings.Builder

	now := time.Now().UTC()
	createdAt := entry.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	updatedAt := entry.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = now
	}

	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", entry.ID)
	fmt.Fprintf(&b, "title: %s\n", yamlScalar(entry.Title))
	fmt.Fprintf(&b, "layer: %s\n", entry.Layer)

	if entry.Category != "" {
		fmt.Fprintf(&b, "category: %s\n", yamlScalar(entry.Category))
	}
	if entry.Status != "" {
		fmt.Fprintf(&b, "status: %s\n", yamlScalar(entry.Status))
	}
	if entry.Confidence != "" {
		fmt.Fprintf(&b, "confidence: %s\n", yamlScalar(entry.Confidence))
	}
	if !entry.LastVerified.IsZero() {
		fmt.Fprintf(&b, "lastVerified: '%s'\n", formatISO(entry.LastVerified))
	}
	if entry.TTLDays > 0 {
		fmt.Fprintf(&b, "ttlDays: %d\n", entry.TTLDays)
	}
	if len(entry.Sources) > 0 {
		b.WriteString("sources:\n")
		for _, source := range entry.Sources {
			fmt.Fprintf(&b, "  - %s\n", yamlScalar(source))
		}
	}
	if entry.MergedInto != "" {
		fmt.Fprintf(&b, "mergedInto: %s\n", yamlScalar(entry.MergedInto))
	}
	if entry.RejectedReason != "" {
		fmt.Fprintf(&b, "rejectedReason: %s\n", yamlScalar(entry.RejectedReason))
	}

	if len(entry.Tags) == 0 {
		b.WriteString("tags: []\n")
	} else {
		b.WriteString("tags:\n")
		for _, t := range entry.Tags {
			fmt.Fprintf(&b, "  - %s\n", t)
		}
	}

	if len(entry.Metadata) > 0 {
		b.WriteString("metadata:\n")
		for k, v := range entry.Metadata {
			fmt.Fprintf(&b, "  %s: %s\n", k, yamlScalar(v))
		}
	}

	fmt.Fprintf(&b, "createdAt: '%s'\n", formatISO(createdAt))
	fmt.Fprintf(&b, "updatedAt: '%s'\n", formatISO(updatedAt))
	b.WriteString("---\n")

	if entry.Content != "" {
		b.WriteString("\n")
		b.WriteString(entry.Content)
		if !strings.HasSuffix(entry.Content, "\n") {
			b.WriteString("\n")
		}
	}

	return b.String()
}
