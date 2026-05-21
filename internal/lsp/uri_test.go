package lsp

import (
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
