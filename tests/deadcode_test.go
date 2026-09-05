package tests

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDeadCode_UnusedFunctions parses internal/cli/*.go using AST and detects
// unexported functions that are defined but never referenced anywhere in the package.
// Interface method implementations and init() are excluded.
//
// Declarations are collected from production files only, but references are
// counted across the test files too: a helper the package's own tests exercise
// is reachable code, and reporting it as dead would push authors to delete the
// thing under test or to bolt on a fake production caller.
func TestDeadCode_UnusedFunctions(t *testing.T) {
	cliDir := filepath.Join(getProjectRoot(t), "internal", "cli")

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, cliDir, nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("failed to parse cli package: %v", err)
	}

	// Test files may sit in "cli" or in the external "cli_test" package; both
	// reference the same identifiers.
	var files []*ast.File
	for name, pkg := range pkgs {
		if name != "cli" && name != "cli_test" {
			continue
		}
		for _, file := range pkg.Files {
			files = append(files, file)
		}
	}
	if _, ok := pkgs["cli"]; !ok {
		t.Fatal("package 'cli' not found in internal/cli")
	}

	type funcInfo struct {
		name string
		pos  token.Position
	}

	// Collect all unexported top-level function declarations, production only.
	funcDefs := make(map[string]funcInfo)
	for name, file := range pkgs["cli"].Files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil {
				continue
			}
			name := fn.Name.Name
			if name == "init" || name == "main" || ast.IsExported(name) {
				continue
			}
			funcDefs[name] = funcInfo{
				name: name,
				pos:  fset.Position(fn.Pos()),
			}
		}
	}

	// Count all identifier usages across the package (excluding the func declaration itself).
	usages := make(map[string]int)
	for _, file := range files {
		ast.Inspect(file, func(n ast.Node) bool {
			ident, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			if _, tracked := funcDefs[ident.Name]; tracked {
				usages[ident.Name]++
			}
			return true
		})
	}

	// A function name appears at least once as its own declaration identifier.
	// If total usages <= 1, it's never called.
	var dead []funcInfo
	for name, info := range funcDefs {
		if usages[name] <= 1 {
			dead = append(dead, info)
		}
	}

	if len(dead) > 0 {
		t.Errorf("found %d dead (unreferenced) functions in internal/cli:", len(dead))
		for _, fn := range dead {
			t.Errorf("  %s:%d — %s", filepath.Base(fn.pos.Filename), fn.pos.Line, fn.name)
		}
	}
}

func getProjectRoot(t *testing.T) string {
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
			t.Fatal("could not find project root (no go.mod found)")
		}
		dir = parent
	}
}
