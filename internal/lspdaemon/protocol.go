package lspdaemon

import (
	"errors"

	"github.com/howznguyen/knowns/internal/lsp"
)

type Operation string

const (
	OperationPing            Operation = "ping"
	OperationDefinition      Operation = "definition"
	OperationReferences      Operation = "references"
	OperationImplementations Operation = "implementations"
	OperationDiagnostics     Operation = "diagnostics"
	OperationDocumentSymbols Operation = "document_symbols"
	OperationWorkspaceSymbol Operation = "workspace_symbol"
	OperationRename          Operation = "rename"
	OperationDidChange       Operation = "did_change"
	OperationStatus          Operation = "status"
	OperationStartLanguage   Operation = "start_language"
	OperationStopLanguage    Operation = "stop_language"
	OperationRestartLanguage Operation = "restart_language"
	OperationApplyConfig     Operation = "apply_config"
	OperationAcquireLease    Operation = "lease_acquire"
	OperationReleaseLease    Operation = "lease_release"
)

type Request struct {
	Handshake
	Operation Operation `json:"operation"`
	Path      string    `json:"path,omitempty"`
	Language  string    `json:"language,omitempty"`
	Query     string    `json:"query,omitempty"`
	Text      string    `json:"text,omitempty"`
	Line      int       `json:"line,omitempty"`
	Character int       `json:"character,omitempty"`
	NewName   string    `json:"newName,omitempty"`
	Owner     string    `json:"owner,omitempty"`
	TTLMillis int64     `json:"ttlMillis,omitempty"`
}

type Response struct {
	Error                  string                      `json:"error,omitempty"`
	RuntimeError           *RuntimeErrorPayload        `json:"runtime_error,omitempty"`
	Location               lsp.Location                `json:"location,omitempty"`
	Locations              []lsp.Location              `json:"locations,omitempty"`
	Diagnostics            []lsp.Diagnostic            `json:"diagnostics,omitempty"`
	DocumentSymbols        []lsp.DocumentSymbol        `json:"document_symbols,omitempty"`
	WorkspaceSymbolResults []lsp.WorkspaceSymbolResult `json:"workspace_symbol_results,omitempty"`
	WorkspaceEdit          *lsp.WorkspaceEdit          `json:"workspace_edit,omitempty"`
	Statuses               []lsp.LanguageRuntimeStatus `json:"statuses,omitempty"`
}

type RuntimeErrorPayload struct {
	Code                   string               `json:"code,omitempty"`
	Language               string               `json:"language,omitempty"`
	Backend                string               `json:"backend,omitempty"`
	Action                 string               `json:"action,omitempty"`
	Message                string               `json:"message,omitempty"`
	Explanation            string               `json:"explanation,omitempty"`
	Capabilities           []string             `json:"capabilities,omitempty"`
	AdvertisedCapabilities []string             `json:"advertised_capabilities,omitempty"`
	Remediation            string               `json:"remediation,omitempty"`
	LogPath                string               `json:"log_path,omitempty"`
	Attempts               []lsp.BackendAttempt `json:"attempts,omitempty"`
	Cause                  string               `json:"cause,omitempty"`
}

func runtimeErrorPayload(err *lsp.RuntimeError) *RuntimeErrorPayload {
	if err == nil {
		return nil
	}
	payload := &RuntimeErrorPayload{
		Code:                   err.Code,
		Language:               err.Language,
		Backend:                err.Backend,
		Action:                 err.Action,
		Message:                err.Message,
		Explanation:            err.Explanation,
		Capabilities:           append([]string(nil), err.Capabilities...),
		AdvertisedCapabilities: append([]string(nil), err.AdvertisedCapabilities...),
		Remediation:            err.Remediation,
		LogPath:                err.LogPath,
		Attempts:               append([]lsp.BackendAttempt(nil), err.Attempts...),
	}
	if err.Cause != nil {
		payload.Cause = err.Cause.Error()
	}
	return payload
}

func (p *RuntimeErrorPayload) toError() *lsp.RuntimeError {
	if p == nil {
		return nil
	}
	var cause error
	if p.Cause != "" {
		cause = errors.New(p.Cause)
	}
	return &lsp.RuntimeError{
		Code:                   p.Code,
		Language:               p.Language,
		Backend:                p.Backend,
		Action:                 p.Action,
		Message:                p.Message,
		Explanation:            p.Explanation,
		Capabilities:           append([]string(nil), p.Capabilities...),
		AdvertisedCapabilities: append([]string(nil), p.AdvertisedCapabilities...),
		Remediation:            p.Remediation,
		LogPath:                p.LogPath,
		Attempts:               append([]lsp.BackendAttempt(nil), p.Attempts...),
		Cause:                  cause,
	}
}

func (r Response) err() error {
	if r.RuntimeError != nil {
		return r.RuntimeError.toError()
	}
	if r.Error != "" {
		return errors.New(r.Error)
	}
	return nil
}
