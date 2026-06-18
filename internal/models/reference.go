package models

// SemanticReferenceRelationReferences is the default relation for plain refs.
const SemanticReferenceRelationReferences = "references"

// DocReferenceFragment captures an optional doc line/range/heading suffix.
type DocReferenceFragment struct {
	Raw        string `json:"raw,omitempty"`
	Line       int    `json:"line,omitempty"`
	RangeStart int    `json:"rangeStart,omitempty"`
	RangeEnd   int    `json:"rangeEnd,omitempty"`
	Heading    string `json:"heading,omitempty"`
}

// SemanticReference is a parsed inline Knowns reference.
type SemanticReference struct {
	Raw              string                `json:"raw"`
	Canonical        string                `json:"canonical"`
	Type             string                `json:"type"`
	Target           string                `json:"target"`
	Relation         string                `json:"relation"`
	ExplicitRelation bool                  `json:"explicitRelation,omitempty"`
	ValidRelation    bool                  `json:"validRelation"`
	Legacy           bool                  `json:"legacy,omitempty"`
	Fragment         *DocReferenceFragment `json:"fragment,omitempty"`
}

// ResolvedEntity is a normalized entity payload returned by semantic resolution.
type ResolvedEntity struct {
	Type        string   `json:"type"`
	ID          string   `json:"id"`
	Path        string   `json:"path,omitempty"`
	Title       string   `json:"title,omitempty"`
	Status      string   `json:"status,omitempty"`
	Priority    string   `json:"priority,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	MemoryLayer string   `json:"memoryLayer,omitempty"`
	Category    string   `json:"category,omitempty"`
	Imported    bool     `json:"imported,omitempty"`
	Source      string   `json:"source,omitempty"`
}

// SemanticResolution is a shared structured resolution result for refs.
type SemanticResolution struct {
	Reference SemanticReference `json:"reference"`
	Entity    *ResolvedEntity   `json:"entity,omitempty"`
	Found     bool              `json:"found"`
}
