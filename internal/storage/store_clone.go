package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// storeIgnoreBegin and storeIgnoreEnd delimit the block of a store clone's
// .gitignore that Knowns owns. Lines outside it belong to the team.
const (
	storeIgnoreBegin = "# >>> knowns: machine-local state, never synced (store spec D1) >>>"
	storeIgnoreEnd   = "# <<< knowns <<<"
)

// StoreIgnorePatterns are the paths D1 of the store spec keeps out of a store:
// rebuildable indexes, local history and machine-local state, in every project
// folder of the clone.
var StoreIgnorePatterns = []string{
	"**/.search/",
	"**/history/",
	"**/time.json",
	"**/time-entries.json",
	"**/workspaces.json",
	"**/chats.json",
	"**/.server-port",
}

// EnsureStoreGitignore makes the .gitignore at the root of a store clone carry
// the managed block of StoreIgnorePatterns, preserving every other line. It
// reports whether the file changed.
func EnsureStoreGitignore(cloneRoot string) (bool, error) {
	path := filepath.Join(cloneRoot, ".gitignore")
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return false, fmt.Errorf("read %s: %w", path, err)
	}

	block := storeIgnoreBegin + "\n" + strings.Join(StoreIgnorePatterns, "\n") + "\n" + storeIgnoreEnd + "\n"
	content := string(existing)
	if start := strings.Index(content, storeIgnoreBegin); start >= 0 {
		end := strings.Index(content[start:], storeIgnoreEnd)
		if end < 0 {
			return false, fmt.Errorf("%s has an unterminated knowns block; restore the %q line", path, storeIgnoreEnd)
		}
		end = start + end + len(storeIgnoreEnd)
		if end < len(content) && content[end] == '\n' {
			end++
		}
		content = content[:start] + block + content[end:]
	} else {
		if content != "" && !strings.HasSuffix(content, "\n") {
			content += "\n"
		}
		content += block
	}

	if content == string(existing) {
		return false, nil
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return false, fmt.Errorf("write %s: %w", path, err)
	}
	return true, nil
}
