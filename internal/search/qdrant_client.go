package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	// QdrantRESTDistanceCosine is the REST API spelling for cosine distance.
	QdrantRESTDistanceCosine = "Cosine"
	// qdrantUpsertBatchSize keeps generation requests comfortably below
	// Qdrant's default 32 MiB JSON payload limit for supported embedding
	// dimensions and pointer-only payloads.
	qdrantUpsertBatchSize = 256

	qdrantPayloadChunkID      = "chunk_id"
	qdrantPayloadSourceID     = "source_id"
	qdrantPayloadType         = "type"
	qdrantPayloadTokenCount   = "token_count"
	qdrantPayloadPosition     = "position"
	qdrantPayloadOffset       = "offset"
	qdrantPayloadChunkVersion = "chunk_version"
	qdrantPayloadChunkHash    = "chunk_hash"
	qdrantPayloadContentHash  = "content_hash"
)

// ErrQdrantNotFound is returned when Qdrant reports a missing resource.
var ErrQdrantNotFound = errors.New("qdrant resource not found")

// QdrantClientConfig configures the lightweight REST Qdrant client used by the
// semantic vector backend. Runtime installation/ownership is handled elsewhere;
// this client only speaks to an already reachable HTTP endpoint.
type QdrantClientConfig struct {
	URL        string
	APIKey     string
	HTTPClient *http.Client
}

// QdrantClient is the backend contract used by Qdrant-backed semantic index
// code. Tests and later runtime/reindex tasks can provide fakes without a live
// Qdrant process.
type QdrantClient interface {
	CreateCollection(ctx context.Context, collectionName string, dimensions int) error
	CollectionExists(ctx context.Context, collectionName string) (bool, error)
	InspectCollection(ctx context.Context, collectionName string) (QdrantCollectionInfo, error)
	CountPoints(ctx context.Context, collectionName string) (int64, error)
	UpsertPoints(ctx context.Context, collectionName string, points []QdrantPoint) error
	Query(ctx context.Context, collectionName string, queryVec []float32, opts QdrantQueryOptions) ([]ScoredChunk, error)
	QueryValidated(ctx context.Context, collectionName string, queryVec []float32, opts QdrantQueryOptions, validation QdrantHitValidationContext) ([]ScoredChunk, QdrantHitValidationSummary, error)
	DeletePoints(ctx context.Context, collectionName string, pointIDs []string) error
	DeleteCollection(ctx context.Context, collectionName string) error
}

// qdrantSourceDeleter is optional to keep the backend-neutral client contract
// compatible with existing fakes. Targeted reconciliation requires exact
// source deletion because a changed entity may have fewer chunks than before.
type qdrantSourceDeleter interface {
	DeletePointsBySource(ctx context.Context, collectionName, sourceID string) error
}

// QdrantHTTPClient is a minimal Qdrant REST client. It intentionally avoids a
// live dependency in tests: callers can inject an httptest-backed HTTPClient.
type QdrantHTTPClient struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// QdrantCollectionInfo describes the parts of collection metadata Knowns needs
// for readiness, doctor checks, and safe writes.
type QdrantCollectionInfo struct {
	Name        string
	Exists      bool
	Dimensions  int
	Distance    string
	Status      string
	PointsCount int64
}

// QdrantPoint is the REST upsert representation for one embedded Chunk.
type QdrantPoint struct {
	ID      string         `json:"id"`
	Vector  []float32      `json:"vector"`
	Payload map[string]any `json:"payload,omitempty"`
}

// QdrantFilterCondition is a simple exact-match payload condition.
type QdrantFilterCondition struct {
	Key   string
	Value any
}

// QdrantQueryOptions controls a Qdrant vector query.
type QdrantQueryOptions struct {
	TopK      int
	Threshold float64
	ChunkType ChunkType
	Filters   []QdrantFilterCondition
}

