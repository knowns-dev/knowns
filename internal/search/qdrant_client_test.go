package search

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewQdrantHTTPClientEnforcesExternalEndpointSecurity(t *testing.T) {
	for _, raw := range []string{"http://qdrant.example", "https://user:secret@qdrant.example", "https://qdrant.example?token=secret"} {
		if _, err := NewQdrantHTTPClient(QdrantClientConfig{URL: raw, APIKey: "secret"}); err == nil {
			t.Fatalf("insecure URL %q accepted", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:6333", "http://localhost:6333", "https://qdrant.example"} {
		if _, err := NewQdrantHTTPClient(QdrantClientConfig{URL: raw}); err != nil {
			t.Fatalf("safe URL %q rejected: %v", raw, err)
		}
	}
}

type capturedQdrantRequest struct {
	Method   string
	Path     string
	RawQuery string
	Header   http.Header
	Body     map[string]any
}

func newQdrantTestServer(t *testing.T, handler func(http.ResponseWriter, *http.Request, map[string]any)) (*httptest.Server, *[]capturedQdrantRequest) {
	t.Helper()
	captured := []capturedQdrantRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil && r.ContentLength != 0 {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		captured = append(captured, capturedQdrantRequest{
			Method:   r.Method,
			Path:     r.URL.Path,
			RawQuery: r.URL.RawQuery,
			Header:   r.Header.Clone(),
			Body:     body,
		})
		if handler != nil {
			handler(w, r, body)
			return
		}
		writeQdrantOK(w, map[string]any{})
	}))
	t.Cleanup(srv.Close)
	return srv, &captured
}

func writeQdrantOK(w http.ResponseWriter, result any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "result": result})
}

