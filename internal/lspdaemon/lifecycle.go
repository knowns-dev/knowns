package lspdaemon

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
)

const (
	EnvDaemonMode        = "KNOWNS_LSP_DAEMON"
	EnvDaemonIdleTimeout = "KNOWNS_LSP_DAEMON_IDLE_TIMEOUT"
	EnvDaemonLeaseTTL    = "KNOWNS_LSP_DAEMON_LEASE_TTL"

	DaemonStateRunning       = "running"
	DaemonStateUnavailable   = "unavailable"
	DaemonStateDisabledByEnv = "disabled_by_env"

	defaultIdleTimeout = 10 * time.Minute
	defaultLeaseTTL    = 30 * time.Minute
)

var ErrDisabledByEnv = errors.New("LSP daemon disabled by KNOWNS_LSP_DAEMON")

type DaemonError struct {
	Operation string
	LogPath   string
	StatePath string
	Cause     error
}

func (e *DaemonError) Error() string {
	operation := strings.TrimSpace(e.Operation)
	if operation == "" {
		operation = "use LSP daemon"
	}
	message := "LSP daemon unavailable during " + operation
	if e.Cause != nil {
		message += ": " + e.Cause.Error()
	}
	if e.LogPath != "" {
		message += "; check daemon log " + e.LogPath
	}
	if e.StatePath != "" {
		message += "; status state " + e.StatePath
	}
	message += "; run `knowns lsp list --json` for current daemon/LSP status"
	return message
}

func (e *DaemonError) Unwrap() error {
	return e.Cause
}

func DisabledByEnv() bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(EnvDaemonMode)))
	switch value {
	case "0", "false", "off", "disabled", "disable", "no":
		return true
	default:
		return false
	}
}

func DisabledWarning() string {
	return "KNOWNS_LSP_DAEMON=0 disables shared LSP daemon routing; code requests may fan out duplicate per-process language servers"
}

func IdleTimeoutFromEnv() time.Duration {
	return durationFromEnv(EnvDaemonIdleTimeout, defaultIdleTimeout)
}

func LeaseTTLFromEnv() time.Duration {
	return durationFromEnv(EnvDaemonLeaseTTL, defaultLeaseTTL)
}

func durationFromEnv(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	if duration < 0 {
		return 0
	}
	return duration
}

func AnnotateLocalStatuses(statuses []lsp.LanguageRuntimeStatus, daemonState string) []lsp.LanguageRuntimeStatus {
	for i := range statuses {
		statuses[i].Owner = "local"
		statuses[i].DaemonState = daemonState
	}
	return statuses
}

func formatDeadline(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func (c *Client) daemonError(operation string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrDisabledByEnv) {
		return err
	}
	return &DaemonError{
		Operation: operation,
		LogPath:   c.paths.LogPath,
		StatePath: c.paths.StatePath,
		Cause:     err,
	}
}

func validateLeaseOwner(owner string) (string, error) {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return "", errors.New("lease owner is required")
	}
	if len(owner) > 80 {
		return "", fmt.Errorf("lease owner %q is too long", owner)
	}
	return owner, nil
}