// NewQdrantHTTPClient creates a REST client for a managed or external Qdrant
// endpoint, for example http://127.0.0.1:6333.
func NewQdrantHTTPClient(cfg QdrantClientConfig) (*QdrantHTTPClient, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.URL), "/")
	if base == "" {
		return nil, fmt.Errorf("qdrant url is required")
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("parse qdrant url: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("qdrant url must include scheme and host")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("qdrant url must not contain credentials, query secrets, or fragments")
	}
	host := parsed.Hostname()
	loopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return nil, fmt.Errorf("non-loopback Qdrant endpoints require HTTPS")
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	return &QdrantHTTPClient{baseURL: base, apiKey: cfg.APIKey, http: hc}, nil
}

// CreateCollection creates a collection with unnamed dense vectors using the
// configured embedding dimensions and cosine distance.
func (c *QdrantHTTPClient) CreateCollection(ctx context.Context, collectionName string, dimensions int) error {
	if strings.TrimSpace(collectionName) == "" {
		return fmt.Errorf("collection name is required")
	}
	if dimensions <= 0 {
		return fmt.Errorf("collection dimensions must be positive")
	}
	body := qdrantCreateCollectionRequest{
		Vectors: qdrantVectorParams{Size: dimensions, Distance: QdrantRESTDistanceCosine},
	}
	return c.doJSON(ctx, http.MethodPut, []string{"collections", collectionName}, body, nil)
}

// CollectionExists checks collection existence without treating a missing
// collection as a transport failure.
func (c *QdrantHTTPClient) CollectionExists(ctx context.Context, collectionName string) (bool, error) {
	var resp qdrantExistsResponse
	if err := c.doJSON(ctx, http.MethodGet, []string{"collections", collectionName, "exists"}, nil, &resp); err != nil {
		if errors.Is(err, ErrQdrantNotFound) {
			return false, nil
		}
		return false, err
	}
	return resp.Result.Exists, nil
}

// InspectCollection returns readiness-relevant metadata for a collection. A
// missing collection returns Exists=false and no error.
func (c *QdrantHTTPClient) InspectCollection(ctx context.Context, collectionName string) (QdrantCollectionInfo, error) {
	info := QdrantCollectionInfo{Name: collectionName}
	exists, err := c.CollectionExists(ctx, collectionName)
	if err != nil {
		return info, err
	}
	info.Exists = exists
	if !exists {
		return info, nil
	}

	var resp qdrantCollectionResponse
	if err := c.doJSON(ctx, http.MethodGet, []string{"collections", collectionName}, nil, &resp); err != nil {
		if errors.Is(err, ErrQdrantNotFound) {
			info.Exists = false
			return info, nil
		}
		return info, err
	}
	info.Status = resp.Result.Status
	info.PointsCount = resp.Result.PointsCount
	info.Dimensions, info.Distance = parseQdrantVectorsConfig(resp.Result.Config.Params.Vectors)
	return info, nil
}

// CountPoints returns Qdrant's exact point count for generation validation.
func (c *QdrantHTTPClient) CountPoints(ctx context.Context, collectionName string) (int64, error) {
	var resp struct {
		Result struct {
			Count int64 `json:"count"`
		} `json:"result"`
	}
	if err := c.doJSON(ctx, http.MethodPost, []string{"collections", collectionName, "points", "count"}, map[string]any{"exact": true}, &resp); err != nil {
		return 0, err
	}
	return resp.Result.Count, nil
}

// UpsertPoints writes embedded points and pointer-only payloads to a collection.
func (c *QdrantHTTPClient) UpsertPoints(ctx context.Context, collectionName string, points []QdrantPoint) error {
	if len(points) == 0 {
		return nil
	}
	batchCount := (len(points) + qdrantUpsertBatchSize - 1) / qdrantUpsertBatchSize
	for start, batch := 0, 1; start < len(points); start, batch = start+qdrantUpsertBatchSize, batch+1 {
		end := start + qdrantUpsertBatchSize
		if end > len(points) {
			end = len(points)
		}
		body := qdrantUpsertPointsRequest{Points: points[start:end]}
		if err := c.doJSONWithQuery(ctx, http.MethodPut, []string{"collections", collectionName, "points"}, url.Values{"wait": []string{"true"}}, body, nil); err != nil {
			return fmt.Errorf("upsert batch %d/%d: %w", batch, batchCount, err)
		}
	}
	return nil
}