func TestQdrantHTTPClientCreateInspectUpsertQueryAndDelete(t *testing.T) {
	srv, captured := newQdrantTestServer(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/collections/kn_test":
			writeQdrantOK(w, true)
		case r.Method == http.MethodGet && r.URL.Path == "/collections/kn_test/exists":
			writeQdrantOK(w, map[string]any{"exists": true})
		case r.Method == http.MethodGet && r.URL.Path == "/collections/kn_test":
			writeQdrantOK(w, map[string]any{
				"status":       "green",
				"points_count": 7,
				"config": map[string]any{
					"params": map[string]any{
						"vectors": map[string]any{"size": 3, "distance": "Cosine"},
					},
				},
			})
		case r.Method == http.MethodPut && r.URL.Path == "/collections/kn_test/points" && r.URL.Query().Get("wait") == "true":
			writeQdrantOK(w, map[string]any{"operation_id": 1})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/kn_test/points/search":
			writeQdrantOK(w, []map[string]any{{
				"id":    "550e8400-e29b-41d4-a716-446655440000",
				"score": 0.87,
				"payload": map[string]any{
					"chunk_id":    "doc:guides/api:0",
					"source_id":   "doc:guides/api",
					"type":        "doc",
					"doc_path":    "guides/api",
					"section":     "Authentication",
					"header_path": "API/Authentication",
					"position":    3,
					"token_count": 42,
				},
			}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/kn_test/points/delete" && r.URL.Query().Get("wait") == "true":
			writeQdrantOK(w, map[string]any{"operation_id": 2})
		case r.Method == http.MethodDelete && r.URL.Path == "/collections/kn_test":
			writeQdrantOK(w, true)
		default:
			t.Fatalf("unexpected qdrant request %s %s body=%v", r.Method, r.URL.Path, body)
		}
	})

	client, err := NewQdrantHTTPClient(QdrantClientConfig{URL: srv.URL, APIKey: "secret"})
	if err != nil {
		t.Fatalf("NewQdrantHTTPClient: %v", err)
	}
	ctx := context.Background()

	if err := client.CreateCollection(ctx, "kn_test", 3); err != nil {
		t.Fatalf("CreateCollection: %v", err)
	}
	info, err := client.InspectCollection(ctx, "kn_test")
	if err != nil {
		t.Fatalf("InspectCollection: %v", err)
	}
	if !info.Exists || info.Dimensions != 3 || info.Distance != "cosine" || info.PointsCount != 7 || info.Status != "green" {
		t.Fatalf("unexpected collection info: %#v", info)
	}
	chunk := Chunk{
		ID:         "doc:guides/api:0",
		Type:       ChunkTypeDoc,
		Content:    "Raw canonical text that must not be copied to Qdrant payload",
		TokenCount: 42,
		Embedding:  []float32{0.1, 0.2, 0.3},
		DocPath:    "guides/api",
		Section:    "Authentication",
		HeaderPath: "API/Authentication",
		Position:   3,
	}
	point := QdrantPointFromChunk(chunk, "source-hash")
	if err := client.UpsertPoints(ctx, "kn_test", []QdrantPoint{point}); err != nil {
		t.Fatalf("UpsertPoints: %v", err)
	}
	results, err := client.Query(ctx, "kn_test", []float32{0.3, 0.2, 0.1}, QdrantQueryOptions{
		TopK:      5,
		Threshold: 0.5,
		ChunkType: ChunkTypeDoc,
		Filters:   []QdrantFilterCondition{{Key: "status", Value: "active"}},
	})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(results) != 1 || results[0].ID != "doc:guides/api:0" || results[0].DocPath != "guides/api" || results[0].Content != "" || results[0].Score != 0.87 {
		t.Fatalf("unexpected query results: %#v", results)
	}
	if err := client.DeletePoints(ctx, "kn_test", []string{point.ID}); err != nil {
		t.Fatalf("DeletePoints: %v", err)
	}
	if err := client.DeleteCollection(ctx, "kn_test"); err != nil {
		t.Fatalf("DeleteCollection: %v", err)
	}

	if len(*captured) != 7 {
		t.Fatalf("captured %d requests, want 7: %#v", len(*captured), *captured)
	}
	create := (*captured)[0]
	if create.Header.Get("api-key") != "secret" {
		t.Fatalf("api-key header not set on create request")
	}
	vectors := create.Body["vectors"].(map[string]any)
	if vectors["size"].(float64) != 3 || vectors["distance"].(string) != QdrantRESTDistanceCosine {
		t.Fatalf("unexpected create vectors body: %#v", create.Body)
	}
	upsert := (*captured)[3]
	if upsert.RawQuery != "wait=true" {
		t.Fatalf("upsert wait query = %q, want wait=true", upsert.RawQuery)
	}
	points := upsert.Body["points"].([]any)
	payload := points[0].(map[string]any)["payload"].(map[string]any)
	if payload["chunk_id"] != "doc:guides/api:0" || payload["source_id"] != "doc:guides/api" || payload["content_hash"] != "source-hash" {
		t.Fatalf("payload missing pointer fields: %#v", payload)
	}
	if _, ok := payload["content"]; ok {
		t.Fatalf("payload must not contain raw content: %#v", payload)
	}
	if strings.Contains(mustJSON(t, payload), "Raw canonical text") {
		t.Fatalf("payload leaked raw chunk text: %#v", payload)
	}
	search := (*captured)[4]
	if search.Body["with_payload"] != true || search.Body["limit"].(float64) != 5 || search.Body["score_threshold"].(float64) != 0.5 {
		t.Fatalf("unexpected search body: %#v", search.Body)
	}
	filter := search.Body["filter"].(map[string]any)
	must := filter["must"].([]any)
	if len(must) != 2 {
		t.Fatalf("filter must condition count = %d, want 2 (%#v)", len(must), must)
	}
	deletePoints := (*captured)[5]
	if deletePoints.RawQuery != "wait=true" {
		t.Fatalf("delete points wait query = %q, want wait=true", deletePoints.RawQuery)
	}
}

