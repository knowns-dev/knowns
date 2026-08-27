package storage

// The JSONL history backend deliberately has no dependency on a particular
// entity store.  It owns serialization, per-entity locking, durability, and
// chain validation; VersionStore supplies Task/Doc-specific deltas.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

const historySchemaVersion = 1

var (
	// ErrHistoryCorrupt means a complete line, sequence, or hash chain cannot
	// be trusted. Callers must fail closed and surface repair guidance.
	ErrHistoryCorrupt = errors.New("history is corrupt")
	// ErrHistoryConflict is returned when an append was based on a stale
	// canonical head. It intentionally carries no entity content.
	ErrHistoryConflict = errors.New("history conflict")
	// ErrHistoryTailTruncated is informational when returned by Read; it is
	// never returned as the only error because prior records remain usable.
	ErrHistoryTailTruncated = errors.New("history final line is truncated")
)

// HistoryStoreOptions provides deterministic failure injection for tests and
// leaves the normal append path using os.File.Write/Sync.
type HistoryStoreOptions struct {
	Append        func(*os.File, []byte) (int, error)
	Sync          func(*os.File) error
	SyncDirectory func(string) error
	PayloadDecode func()
	// Validate is called against a fully staged replacement before activation.
	Validate func([]models.HistoryRecord) error
	// CompactSync and Rename are failure-injection seams for compaction tests.
	CompactSync func(*os.File) error
	Rename      func(string, string) error
}

// HistoryStore persists one append-only JSONL stream per stable entity.
type HistoryStore struct {
	root          string
	append        func(*os.File, []byte) (int, error)
	sync          func(*os.File) error
	syncDirectory func(string) error
	payloadDecode func()
	validate      func([]models.HistoryRecord) error
	compactSync   func(*os.File) error
	rename        func(string, string) error
}

// JSONLHistoryStore is an explicit alias for callers that want to name the
// wire format. Both names share the same implementation.
type JSONLHistoryStore = HistoryStore

func NewHistoryStore(root string, opts ...HistoryStoreOptions) *HistoryStore {
	var option HistoryStoreOptions
	if len(opts) > 0 {
		option = opts[0]
	}
	return &HistoryStore{
		root:          root,
		append:        option.Append,
		sync:          option.Sync,
		syncDirectory: option.SyncDirectory,
		payloadDecode: option.PayloadDecode,
		validate:      option.Validate,
		compactSync:   option.CompactSync,
		rename:        option.Rename,
	}
}

func NewJSONLHistoryStore(root string, opts ...HistoryStoreOptions) *HistoryStore {
	return NewHistoryStore(root, opts...)
}

func (s *HistoryStore) historyRoot() string { return filepath.Join(s.root, "history") }

func validHistoryEntityType(entityType string) bool {
	return entityType == "task" || entityType == "doc"
}

func (s *HistoryStore) entityDir(entityType string) string {
	return filepath.Join(s.historyRoot(), strings.ToLower(entityType)+"s")
}

// EntityPath exposes the stable path used for diagnostics and tests.
func (s *HistoryStore) EntityPath(entityType, entityID string) string {
	if !validHistoryEntityType(entityType) {
		return ""
	}
	return filepath.Join(s.entityDir(entityType), safeHistoryID(entityID)+".jsonl")
}

func (s *HistoryStore) lockPath(entityType, entityID string) string {
	if !validHistoryEntityType(entityType) {
		return ""
	}
	return filepath.Join(s.historyRoot(), "locks", strings.ToLower(entityType)+"-"+safeHistoryID(entityID)+".lock")
}

func safeHistoryID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "empty"
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		h := sha256.Sum256([]byte(id))
		return hex.EncodeToString(h[:])
	}
	return id
}

var historyEntityMu sync.Map // absolute lock path -> *sync.Mutex

