package search

import (
	"fmt"
	"runtime"
	"strings"
)

const macOSIntelONNXReason = "Local ONNX is not bundled for macOS Intel (x86_64). Use Ollama or an OpenAI-compatible API provider, or set KNOWNS_ORT_LIB to a compatible x86_64 libonnxruntime.dylib."

// LocalONNXCapability describes whether this installation can select the
// in-process ONNX embedding provider. macOS Intel releases intentionally ship
// without ONNX Runtime because upstream no longer publishes a compatible
// prebuilt dylib.
type LocalONNXCapability struct {
	Supported        bool   `json:"supported"`
	RuntimeAvailable bool   `json:"runtimeAvailable"`
	CustomLibrary    bool   `json:"customLibrary"`
	Reason           string `json:"reason,omitempty"`
}

// LocalONNXCapabilityForPlatform resolves support without depending on the
// current process architecture, which keeps release and platform tests
// deterministic.
func LocalONNXCapabilityForPlatform(goos, goarch, libraryPath string) LocalONNXCapability {
	runtimeAvailable := strings.TrimSpace(libraryPath) != ""
	if goos == "darwin" && goarch == "amd64" {
		if runtimeAvailable {
			return LocalONNXCapability{
				Supported:        true,
				RuntimeAvailable: true,
				CustomLibrary:    true,
			}
		}
		return LocalONNXCapability{
			Supported: false,
			Reason:    macOSIntelONNXReason,
		}
	}
	return LocalONNXCapability{
		Supported:        true,
		RuntimeAvailable: runtimeAvailable,
	}
}

// CurrentLocalONNXCapability reports support for the running binary. An
// explicitly supplied compatible library re-enables local ONNX on macOS Intel.
func CurrentLocalONNXCapability() LocalONNXCapability {
	return LocalONNXCapabilityForPlatform(runtime.GOOS, runtime.GOARCH, ResolveORTLibraryPath())
}

// RequireLocalONNX returns actionable guidance when local ONNX cannot be used
// by this installation.
func RequireLocalONNX() error {
	capability := CurrentLocalONNXCapability()
	if capability.Supported {
		return nil
	}
	return fmt.Errorf("%s", capability.Reason)
}
