package lsp

import (
	"fmt"
	"path/filepath"
)

// RuntimeError is an actionable LSP runtime failure suitable for MCP/CLI output.
type RuntimeError struct {
	Code                   string
	Language               string
	Backend                string
	Action                 string
	Message                string
	Explanation            string
	Capabilities           []string
	AdvertisedCapabilities []string
	Remediation            string
	LogPath                string
	Attempts               []BackendAttempt
	Cause                  error
}

func (e *RuntimeError) Error() string {
	if e == nil {
		return ""
	}
	msg := e.Message
	if msg == "" && e.Cause != nil {
		msg = e.Cause.Error()
	}
	if e.Remediation != "" {
		return fmt.Sprintf("%s. %s", msg, e.Remediation)
	}
	return msg
}

func (e *RuntimeError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func (e *RuntimeError) Payload() map[string]any {
	payload := map[string]any{
		"error":       e.Code,
		"language":    e.Language,
		"message":     e.Message,
		"remediation": e.Remediation,
	}
	if e.Backend != "" {
		payload["backend"] = e.Backend
	}
	if e.Action != "" {
		payload["action"] = e.Action
	}
	if e.Explanation != "" {
		payload["explanation"] = e.Explanation
	}
	if len(e.Capabilities) > 0 {
		payload["capabilities"] = e.Capabilities
	}
	if len(e.AdvertisedCapabilities) > 0 {
		payload["advertised_capabilities"] = e.AdvertisedCapabilities
	} else if e.Code == "unsupported_capability" {
		payload["advertised_capabilities"] = []string{}
	}
	if e.LogPath != "" {
		payload["log_path"] = e.LogPath
	}
	if len(e.Attempts) > 0 {
		payload["attempts"] = e.Attempts
	}
	if e.Cause != nil {
		payload["cause"] = e.Cause.Error()
	}
	return payload
}

func CSharpLogPath(root, backend string) string {
	if backend == "" {
		backend = CSharpLanguageID
	}
	return filepath.Join(root, ".knowns", "logs", "lsp", CSharpLanguageID+"-"+backend+".log")
}
