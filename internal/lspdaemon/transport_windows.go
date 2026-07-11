//go:build windows

package lspdaemon

import (
	"context"
	"fmt"
	"net"

	"github.com/Microsoft/go-winio"
)

func dialEndpoint(ctx context.Context, endpoint TransportEndpoint) (net.Conn, error) {
	if endpoint.Kind != TransportWindowsPipe {
		return nil, fmt.Errorf("unsupported LSP daemon transport %q", endpoint.Kind)
	}
	return winio.DialPipeContext(ctx, endpoint.Address)
}

func listenEndpoint(paths Paths) (net.Listener, error) {
	endpoint := paths.Endpoint()
	if endpoint.Kind != TransportWindowsPipe {
		return nil, fmt.Errorf("unsupported LSP daemon transport %q", endpoint.Kind)
	}
	return winio.ListenPipe(endpoint.Address, nil)
}

func cleanupEndpoint(Paths) {}
