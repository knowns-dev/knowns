package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// A doc that names a file which does not exist is the failure that produced the
// old ARCHITECTURE.md: it described task.ts, file-store.ts, and src/index.ts in
// a repository that has never contained a line of TypeScript outside ui/. The
// command lint cannot see that class, because none of it is a command.
//
// Precision matters more than recall here. A check that cries wolf gets
// disabled, so this only considers tokens that are unambiguously meant as a
// path in this repository, and everything else needs an explicit allow entry.

const allowFile = "docs/allowed-missing-paths.txt"

var (
	// Source extensions only, and backticked. Config and markdown names in docs
	// are overwhelmingly artifacts Knowns writes into a *user's* project
	// (KNOWNS.md, .cursor/mcp.json, requirements.md), which cannot be resolved
	// here; including them made every finding a false positive. A .go or .ts
	// name, by contrast, can only mean a file in this repository.
	pathTokenRE = regexp.MustCompile("`([A-Za-z0-9_./-]+\\.(?:go|ts|tsx|js|jsx))`")

	// Directory-tree blocks name files without backticks, and that is exactly
	// where the old ARCHITECTURE.md listed eleven TypeScript files this
	// repository has never had.
	fencedPathRE = regexp.MustCompile(`\b([A-Za-z0-9_./-]+\.(?:go|ts|tsx|js|jsx))\b`)
	placeholder  = regexp.MustCompile(`[<>*$]|\.\.\.`)
)

type pathFinding struct {
	file, line, token string
}

// lintPaths reports backticked file references that resolve to nothing.
func lintPaths() ([]pathFinding, int) {
	allow := loadAllowList()
	index := buildBasenameIndex()

	var findings []pathFinding
	checked := 0

	for _, r := range docRoots {
		_ = filepath.Walk(r, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
				return nil
			}
			if strings.Contains(path, "cli-reference") {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			inFence := false
			for n, line := range strings.Split(string(body), "\n") {
				if fenceRE.MatchString(line) {
					inFence = !inFence
					continue
				}
				re := pathTokenRE
				if inFence {
					re = fencedPathRE
				}
				for _, m := range re.FindAllStringSubmatch(line, -1) {
					token := m[1]
					if placeholder.MatchString(token) || allow[token] {
						continue
					}
					checked++
					if !pathExists(token, index) {
						findings = append(findings, pathFinding{path, itoa(n + 1), token})
					}
				}
			}
			return nil
		})
	}
	return findings, checked
}

// pathExists accepts a repo-relative path, or - for a bare filename - any file
// in the tree with that basename. Docs legitimately say "storage/store.go" or
// just "store.go" depending on how much context the sentence already carries.
func pathExists(token string, index map[string]bool) bool {
	for _, candidate := range []string{token, filepath.Join("internal", token)} {
		if _, err := os.Stat(candidate); err == nil {
			return true
		}
	}
	if !strings.Contains(token, "/") {
		return index[token]
	}
	// A partial path like "handlers/task.go": accept it if some real file ends
	// with it, so docs can name the meaningful tail instead of the full path.
	return index["suffix:"+token]
}

func buildBasenameIndex() map[string]bool {
	index := map[string]bool{}
	_ = filepath.Walk(".", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			switch info.Name() {
			case "node_modules", ".git", "dist", "bin":
				return filepath.SkipDir
			}
			return nil
		}
		index[info.Name()] = true
		parts := strings.Split(filepath.ToSlash(path), "/")
		for i := range parts {
			index["suffix:"+strings.Join(parts[i:], "/")] = true
		}
		return nil
	})
	return index
}

func loadAllowList() map[string]bool {
	allow := map[string]bool{}
	body, err := os.ReadFile(allowFile)
	if err != nil {
		return allow
	}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		allow[line] = true
	}
	return allow
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
