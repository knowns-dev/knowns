package search

// SearchMode determines how results are found.
type SearchMode string

const (
	ModeKeyword  SearchMode = "keyword"
	ModeSemantic SearchMode = "semantic"
	ModeHybrid   SearchMode = "hybrid"
)

// ChunkVersion is incremented when chunking/embedding logic changes,
// triggering auto-reindex on next search initialization.
const ChunkVersion = 4

// ChunkType indicates whether a chunk came from a doc or a task.
type ChunkType string

const (
	ChunkTypeDoc      ChunkType = "doc"
	ChunkTypeTask     ChunkType = "task"
	ChunkTypeMemory   ChunkType = "memory"
	ChunkTypeDecision ChunkType = "decision"
	ChunkTypeCode     ChunkType = "code"
)

// Chunk is a piece of a task or document prepared for embedding.
type Chunk struct {
	ID         string    `json:"id"`
	Type       ChunkType `json:"type"`
	Content    string    `json:"content"`
	TokenCount int       `json:"tokenCount"`
	Embedding  []float32 `json:"-"` // populated after embedding

	// Doc fields (populated when Type == ChunkTypeDoc).
	DocPath      string `json:"docPath,omitempty"`
	Section      string `json:"section,omitempty"`
	HeadingLevel int    `json:"headingLevel,omitempty"`
	HeaderPath   string `json:"headerPath,omitempty"` // full hierarchy path e.g. "API/Endpoints/GET /users"
	Position     int    `json:"position,omitempty"`

	// Task fields (populated when Type == ChunkTypeTask).
	TaskID   string   `json:"taskId,omitempty"`
	Field    string   `json:"field,omitempty"` // "description", "ac", "plan", "notes"
	Status   string   `json:"status,omitempty"`
	Priority string   `json:"priority,omitempty"`
	Labels   []string `json:"labels,omitempty"`

	// Memory fields (populated when Type == ChunkTypeMemory).
	MemoryID    string `json:"memoryId,omitempty"`
	MemoryLayer string `json:"memoryLayer,omitempty"`
	MemoryStore string `json:"memoryStore,omitempty"`

	// Decision fields (populated when Type == ChunkTypeDecision).
	DecisionID string `json:"decisionId,omitempty"`

	// Code fields (populated when Type == ChunkTypeCode).
	Name       string `json:"name,omitempty"`       // symbol name e.g. "getGraph"
	Signature  string `json:"signature,omitempty"`  // function/method signature
	Visibility string `json:"visibility,omitempty"` // exported/private when known
	Detail     string `json:"detail,omitempty"`     // LSP detail/type info when known
}

// ChunkResult is the output of chunking a single task or doc.
type ChunkResult struct {
	Chunks      []Chunk
	TotalTokens int
}

// ScoredChunk is a chunk with a similarity score from vector search.
type ScoredChunk struct {
	Chunk
	Score float64
}

// VectorSearchOpts controls how vector search behaves.
type VectorSearchOpts struct {
	TopK      int
	Threshold float64 // minimum cosine similarity (0-1)
	ChunkType ChunkType
}

// EmbedderProvider is the interface for all embedding backends (local ONNX and API).
type EmbedderProvider interface {
	Embed(text string) ([]float32, error)
	EmbedDocument(text string) ([]float32, error)
	EmbedQuery(text string) ([]float32, error)
	EmbedBatch(texts []string) ([][]float32, error)
	EmbedDocumentBatch(texts []string) ([][]float32, error)
	EmbedQueryBatch(texts []string) ([][]float32, error)
	Dimensions() int
	ModelConfig() EmbeddingModelConfig
	GetTokenizer() Tokenizer
	Close()
}

// MatchMethod describes how a result was found.
type MatchMethod string

const (
	MatchKeyword  MatchMethod = "keyword"
	MatchSemantic MatchMethod = "semantic"
)

// EmbeddingModelConfig holds the configuration for a specific embedding model.
type EmbeddingModelConfig struct {
	Name          string
	Dimensions    int
	MaxTokens     int
	HuggingFaceID string
	QueryPrefix   string // prefix prepended to queries before embedding
	DocPrefix     string // prefix prepended to documents before embedding
}

// Known embedding model configurations.
var EmbeddingModels = map[string]EmbeddingModelConfig{
	"gte-small": {
		Name:          "gte-small",
		Dimensions:    384,
		MaxTokens:     512,
		HuggingFaceID: "Xenova/gte-small",
	},
	"all-MiniLM-L6-v2": {
		Name:          "all-MiniLM-L6-v2",
		Dimensions:    384,
		MaxTokens:     256,
		HuggingFaceID: "Xenova/all-MiniLM-L6-v2",
	},
	"gte-base": {
		Name:          "gte-base",
		Dimensions:    768,
		MaxTokens:     512,
		HuggingFaceID: "Xenova/gte-base",
	},
	"bge-small-en-v1.5": {
		Name:          "bge-small-en-v1.5",
		Dimensions:    384,
		MaxTokens:     512,
		HuggingFaceID: "Xenova/bge-small-en-v1.5",
		QueryPrefix:   "Represent this sentence: ",
		DocPrefix:     "Represent this sentence: ",
	},
	"bge-base-en-v1.5": {
		Name:          "bge-base-en-v1.5",
		Dimensions:    768,
		MaxTokens:     512,
		HuggingFaceID: "Xenova/bge-base-en-v1.5",
		QueryPrefix:   "Represent this sentence: ",
		DocPrefix:     "Represent this sentence: ",
	},
	"nomic-embed-text-v1.5": {
		Name:          "nomic-embed-text-v1.5",
		Dimensions:    768,
		MaxTokens:     8192,
		HuggingFaceID: "Xenova/nomic-embed-text-v1.5",
		QueryPrefix:   "search_query: ",
		DocPrefix:     "search_document: ",
	},
	"multilingual-e5-small": {
		Name:          "multilingual-e5-small",
		Dimensions:    384,
		MaxTokens:     512,
		HuggingFaceID: "Xenova/multilingual-e5-small",
		QueryPrefix:   "query: ",
		DocPrefix:     "passage: ",
	},
}
