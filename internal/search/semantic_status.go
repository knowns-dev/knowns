package search

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/howznguyen/knowns/internal/runtimequeue"
)

const semanticRuntimeStatusMaxAge = 10 * time.Minute

type semanticRuntimeStatusSnapshot struct {
	UpdatedAt time.Time             `json:"updatedAt"`
	Status    SemanticRuntimeStatus `json:"status"`
}

func PersistDefaultSemanticRuntimeStatus() error {
	path := semanticRuntimeStatusPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(semanticRuntimeStatusSnapshot{
		UpdatedAt: time.Now().UTC(),
		Status:    DefaultSemanticRuntime().Status(),
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func ObservedSemanticRuntimeStatus() SemanticRuntimeStatus {
	if !SemanticRuntimeEnabled() {
		return DefaultSemanticRuntime().Status()
	}
	data, err := os.ReadFile(semanticRuntimeStatusPath())
	if err != nil {
		return DefaultSemanticRuntime().Status()
	}
	var snapshot semanticRuntimeStatusSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return DefaultSemanticRuntime().Status()
	}
	if snapshot.UpdatedAt.IsZero() || time.Since(snapshot.UpdatedAt) > semanticRuntimeStatusMaxAge {
		return DefaultSemanticRuntime().Status()
	}
	if !runtimequeue.IsRunning() {
		return DefaultSemanticRuntime().Status()
	}
	return snapshot.Status
}

func semanticRuntimeStatusPath() string {
	return filepath.Join(runtimequeue.RuntimeRoot(), "semantic-status.json")
}
