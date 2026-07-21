package lspdaemon

import (
	"errors"
	"reflect"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestRuntimeErrorPayloadRoundTripsUnsupportedCapability(t *testing.T) {
	want := &lsp.RuntimeError{
		Code:                   "unsupported_capability",
		Language:               "json",
		Backend:                "vscode-json-languageserver",
		Action:                 "references",
		Message:                "LSP action is unavailable",
		Explanation:            "backend did not advertise references",
		Capabilities:           []string{lsp.CapabilityDiagnostics, lsp.CapabilityDocumentSymbols},
		AdvertisedCapabilities: []string{lsp.CapabilityDocumentSymbols},
	}

	err := (Response{RuntimeError: runtimeErrorPayload(want)}).err()
	var got *lsp.RuntimeError
	if !errors.As(err, &got) {
		t.Fatalf("Response.err() = %v, want RuntimeError", err)
	}
	if got.Code != want.Code || got.Language != want.Language || got.Backend != want.Backend || got.Action != want.Action || got.Explanation != want.Explanation {
		t.Fatalf("round trip = %#v, want %#v", got, want)
	}
	if !reflect.DeepEqual(got.Capabilities, want.Capabilities) || !reflect.DeepEqual(got.AdvertisedCapabilities, want.AdvertisedCapabilities) {
		t.Fatalf("round-trip capabilities = %#v/%#v", got.Capabilities, got.AdvertisedCapabilities)
	}
}
