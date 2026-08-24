package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
	"github.com/howznguyen/knowns/internal/safepath"
	"gopkg.in/yaml.v3"
)

// DocStore reads and writes doc files from .knowns/docs/ (and .knowns/imports/).
type DocStore struct {
	root string
}

func (ds *DocStore) docsDir() string    { return filepath.Join(ds.root, "docs") }
func (ds *DocStore) importsDir() string { return filepath.Join(ds.root, "imports") }

// docFrontmatter mirrors the YAML frontmatter in every doc file.
type docFrontmatter struct {
	ID          string   `yaml:"id"`
	Title       string   `yaml:"title"`
	Description string   `yaml:"description"`
	CreatedAt   string   `yaml:"createdAt"`
	UpdatedAt   string   `yaml:"updatedAt"`
	Tags        []string `yaml:"tags"`
	Order       *int     `yaml:"order,omitempty"`
}

// List returns all docs from .knowns/docs/ and .knowns/imports/*/docs/.
func (ds *DocStore) List() ([]*models.Doc, error) {
	var docs []*models.Doc

	local, err := ds.walkDocs(ds.docsDir(), "", false, "")
	if err != nil {
		return nil, err
	}
	docs = append(docs, local...)

	imported, err := ds.listImported()
	if err != nil {
		// Non-fatal: return what we have so far.
		return docs, nil
	}
	docs = append(docs, imported...)
	if err := validateDocStableIDs(docs); err != nil {
		return nil, err
	}

	return docs, nil
}

func validateDocStableIDs(docs []*models.Doc) error {
	seen := make(map[string]string)
	for _, doc := range docs {
		if doc == nil || strings.TrimSpace(doc.ID) == "" {
			continue
		}
		if previous, ok := seen[doc.ID]; ok && previous != doc.Path {
			return fmt.Errorf("ambiguous Doc stable ID %q at paths %q and %q; repair duplicate frontmatter id before mutating", doc.ID, previous, doc.Path)
		}
		seen[doc.ID] = doc.Path
	}
	return nil
}

// ValidateStableID rejects a duplicate stable identity before a canonical
// write. Legacy documents without an ID are intentionally ignored.
func (ds *DocStore) ValidateStableID(id, path string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	docs, err := ds.List()
	if err != nil {
		return err
	}
	for _, doc := range docs {
		if doc != nil && doc.ID == id && normalizeDocPathForStore(doc.Path) != normalizeDocPathForStore(path) {
			return fmt.Errorf("ambiguous Doc stable ID %q at paths %q and %q; repair duplicate frontmatter id before mutating", id, doc.Path, path)
		}
	}
	return nil
}

func normalizeDocPathForStore(path string) string {
	return strings.Trim(strings.TrimSuffix(strings.TrimSpace(path), ".md"), "/")
}

// listImported scans .knowns/imports/*/docs/ for additional docs.
func (ds *DocStore) listImported() ([]*models.Doc, error) {
	entries, err := os.ReadDir(ds.importsDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var docs []*models.Doc
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		importSource := e.Name()
		importDocsDir := filepath.Join(ds.importsDir(), importSource, "docs")
		imported, err := ds.walkDocs(importDocsDir, "", true, importSource)
		if err != nil {
			continue
		}
		docs = append(docs, imported...)
	}
	return docs, nil
}

// walkDocs recursively collects docs from a directory.
func (ds *DocStore) walkDocs(dir, relBase string, imported bool, importSource string) ([]*models.Doc, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("walkDocs %s: %w", dir, err)
	}
	var docs []*models.Doc
	for _, e := range entries {
		fullPath := filepath.Join(dir, e.Name())
		if e.IsDir() {
			subBase := e.Name()
			if relBase != "" {
				subBase = relBase + "/" + e.Name()
			}
			sub, err := ds.walkDocs(fullPath, subBase, imported, importSource)
			if err != nil {
				continue
			}
			docs = append(docs, sub...)
			continue
		}
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		baseName := strings.TrimSuffix(e.Name(), ".md")
		var relPath string
		if relBase == "" {
			relPath = baseName
		} else {
			relPath = relBase + "/" + baseName
		}
		folder := relBase
		doc, err := ds.parseFile(fullPath, relPath, folder, imported, importSource)
		if err != nil {
			continue
		}
		docs = append(docs, doc)
	}
	return docs, nil
}

