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
	err := mgr.WithFile(ctx, absPath, func(srv *lsp.Server) error {
		var callErr error
		symbols, callErr = srv.DocumentSymbols(ctx, absPath)
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

func extractFileRegex(absPath, root string) []search.CodeSummary {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil
	}
	rel, _ := filepath.Rel(root, absPath)
	ext := strings.ToLower(filepath.Ext(absPath))
	source := string(data)

	switch ext {
	case ".ts", ".tsx", ".js", ".jsx":
		return extractTSSymbols(filepath.ToSlash(rel), source)
	case ".py":
		return extractPythonSymbols(filepath.ToSlash(rel), source)
	case ".rs":
		return extractRustSymbols(filepath.ToSlash(rel), source)
	case ".cs":
		return extractCSymbols(filepath.ToSlash(rel), source)
	case ".java":
		return extractJavaSymbols(filepath.ToSlash(rel), source)
	case ".kt", ".kts":
		return extractKotlinSymbols(filepath.ToSlash(rel), source)
	case ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp":
		return extractCppSymbols(filepath.ToSlash(rel), source)
	case ".php":
		return extractPHPSymbols(filepath.ToSlash(rel), source)
	case ".rb":
		return extractRubySymbols(filepath.ToSlash(rel), source)
	case ".swift":
		return extractSwiftSymbols(filepath.ToSlash(rel), source)
	default:
		return extractGoSymbols(filepath.ToSlash(rel), source)
	}
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
