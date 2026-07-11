package lspdaemon

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
)

const daemonRuntimeDir = "lsp-daemon"

// Paths contains all project-scoped daemon filesystem paths and local endpoint
// names derived from a canonical project identity.
type Paths struct {
	Project ProjectIdentity `json:"project"`

	GlobalRoot  string `json:"global_root"`
	RuntimeRoot string `json:"runtime_root"`
	DaemonDir   string `json:"daemon_dir"`

	LockPath  string `json:"lock_path"`
	StatePath string `json:"state_path"`
	TokenPath string `json:"token_path"`
	LogPath   string `json:"log_path"`

	SocketPath string `json:"socket_path"`
	PipeName   string `json:"pipe_name"`
}

// GlobalRoot returns the Knowns user state directory.
func GlobalRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(os.TempDir(), ".knowns")
	}
	return filepath.Join(home, ".knowns")
}

// RuntimeRoot returns the Knowns runtime root used by shared runtime helpers.
func RuntimeRoot() string {
	return filepath.Join(GlobalRoot(), "runtime")
}

// PathsForProject resolves root and returns project-scoped daemon paths.
func PathsForProject(root string) (Paths, error) {
	identity, err := IdentifyProject(root)
	if err != nil {
		return Paths{}, err
	}
	return PathsForIdentity(identity), nil
}

// PathsForIdentity returns project-scoped daemon paths for identity.
func PathsForIdentity(identity ProjectIdentity) Paths {
	globalRoot := GlobalRoot()
	runtimeRoot := filepath.Join(globalRoot, "runtime")
	daemonDir := filepath.Join(runtimeRoot, daemonRuntimeDir, identity.Key)
	return Paths{
		Project:     identity,
		GlobalRoot:  globalRoot,
		RuntimeRoot: runtimeRoot,
		DaemonDir:   daemonDir,
		LockPath:    filepath.Join(daemonDir, "daemon.lock"),
		StatePath:   filepath.Join(daemonDir, "state.json"),
		TokenPath:   filepath.Join(daemonDir, "token"),
		LogPath:     filepath.Join(daemonDir, "daemon.log"),
		SocketPath:  filepath.Join(os.TempDir(), "knowns-lsp-"+shortKey(identity.Key)+".sock"),
		PipeName:    WindowsPipeName(identity),
	}
}

func shortKey(key string) string {
	hash := sha256.Sum256([]byte(key))
	return hex.EncodeToString(hash[:])[:16]
}

// EnsureDir creates the per-project daemon directory with user-only
// permissions where supported.
func (p Paths) EnsureDir() error {
	return os.MkdirAll(p.DaemonDir, 0o700)
}