func TestQdrantHTTPClientUpsertPointsBatchesLargeGenerations(t *testing.T) {
	srv, captured := newQdrantTestServer(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		if r.Method != http.MethodPut || r.URL.Path != "/collections/kn_large/points" || r.URL.Query().Get("wait") != "true" {
			t.Fatalf("unexpected qdrant request %s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
		}
		writeQdrantOK(w, map[string]any{"operation_id": 1})
	})
	client, err := NewQdrantHTTPClient(QdrantClientConfig{URL: srv.URL})
	if err != nil {
		t.Fatalf("NewQdrantHTTPClient: %v", err)
	}

	points := make([]QdrantPoint, qdrantUpsertBatchSize*2+1)
	for i := range points {
		points[i] = QdrantPoint{ID: fmt.Sprintf("point-%d", i), Vector: []float32{0.1, 0.2, 0.3}}
	}
	if err := client.UpsertPoints(context.Background(), "kn_large", points); err != nil {
		t.Fatalf("UpsertPoints: %v", err)
	}
	if len(*captured) != 3 {
		t.Fatalf("captured %d upsert requests, want 3", len(*captured))
	}
	wantSizes := []int{qdrantUpsertBatchSize, qdrantUpsertBatchSize, 1}
	for i, request := range *captured {
		got := len(request.Body["points"].([]any))
		if got != wantSizes[i] {
			t.Fatalf("batch %d point count = %d, want %d", i+1, got, wantSizes[i])
		}
	}
}

func TestQdrantHTTPClientTargetedSourceDeleteAnd257BatchBound(t *testing.T) {
	srv, captured := newQdrantTestServer(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		if r.Method == http.MethodPost && r.URL.Path == "/collections/kn_target/points/delete" {
			filter := body["filter"].(map[string]any)["must"].([]any)[0].(map[string]any)
			if filter["key"] != qdrantPayloadSourceID {
				t.Fatalf("source delete key = %#v", filter["key"])
			}
			writeQdrantOK(w, map[string]any{"operation_id": 3})
			return
		}
		if r.Method != http.MethodPut || r.URL.Path != "/collections/kn_target/points" || r.URL.Query().Get("wait") != "true" {
			t.Fatalf("unexpected targeted request %s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
		}
		writeQdrantOK(w, map[string]any{"operation_id": 4})
	})
	client, err := NewQdrantHTTPClient(QdrantClientConfig{URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.DeletePointsBySource(context.Background(), "kn_target", "doc:old"); err != nil {
		t.Fatal(err)
	}
	points := make([]QdrantPoint, 257)
	for i := range points {
		points[i] = QdrantPoint{ID: fmt.Sprintf("point-%d", i), Vector: []float32{0.1, 0.2, 0.3}, Payload: map[string]any{"source_id": "doc:new"}}
	}
	if err := client.UpsertPoints(context.Background(), "kn_target", points); err != nil {
		t.Fatal(err)
	}
	if len(*captured) != 3 {
		t.Fatalf("targeted requests = %d, want delete + 256 + 1", len(*captured))
	}
	if got := len((*captured)[1].Body["points"].([]any)); got != 256 {
		t.Fatalf("first targeted batch = %d, want 256", got)
	}
	if got := len((*captured)[2].Body["points"].([]any)); got != 1 {
		t.Fatalf("second targeted batch = %d, want 1", got)
	}
}

func TestQdrantHTTPClientMissingCollectionAndIdempotentDelete(t *testing.T) {
	srv, _ := newQdrantTestServer(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections/missing/exists":
			http.NotFound(w, r)
		case r.Method == http.MethodDelete && r.URL.Path == "/collections/missing":
			http.NotFound(w, r)
		default:
			t.Fatalf("unexpected qdrant request %s %s body=%v", r.Method, r.URL.Path, body)
		}
	})
	client, err := NewQdrantHTTPClient(QdrantClientConfig{URL: srv.URL})
	if err != nil {
		t.Fatalf("NewQdrantHTTPClient: %v", err)
	}

	exists, err := client.CollectionExists(context.Background(), "missing")
	if err != nil {
		t.Fatalf("CollectionExists missing: %v", err)
	}
	if exists {
		t.Fatal("CollectionExists missing = true, want false")
	}
	info, err := client.InspectCollection(context.Background(), "missing")
	if err != nil {
		t.Fatalf("InspectCollection missing: %v", err)
	}
	if info.Exists || info.Name != "missing" {
		t.Fatalf("InspectCollection missing = %#v, want Exists=false with name", info)
	}
	if err := client.DeleteCollection(context.Background(), "missing"); err != nil {
		t.Fatalf("DeleteCollection missing should be idempotent: %v", err)
	}
}