func (s *HistoryStore) withEntityLock(ctx context.Context, entityType, entityID string, fn func() error) error {
	if !validHistoryEntityType(entityType) {
		return fmt.Errorf("unsupported history entity type %q", entityType)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	path := s.lockPath(entityType, entityID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("history lock directory: %w", err)
	}
	muAny, _ := historyEntityMu.LoadOrStore(path, &sync.Mutex{})
	mu := muAny.(*sync.Mutex)
	for !mu.TryLock() {
		timer := time.NewTimer(2 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	defer mu.Unlock()

	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open history lock: %w", err)
	}
	defer file.Close()
	if err := lockTaskLifecycleFile(ctx, file); err != nil {
		return fmt.Errorf("acquire history lock: %w", err)
	}
	defer unlockTaskLifecycleFile(file)
	return fn()
}

// Append validates the existing stream, truncates only a recoverable final
// partial line, then appends one newline-terminated record and fsyncs it.
func (s *HistoryStore) Append(ctx context.Context, record models.HistoryRecord) error {
	if !validHistoryEntityType(record.EntityType) {
		return fmt.Errorf("unsupported history entity type %q", record.EntityType)
	}
	if record.EntityType == "" || record.EntityID == "" {
		return fmt.Errorf("history record requires entity type and ID")
	}
	if record.SchemaVersion == 0 {
		record.SchemaVersion = historySchemaVersion
	}
	if record.SchemaVersion != historySchemaVersion {
		return fmt.Errorf("unsupported history schema version %d", record.SchemaVersion)
	}
	path := s.EntityPath(record.EntityType, record.EntityID)
	return s.withEntityLock(ctx, record.EntityType, record.EntityID, func() error {
		read, err := s.readFile(path, record.EntityType, record.EntityID)
		if err != nil {
			return err
		}
		records := read.Records
		record.Revision = len(records) + 1
		if len(records) > 0 {
			record.PrevRecordHash = records[len(records)-1].RecordHash
			if record.LegacyPath == "" {
				record.LegacyPath = records[len(records)-1].LegacyPath
			}
			if record.LegacyDigest == "" {
				record.LegacyDigest = records[len(records)-1].LegacyDigest
			}
			if records[len(records)-1].LegacyRevision > 0 {
				record.LegacyRevision = records[len(records)-1].LegacyRevision + 1
				record.LegacyID = fmt.Sprintf("v%d", record.LegacyRevision)
			}
		}
		record.RecordHash = ""
		record.RecordHash = historyRecordHash(record)
		if err := validateHistoryRecord(record, record.Revision, records, record.EntityType, record.EntityID); err != nil {
			if len(records) > 0 && record.NewHash != "" && errors.Is(err, ErrHistoryCorrupt) && record.BaseHash != records[len(records)-1].NewHash {
				return fmt.Errorf("%w: stale history head", ErrHistoryConflict)
			}
			return err
		}
		data, err := json.Marshal(record)
		if err != nil {
			return fmt.Errorf("marshal history record: %w", err)
		}
		data = append(data, '\n')
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("create history directory: %w", err)
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return fmt.Errorf("open history log: %w", err)
		}
		defer file.Close()
		if read.TailTruncated {
			if err := file.Truncate(read.ValidBytes); err != nil {
				return fmt.Errorf("recover truncated history tail: %w", err)
			}
			if _, err := file.Seek(0, io.SeekEnd); err != nil {
				return fmt.Errorf("seek recovered history tail: %w", err)
			}
		}
		baseOffset := read.ValidBytes
		rollbackAppend := func() {
			_ = file.Truncate(baseOffset)
			_ = file.Sync()
		}
		appendFn := s.append
		if appendFn == nil {
			appendFn = func(f *os.File, b []byte) (int, error) { return f.Write(b) }
		}
		n, err := appendFn(file, data)
		if err != nil {
			rollbackAppend()
			return fmt.Errorf("append history record: %w", err)
		}
		if n != len(data) {
			rollbackAppend()
			return io.ErrShortWrite
		}
		syncFn := s.sync
		if syncFn == nil {
			syncFn = (*os.File).Sync
		}
		if err := syncFn(file); err != nil {
			rollbackAppend()
			return fmt.Errorf("sync history log: %w", err)
		}
		syncDir := s.syncDirectory
		if syncDir == nil {
			syncDir = syncDirectory
		}
		if err := syncDir(filepath.Dir(path)); err != nil {
			rollbackAppend()
			return fmt.Errorf("sync history directory: %w", err)
		}
		return nil
	})
}

// Read returns all valid records and reports an incomplete final line. A
// complete malformed line or any sequence/hash discontinuity fails closed.
func (s *HistoryStore) Read(ctx context.Context, entityType, entityID string) (models.HistoryReadResult, error) {
	if !validHistoryEntityType(entityType) {
		return models.HistoryReadResult{}, fmt.Errorf("unsupported history entity type %q", entityType)
	}
	var result models.HistoryReadResult
	path := s.EntityPath(entityType, entityID)
	err := s.withEntityLock(ctx, entityType, entityID, func() error {
		read, err := s.readFile(path, entityType, entityID)
		result = read.HistoryReadResult
		return err
	})
	return result, err
}

// ReadPreview is a strictly read-only history read for dry-run reconciliation.
// Unlike Read, it does not create per-entity lock files when no history exists.
func (s *HistoryStore) ReadPreview(entityType, entityID string) (models.HistoryReadResult, error) {
	if !validHistoryEntityType(entityType) {
		return models.HistoryReadResult{}, fmt.Errorf("unsupported history entity type %q", entityType)
	}
	path := s.EntityPath(entityType, entityID)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return models.HistoryReadResult{}, nil
	} else if err != nil {
		return models.HistoryReadResult{}, err
	}
	read, err := s.readFile(path, entityType, entityID)
	return read.HistoryReadResult, err
}

