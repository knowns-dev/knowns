package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/search"
)

func extractFileLSP(ctx context.Context, mgr *lsp.Manager, root, absPath string) []search.CodeSummary {
	var symbols []lsp.DocumentSymbol
	err := mgr.WithSession(ctx, absPath, func(session lsp.Session) error {
		var callErr error
		symbols, callErr = session.DocumentSymbols(ctx, absPath)
		return callErr
	})
	if err != nil || len(symbols) == 0 {
		return nil
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil
	}
	relPath, _ := filepath.Rel(root, absPath)
	return search.BuildCodeSummaries(filepath.ToSlash(relPath), symbols, string(data))
}

func findSourceFiles(root string) []string {
	files := []string{}
	skipDirs := map[string]bool{
		".":            true,
		"node_modules": true,
		"vendor":       true,
		"dist":         true,
		"build":        true,
		".git":         true,
	}

	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || len(files) >= 200 {
			return err
		}
		if d.IsDir() {
			if skipDirs[d.Name()] && p != root {
				return filepath.SkipDir
			}
			return nil
		}
		if isSourceExt(strings.ToLower(filepath.Ext(p))) {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return files
	}
	return files
}

func isSourceExt(ext string) bool {
	switch ext {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs",
		".java", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp",
		".cs", ".rb", ".php", ".swift", ".kt", ".kts":
		return true
	default:
		return false
	}
}
