package lspdaemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// State is the persisted daemon discovery snapshot for one project.
type State struct {
	ProjectRoot string            `json:"project_root"`
	ProjectKey  string            `json:"project_key"`
	PID         int               `json:"pid,omitempty"`
	Endpoint    TransportEndpoint `json:"endpoint"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

// NewState returns a discovery snapshot populated from paths.
func NewState(paths Paths, pid int) State {
	return State{
		ProjectRoot: paths.Project.Root,
		ProjectKey:  paths.Project.Key,
		PID:         pid,
		Endpoint:    paths.Endpoint(),
		UpdatedAt:   time.Now().UTC(),
	}
}

// WriteState writes a user-only state file for daemon discovery.
func WriteState(paths Paths, state State) error {
	if state.ProjectRoot == "" {
		state.ProjectRoot = paths.Project.Root
	}
	if state.ProjectKey == "" {
		state.ProjectKey = paths.Project.Key
	}
	if state.Endpoint.Address == "" {
		state.Endpoint = paths.Endpoint()
	}
	if state.UpdatedAt.IsZero() {
		state.UpdatedAt = time.Now().UTC()
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return writeUserOnlyFile(paths.StatePath, append(data, '\n'))
}

// ReadState reads the persisted daemon discovery snapshot.
func ReadState(paths Paths) (State, error) {
	data, err := os.ReadFile(paths.StatePath)
	if err != nil {
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, err
	}
	return state, nil
}

func writeUserOnlyFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
