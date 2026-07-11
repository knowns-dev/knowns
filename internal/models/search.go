package models

import "time"

// SearchResult is a single hit returned by the search engine across tasks,
// docs, memories, decisions, and code.
type SearchResult struct {
	// Type is one of "task", "doc", "memory", "decision", or "code".
	Type string `json:"type"`

	// ID is the source identifier for the result type.
	ID string `json:"id"`

	Title string `json:"title"`

	// Score is the relevance score (higher = more relevant).
	Score float64 `json:"score"`

	// Snippet is an optional excerpt of matching text.
	Snippet string `json:"snippet,omitempty"`

	// MatchedBy indicates which methods found this result.
	// Possible values: "keyword", "semantic".
	MatchedBy []string `json:"matchedBy,omitempty"`

	// Task-specific fields (populated when Type == "task").
	Status   string `json:"status,omitempty"`
	Priority string `json:"priority,omitempty"`

	// Doc-specific fields (populated when Type == "doc").
	Path string   `json:"path,omitempty"`
	Tags []string `json:"tags,omitempty"`

	// Memory-specific fields (populated when Type == "memory").
	MemoryLayer string `json:"memoryLayer,omitempty"`
	Category    string `json:"category,omitempty"`
	MemoryStore string `json:"memoryStore,omitempty"`

	// Code-specific fields (populated when Type == "code").
	Name      string `json:"name,omitempty"`      // symbol name e.g. "getGraph"
	Signature string `json:"signature,omitempty"` // function signature e.g. "getGraph(includeCode bool)"

	// Runtime is optional additive metadata for degraded runtime-backed results.
	Runtime *RuntimeWarning `json:"_runtime,omitempty"`
}

// RuntimeWarning describes degraded runtime behavior without changing response shape.
type RuntimeWarning struct {
	Degraded bool   `json:"degraded,omitempty"`
	Mode     string `json:"mode,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Message  string `json:"message,omitempty"`
}

// RetrievalOptions configures mixed-source retrieval and context assembly.
type RetrievalOptions struct {
	Query             string   `json:"query"`
	Mode              string   `json:"mode,omitempty"`
	Limit             int      `json:"limit,omitempty"`
	SourceTypes       []string `json:"sourceTypes,omitempty"`
	ExpandReferences  bool     `json:"expandReferences,omitempty"`
	Tag               string   `json:"tag,omitempty"`
	Status            string   `json:"status,omitempty"`
	Priority          string   `json:"priority,omitempty"`
	Assignee          string   `json:"assignee,omitempty"`
	Label             string   `json:"label,omitempty"`
	IncludeHistorical bool     `json:"includeHistorical,omitempty"`
}

// RetrievalResponse contains both ranked results and a context pack.
type RetrievalResponse struct {
	Query       string               `json:"query"`
	Mode        string               `json:"mode"`
	Candidates  []RetrievalCandidate `json:"candidates"`
	ContextPack ContextPack          `json:"contextPack"`
}

// RetrievalCandidate is a ranked source-level retrieval hit.
type RetrievalCandidate struct {
	Type             string       `json:"type"`
	ID               string       `json:"id"`
	Title            string       `json:"title"`
	Path             string       `json:"path,omitempty"`
	Score            float64      `json:"score"`
	MatchedBy        []string     `json:"matchedBy,omitempty"`
	Snippet          string       `json:"snippet,omitempty"`
	Citation         Citation     `json:"citation"`
	DirectMatch      bool         `json:"directMatch"`
	ExpandedFrom     []string     `json:"expandedFrom,omitempty"`
	Status           string       `json:"status,omitempty"`
	Priority         string       `json:"priority,omitempty"`
	Tags             []string     `json:"tags,omitempty"`
	MemoryLayer      string       `json:"memoryLayer,omitempty"`
	Category         string       `json:"category,omitempty"`
	MemoryStore      string       `json:"memoryStore,omitempty"`
	SourcePreference int          `json:"sourcePreference"`
	UpdatedAt        *time.Time   `json:"updatedAt,omitempty"`
	Metadata         SourceRecord `json:"metadata"`
}

// ContextPack is the assembled retrieval payload for AI consumers.
type ContextPack struct {
	Items []ContextItem `json:"items"`
	Mode  string        `json:"mode"`
}

// ContextItem is a source-backed item included in the assembled context pack.
type ContextItem struct {
	Type         string       `json:"type"`
	ID           string       `json:"id"`
	Title        string       `json:"title"`
	Content      string       `json:"content"`
	Snippet      string       `json:"snippet,omitempty"`
	DirectMatch  bool         `json:"directMatch"`
	ExpandedFrom []string     `json:"expandedFrom,omitempty"`
	Citation     Citation     `json:"citation"`
	Metadata     SourceRecord `json:"metadata"`
}

// Citation points back to the originating source.
type Citation struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Path    string `json:"path,omitempty"`
	Section string `json:"section,omitempty"`
}

// SourceRecord preserves source metadata for consumer inspection.
type SourceRecord struct {
	Type        string     `json:"type"`
	ID          string     `json:"id"`
	Path        string     `json:"path,omitempty"`
	Tags        []string   `json:"tags,omitempty"`
	Status      string     `json:"status,omitempty"`
	Priority    string     `json:"priority,omitempty"`
	MemoryLayer string     `json:"memoryLayer,omitempty"`
	Category    string     `json:"category,omitempty"`
	MemoryStore string     `json:"memoryStore,omitempty"`
	UpdatedAt   *time.Time `json:"updatedAt,omitempty"`
	Imported    bool       `json:"imported,omitempty"`
	Source      string     `json:"source,omitempty"`
}