// ReadRecord loads one payload on demand, supporting lazy metadata clients.
// It validates the complete metadata/hash envelope but decodes only the
// nearest checkpoint and deltas required to reach the requested revision.
func (s *HistoryStore) ReadRecord(ctx context.Context, entityType, entityID string, revision int) (*models.HistoryRecord, error) {
	if !validHistoryEntityType(entityType) {
		return nil, fmt.Errorf("unsupported history entity type %q", entityType)
	}
	window, err := s.ReadRecordWindow(ctx, entityType, entityID, revision)
	if err != nil {
		return nil, err
	}
	record := window[len(window)-1]
	return &record, nil
}

// ReadRecordWindow returns the nearest checkpoint and the payload-bearing
// records through revision. Metadata for every record is still checked, but
// unrelated checkpoint/delta payloads are never unmarshaled.
func (s *HistoryStore) ReadRecordWindow(ctx context.Context, entityType, entityID string, revision int) ([]models.HistoryRecord, error) {
	if !validHistoryEntityType(entityType) {
		return nil, fmt.Errorf("unsupported history entity type %q", entityType)
	}
	if revision < 1 {
		return nil, fmt.Errorf("history revision %d not found", revision)
	}
	var selected []models.HistoryRecord
	path := s.EntityPath(entityType, entityID)
	err := s.withEntityLock(ctx, entityType, entityID, func() error {
		file, err := os.Open(path)
		if os.IsNotExist(err) {
			return fmt.Errorf("history revision %d not found", revision)
		}
		if err != nil {
			return fmt.Errorf("read history log: %w", err)
		}
		defer file.Close()
		var records []models.HistoryRecord
		reader := bufio.NewReader(file)
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(line) == 0 && errors.Is(readErr, io.EOF) {
				break
			}
			// History durability is defined at newline boundaries. Even when an
			// unterminated tail happens to contain valid JSON, it may be only a
			// partially persisted append and must never become addressable as a
			// revision detail.
			if errors.Is(readErr, io.EOF) {
				break
			}
			line = bytes.TrimSuffix(line, []byte("\n"))
			line = bytes.TrimSuffix(line, []byte("\r"))
			if len(bytes.TrimSpace(line)) == 0 {
				return fmt.Errorf("%w: empty history line", ErrHistoryCorrupt)
			}
			var raw map[string]json.RawMessage
			if err := json.Unmarshal(line, &raw); err != nil {
				return fmt.Errorf("%w: history metadata line: %v", ErrHistoryCorrupt, err)
			}
			metadata, err := metadataRecord(raw)
			if err != nil {
				return err
			}
			if err := validateMetadataRecord(raw, metadata, len(records)+1, records, entityType, entityID); err != nil {
				return err
			}
			records = append(records, metadata)
			if errors.Is(readErr, io.EOF) {
				break
			}
			if readErr != nil {
				return fmt.Errorf("read history metadata: %w", readErr)
			}
		}
		if revision > len(records) {
			return fmt.Errorf("history revision %d not found", revision)
		}
		checkpoint := 0
		for i := 0; i < revision; i++ {
			if records[i].Checkpoint {
				checkpoint = i
			}
		}
		selected = make([]models.HistoryRecord, 0, revision-checkpoint)
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return fmt.Errorf("rewind history log: %w", err)
		}
		reader = bufio.NewReader(file)
		for i := 0; i < revision; i++ {
			line, readErr := reader.ReadBytes('\n')
			if errors.Is(readErr, io.EOF) && len(line) == 0 {
				return fmt.Errorf("history revision %d not found", revision)
			}
			line = bytes.TrimSuffix(line, []byte("\n"))
			line = bytes.TrimSuffix(line, []byte("\r"))
			if i < checkpoint {
				if readErr != nil && !errors.Is(readErr, io.EOF) {
					return fmt.Errorf("read history payload: %w", readErr)
				}
				continue
			}
			var record models.HistoryRecord
			if err := json.Unmarshal(line, &record); err != nil {
				return fmt.Errorf("%w: history payload at revision %d: %v", ErrHistoryCorrupt, i+1, err)
			}
			if s.payloadDecode != nil {
				s.payloadDecode()
			}
			if err := validateHistoryEnvelope(record, i+1, records[:i], entityType, entityID, len(record.CheckpointPayload) > 0, false); err != nil {
				return err
			}
			selected = append(selected, record)
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return fmt.Errorf("read history payload: %w", readErr)
			}
		}
		return nil
	})
	return selected, err
}