// Query searches a collection and maps pointer-only payloads back to ScoredChunk
// values. Snippets/content are intentionally absent and must be read from
// canonical Knowns files by higher layers.
func (c *QdrantHTTPClient) Query(ctx context.Context, collectionName string, queryVec []float32, opts QdrantQueryOptions) ([]ScoredChunk, error) {
	raw, err := c.queryPayloads(ctx, collectionName, queryVec, opts)
	if err != nil {
		return nil, err
	}
	out := make([]ScoredChunk, 0, len(raw))
	for _, point := range raw {
		chunk := ChunkFromQdrantPayload(point.Payload)
		if chunk.ID == "" {
			continue
		}
		out = append(out, ScoredChunk{Chunk: chunk, Score: point.Score})
	}
	return out, nil
}

// QueryValidated searches Qdrant and drops stale hits before returning chunks to
// result assembly. It validates pointer identity and canonical source hashes so
// snippets/context are read only from current Knowns files.
func (c *QdrantHTTPClient) QueryValidated(ctx context.Context, collectionName string, queryVec []float32, opts QdrantQueryOptions, validation QdrantHitValidationContext) ([]ScoredChunk, QdrantHitValidationSummary, error) {
	raw, err := c.queryPayloads(ctx, collectionName, queryVec, opts)
	if err != nil {
		return nil, QdrantHitValidationSummary{}, err
	}
	chunks, summary := ValidateQdrantPayloads(validation, raw)
	return chunks, summary, nil
}

func (c *QdrantHTTPClient) queryPayloads(ctx context.Context, collectionName string, queryVec []float32, opts QdrantQueryOptions) ([]QdrantScoredPayload, error) {
	if len(queryVec) == 0 {
		return nil, fmt.Errorf("query vector is required")
	}
	limit := opts.TopK
	if limit <= 0 {
		limit = 20
	}
	req := qdrantSearchRequest{
		Vector:      queryVec,
		Limit:       limit,
		WithPayload: true,
	}
	if opts.Threshold > 0 {
		threshold := opts.Threshold
		req.ScoreThreshold = &threshold
	}
	if filter := qdrantFilterFromQueryOptions(opts); filter != nil {
		req.Filter = filter
	}

	var resp qdrantSearchResponse
	if err := c.doJSON(ctx, http.MethodPost, []string{"collections", collectionName, "points", "search"}, req, &resp); err != nil {
		return nil, err
	}
	out := make([]QdrantScoredPayload, 0, len(resp.Result))
	for _, point := range resp.Result {
		out = append(out, QdrantScoredPayload{Score: point.Score, Payload: point.Payload})
	}
	return out, nil
}

// DeletePoints removes point IDs from a collection. The supplied IDs must be
// Qdrant point IDs, not arbitrary chunk IDs; use QdrantPointIDForChunkID for
// chunk-derived points.
func (c *QdrantHTTPClient) DeletePoints(ctx context.Context, collectionName string, pointIDs []string) error {
	if len(pointIDs) == 0 {
		return nil
	}
	body := qdrantDeletePointsRequest{Points: pointIDs}
	return c.doJSONWithQuery(ctx, http.MethodPost, []string{"collections", collectionName, "points", "delete"}, url.Values{"wait": []string{"true"}}, body, nil)
}

// DeletePointsBySource removes every point whose pointer-only source_id equals
// sourceID. It is deliberately scoped to one source and never scans or deletes
// a collection. The routine path uses this instead of guessing old chunk IDs.
func (c *QdrantHTTPClient) DeletePointsBySource(ctx context.Context, collectionName, sourceID string) error {
	if strings.TrimSpace(sourceID) == "" {
		return fmt.Errorf("qdrant source id is required")
	}
	body := map[string]any{"filter": map[string]any{"must": []any{map[string]any{
		"key": qdrantPayloadSourceID, "match": map[string]any{"value": sourceID},
	}}}}
	return c.doJSONWithQuery(ctx, http.MethodPost, []string{"collections", collectionName, "points", "delete"}, url.Values{"wait": []string{"true"}}, body, nil)
}

