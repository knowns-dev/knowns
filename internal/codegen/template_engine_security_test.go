package codegen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func TestEngineRejectsPathTraversalInAdd(t *testing.T) {
	tmpDir := t.TempDir()
	projectRoot := filepath.Join(tmpDir, "project")
	outsideDir := filepath.Join(tmpDir, "outside")
	os.MkdirAll(projectRoot, 0755)
	os.MkdirAll(outsideDir, 0755)

	engine := NewEngine(projectRoot)

	// Test relative path traversal escape
	tmplTraverse := &models.Template{
		Path: projectRoot,
		Actions: []models.TemplateAction{
			{
				Type:     "add",
				Path:     "../../outside/pwned.txt",
				Template: "pwned",
			},
		},
	}

	result, err := engine.Run(tmplTraverse, nil, false)
	if err == nil {
		t.Fatalf("expected error on path traversal in add, got nil; result: %+v", result)
	}

	// Test absolute path outside project root
	absOutsideFile := filepath.Join(outsideDir, "abs_pwned.txt")
	tmplAbs := &models.Template{
		Path: projectRoot,
		Actions: []models.TemplateAction{
			{
				Type:     "add",
				Path:     absOutsideFile,
				Template: "pwned",
			},
		},
	}

	result, err = engine.Run(tmplAbs, nil, false)
	if err == nil {
		t.Fatalf("expected error on absolute outside path in add, got nil; result: %+v", result)
	}

	// Verify no files were created outside
	if _, statErr := os.Stat(filepath.Join(outsideDir, "pwned.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("file was created outside project root: %s", filepath.Join(outsideDir, "pwned.txt"))
	}
	if _, statErr := os.Stat(absOutsideFile); !os.IsNotExist(statErr) {
		t.Fatalf("file was created outside project root: %s", absOutsideFile)
	}
}

func TestEngineRejectsPathTraversalInAddMany(t *testing.T) {
	tmpDir := t.TempDir()
	projectRoot := filepath.Join(tmpDir, "project")
	outsideDir := filepath.Join(tmpDir, "outside")
	tmplDir := filepath.Join(projectRoot, "templates")
	os.MkdirAll(projectRoot, 0755)
	os.MkdirAll(outsideDir, 0755)
	os.MkdirAll(tmplDir, 0755)
	os.WriteFile(filepath.Join(tmplDir, "test.hbs"), []byte("content"), 0644)

	engine := NewEngine(projectRoot)

	// Test escaping destination in addMany
	tmpl := &models.Template{
		Path: tmplDir,
		Actions: []models.TemplateAction{
			{
				Type:        "addMany",
				Destination: "../../outside",
				Source:      "",
			},
		},
	}

	_, err := engine.Run(tmpl, nil, false)
	if err == nil {
		t.Fatalf("expected error on escaping destination in addMany, got nil")
	}

	// Test escaping source directory in addMany
	tmplSource := &models.Template{
		Path: tmplDir,
		Actions: []models.TemplateAction{
			{
				Type:        "addMany",
				Destination: "output",
				Source:      "../../outside",
			},
		},
	}

	_, err = engine.Run(tmplSource, nil, false)
	if err == nil {
		t.Fatalf("expected error on escaping source in addMany, got nil")
	}
}

func TestEngineRejectsTemplateSourcePathTraversal(t *testing.T) {
	tmpDir := t.TempDir()
	projectRoot := filepath.Join(tmpDir, "project")
	outsideDir := filepath.Join(tmpDir, "outside")
	os.MkdirAll(projectRoot, 0755)
	os.MkdirAll(outsideDir, 0755)

	secretFile := filepath.Join(outsideDir, "secret.txt")
	os.WriteFile(secretFile, []byte("super-secret-key"), 0644)

	engine := NewEngine(projectRoot)

	tmpl := &models.Template{
		Path: projectRoot,
		Actions: []models.TemplateAction{
			{
				Type:     "add",
				Path:     "output.txt",
				Template: "../../outside/secret.txt",
			},
		},
	}

	_, err := engine.Run(tmpl, nil, false)
	if err == nil {
		t.Fatalf("expected error on path traversal in template source file, got nil")
	}
	if !strings.Contains(err.Error(), "invalid template file path") && !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("unexpected error message: %v", err)
	}
}
