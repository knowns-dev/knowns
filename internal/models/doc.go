package models

import "time"

// Doc represents a documentation file stored under .knowns/docs/.
// Metadata is kept in a YAML frontmatter block; body content is plain
// markdown.
type Doc struct {
	// ID is the stable identity of this document. Legacy documents may omit it
	// until their next canonical mutation; passive reads never backfill it.
	ID string `json:"id,omitempty" yaml:"id,omitempty"`

	// Path is the relative path inside .knowns/docs/ without the .md suffix
	// (e.g., "guides/setup").  When a filename is needed use Path + ".md".
	Path string `json:"path"`

	Title       string `json:"title"                 yaml:"title"`
	Description string `json:"description,omitempty" yaml:"description,omitempty"`

	// Content holds the markdown body. It is not persisted in the frontmatter.
	Content string `json:"content,omitempty" yaml:"-"`

	Tags  []string `json:"tags,omitempty"  yaml:"tags,omitempty"`
	Order *int     `json:"order,omitempty" yaml:"order,omitempty"`

	CreatedAt time.Time `json:"createdAt" yaml:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt" yaml:"updatedAt"`

	// Folder is the parent folder relative to the docs root (e.g., "guides").
	// Derived at load time; not stored in frontmatter.
	Folder string `json:"folder,omitempty" yaml:"-"`

	// IsImported indicates this doc comes from an imported package rather
	// than the local project.
	IsImported bool `json:"isImported,omitempty"`

	// ImportSource is the name of the package that owns this doc when
	// IsImported is true.
	ImportSource string `json:"importSource,omitempty"`

	// CanonicalHash is derived from the current canonical state and is never
	// written to frontmatter. It is exposed so callers can form a safe base.
	CanonicalHash string `json:"canonicalHash,omitempty" yaml:"-"`
}