// DeleteCollection deletes an entire collection. Missing collections are treated
// as already deleted so cleanup and purge operations can be idempotent.
func (c *QdrantHTTPClient) DeleteCollection(ctx context.Context, collectionName string) error {
	if err := c.doJSONWithQuery(ctx, http.MethodDelete, []string{"collections", collectionName}, url.Values{"wait": []string{"true"}}, nil, nil); err != nil {
		if errors.Is(err, ErrQdrantNotFound) {
			return nil
		}
		return err
	}
	return nil
}

// QdrantPointFromChunk maps an embedded Chunk to a Qdrant point. The point ID
// is deterministic and UUID-shaped because Qdrant point IDs cannot be arbitrary
// chunk strings such as "doc:path:3".
func QdrantPointFromChunk(chunk Chunk, sourceContentHash string) QdrantPoint {
	return QdrantPoint{
		ID:      QdrantPointIDForChunkID(chunk.ID),
		Vector:  append([]float32(nil), chunk.Embedding...),
		Payload: QdrantPayloadFromChunk(chunk, sourceContentHash),
	}
}

// QdrantPointIDForChunkID creates a stable UUID point ID from a Knowns chunk ID.
func QdrantPointIDForChunkID(chunkID string) string {
	return deterministicUUIDString("knowns:qdrant:chunk:" + chunkID)
}

// QdrantPayloadFromChunk builds the default v1 pointer-only payload. It stores
// source IDs, chunk IDs, offsets/positions, hashes, type, and filter metadata;
// it deliberately omits Chunk.Content and embedding values (spec D5/AC-15).
func QdrantPayloadFromChunk(chunk Chunk, sourceContentHash string) map[string]any {
	payload := map[string]any{
		qdrantPayloadChunkID:      chunk.ID,
		qdrantPayloadSourceID:     SourceIDForChunk(chunk),
		qdrantPayloadType:         string(chunk.Type),
		qdrantPayloadTokenCount:   chunk.TokenCount,
		qdrantPayloadPosition:     chunk.Position,
		qdrantPayloadOffset:       chunk.Position,
		qdrantPayloadChunkVersion: ChunkVersion,
	}
	if chunk.Content != "" {
		payload[qdrantPayloadChunkHash] = contentHash(chunk.Content)
	}
	if sourceContentHash != "" {
		payload[qdrantPayloadContentHash] = sourceContentHash
	}
	putString := func(key, value string) {
		if value != "" {
			payload[key] = value
		}
	}
	putInt := func(key string, value int) {
		if value != 0 {
			payload[key] = value
		}
	}

	putString("doc_path", chunk.DocPath)
	putString("section", chunk.Section)
	putInt("heading_level", chunk.HeadingLevel)
	putString("header_path", chunk.HeaderPath)
	putString("task_id", chunk.TaskID)
	putString("field", chunk.Field)
	putString("status", chunk.Status)
	putString("priority", chunk.Priority)
	if len(chunk.Labels) > 0 {
		payload["labels"] = append([]string(nil), chunk.Labels...)
	}
	putString("memory_id", chunk.MemoryID)
	putString("memory_layer", chunk.MemoryLayer)
	putString("memory_store", chunk.MemoryStore)
	putString("decision_id", chunk.DecisionID)
	putString("name", chunk.Name)
	putString("signature", chunk.Signature)
	putString("visibility", chunk.Visibility)
	putString("detail", chunk.Detail)
	return payload
}

