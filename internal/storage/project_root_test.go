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

func TestNewStoreDerivesProjectRootFromInRepoLayout(t *testing.T) {
	project := t.TempDir()
	store := NewStore(filepath.Join(project, ".knowns"))

	if store.ProjectRoot != project {
		t.Fatalf("ProjectRoot = %q, want %q", store.ProjectRoot, project)
	}
}

func TestNewStoreWithProjectRootKeepsRootsIndependent(t *testing.T) {
	knowledge := filepath.Join(t.TempDir(), "stores", "team", "shop-web")
	project := filepath.Join(t.TempDir(), "shop-web")

	store := NewStoreWithProjectRoot(knowledge, project)

	if store.Root != knowledge {
		t.Fatalf("Root = %q, want %q", store.Root, knowledge)
	}
	if store.ProjectRoot != project {
		t.Fatalf("ProjectRoot = %q, want %q", store.ProjectRoot, project)
	}
	if store.Docs.root != knowledge || store.Tasks.root != knowledge {
		t.Fatalf("entity stores must live under the knowledge root, got docs=%q tasks=%q", store.Docs.root, store.Tasks.root)
	}
}

func TestManagerActiveProjectRootReadsProjectRoot(t *testing.T) {
	knowledge := filepath.Join(t.TempDir(), "knowledge")
	project := filepath.Join(t.TempDir(), "code")
	m := &Manager{active: NewStoreWithProjectRoot(knowledge, project)}

	if got := m.ActiveProjectRoot(); got != project {
		t.Fatalf("ActiveProjectRoot() = %q, want %q", got, project)
	}
}

// TestNoCodeRootDerivedFromKnowledgeRoot guards the store decision: no
// production code may compute the code root as filepath.Dir(<something>.Root).
// Store.ProjectRoot is the only source of the code root.
func TestNoCodeRootDerivedFromKnowledgeRoot(t *testing.T) {
	moduleRoot := findModuleRoot(t)
	fset := token.NewFileSet()
	var offenders []string

	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(moduleRoot, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			file, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				return err
			}
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) != 1 || !isFilepathDir(call.Fun) {
					return true
				}
				if sel, ok := call.Args[0].(*ast.SelectorExpr); ok && sel.Sel.Name == "Root" {
					rel, _ := filepath.Rel(moduleRoot, path)
					offenders = append(offenders, rel+":"+strconv.Itoa(fset.Position(call.Pos()).Line))
				}
				return true
			})
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}

	if len(offenders) > 0 {
		t.Fatalf("code root derived from knowledge root; read Store.ProjectRoot instead:\n%s", strings.Join(offenders, "\n"))
	}
}

func isFilepathDir(fun ast.Expr) bool {
	sel, ok := fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Dir" {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "filepath"
}

func findModuleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found above test directory")
		}
		dir = parent
	}
}