func TestQdrantQueryFilterAnyAndNamedVectors(t *testing.T) {
	filter := qdrantFilterFromQueryOptions(QdrantQueryOptions{
		Filters: []QdrantFilterCondition{{Key: "labels", Value: []string{"api", "search"}}},
	})
	if filter == nil || len(filter.Must) != 1 {
		t.Fatalf("filter = %#v, want one condition", filter)
	}
	if filter.Must[0].Match.Any == nil || filter.Must[0].Match.Value != nil {
		t.Fatalf("label filter should use match.any, got %#v", filter.Must[0].Match)
	}

	raw := json.RawMessage(`{"text":{"size":1024,"distance":"Cosine"}}`)
	dims, distance := parseQdrantVectorsConfig(raw)
	if dims != 1024 || distance != "cosine" {
		t.Fatalf("parse named vectors = %d/%q, want 1024/cosine", dims, distance)
	}
}

func TestQdrantPayloadFromChunkPointerOnlyCoversSourceTypes(t *testing.T) {
	cases := []struct {
		name         string
		chunk        Chunk
		wantSourceID string
		wantFields   map[string]any
	}{
		{
			name:         "task",
			chunk:        Chunk{ID: "task:t123:description", Type: ChunkTypeTask, Content: "task content", TaskID: "t123", Field: "description", Status: "in-progress", Priority: "high", Labels: []string{"qdrant", "search"}, TokenCount: 12},
			wantSourceID: "task:t123",
			wantFields:   map[string]any{"task_id": "t123", "field": "description", "status": "in-progress", "priority": "high"},
		},
		{
			name:         "memory",
			chunk:        Chunk{ID: "memory:m1:0", Type: ChunkTypeMemory, Content: "memory content", MemoryID: "m1", MemoryLayer: "global", MemoryStore: "global"},
			wantSourceID: "memory:m1",
			wantFields:   map[string]any{"memory_id": "m1", "memory_layer": "global", "memory_store": "global"},
		},
		{
			name:         "decision",
			chunk:        Chunk{ID: "decision:d1:0", Type: ChunkTypeDecision, Content: "decision content", DecisionID: "d1", Status: "accepted"},
			wantSourceID: "decision:d1",
			wantFields:   map[string]any{"decision_id": "d1", "status": "accepted"},
		},
		{
			name:         "code",
			chunk:        Chunk{ID: CodeChunkID("internal/search/qdrant_client.go", "NewQdrantHTTPClient"), Type: ChunkTypeCode, Content: "code content", DocPath: "internal/search/qdrant_client.go", Name: "NewQdrantHTTPClient", Signature: "func NewQdrantHTTPClient(...)", Visibility: "exported"},
			wantSourceID: "code:internal/search/qdrant_client.go",
			wantFields:   map[string]any{"doc_path": "internal/search/qdrant_client.go", "name": "NewQdrantHTTPClient", "visibility": "exported"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := QdrantPayloadFromChunk(tc.chunk, "source-hash")
			if payload["source_id"] != tc.wantSourceID || payload["chunk_id"] != tc.chunk.ID || payload["type"] != string(tc.chunk.Type) {
				t.Fatalf("payload identity mismatch: %#v", payload)
			}
			if payload["content_hash"] != "source-hash" || payload["chunk_hash"] == "" || payload["chunk_version"] != ChunkVersion {
				t.Fatalf("payload hash/version fields missing: %#v", payload)
			}
			for key, want := range tc.wantFields {
				if payload[key] != want {
					t.Fatalf("payload[%s] = %#v, want %#v (payload=%#v)", key, payload[key], want, payload)
				}
			}
			encoded := mustJSON(t, payload)
			if strings.Contains(encoded, tc.chunk.Content) || strings.Contains(encoded, "embedding") || strings.Contains(encoded, "vector") {
				t.Fatalf("payload leaked raw text/vector fields: %s", encoded)
			}
		})
	}
}

