package adapters

import "github.com/howznguyen/knowns/internal/lsp"

// AllAdapters returns all Phase 1 adapters.
func AllAdapters() []lsp.LanguageAdapter {
	return []lsp.LanguageAdapter{
		NewGoAdapter(),
		NewTypeScriptAdapter(),
		NewPythonAdapter(),
		NewRustAnalyzerAdapter(),
		NewClangdAdapter(),
		NewJdtlsAdapter(),
		NewRoslynAdapter(),
		NewRubyLspAdapter(),
		NewIntelephenseAdapter(),
		NewScssAdapter(),
	}
}

// All returns all built-in language adapters supported by the LSP CLI.
func All() []lsp.LanguageAdapter {
	return AllAdapters()
}

// Find returns the adapter for id.
func Find(id string) (lsp.LanguageAdapter, bool) {
	for _, adapter := range AllAdapters() {
		if adapter.ID() == id {
			return adapter, true
		}
	}
	return nil, false
}