// ChunkFromQdrantPayload reconstructs chunk metadata from a pointer-only Qdrant
// payload. Content is intentionally empty and must be loaded from canonical
// sources by result assembly.
func ChunkFromQdrantPayload(payload map[string]any) Chunk {
	chunk := Chunk{
		ID:           payloadString(payload, qdrantPayloadChunkID),
		Type:         ChunkType(payloadString(payload, qdrantPayloadType)),
		TokenCount:   payloadInt(payload, qdrantPayloadTokenCount),
		DocPath:      payloadString(payload, "doc_path"),
		Section:      payloadString(payload, "section"),
		HeadingLevel: payloadInt(payload, "heading_level"),
		HeaderPath:   payloadString(payload, "header_path"),
		Position:     payloadInt(payload, qdrantPayloadPosition),
		TaskID:       payloadString(payload, "task_id"),
		Field:        payloadString(payload, "field"),
		Status:       payloadString(payload, "status"),
		Priority:     payloadString(payload, "priority"),
		Labels:       payloadStringSlice(payload, "labels"),
		MemoryID:     payloadString(payload, "memory_id"),
		MemoryLayer:  payloadString(payload, "memory_layer"),
		MemoryStore:  payloadString(payload, "memory_store"),
		DecisionID:   payloadString(payload, "decision_id"),
		Name:         payloadString(payload, "name"),
		Signature:    payloadString(payload, "signature"),
		Visibility:   payloadString(payload, "visibility"),
		Detail:       payloadString(payload, "detail"),
	}
	if chunk.Position == 0 {
		chunk.Position = payloadInt(payload, qdrantPayloadOffset)
	}
	return chunk
}

// SourceIDForChunk returns the canonical source pointer for a chunk.
func SourceIDForChunk(chunk Chunk) string {
	switch chunk.Type {
	case ChunkTypeDoc:
		if chunk.DocPath != "" {
			return "doc:" + chunk.DocPath
		}
	case ChunkTypeTask:
		if chunk.TaskID != "" {
			return "task:" + chunk.TaskID
		}
	case ChunkTypeMemory:
		if chunk.MemoryID != "" {
			return "memory:" + chunk.MemoryID
		}
	case ChunkTypeDecision:
		if chunk.DecisionID != "" {
			return "decision:" + chunk.DecisionID
		}
	case ChunkTypeCode:
		if chunk.DocPath != "" {
			return "code:" + chunk.DocPath
		}
	}
	return sourceIDFromChunkID(chunk.ID)
}

// MergeQdrantScoredChunks merges project/global collection result sets above
// the storage layer. Collections remain physically separate; only scored chunks
// are combined and ranked here (spec D6/AC-17).
func MergeQdrantScoredChunks(limit int, resultSets ...[]ScoredChunk) []ScoredChunk {
	var merged []ScoredChunk
	for _, set := range resultSets {
		merged = append(merged, set...)
	}
	sort.SliceStable(merged, func(i, j int) bool {
		return merged[i].Score > merged[j].Score
	})
	if limit > 0 && len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}

func (c *QdrantHTTPClient) doJSON(ctx context.Context, method string, parts []string, body any, out any) error {
	return c.doJSONWithQuery(ctx, method, parts, nil, body, out)
}

