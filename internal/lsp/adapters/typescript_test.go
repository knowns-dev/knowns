package adapters

import (
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

// The manager wires per-path document sync through a type assertion, so a
// drifted method signature would not fail anything: every file would quietly go
// back to being opened as "typescript". This turns that drift into a build
// failure.
var _ lsp.PathDocumentSyncAdapter = (*TypeScriptAdapter)(nil)

// TestTypeScriptAdapterSendsLanguageIDPerExtension covers the defect where every
// file this adapter serves was opened with languageId "typescript". tsserver
// picks the script kind from that identifier, so a .tsx page was parsed as plain
// TypeScript and its components came back as <unknown> symbols.
func TestTypeScriptAdapterSendsLanguageIDPerExtension(t *testing.T) {
	adapter := NewTypeScriptAdapter()
	for _, tt := range []struct{ path, want string }{
		{"src/index.ts", "typescript"},
		{"src/types.d.ts", "typescript"},
		{"src/pages/AuditPage.tsx", "typescriptreact"},
		{"src/util.js", "javascript"},
		{"src/Button.jsx", "javascriptreact"},
		{"src/PAGE.TSX", "typescriptreact"},
		{`C:\repo\src\Legacy.JSX`, "javascriptreact"},
		{`C:\repo\src\index.JS`, "javascript"},
	} {
		t.Run(tt.path, func(t *testing.T) {
			got := adapter.DocumentSyncForPath(tt.path)
			if got.LanguageID != tt.want {
				t.Errorf("DocumentSyncForPath(%q).LanguageID = %q, want %q", tt.path, got.LanguageID, tt.want)
			}
			if got.Suppress {
				t.Errorf("DocumentSyncForPath(%q) suppressed sync; every TypeScript-family file must open on the server", tt.path)
			}
		})
	}
}

// TestTypeScriptAdapterMapsEveryClaimedExtension forces a decision whenever the
// adapter starts claiming a new extension. Without it, an added extension falls
// through to "typescript", which is exactly how .tsx and .jsx were misparsed.
func TestTypeScriptAdapterMapsEveryClaimedExtension(t *testing.T) {
	want := map[string]string{
		".ts":  "typescript",
		".tsx": "typescriptreact",
		".js":  "javascript",
		".jsx": "javascriptreact",
	}
	adapter := NewTypeScriptAdapter()
	for _, ext := range adapter.Extensions() {
		expected, ok := want[ext]
		if !ok {
			t.Errorf("extension %q is claimed by the adapter but has no expected language identifier; decide which identifier tsserver needs for it before adding it", ext)
			continue
		}
		if got := adapter.DocumentSyncForPath("file" + ext).LanguageID; got != expected {
			t.Errorf("extension %q opens as %q, want %q", ext, got, expected)
		}
	}
}
