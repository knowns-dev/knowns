package lsp

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestNormalizeInitializeCapabilitiesSupportsBooleanAndObjectProviders(t *testing.T) {
	raw := map[string]json.RawMessage{
		"documentSymbolProvider":     json.RawMessage(`true`),
		"workspaceSymbolProvider":    json.RawMessage(`false`),
		"definitionProvider":         json.RawMessage(`{}`),
		"referencesProvider":         json.RawMessage(`{"workDoneProgress":true}`),
		"renameProvider":             json.RawMessage(`null`),
		"implementationProvider":     json.RawMessage(`true`),
		"diagnosticProvider":         json.RawMessage(`{"interFileDependencies":false}`),
		"documentFormattingProvider": json.RawMessage(`true`),
		"hoverProvider":              json.RawMessage(`true`),
		"completionProvider":         json.RawMessage(`{"resolveProvider":true}`),
		"documentLinkProvider":       json.RawMessage(`{}`),
	}

	want := []string{
		CapabilityCompletion,
		CapabilityDefinition,
		CapabilityDiagnostics,
		CapabilityDocumentLinks,
		CapabilityDocumentSymbols,
		CapabilityFormatting,
		CapabilityHover,
		CapabilityImplementation,
		CapabilityReferences,
	}
	if got := normalizeInitializeCapabilities(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeInitializeCapabilities() = %#v, want %#v", got, want)
	}
}

func TestCapabilitySnapshotCombinesOnlyAdvertisedAndObservedCapabilities(t *testing.T) {
	snapshot := newCapabilitySnapshot(
		true,
		[]string{CapabilityDocumentSymbols},
		[]string{CapabilityHover},
	)
	want := []string{CapabilityDocumentSymbols, CapabilityHover}
	if !reflect.DeepEqual(snapshot.Capabilities, want) {
		t.Fatalf("Capabilities = %#v, want %#v", snapshot.Capabilities, want)
	}
	if !reflect.DeepEqual(snapshot.Advertised, []string{CapabilityDocumentSymbols}) {
		t.Fatalf("Advertised = %#v", snapshot.Advertised)
	}
	if !reflect.DeepEqual(snapshot.Observed, []string{CapabilityHover}) {
		t.Fatalf("Observed = %#v", snapshot.Observed)
	}
}

func TestLegacyPushDiagnosticsRemainCallableBeforeObservation(t *testing.T) {
	server := NewServer(t.TempDir(), ServerCommand{Language: "yaml", Name: "yaml-language-server"})
	server.SetCapabilityProfile(DocumentConfigCapabilityProfile())
	server.mu.Lock()
	server.capabilitiesKnown = true
	server.advertisedCapabilities = []string{CapabilityDocumentSymbols}
	server.mu.Unlock()

	if err := server.requireCapability("diagnostics", CapabilityDiagnostics); err != nil {
		t.Fatalf("legacy push diagnostics rejected before observation: %v", err)
	}
	if snapshot := server.CapabilitySnapshot(); hasCapability(snapshot.Capabilities, CapabilityDiagnostics) {
		t.Fatalf("legacy push diagnostics promoted before observation: %#v", snapshot)
	}
}

func TestMissingCapabilitiesIsStableAndDeduplicated(t *testing.T) {
	got := missingCapabilities(
		[]string{CapabilityReferences, CapabilityDefinition, CapabilityReferences},
		[]string{CapabilityDefinition},
	)
	if want := []string{CapabilityReferences}; !reflect.DeepEqual(got, want) {
		t.Fatalf("missingCapabilities() = %#v, want %#v", got, want)
	}
}

func TestUnprofiledServerKeepsLegacyQueryCompatibility(t *testing.T) {
	server := NewServer(t.TempDir(), ServerCommand{Language: "plugin", Name: "plugin-ls"})
	server.mu.Lock()
	server.capabilitiesKnown = true
	server.mu.Unlock()

	if err := server.requireCapability("definition", CapabilityDefinition); err != nil {
		t.Fatalf("unprofiled server rejected legacy query: %v", err)
	}
	server.SetCapabilityProfile(CodeCapabilityProfile())
	if err := server.requireCapability("definition", CapabilityDefinition); err == nil {
		t.Fatal("profiled server accepted missing advertised capability")
	}
}