// ListMetadata reads only the fixed metadata fields. Payloads remain nil in
// the returned records so callers can page history without materializing it.
func (s *HistoryStore) ListMetadata(ctx context.Context, entityType, entityID string, offset, limit int) ([]models.HistoryRecord, bool, error) {
	metadata, more, _, err := s.ListMetadataWithStatus(ctx, entityType, entityID, offset, limit)
	return metadata, more, err
}

// ListMetadataWithStatus is ListMetadata plus the durability status of the
// ignored final line. Public adapters use it to surface interrupted appends
// without materializing any payload.
func (s *HistoryStore) ListMetadataWithStatus(ctx context.Context, entityType, entityID string, offset, limit int) ([]models.HistoryRecord, bool, bool, error) {
	if !validHistoryEntityType(entityType) {
		return nil, false, false, fmt.Errorf("unsupported history entity type %q", entityType)
	}
	result, err := s.readMetadata(ctx, entityType, entityID)
	if err != nil {
		return nil, false, false, err
	}
	if offset < 0 {
		offset = 0
	}
	if offset > len(result.Records) {
		offset = len(result.Records)
	}
	end := len(result.Records)
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	metadata := make([]models.HistoryRecord, end-offset)
	copy(metadata, result.Records[offset:end])
	for i := range metadata {
		metadata[i].TaskChanges = nil
		metadata[i].DocChanges = nil
		metadata[i].ChangedScopes = nil
		metadata[i].CheckpointPayload = nil
	}
	return metadata, end < len(result.Records), result.TailTruncated, nil
}

// readMetadata parses only the fixed record envelope. Payload fields remain
// RawMessage values and are deliberately discarded before unmarshalling the
// returned metadata model.
func (s *HistoryStore) readMetadata(ctx context.Context, entityType, entityID string) (models.HistoryReadResult, error) {
	var result models.HistoryReadResult
	path := s.EntityPath(entityType, entityID)
	err := s.withEntityLock(ctx, entityType, entityID, func() error {
		file, err := os.Open(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		defer file.Close()
		var previous []models.HistoryRecord
		reader := bufio.NewReader(file)
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(line) == 0 && errors.Is(readErr, io.EOF) {
				break
			}
			if errors.Is(readErr, io.EOF) {
				result.TailTruncated = true
				break
			}
			line = bytes.TrimSuffix(line, []byte("\n"))
			line = bytes.TrimSuffix(line, []byte("\r"))
			if len(bytes.TrimSpace(line)) == 0 {
				return fmt.Errorf("%w: empty metadata line", ErrHistoryCorrupt)
			}
			var raw map[string]json.RawMessage
			if err := json.Unmarshal(line, &raw); err != nil {
				return fmt.Errorf("%w: metadata line: %v", ErrHistoryCorrupt, err)
			}
			record, err := metadataRecord(raw)
			if err != nil {
				return err
			}
			if err := validateMetadataRecord(raw, record, len(previous)+1, previous, entityType, entityID); err != nil {
				return err
			}
			previous = append(previous, record)
			result.Records = append(result.Records, record)
			if readErr != nil {
				return fmt.Errorf("read history metadata: %w", readErr)
			}
		}
		return nil
	})
	return result, err
}

func metadataRecord(raw map[string]json.RawMessage) (models.HistoryRecord, error) {
	metadata := make(map[string]json.RawMessage, len(raw))
	for key, value := range raw {
		metadata[key] = value
	}
	delete(metadata, "taskChanges")
	delete(metadata, "docChanges")
	delete(metadata, "changedScopes")
	delete(metadata, "checkpointPayload")
	data, err := json.Marshal(metadata)
	if err != nil {
		return models.HistoryRecord{}, err
	}
	var record models.HistoryRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return models.HistoryRecord{}, err
	}
	return record, nil
}

func validateMetadataRecord(raw map[string]json.RawMessage, record models.HistoryRecord, expected int, previous []models.HistoryRecord, entityType, entityID string) error {
	recordHash := record.RecordHash
	computed, err := metadataRecordHash(raw)
	if err != nil {
		return err
	}
	if recordHash == "" || recordHash != computed {
		return fmt.Errorf("%w: record hash mismatch at revision %d", ErrHistoryCorrupt, expected)
	}
	return validateHistoryEnvelope(record, expected, previous, entityType, entityID, rawCheckpointPayloadPresent(raw), true)
}

