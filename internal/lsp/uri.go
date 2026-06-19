package lsp

import (
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
)

// PathFromFileURI extracts a filesystem path from a file:// URI.
// On Windows, it strips the leading "/" before drive letters
// (e.g., "/C:/foo" becomes "C:/foo" then normalized to "C:\foo").
func PathFromFileURI(uri string) string {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" {
		return uri
	}
	path := u.Path
	if runtime.GOOS == "windows" && len(path) >= 3 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	return filepath.FromSlash(path)
}

// FileURI converts a filesystem path to a file:// URI.
func FileURI(path string) string {
	abs := canonicalAbsPath(path)
	slashed := filepath.ToSlash(abs)
	if runtime.GOOS == "windows" && len(slashed) >= 2 && slashed[1] == ':' {
		slashed = "/" + slashed
	}
	return (&url.URL{Scheme: "file", Path: slashed}).String()
}

// SameFileURI reports whether a file:// URI and a filesystem path refer to the same file.
func SameFileURI(uri, path string) bool {
	uriPath := PathFromFileURI(uri)
	clean1 := filepath.Clean(canonicalAbsPath(uriPath))
	clean2 := filepath.Clean(canonicalAbsPath(path))
	if runtime.GOOS == "windows" {
		clean1 = strings.ToLower(clean1)
		clean2 = strings.ToLower(clean2)
	}
	return clean1 == clean2
}

func canonicalAbsPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return abs
}
