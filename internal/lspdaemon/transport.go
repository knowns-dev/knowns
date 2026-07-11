package lspdaemon

import "runtime"

// TransportKind identifies the local IPC transport type.
type TransportKind string

const (
	TransportUnixSocket  TransportKind = "unix_socket"
	TransportWindowsPipe TransportKind = "windows_pipe"
)

// TransportEndpoint is the daemon endpoint a local client should dial.
type TransportEndpoint struct {
	Kind    TransportKind `json:"kind"`
	Address string        `json:"address"`
}

// Endpoint returns the local transport endpoint for the current OS.
func (p Paths) Endpoint() TransportEndpoint {
	return p.EndpointForGOOS(runtime.GOOS)
}

// EndpointForGOOS returns the endpoint naming strategy for goos.
func (p Paths) EndpointForGOOS(goos string) TransportEndpoint {
	if goos == "windows" {
		return TransportEndpoint{Kind: TransportWindowsPipe, Address: p.PipeName}
	}
	return TransportEndpoint{Kind: TransportUnixSocket, Address: p.SocketPath}
}

// WindowsPipeName returns the Windows named pipe endpoint for identity.
func WindowsPipeName(identity ProjectIdentity) string {
	key := identity.Key
	if key == "" {
		key = KeyForRoot(identity.Root)
	}
	return `\\.\pipe\knowns-lsp-` + key
}
