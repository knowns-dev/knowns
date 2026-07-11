package handlers

import (
	"context"

	"github.com/howznguyen/knowns/internal/lsp"
)

// CodeRuntime is the code-intelligence boundary used by MCP code tools.
// Implementations may be local manager-backed or daemon/client-backed.
type CodeRuntime interface {
	WithSession(ctx context.Context, path string, fn func(lsp.Session) error) error
	DescribeRuntimeError(path string, err error) *lsp.RuntimeError
}

func codeRuntimeFromLSPManagerProvider(getLSPManager func() *lsp.Manager) func() CodeRuntime {
	return func() CodeRuntime {
		if getLSPManager == nil {
			return nil
		}
		return NewManagerCodeRuntime(getLSPManager())
	}
}

func NewManagerCodeRuntime(manager *lsp.Manager) CodeRuntime {
	if manager == nil {
		return nil
	}
	return managerCodeRuntime{manager: manager}
}

type managerCodeRuntime struct {
	manager *lsp.Manager
}

func (r managerCodeRuntime) WithSession(ctx context.Context, path string, fn func(lsp.Session) error) error {
	if r.manager == nil {
		return lsp.ErrServerUnavailable
	}
	return r.manager.WithSession(ctx, path, fn)
}

func (r managerCodeRuntime) DescribeRuntimeError(path string, err error) *lsp.RuntimeError {
	if r.manager == nil {
		return nil
	}
	return r.manager.DescribeRuntimeError(path, err)
}