// historyRecordWire preserves the writer's field order while retaining
// payloads as RawMessage. Metadata pagination can therefore verify the exact
// record hash without decoding checkpoint or delta contents.
type historyRecordWire struct {
	SchemaVersion     int                    `json:"schemaVersion"`
	EntityType        string                 `json:"entityType"`
	EntityID          string                 `json:"entityId"`
	Revision          int                    `json:"revision"`
	Timestamp         time.Time              `json:"timestamp"`
	Author            string                 `json:"author,omitempty"`
	Actor             string                 `json:"actor,omitempty"`
	Source            string                 `json:"source,omitempty"`
	AuditEventID      string                 `json:"auditEventId,omitempty"`
	SessionID         string                 `json:"sessionId,omitempty"`
	BatchID           string                 `json:"batchId,omitempty"`
	Operation         string                 `json:"operation,omitempty"`
	Tombstone         bool                   `json:"tombstone,omitempty"`
	LifecycleID       string                 `json:"lifecycleEventId,omitempty"`
	BaseHash          string                 `json:"baseHash,omitempty"`
	NewHash           string                 `json:"newHash,omitempty"`
	PrevRecordHash    string                 `json:"prevRecordHash,omitempty"`
	RecordHash        string                 `json:"recordHash,omitempty"`
	Checkpoint        bool                   `json:"checkpoint,omitempty"`
	LegacyRevision    int                    `json:"legacyRevision,omitempty"`
	LegacyID          string                 `json:"legacyId,omitempty"`
	Legacy            bool                   `json:"legacy,omitempty"`
	LegacyUnverified  bool                   `json:"legacyUnverified,omitempty"`
	LegacyBaseHash    string                 `json:"legacyBaseHash,omitempty"`
	LegacyNewHash     string                 `json:"legacyNewHash,omitempty"`
	LegacyPath        string                 `json:"legacyPath,omitempty"`
	LegacyDigest      string                 `json:"legacyDigest,omitempty"`
	RetentionGaps     []models.DocHistoryGap `json:"retentionGaps,omitempty"`
	TaskChanges       json.RawMessage        `json:"taskChanges,omitempty"`
	DocChanges        json.RawMessage        `json:"docChanges,omitempty"`
	ChangedScopes     json.RawMessage        `json:"changedScopes,omitempty"`
	CurrentPath       string                 `json:"currentPath,omitempty"`
	PreviousPath      string                 `json:"previousPath,omitempty"`
	CheckpointPayload json.RawMessage        `json:"checkpointPayload,omitempty"`
}

// metadataRecordHash recomputes a record hash from the raw line so the metadata
// reader validates with exactly the function that wrote the hash.
//
// It must not hash the file's bytes directly. `historyRecordHash` normalizes a
// record through `models.HistoryRecord`, where `TaskChange.OldValue` and
// `NewValue` are `any` and therefore become `map[string]any`, whose keys Go
// marshals in sorted order. On disk the same values keep the field order of the
// struct they were written from. Any record whose changes carry a nested object
// - an acceptance criterion, for instance - therefore hashes one way when
// written and another when read back verbatim, and a perfectly intact history
// gets reported as corrupt.
func metadataRecordHash(raw map[string]json.RawMessage) (string, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return "", err
	}
	var record models.HistoryRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return "", err
	}
	return historyRecordHash(record), nil
}

// FindEntityByPath locates a Doc history by its current or historical path.
// The path index is intentionally a later optimization; scanning immutable
// per-entity logs keeps this foundation backend-neutral and rename-safe.
func (s *HistoryStore) FindEntityByPath(ctx context.Context, entityType, entityPath string) (string, bool, error) {
	if !validHistoryEntityType(entityType) {
		return "", false, fmt.Errorf("unsupported history entity type %q", entityType)
	}
	entries, err := os.ReadDir(s.entityDir(entityType))
	if os.IsNotExist(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	want := strings.TrimPrefix(strings.TrimSpace(entityPath), "/")
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		entityID := strings.TrimSuffix(entry.Name(), ".jsonl")
		result, err := s.Read(ctx, entityType, entityID)
		if err != nil {
			return "", false, err
		}
		for _, record := range result.Records {
			if record.CurrentPath == want || record.PreviousPath == want {
				return record.EntityID, true, nil
			}
			if path, ok := record.CheckpointPayload["path"].(string); ok && path == want {
				return record.EntityID, true, nil
			}
		}
	}
	return "", false, nil
}

