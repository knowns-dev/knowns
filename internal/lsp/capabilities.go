package lsp

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

const (
	CapabilityDocumentSymbols  = "document_symbols"
	CapabilityWorkspaceSymbols = "workspace_symbols"
	CapabilityDefinition       = "definition"
	CapabilityReferences       = "references"
	CapabilityRename           = "rename"
	CapabilityImplementation   = "implementation"
	CapabilityDiagnostics      = "diagnostics"
	CapabilityFormatting       = "formatting"
	CapabilityHover            = "hover"
	CapabilityCompletion       = "completion"
	CapabilityDocumentLinks    = "document_links"
)

// CapabilityProfile defines the minimum runtime contract expected from an
// adapter. LegacyPushDiagnostics is explicit because publishDiagnostics is a
// server notification and therefore is not advertised by legacy LSP servers
// in their initialize response.
type CapabilityProfile struct {
	Required              []string
	LegacyPushDiagnostics bool
	EnforceAdvertised     bool
}

// CapabilityBaselineProvider is optional so existing built-in and plugin
// adapters keep their current behavior until they deliberately opt in.
type CapabilityBaselineProvider interface {
	CapabilityProfile() CapabilityProfile
}

// CodeCapabilityProfile is the baseline for code-language adapters.
func CodeCapabilityProfile() CapabilityProfile {
	return CapabilityProfile{
		Required: []string{
			CapabilityDocumentSymbols,
			CapabilityDefinition,
			CapabilityReferences,
		},
		EnforceAdvertised: true,
	}
}

// DocumentConfigCapabilityProfile is the baseline for documentation and
// configuration adapters. These servers commonly use legacy push diagnostics.
func DocumentConfigCapabilityProfile() CapabilityProfile {
	return CapabilityProfile{
		Required:              []string{CapabilityDocumentSymbols, CapabilityDiagnostics},
		LegacyPushDiagnostics: true,
		EnforceAdvertised:     true,
	}
}

func capabilityProfileForAdapter(adapter LanguageAdapter) CapabilityProfile {
	provider, ok := adapter.(CapabilityBaselineProvider)
	if !ok {
		return CapabilityProfile{}
	}
	profile := provider.CapabilityProfile()
	profile.Required = normalizeCapabilities(profile.Required)
	return profile
}

// CapabilitySnapshot separates initialize-advertised support from support
// observed at runtime. Capabilities is the effective normalized union.
type CapabilitySnapshot struct {
	Known        bool     `json:"known"`
	Capabilities []string `json:"capabilities,omitempty"`
	Advertised   []string `json:"advertised_capabilities,omitempty"`
	Observed     []string `json:"observed_capabilities,omitempty"`
}

func newCapabilitySnapshot(known bool, advertised, observed []string) CapabilitySnapshot {
	advertised = normalizeCapabilities(advertised)
	observed = normalizeCapabilities(observed)
	effective := append(append([]string(nil), advertised...), observed...)
	return CapabilitySnapshot{
		Known:        known,
		Capabilities: normalizeCapabilities(effective),
		Advertised:   advertised,
		Observed:     observed,
	}
}

// SetCapabilityProfile configures the static baseline and legacy-diagnostics
// expectation for this server without changing the advertised capability set.
func (s *Server) SetCapabilityProfile(profile CapabilityProfile) {
	if s == nil {
		return
	}
	profile.Required = normalizeCapabilities(profile.Required)
	s.mu.Lock()
	s.capabilityProfile = profile
	s.mu.Unlock()
}

