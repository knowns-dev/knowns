package search

import (
	"strings"
	"testing"
)

func TestLocalONNXCapabilityForPlatform(t *testing.T) {
	tests := []struct {
		name       string
		goos       string
		goarch     string
		library    string
		supported  bool
		available  bool
		custom     bool
		reasonText string
	}{
		{
			name:      "macOS Apple Silicon remains supported",
			goos:      "darwin",
			goarch:    "arm64",
			supported: true,
		},
		{
			name:       "macOS Intel defaults to remote semantic providers",
			goos:       "darwin",
			goarch:     "amd64",
			reasonText: "Ollama",
		},
		{
			name:      "macOS Intel accepts an explicit compatible runtime",
			goos:      "darwin",
			goarch:    "amd64",
			library:   "/opt/onnx/libonnxruntime.dylib",
			supported: true,
			available: true,
			custom:    true,
		},
		{
			name:      "Linux remains supported",
			goos:      "linux",
			goarch:    "amd64",
			supported: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			capability := LocalONNXCapabilityForPlatform(test.goos, test.goarch, test.library)
			if capability.Supported != test.supported {
				t.Fatalf("Supported = %v, want %v", capability.Supported, test.supported)
			}
			if capability.RuntimeAvailable != test.available {
				t.Fatalf("RuntimeAvailable = %v, want %v", capability.RuntimeAvailable, test.available)
			}
			if capability.CustomLibrary != test.custom {
				t.Fatalf("CustomLibrary = %v, want %v", capability.CustomLibrary, test.custom)
			}
			if test.reasonText != "" && !strings.Contains(capability.Reason, test.reasonText) {
				t.Fatalf("Reason = %q, want text %q", capability.Reason, test.reasonText)
			}
		})
	}
}
