package storage

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Store spec D10 and AC-28: every Doc write reaches the filesystem through
// the mutation path, which holds withDocMutationLocks, and the sync daemon
// joins those locks through Store.WithSyncLocks. This guard keeps DocStore's
// write methods callable only from that path.
func TestDocStoreWritesOnlyHappenUnderMutationLocks(t *testing.T) {
	writeMethods := map[string]bool{"Create": true, "Update": true, "Rename": true, "Delete": true, "RewriteDocReferences": true}
	allowedFiles := map[string]bool{
		"internal/storage/mutation_transaction.go": true, // runs every write inside withDocMutationLocks
		"internal/storage/doc_store.go":            true, // RewriteDocReferences delegates to Update
	}
	moduleRoot := findModuleRoot(t)
	fset := token.NewFileSet()
	var offenders []string
	for _, dir := range []string{"internal", "cmd"} {
		_ = filepath.WalkDir(filepath.Join(moduleRoot, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, _ := filepath.Rel(moduleRoot, path)
			rel = filepath.ToSlash(rel)
			file, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				t.Fatalf("parse %s: %v", rel, err)
			}
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || !writeMethods[sel.Sel.Name] {
					return true
				}
				if receiverIsDocStore(sel.X) && !allowedFiles[rel] {
					offenders = append(offenders, rel+":"+strconv.Itoa(fset.Position(call.Pos()).Line)+" "+sel.Sel.Name)
				}
				return true
			})
			return nil
		})
	}
	if len(offenders) > 0 {
		t.Fatalf("Doc writes outside the locked mutation path; use Store.MutateDocWithHistory or DeleteDocWithExpectedHash:\n%s", strings.Join(offenders, "\n"))
	}
}

// receiverIsDocStore recognises the receivers Doc writes use: x.Docs and a
// DocStore method receiver named ds.
func receiverIsDocStore(x ast.Expr) bool {
	switch v := x.(type) {
	case *ast.SelectorExpr:
		return v.Sel.Name == "Docs"
	case *ast.Ident:
		return v.Name == "ds"
	}
	return false
}