// CapabilitySnapshot returns immutable copies of the current capability state.
func (s *Server) CapabilitySnapshot() CapabilitySnapshot {
	if s == nil {
		return CapabilitySnapshot{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	observed := make([]string, 0, len(s.observedCapabilities))
	for capability := range s.observedCapabilities {
		observed = append(observed, capability)
	}
	return newCapabilitySnapshot(s.capabilitiesKnown, s.advertisedCapabilities, observed)
}

func (s *Server) clearCapabilitiesLocked() {
	s.capabilitiesKnown = false
	s.advertisedCapabilities = nil
	s.observedCapabilities = make(map[string]struct{})
}

func (s *Server) observeCapabilityLocked(capability string) {
	if s.observedCapabilities == nil {
		s.observedCapabilities = make(map[string]struct{})
	}
	capability = strings.ToLower(strings.TrimSpace(capability))
	if capability != "" {
		s.observedCapabilities[capability] = struct{}{}
	}
}

func (s *Server) requireCapability(action, capability string) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	profile := s.capabilityProfile
	s.mu.Unlock()
	if !profile.EnforceAdvertised {
		return nil
	}
	snapshot := s.CapabilitySnapshot()
	if !snapshot.Known || hasCapability(snapshot.Capabilities, capability) {
		return nil
	}
	if capability == CapabilityDiagnostics && profile.LegacyPushDiagnostics {
		return nil
	}
	backend := s.capabilityBackend()
	explanation := fmt.Sprintf("the %s backend did not advertise or establish the %s capability", backend, capability)
	return s.unsupportedCapabilityError(action, explanation, snapshot.Capabilities, snapshot.Advertised)
}

func (s *Server) requirePathCapability(path, action, capability string) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	adapter := s.pathCapabilityAdapter
	s.mu.Unlock()
	if adapter == nil {
		return nil
	}
	decision, handled := adapter.PathCapabilityForAction(path, action, capability)
	if !handled || decision.Supported {
		return nil
	}
	explanation := strings.TrimSpace(decision.Explanation)
	if explanation == "" {
		explanation = fmt.Sprintf("the %s backend does not support action %q for this path", s.capabilityBackend(), action)
	}
	return s.unsupportedCapabilityError(action, explanation, decision.Capabilities, decision.AdvertisedCapabilities)
}

func (s *Server) pathCapabilityBlocksAll(path string) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	adapter := s.pathCapabilityAdapter
	s.mu.Unlock()
	if adapter == nil {
		return false
	}
	decision, handled := adapter.PathCapabilityForAction(path, "", "")
	return handled && !decision.Supported
}

func (s *Server) capabilityBackend() string {
	backend := strings.TrimSpace(s.Command.Backend)
	if backend == "" {
		backend = strings.TrimSpace(s.Command.Name)
	}
	return backend
}

func (s *Server) unsupportedCapabilityError(action, explanation string, capabilities, advertised []string) *RuntimeError {
	return &RuntimeError{
		Code:                   "unsupported_capability",
		Language:               s.Command.Language,
		Backend:                s.capabilityBackend(),
		Action:                 action,
		Message:                fmt.Sprintf("LSP action %q is unavailable", action),
		Explanation:            explanation,
		Capabilities:           normalizeCapabilities(capabilities),
		AdvertisedCapabilities: normalizeCapabilities(advertised),
	}
}

func normalizeCapabilities(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "" {
			seen[value] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func missingCapabilities(required, available []string) []string {
	availableSet := make(map[string]struct{}, len(available))
	for _, capability := range normalizeCapabilities(available) {
		availableSet[capability] = struct{}{}
	}
	missing := make([]string, 0)
	for _, capability := range normalizeCapabilities(required) {
		if _, ok := availableSet[capability]; !ok {
			missing = append(missing, capability)
		}
	}
	return missing
}

func hasCapability(capabilities []string, capability string) bool {
	capability = strings.ToLower(strings.TrimSpace(capability))
	for _, candidate := range capabilities {
		if candidate == capability {
			return true
		}
	}
	return false
}

func normalizeInitializeCapabilities(raw map[string]json.RawMessage) []string {
	providers := map[string]string{
		"documentSymbolProvider":     CapabilityDocumentSymbols,
		"workspaceSymbolProvider":    CapabilityWorkspaceSymbols,
		"definitionProvider":         CapabilityDefinition,
		"referencesProvider":         CapabilityReferences,
		"renameProvider":             CapabilityRename,
		"implementationProvider":     CapabilityImplementation,
		"diagnosticProvider":         CapabilityDiagnostics,
		"documentFormattingProvider": CapabilityFormatting,
		"hoverProvider":              CapabilityHover,
		"completionProvider":         CapabilityCompletion,
		"documentLinkProvider":       CapabilityDocumentLinks,
	}
	capabilities := make([]string, 0, len(providers))
	for provider, capability := range providers {
		if providerEnabled(raw[provider]) {
			capabilities = append(capabilities, capability)
		}
	}
	return normalizeCapabilities(capabilities)
}

func providerEnabled(raw json.RawMessage) bool {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "false" {
		return false
	}
	if string(raw) == "true" {
		return true
	}
	var object map[string]any
	return json.Unmarshal(raw, &object) == nil && object != nil
}
