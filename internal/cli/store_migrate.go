package cli

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// storeLocalOnlyPaths are the top-level entries of a knowledge root that
// store spec D1 keeps out of a store. A migration copies them so this machine
// keeps its history, timers and index, but the store .gitignore keeps them out
// of sync.
var storeLocalOnlyPaths = []string{".search", "history", "time.json", "time-entries.json", "workspaces.json", "chats.json", ".server-port"}

// migrationReport summarizes what `store link --migrate` copied.
type migrationReport struct {
	Tasks, Docs, Decisions, Memories int
	LocalOnly                        []string
}

// copyKnowledge copies an in-repo .knowns/ into a store project folder
// verbatim, so every entity keeps its ID. The source is only read.
func copyKnowledge(src, dst string) (migrationReport, error) {
	var report migrationReport
	for _, p := range storeLocalOnlyPaths {
		if _, err := os.Lstat(filepath.Join(src, p)); err == nil {
			report.LocalOnly = append(report.LocalOnly, p)
		}
	}
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil // symlinks and devices are not knowledge
		}
		if err := copyFile(path, target); err != nil {
			return err
		}
		if strings.HasSuffix(rel, ".md") {
			switch strings.SplitN(filepath.ToSlash(rel), "/", 2)[0] {
			case "tasks", "archive":
				report.Tasks++
			case "docs":
				report.Docs++
			case "decisions":
				report.Decisions++
			case "memory":
				report.Memories++
			}
		}
		return nil
	})
	return report, err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}

// folderHasContent reports whether dir exists with any entry in it.
func folderHasContent(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

func printMigrationReport(w io.Writer, r migrationReport, inRepo string) {
	fmt.Fprintf(w, "Migrated %d task%s, %d doc%s, %d decision%s and %d memor%s with their IDs unchanged.\n",
		r.Tasks, plural(r.Tasks, "", "s"), r.Docs, plural(r.Docs, "", "s"), r.Decisions, plural(r.Decisions, "", "s"), r.Memories, plural(r.Memories, "y", "ies"))
	if len(r.LocalOnly) > 0 {
		fmt.Fprintf(w, "Kept on this machine only, never synced (store spec D1): %s\n", strings.Join(r.LocalOnly, ", "))
	}
	fmt.Fprintf(w, "%s was left in place and is ignored from now on; remove it once everyone on the project has migrated.\n", inRepo)
}