// Get retrieves a doc by its relative path (without .md extension).
// Examples: "readme", "patterns/module", "specs/user-auth"
func (ds *DocStore) Get(path string) (*models.Doc, error) {
	path, absPath, err := resolveDocPath(ds.docsDir(), path)
	if err != nil {
		return nil, err
	}

	// Try local docs first.
	if _, err := os.Stat(absPath); err == nil {
		folder := filepath.ToSlash(filepath.Dir(filepath.FromSlash(path)))
		if folder == "." {
			folder = ""
		}
		return ds.parseFile(absPath, path, folder, false, "")
	}

	// Try imported docs: files are nested as .knowns/imports/{name}/docs/{name}/...
	entries, _ := os.ReadDir(ds.importsDir())
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		importSource := e.Name()
		// Direct lookup: path already includes the source prefix.
		importDocsDir := filepath.Join(ds.importsDir(), importSource, "docs")
		candidate, err := safepath.Resolve(importDocsDir, path+".md")
		if err != nil {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			folder := filepath.ToSlash(filepath.Dir(filepath.FromSlash(path)))
			if folder == "." {
				folder = ""
			}
			return ds.parseFile(candidate, path, folder, true, importSource)
		}
		// Fallback: mentions inside imported docs use short paths without the
		// source prefix (e.g. @doc/patterns/foo instead of @doc/source/patterns/foo).
		// Try prepending the import source name.
		prefixed := importSource + "/" + path
		candidate, err = safepath.Resolve(importDocsDir, prefixed+".md")
		if err != nil {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			folder := filepath.ToSlash(filepath.Dir(filepath.FromSlash(prefixed)))
			if folder == "." {
				folder = ""
			}
			return ds.parseFile(candidate, prefixed, folder, true, importSource)
		}
	}

	return nil, fmt.Errorf("doc %q not found", path)
}

// Create writes a new doc to .knowns/docs/{path}.md.
// doc.Path must be set (relative, without .md).
func (ds *DocStore) Create(doc *models.Doc) error {
	if doc == nil || doc.Path == "" {
		return fmt.Errorf("doc path is required")
	}
	path, absPath, err := resolveDocPath(ds.docsDir(), doc.Path)
	if err != nil {
		return err
	}
	doc.Path = path
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		return fmt.Errorf("create doc dir: %w", err)
	}
	return ds.writeFile(absPath, doc)
}

// Update writes updated doc content.
func (ds *DocStore) Update(doc *models.Doc) error {
	if doc == nil || doc.Path == "" {
		return fmt.Errorf("doc path is required")
	}
	path, absPath, err := resolveDocPath(ds.docsDir(), doc.Path)
	if err != nil {
		return err
	}
	doc.Path = path
	if existing, err := ds.Get(path); err == nil {
		applyLockedDecisionReviewGate(existing, doc)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		return err
	}
	return ds.writeFile(absPath, doc)
}