// FindEntityByPathMetadata resolves current and historical paths without
// decoding checkpoint or delta payloads. It is the preferred lookup for lazy
// history APIs; legacy-only path forms may still require FindEntityByPath.
func (s *HistoryStore) FindEntityByPathMetadata(ctx context.Context, entityType, entityPath string) (string, bool, error) {
	if !validHistoryEntityType(entityType) {
		return "", false, fmt.Errorf("unsupported history entity type %q", entityType)
	}
	entries, err := os.ReadDir(s.entityDir(entityType))
	if os.IsNotExist(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	want := strings.TrimPrefix(strings.TrimSpace(entityPath), "/")
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		entityID := strings.TrimSuffix(entry.Name(), ".jsonl")
		page, _, err := s.ListMetadata(ctx, entityType, entityID, 0, 0)
		if err != nil {
			return "", false, err
		}
		for _, record := range page {
			if record.CurrentPath == want || record.PreviousPath == want {
				return record.EntityID, true, nil
			}
		}
	}
	return "", false, nil
}

// Delete removes an entity's log through the same per-entity lock boundary.
func (s *HistoryStore) Delete(ctx context.Context, entityType, entityID string) error {
	if !validHistoryEntityType(entityType) {
		return fmt.Errorf("unsupported history entity type %q", entityType)
	}
	path := s.EntityPath(entityType, entityID)
	return s.withEntityLock(ctx, entityType, entityID, func() error {
		err := os.Remove(path)
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("delete history: %w", err)
		}
		if err == nil {
			return syncDirectory(filepath.Dir(path))
		}
		return nil
	})
}

// PurgeAuthorized removes the exact JSONL stream and only legacy successor
// proven to derive from that stream. The caller is an already-authorized
// lifecycle adapter; this storage primitive deliberately has no public
// request/capability flag that could be forged by untrusted input.
func (s *HistoryStore) PurgeAuthorized(ctx context.Context, entityType, entityID, actor, reason, expectedHash string) error {
	if strings.TrimSpace(reason) == "" {
		return errors.New("authorized history purge requires a reason")
	}
	if strings.TrimSpace(actor) == "" {
		actor = "task-lifecycle"
	}
	return s.withEntityLock(ctx, entityType, entityID, func() error {
		stream, err := s.readFile(s.EntityPath(entityType, entityID), entityType, entityID)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil && expectedHash != "" && len(stream.Records) > 0 && stream.Records[len(stream.Records)-1].NewHash != expectedHash {
			return fmt.Errorf("%w: history purge hash mismatch", ErrHistoryConflict)
		}
		marker := map[string]any{"entityType": entityType, "entityId": entityID, "actor": actor, "reason": reason, "expectedHash": expectedHash, "phase": "authorized", "purgedAt": time.Now().UTC()}
		markerPath := filepath.Join(s.root, "history", "purged", safeHistoryID(entityType+"-"+entityID)+".json")
		if err := durableWriteJSON(markerPath, marker); err != nil {
			return err
		}
		if err == nil {
			for _, target := range s.previewLegacyCleanupLocked(entityType, entityID).Targets {
				if target.Verified {
					if err := s.confirmLegacyCleanupLocked(ctx, target); err != nil {
						return err
					}
				}
			}
			marker["phase"] = "legacy_removed"
			if err := durableWriteJSON(markerPath, marker); err != nil {
				return err
			}
		}
		if err := os.Remove(s.EntityPath(entityType, entityID)); err != nil && !os.IsNotExist(err) {
			return err
		}
		marker["phase"] = "history_removed"
		return durableWriteJSON(markerPath, marker)
	})
}

