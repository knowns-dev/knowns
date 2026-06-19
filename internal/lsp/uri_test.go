package lsp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPathFromFileURI(t *testing.T) {
	tests := []struct {
		name     string
		uri      string
		wantUnix string
		wantWin  string
	}{
		{"unix path", "file:///home/user/main.go", "/home/user/main.go", `\home\user\main.go`},
		{"windows drive", "file:///C:/Users/dev/main.go", "/C:/Users/dev/main.go", `C:\Users\dev\main.go`},
		{"not file URI", "https://example.com/path", "https://example.com/path", "https://example.com/path"},
		{"invalid URI", "://broken", "://broken", "://broken"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PathFromFileURI(tt.uri)
			want := tt.wantUnix
			if runtime.GOOS == "windows" {
				want = tt.wantWin
			}
			if got != want {
				t.Errorf("PathFromFileURI(%q) = %q, want %q", tt.uri, got, want)
			}
		})
	}
}

func TestFileURI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("platform-specific test")
	}
	tests := []struct {
		path string
		want string
	}{
		{"/home/user/main.go", "file:///home/user/main.go"},
		{"/tmp/a b.go", "file:///tmp/a%20b.go"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := FileURI(tt.path)
			if got != tt.want {
				t.Errorf("FileURI(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestFileURIEvaluatesSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privileges vary on Windows")
	}
	realDir := t.TempDir()
	file := filepath.Join(realDir, "main.go")
	if err := os.WriteFile(file, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(filepath.Dir(realDir), filepath.Base(realDir)+"-link")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(linkDir) })

	if got, want := FileURI(filepath.Join(linkDir, "main.go")), FileURI(file); got != want {
		t.Fatalf("FileURI(symlinked path) = %q, want %q", got, want)
	}
}

func TestSameFileURI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("platform-specific test")
	}
	tests := []struct {
		name string
		uri  string
		path string
		want bool
	}{
		{"match", "file:///home/user/main.go", "/home/user/main.go", true},
		{"no match", "file:///home/user/main.go", "/home/other/main.go", false},
		{"trailing slash normalization", "file:///home/user/", "/home/user", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SameFileURI(tt.uri, tt.path); got != tt.want {
				t.Errorf("SameFileURI(%q, %q) = %v, want %v", tt.uri, tt.path, got, tt.want)
			}
		})
	}
}

func TestSameFileURIEvaluatesSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privileges vary on Windows")
	}
	realDir := t.TempDir()
	file := filepath.Join(realDir, "main.go")
	if err := os.WriteFile(file, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(filepath.Dir(realDir), filepath.Base(realDir)+"-link")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(linkDir) })

	if !SameFileURI(FileURI(file), filepath.Join(linkDir, "main.go")) {
		t.Fatalf("SameFileURI should match canonical and symlinked paths")
	}
}
