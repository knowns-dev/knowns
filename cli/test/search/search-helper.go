//go:build ignore

// Test helper for the TypeScript search tests. It drives the REAL internal/search code (not a copy
// of its algorithm), so chunking, point ids, payloads, pointer files and float formatting are
// compared against the code the 0.34.1 binary runs.
//
// Build (from the repository root; the `ignore` tag keeps it out of `go build ./...`):
//
//	go build -o /tmp/knowns-search-helper ./cli/test/search/search-helper.go
//
// It reads a JSON array of requests on stdin and writes a JSON array of responses on stdout.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
)

type request struct {
	Op          string                          `json:"op"`
	Text        string                          `json:"text"`
	Content     string                          `json:"content"`
	Path        string                          `json:"path"`
	Title       string                          `json:"title"`
	Description string                          `json:"description"`
	MaxTokens   int                             `json:"maxTokens"`
	Task        *models.Task                    `json:"task"`
	Memory      *models.MemoryEntry             `json:"memory"`
	Decision    *models.DecisionEntry           `json:"decision"`
	Chunk       *search.Chunk                   `json:"chunk"`
	SourceHash  string                          `json:"sourceHash"`
	UUID        string                          `json:"uuid"`
	Root        string                          `json:"root"`
	Pointer     *search.QdrantPointer           `json:"pointer"`
	Records     []search.QdrantGenerationRecord `json:"records"`
	Values      []float64                       `json:"values"`
	A           float64                         `json:"a"`
	B           float64                         `json:"b"`
	C           float64                         `json:"c"`
	Vector      []float32                       `json:"vector"`
}

func handle(r request) (any, error) {
	switch r.Op {
	case "estimate":
		return search.EstimateTokens(r.Text), nil
	case "tokenize":
		return search.BM25Tokenize(r.Text), nil
	case "chunkDoc":
		return search.ChunkDocument(r.Content, r.Path, r.Title, r.Description, r.MaxTokens, nil), nil
	case "chunkTask":
		return search.ChunkTask(r.Task, r.MaxTokens, nil), nil
	case "chunkMemory":
		return search.ChunkMemory(r.Memory, r.MaxTokens, nil), nil
	case "chunkDecision":
		return search.ChunkDecision(r.Decision, r.MaxTokens, nil), nil
	case "point":
		return search.QdrantPointFromChunk(*r.Chunk, r.SourceHash), nil
	case "pointJSON":
		p := search.QdrantPointFromChunk(*r.Chunk, r.SourceHash)
		p.Vector = r.Vector
		raw, err := json.Marshal(p)
		return string(raw), err
	case "pointID":
		return search.QdrantPointIDForChunkID(r.Text), nil
	case "sourceID":
		return search.SourceIDForChunk(*r.Chunk), nil
	case "collectionName":
		return search.CollectionNameFromUUID(r.UUID), nil
	case "fingerprint":
		return search.StoreRootFingerprint(r.Root), nil
	case "savePointer":
		return nil, search.SaveQdrantPointer(r.Root, r.Pointer)
	case "saveGenerations":
		return nil, search.SaveQdrantGenerations(r.Root, r.Records)
	case "log":
		return fmt.Sprintf("%x", math.Float64bits(math.Log(r.A))), nil
	case "fma":
		return fmt.Sprintf("%x", math.Float64bits(math.FMA(r.A, r.B, r.C))), nil
	case "f32json":
		f := make([]float32, len(r.Values))
		for i, v := range r.Values {
			f[i] = float32(v)
		}
		raw, err := json.Marshal(f)
		return string(raw), err
	case "chunkVersion":
		return search.ChunkVersion, nil
	}
	return nil, fmt.Errorf("unknown op %q", r.Op)
}

func main() {
	var reqs []request
	if err := json.NewDecoder(os.Stdin).Decode(&reqs); err != nil {
		fmt.Fprintln(os.Stderr, "decode:", err)
		os.Exit(2)
	}
	out := make([]any, 0, len(reqs))
	for _, r := range reqs {
		v, err := handle(r)
		if err != nil {
			out = append(out, map[string]string{"error": err.Error()})
			continue
		}
		out = append(out, map[string]any{"ok": v})
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
}