// PurgeLegacyOnly verifies and removes a legacy-only stream under the same
// entity lock. A false result is a deliberate fail-closed retention decision.
func (s *HistoryStore) PurgeLegacyOnly(ctx context.Context, entityType, entityID, actor, reason, legacyPath string) (bool, error) {
	if strings.TrimSpace(reason) == "" {
		return false, errors.New("authorized history purge requires a reason")
	}
	if strings.TrimSpace(actor) == "" {
		actor = "task-lifecycle"
	}
	removed := false
	err := s.withEntityLock(ctx, entityType, entityID, func() error {
		canonical, ok := s.managedLegacyPath(entityType, entityID, legacyPath)
		if !ok {
			return nil
		}
		info, err := os.Lstat(canonical)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if info.Mode().IsDir() {
			return fmt.Errorf("legacy cleanup target is not a regular file")
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		data, err := os.ReadFile(canonical)
		if err != nil {
			return err
		}
		var envelope map[string]any
		if json.Unmarshal(data, &envelope) != nil {
			return nil
		}
		identityOK := false
		for _, key := range []string{"taskId", "docId", "entityId", "id"} {
			if value, exists := envelope[key].(string); exists && value != "" {
				identityOK = value == entityID
				break
			}
		}
		if !identityOK {
			return nil
		}
		marker := map[string]any{"entityType": entityType, "entityId": entityID, "path": canonical, "actor": actor, "reason": reason, "phase": "authorized", "purgedAt": time.Now().UTC()}
		markerPath := filepath.Join(s.root, "history", "purged", safeHistoryID(entityType+"-"+entityID)+".json")
		if err := durableWriteJSON(markerPath, marker); err != nil {
			return err
		}
		// The proof and reservation are serialized by the entity lock, but a
		// legacy file can still be replaced by an external actor that does not
		// participate in that lock. Re-read the exact bytes and identity after
		// the durable reservation immediately before the irreversible remove.
		currentInfo, err := os.Lstat(canonical)
		if err != nil || !currentInfo.Mode().IsRegular() || currentInfo.Mode()&os.ModeSymlink != 0 {
			return errors.New("legacy cleanup target changed after reservation")
		}
		currentData, err := os.ReadFile(canonical)
		if err != nil {
			return err
		}
		if !bytes.Equal(currentData, data) {
			return errors.New("legacy cleanup target changed after reservation")
		}
		var currentEnvelope map[string]any
		if json.Unmarshal(currentData, &currentEnvelope) != nil {
			return errors.New("legacy cleanup target changed after reservation")
		}
		currentIdentity := ""
		for _, key := range []string{"taskId", "docId", "entityId", "id"} {
			if value, exists := currentEnvelope[key].(string); exists && value != "" {
				currentIdentity = value
				break
			}
		}
		if currentIdentity != entityID {
			return errors.New("legacy cleanup target identity changed after reservation")
		}
		if err := os.Remove(canonical); err != nil && !os.IsNotExist(err) {
			return err
		}
		marker["phase"] = "legacy_removed"
		if err := durableWriteJSON(markerPath, marker); err != nil {
			return err
		}
		removed = true
		return nil
	})
	return removed, err
}

// RemoveLast removes exactly one already durable record for lifecycle
// rollback. It never rewrites or accepts a corrupt earlier prefix.
func (s *HistoryStore) RemoveLast(ctx context.Context, entityType, entityID string) error {
	if !validHistoryEntityType(entityType) {
		return fmt.Errorf("unsupported history entity type %q", entityType)
	}
	path := s.EntityPath(entityType, entityID)
	return s.withEntityLock(ctx, entityType, entityID, func() error {
		read, err := s.readFile(path, entityType, entityID)
		if err != nil {
			return err
		}
		if len(read.Records) == 0 {
			return nil
		}
		if err := os.Truncate(path, read.ValidOffsets[len(read.ValidOffsets)-2]); err != nil {
			return fmt.Errorf("truncate history rollback: %w", err)
		}
		if err := syncFilePath(path); err != nil {
			return err
		}
		return syncDirectory(filepath.Dir(path))
	})
}

type historyReadInternal struct {
	models.HistoryReadResult
	ValidBytes   int64
	ValidOffsets []int64
}

func (s *HistoryStore) readFile(path, entityType, entityID string) (historyReadInternal, error) {
	var result historyReadInternal
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("read history log: %w", err)
	}
	result.ValidOffsets = []int64{0}
	start := 0
	for start < len(data) {
		nl := bytes.IndexByte(data[start:], '\n')
		if nl < 0 {
			result.TailTruncated = true
			break
		}
		end := start + nl
		line := strings.TrimSuffix(string(data[start:end]), "\r")
		if strings.TrimSpace(line) == "" {
			return result, fmt.Errorf("%w: empty line at byte %d", ErrHistoryCorrupt, start)
		}
		var record models.HistoryRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			return result, fmt.Errorf("%w: line at byte %d: %v", ErrHistoryCorrupt, start, err)
		}
		if s.payloadDecode != nil {
			s.payloadDecode()
		}
		if err := validateHistoryRecord(record, len(result.Records)+1, result.Records, entityType, entityID); err != nil {
			return result, err
		}
		result.Records = append(result.Records, record)
		result.ValidOffsets = append(result.ValidOffsets, int64(end+1))
		result.ValidBytes = int64(end + 1)
		start = end + 1
	}
	if result.TailTruncated {
		// ValidBytes points at the end of the last complete line, which is the
		// only safe recovery boundary.
		if len(result.ValidOffsets) > 0 {
			result.ValidBytes = result.ValidOffsets[len(result.ValidOffsets)-1]
		}
	}
	return result, nil
}

