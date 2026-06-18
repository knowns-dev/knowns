package lsp

import "context"

// Session is the shared runtime surface used by code intelligence callers.
// It hides process ownership and JSON-RPC plumbing behind language-neutral
// lifecycle, file sync, query, edit, readiness, and diagnostics operations.
type Session interface {
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	WaitReady(ctx context.Context)
	Alive() bool
	WithFile(ctx context.Context, path string, fn func() error) error
	DidChange(ctx context.Context, path, text string) error

	Definition(ctx context.Context, path string, line, col int) (Location, error)
	References(ctx context.Context, path string, line, col int) ([]Location, error)
	Implementations(ctx context.Context, path string, line, col int) ([]Location, error)
	Diagnostics(ctx context.Context, path string) ([]Diagnostic, error)
	DocumentSymbols(ctx context.Context, path string) ([]DocumentSymbol, error)
	WorkspaceSymbol(ctx context.Context, query string) ([]WorkspaceSymbolResult, error)
	Rename(ctx context.Context, path string, line, col int, newName string) (*WorkspaceEdit, error)
}

var _ Session = (*Server)(nil)