func (c *QdrantHTTPClient) doJSONWithQuery(ctx context.Context, method string, parts []string, query url.Values, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal qdrant request: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	endpoint := c.endpoint(parts...)
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("api-key", c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("qdrant %s %s: %w", method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrQdrantNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("qdrant %s %s: status %d: %s", method, req.URL.Path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode qdrant response: %w", err)
	}
	return nil
}

func (c *QdrantHTTPClient) endpoint(parts ...string) string {
	escaped := make([]string, 0, len(parts))
	for _, part := range parts {
		escaped = append(escaped, url.PathEscape(part))
	}
	return c.baseURL + "/" + strings.Join(escaped, "/")
}

type qdrantCreateCollectionRequest struct {
	Vectors qdrantVectorParams `json:"vectors"`
}

type qdrantVectorParams struct {
	Size     int    `json:"size"`
	Distance string `json:"distance"`
}

type qdrantExistsResponse struct {
	Result struct {
		Exists bool `json:"exists"`
	} `json:"result"`
}

type qdrantCollectionResponse struct {
	Result struct {
		Status      string `json:"status"`
		PointsCount int64  `json:"points_count"`
		Config      struct {
			Params struct {
				Vectors json.RawMessage `json:"vectors"`
			} `json:"params"`
		} `json:"config"`
	} `json:"result"`
}

type qdrantUpsertPointsRequest struct {
	Points []QdrantPoint `json:"points"`
}

type qdrantSearchRequest struct {
	Vector         []float32     `json:"vector"`
	Limit          int           `json:"limit"`
	WithPayload    bool          `json:"with_payload"`
	Filter         *qdrantFilter `json:"filter,omitempty"`
	ScoreThreshold *float64      `json:"score_threshold,omitempty"`
}

type qdrantSearchResponse struct {
	Result []struct {
		ID      any            `json:"id"`
		Score   float64        `json:"score"`
		Payload map[string]any `json:"payload"`
	} `json:"result"`
}

type qdrantDeletePointsRequest struct {
	Points []string `json:"points"`
}

type qdrantFilter struct {
	Must []qdrantMatchCondition `json:"must,omitempty"`
}

type qdrantMatchCondition struct {
	Key   string             `json:"key"`
	Match qdrantMatchPayload `json:"match"`
}

type qdrantMatchPayload struct {
	Value any `json:"value,omitempty"`
	Any   any `json:"any,omitempty"`
}

func qdrantFilterFromQueryOptions(opts QdrantQueryOptions) *qdrantFilter {
	conditions := make([]QdrantFilterCondition, 0, len(opts.Filters)+1)
	if opts.ChunkType != "" {
		conditions = append(conditions, QdrantFilterCondition{Key: qdrantPayloadType, Value: string(opts.ChunkType)})
	}
	conditions = append(conditions, opts.Filters...)
	if len(conditions) == 0 {
		return nil
	}
	filter := &qdrantFilter{Must: make([]qdrantMatchCondition, 0, len(conditions))}
	for _, cond := range conditions {
		if strings.TrimSpace(cond.Key) == "" || cond.Value == nil {
			continue
		}
		match := qdrantMatchPayload{Value: cond.Value}
		switch cond.Value.(type) {
		case []string, []any:
			match = qdrantMatchPayload{Any: cond.Value}
		}
		filter.Must = append(filter.Must, qdrantMatchCondition{Key: cond.Key, Match: match})
	}
	if len(filter.Must) == 0 {
		return nil
	}
	return filter
}

func parseQdrantVectorsConfig(raw json.RawMessage) (int, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, ""
	}
	var direct qdrantVectorParams
	if err := json.Unmarshal(raw, &direct); err == nil && direct.Size > 0 {
		return direct.Size, strings.ToLower(direct.Distance)
	}
	var named map[string]qdrantVectorParams
	if err := json.Unmarshal(raw, &named); err == nil {
		for _, params := range named {
			if params.Size > 0 {
				return params.Size, strings.ToLower(params.Distance)
			}
		}
	}
	return 0, ""
}

func payloadString(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	if value, ok := payload[key]; ok {
		switch v := value.(type) {
		case string:
			return v
		case fmt.Stringer:
			return v.String()
		}
	}
	return ""
}

func payloadInt(payload map[string]any, key string) int {
	if payload == nil {
		return 0
	}
	switch v := payload[key].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		i, _ := v.Int64()
		return int(i)
	}
	return 0
}

func payloadStringSlice(payload map[string]any, key string) []string {
	if payload == nil {
		return nil
	}
	switch v := payload[key].(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func sourceIDFromChunkID(id string) string {
	if id == "" {
		return ""
	}
	if strings.HasPrefix(id, "code::") {
		parts := strings.Split(id, "::")
		if len(parts) >= 2 {
			return "code:" + parts[1]
		}
	}
	idx := strings.LastIndex(id, ":")
	if idx <= 0 {
		return id
	}
	return id[:idx]
}

func deterministicUUIDString(seed string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(seed)).String()
}