func validateHistoryRecord(record models.HistoryRecord, expected int, previous []models.HistoryRecord, entityType, entityID string) error {
	return validateHistoryEnvelope(record, expected, previous, entityType, entityID, len(record.CheckpointPayload) > 0, false)
}

func validateHistoryEnvelope(record models.HistoryRecord, expected int, previous []models.HistoryRecord, entityType, entityID string, checkpointPayloadPresent, recordHashVerified bool) error {
	if record.SchemaVersion != historySchemaVersion || !validHistoryEntityType(record.EntityType) || record.EntityID == "" {
		return fmt.Errorf("%w: invalid record identity/schema at revision %d", ErrHistoryCorrupt, expected)
	}
	if entityType != "" && (record.EntityType != entityType || record.EntityID != entityID) {
		return fmt.Errorf("%w: record entity does not match history stream at revision %d", ErrHistoryCorrupt, expected)
	}
	if record.Revision != expected {
		return fmt.Errorf("%w: revision gap, got %d want %d", ErrHistoryCorrupt, record.Revision, expected)
	}
	if record.NewHash == "" && !record.LegacyUnverified {
		return fmt.Errorf("%w: empty canonical hash at revision %d", ErrHistoryCorrupt, expected)
	}
	if !recordHashVerified && (record.RecordHash == "" || record.RecordHash != historyRecordHash(record)) {
		return fmt.Errorf("%w: record hash mismatch at revision %d", ErrHistoryCorrupt, expected)
	}
	if record.Checkpoint && !checkpointPayloadPresent && !record.LegacyUnverified {
		return fmt.Errorf("%w: checkpoint payload missing at revision %d", ErrHistoryCorrupt, expected)
	}
	if len(previous) == 0 {
		if !record.Checkpoint && !record.LegacyUnverified || record.BaseHash != "" && !record.LegacyUnverified {
			return fmt.Errorf("%w: first history record must be a checkpoint with empty base hash", ErrHistoryCorrupt)
		}
	} else {
		last := previous[len(previous)-1]
		if record.PrevRecordHash != last.RecordHash {
			return fmt.Errorf("%w: record hash chain mismatch at revision %d", ErrHistoryCorrupt, expected)
		}
		reconcileAfterLegacy := record.Source == "migration-reconcile" && last.LegacyUnverified
		if !record.LegacyUnverified && !reconcileAfterLegacy && (record.BaseHash == "" || last.NewHash == "" || record.BaseHash != last.NewHash) {
			return fmt.Errorf("%w: canonical hash chain mismatch at revision %d", ErrHistoryCorrupt, expected)
		}
	}
	return nil
}

func rawCheckpointPayloadPresent(raw map[string]json.RawMessage) bool {
	payload, ok := raw["checkpointPayload"]
	if !ok || string(bytes.TrimSpace(payload)) == "null" {
		return false
	}
	var decoded map[string]json.RawMessage
	return json.Unmarshal(payload, &decoded) == nil && len(decoded) > 0
}

func historyRecordHash(record models.HistoryRecord) string {
	record.RecordHash = ""
	data, _ := json.Marshal(record)
	// Normalize interface payloads exactly as they will appear after a JSON
	// read (for example time.Time and integer values inside map[string]any).
	// This keeps record hashes stable across process boundaries.
	var normalized models.HistoryRecord
	if json.Unmarshal(data, &normalized) == nil {
		data, _ = json.Marshal(normalized)
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	// On Windows, Sync() on directories is not supported and returns "Access is denied."
	// Since directory sync is a durability optimization (ensures metadata is flushed),
	// we can safely skip it on Windows without affecting correctness.
	if err := dir.Sync(); err != nil && !isWindowsAccessDeniedOnDirSync(err) {
		return err
	}
	return nil
}

func syncFilePath(path string) error {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

// isWindowsAccessDeniedOnDirSync detects Windows "Access is denied" errors
// when calling Sync() on a directory handle. Windows does not support fsync
// on directories, so we treat this as a non-error.
func isWindowsAccessDeniedOnDirSync(err error) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	// On Windows, dir.Sync() returns ERROR_ACCESS_DENIED (errno 5)
	var errno syscall.Errno
	return errors.As(err, &errno) && errno == 5
}