// Rename rewrites a doc to a new path and removes the old file.
func (ds *DocStore) Rename(oldPath string, doc *models.Doc) error {
	if strings.TrimSpace(oldPath) == "" || doc == nil || strings.TrimSpace(doc.Path) == "" {
		return fmt.Errorf("old path and new doc path are required")
	}
	oldPath, oldAbsPath, err := resolveDocPath(ds.docsDir(), oldPath)
	if err != nil {
		return err
	}
	newPath, newAbsPath, err := resolveDocPath(ds.docsDir(), doc.Path)
	if err != nil {
		return err
	}
	doc.Path = newPath
	if existing, err := ds.Get(oldPath); err == nil {
		applyLockedDecisionReviewGate(existing, doc)
	}
	if err := os.MkdirAll(filepath.Dir(newAbsPath), 0755); err != nil {
		return err
	}
	if err := ds.writeFile(newAbsPath, doc); err != nil {
		return err
	}
	if oldAbsPath != newAbsPath {
		if err := os.Remove(oldAbsPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// writeExact and renameExact are rollback-only primitives. Unlike public
// writes they do not backfill a legacy Doc ID, so failed multi-entity
// mutations restore the original canonical bytes exactly.
func (ds *DocStore) writeExact(doc *models.Doc) error {
	if doc == nil || strings.TrimSpace(doc.Path) == "" {
		return fmt.Errorf("doc path is required")
	}
	path, absPath, err := resolveDocPath(ds.docsDir(), doc.Path)
	if err != nil {
		return err
	}
	doc.Path = path
	return atomicWrite(absPath, []byte(renderDoc(doc)))
}

func (ds *DocStore) renameExact(oldPath string, doc *models.Doc) error {
	if doc == nil || strings.TrimSpace(oldPath) == "" {
		return fmt.Errorf("old path and new doc are required")
	}
	oldCanonical, oldAbsPath, err := resolveDocPath(ds.docsDir(), oldPath)
	if err != nil {
		return err
	}
	newCanonical, newAbsPath, err := resolveDocPath(ds.docsDir(), doc.Path)
	if err != nil {
		return err
	}
	doc.Path = newCanonical
	if err := os.MkdirAll(filepath.Dir(newAbsPath), 0755); err != nil {
		return err
	}
	if err := atomicWrite(newAbsPath, []byte(renderDoc(doc))); err != nil {
		return err
	}
	if oldCanonical != newCanonical {
		if err := os.Remove(oldAbsPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func (ds *DocStore) writeRaw(path string, data []byte) error {
	_, absPath, err := resolveDocPath(ds.docsDir(), path)
	if err != nil {
		return err
	}
	return atomicWrite(absPath, data)
}

func (ds *DocStore) renameRaw(oldPath, newPath string, data []byte) error {
	_, oldAbsPath, err := resolveDocPath(ds.docsDir(), oldPath)
	if err != nil {
		return err
	}
	_, newAbsPath, err := resolveDocPath(ds.docsDir(), newPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(newAbsPath), 0755); err != nil {
		return err
	}
	if err := atomicWrite(newAbsPath, data); err != nil {
		return err
	}
	if oldAbsPath != newAbsPath {
		if err := os.Remove(oldAbsPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func applyLockedDecisionReviewGate(existing, updated *models.Doc) {
	if existing == nil || updated == nil || !docHasTag(existing.Tags, "approved") {
		return
	}
	before, beforeOK := findMarkdownSection(existing.Content, "Locked Decisions")
	after, afterOK := findMarkdownSection(updated.Content, "Locked Decisions")
	if beforeOK == afterOK && (!beforeOK || strings.TrimSpace(before.Text) == strings.TrimSpace(after.Text)) {
		return
	}
	updated.Tags = removeDocTag(updated.Tags, "approved")
	updated.Tags = appendDocTag(updated.Tags, "draft")
	updated.Tags = appendDocTag(updated.Tags, "review-required")
}

func docHasTag(tags []string, target string) bool {
	for _, tag := range tags {
		if strings.EqualFold(strings.TrimSpace(tag), target) {
			return true
		}
	}
	return false
}

func removeDocTag(tags []string, target string) []string {
	filtered := make([]string, 0, len(tags))
	for _, tag := range tags {
		if strings.EqualFold(strings.TrimSpace(tag), target) {
			continue
		}
		filtered = append(filtered, tag)
	}
	return filtered
}

func appendDocTag(tags []string, tag string) []string {
	if docHasTag(tags, tag) {
		return tags
	}
	return append(tags, tag)
}

// RewriteDocReferences rewrites @doc refs across local docs, tasks, and memories.
func (ds *DocStore) RewriteDocReferences(oldPath, newPath string, taskStore *TaskStore, memoryStore *MemoryStore) error {
	docs, err := ds.List()
	if err != nil {
		return err
	}
	for _, doc := range docs {
		if doc.IsImported || doc.Path == newPath {
			continue
		}
		fullDoc, err := ds.Get(doc.Path)
		if err != nil {
			continue
		}
		rewritten := references.RewriteDocPath(fullDoc.Content, oldPath, newPath)
		if rewritten == fullDoc.Content {
			continue
		}
		fullDoc.Content = rewritten
		fullDoc.UpdatedAt = time.Now().UTC()
		if err := ds.Update(fullDoc); err != nil {
			return err
		}
	}
	if taskStore != nil {
		tasks, err := taskStore.ListAll()
		if err != nil {
			return err
		}
		for _, task := range tasks {
			updated := false
			// Rewrite the spec field if it matches the old doc path.
			if task.Spec == oldPath {
				task.Spec = newPath
				updated = true
			}
			description := references.RewriteDocPath(task.Description, oldPath, newPath)
			if description != task.Description {
				task.Description = description
				updated = true
			}
			plan := references.RewriteDocPath(task.ImplementationPlan, oldPath, newPath)
			if plan != task.ImplementationPlan {
				task.ImplementationPlan = plan
				updated = true
			}
			notes := references.RewriteDocPath(task.ImplementationNotes, oldPath, newPath)
			if notes != task.ImplementationNotes {
				task.ImplementationNotes = notes
				updated = true
			}
			if updated {
				task.UpdatedAt = time.Now().UTC()
				if err := taskStore.Update(task); err != nil {
					return err
				}
			}
		}
	}
	if memoryStore != nil {
		memories, err := memoryStore.List("")
		if err != nil {
			return err
		}
		for _, memory := range memories {
			rewritten := references.RewriteDocPath(memory.Content, oldPath, newPath)
			if rewritten == memory.Content {
				continue
			}
			memory.Content = rewritten
			memory.UpdatedAt = time.Now().UTC()
			if err := memoryStore.Update(memory); err != nil {
				return err
			}
		}
	}
	return nil
}

// Delete removes a doc file.
func (ds *DocStore) Delete(path string) error {
	_, absPath, err := resolveDocPath(ds.docsDir(), path)
	if err != nil {
		return err
	}
	return os.Remove(absPath)
}

func resolveDocPath(root, path string) (string, string, error) {
	path = strings.TrimSuffix(path, ".md")
	if strings.TrimSpace(path) == "" {
		return "", "", fmt.Errorf("doc path is required")
	}
	absPath, err := safepath.Resolve(root, filepath.ToSlash(path)+".md")
	if err != nil {
		return "", "", fmt.Errorf("invalid doc path %q: %w", path, err)
	}
	rel, err := filepath.Rel(root, absPath)
	if err != nil {
		return "", "", fmt.Errorf("resolve doc path: %w", err)
	}
	canonical := strings.TrimSuffix(filepath.ToSlash(rel), ".md")
	return canonical, absPath, nil
}

// parseFile reads and parses a single doc markdown file.
func (ds *DocStore) parseFile(absPath, relPath, folder string, imported bool, importSource string) (*models.Doc, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("parseFile %s: %w", absPath, err)
	}
	doc, err := parseDocContent(string(data), relPath, folder, imported, importSource)
	if err != nil {
		return nil, err
	}
	doc.CanonicalHash = CanonicalDocHash(doc)
	return doc, nil
}

// parseDocContent parses the content of a doc markdown file.
func parseDocContent(content, relPath, folder string, imported bool, importSource string) (*models.Doc, error) {
	yamlBlock, body := splitFrontmatter(content)

	doc := &models.Doc{
		Path:         relPath,
		Folder:       folder,
		IsImported:   imported,
		ImportSource: importSource,
		Content:      strings.TrimSpace(body),
	}

	if yamlBlock == "" {
		// No frontmatter: derive title from the path basename.
		doc.Title = filepath.Base(relPath)
		doc.Tags = []string{}
		return doc, nil
	}

	var fm docFrontmatter
	if err := yaml.Unmarshal([]byte(yamlBlock), &fm); err != nil {
		return nil, fmt.Errorf("parse doc frontmatter: %w", err)
	}

	doc.Title = fm.Title
	doc.ID = strings.TrimSpace(fm.ID)
	doc.Description = fm.Description
	doc.Tags = fm.Tags
	if doc.Tags == nil {
		doc.Tags = []string{}
	}
	doc.Order = fm.Order
	doc.CreatedAt, _ = parseISO(fm.CreatedAt)
	doc.UpdatedAt, _ = parseISO(fm.UpdatedAt)

	return doc, nil
}

// canonicalDocContent is the only body form the markdown round-trip preserves:
// renderDoc frames the body with newlines and parseDocContent trims it back, so
// surrounding whitespace never survives a read. Normalising before the write
// keeps the in-memory doc, the file bytes, and the history hash identical.
func canonicalDocContent(content string) string { return strings.TrimSpace(content) }

// writeFile serialises a doc to the canonical markdown format.
func (ds *DocStore) writeFile(path string, doc *models.Doc) error {
	if doc != nil {
		if strings.TrimSpace(doc.ID) == "" {
			doc.ID = newDocID()
		}
		doc.Content = canonicalDocContent(doc.Content)
	}
	return atomicWrite(path, []byte(renderDoc(doc)))
}

// renderDoc produces the canonical markdown content for a doc file.
func renderDoc(doc *models.Doc) string {
	var b strings.Builder

	now := time.Now().UTC()
	createdAt := doc.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	updatedAt := doc.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = now
	}

	b.WriteString("---\n")
	if strings.TrimSpace(doc.ID) != "" {
		fmt.Fprintf(&b, "id: %s\n", yamlScalar(doc.ID))
	}
	fmt.Fprintf(&b, "title: %s\n", yamlScalar(doc.Title))
	fmt.Fprintf(&b, "description: %s\n", yamlScalar(doc.Description))
	fmt.Fprintf(&b, "createdAt: '%s'\n", formatISO(createdAt))
	fmt.Fprintf(&b, "updatedAt: '%s'\n", formatISO(updatedAt))

	if len(doc.Tags) == 0 {
		b.WriteString("tags: []\n")
	} else {
		b.WriteString("tags:\n")
		for _, t := range doc.Tags {
			fmt.Fprintf(&b, "  - %s\n", t)
		}
	}

	if doc.Order != nil {
		fmt.Fprintf(&b, "order: %d\n", *doc.Order)
	}

	b.WriteString("---\n")

	if doc.Content != "" {
		b.WriteString("\n")
		b.WriteString(doc.Content)
		if !strings.HasSuffix(doc.Content, "\n") {
			b.WriteString("\n")
		}
	}

	return b.String()
}