func TestQdrantPointIDForChunkIDIsStableUUID(t *testing.T) {
	first := QdrantPointIDForChunkID("doc:guides/api:0")
	second := QdrantPointIDForChunkID("doc:guides/api:0")
	other := QdrantPointIDForChunkID("doc:guides/api:1")
	if first != second {
		t.Fatalf("point id not stable: %q vs %q", first, second)
	}
	if first == other {
		t.Fatalf("different chunk IDs produced same point ID: %q", first)
	}
	if len(first) != 36 || strings.Count(first, "-") != 4 {
		t.Fatalf("point id = %q, want UUID string", first)
	}
}

func TestNewQdrantPointerUsesSeparateUUIDsForProjectAndGlobalStores(t *testing.T) {
	embedding := QdrantEmbeddingPointer{Provider: "ollama", Model: "qwen3-embedding:0.6b", Dimensions: 1024}
	projectRoot := t.TempDir()
	globalRoot := t.TempDir()

	projectPointer, err := NewQdrantPointer(projectRoot, "project", embedding)
	if err != nil {
		t.Fatalf("NewQdrantPointer project: %v", err)
	}
	globalPointer, err := NewQdrantPointer(globalRoot, "global", embedding)
	if err != nil {
		t.Fatalf("NewQdrantPointer global: %v", err)
	}
	if projectPointer.CollectionUUID == globalPointer.CollectionUUID || projectPointer.CollectionName == globalPointer.CollectionName {
		t.Fatalf("project/global pointers share collection identity: %#v %#v", projectPointer, globalPointer)
	}
	if strings.Contains(projectPointer.CollectionName, projectRoot) || strings.Contains(globalPointer.CollectionName, globalRoot) {
		t.Fatalf("collection names must not include store paths: %q %q", projectPointer.CollectionName, globalPointer.CollectionName)
	}
	if projectPointer.Owner.StoreRootFingerprint == globalPointer.Owner.StoreRootFingerprint {
		t.Fatalf("project/global owner fingerprints should differ")
	}
	if projectPointer.CollectionName != CollectionNameFromUUID(projectPointer.CollectionUUID) || globalPointer.CollectionName != CollectionNameFromUUID(globalPointer.CollectionUUID) {
		t.Fatalf("collection names were not derived from UUIDs")
	}
}

func TestMergeQdrantScoredChunksMergesAboveStorageLayer(t *testing.T) {
	projectResults := []ScoredChunk{{Chunk: Chunk{ID: "doc:readme:0", Type: ChunkTypeDoc}, Score: 0.7}}
	globalResults := []ScoredChunk{{Chunk: Chunk{ID: "memory:g1:0", Type: ChunkTypeMemory, MemoryID: "g1", MemoryStore: "global"}, Score: 0.9}}

	merged := MergeQdrantScoredChunks(10, projectResults, globalResults)
	if len(merged) != 2 {
		t.Fatalf("merged len = %d, want 2", len(merged))
	}
	if merged[0].ID != "memory:g1:0" || merged[1].ID != "doc:readme:0" {
		t.Fatalf("merged results not sorted by score: %#v", merged)
	}
	limited := MergeQdrantScoredChunks(1, projectResults, globalResults)
	if len(limited) != 1 || limited[0].ID != "memory:g1:0" {
		t.Fatalf("limited merge wrong: %#v", limited)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json marshal: %v", err)
	}
	return string(data)
}
