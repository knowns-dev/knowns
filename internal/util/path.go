package util

import (
	"os"
	"path/filepath"
	"strings"
)

// CanonicalPath returns path with every component rewritten to the spelling
// that actually exists on disk.
//
// Windows and the default macOS filesystem are case-insensitive, so
// C:\Users\me\Projects\app and C:\Users\me\projects\app name one directory
// while comparing as two different strings. Resolving each component against
// its parent's directory listing collapses those spellings onto a single key
// without branching on the operating system: where a filesystem is
// case-sensitive the exact spelling matches first, so two genuinely distinct
// directories keep their own paths.
//
// A component that cannot be resolved keeps the caller's spelling and the walk
// carries on into the components below it, so a directory that is absent or
// unreadable never strands the rest of the path.
//
// Resolution reads a parent's directory listing, and a component the listing
// never names still has to collapse: a Windows 8.3 short name such as RUNNER~1
// opens fine but is not enumerated, so keeping the caller's spelling there
// would let RUNNER~1 and runner~1 canonicalize to two different strings for
// one directory.
func CanonicalPath(path string) string {
	if path == "" {
		return path
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}

	volume := filepath.VolumeName(abs)
	current := canonicalVolume(volume) + string(filepath.Separator)
	rest := strings.Trim(strings.TrimPrefix(abs, volume), string(filepath.Separator))
	if rest == "" {
		return current
	}

	for _, component := range strings.Split(rest, string(filepath.Separator)) {
		match, ok := onDiskName(current, component)
		if !ok {
			// Not in the parent's listing: keep what the caller spelled and
			// keep walking, since the directory may still open under that name.
			match = component
		}
		current = filepath.Join(current, match)
	}
	return current
}

// onDiskName resolves name against the entries of dir, returning the spelling
// stored on disk. An exact match always wins. Any other match has to be proved
// with os.SameFile, so on a case-sensitive filesystem a missing name never
// silently resolves to a differently cased sibling.
func onDiskName(dir, name string) (string, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}

	folded := ""
	for _, entry := range entries {
		if entry.Name() == name {
			return name, true
		}
		if folded == "" && strings.EqualFold(entry.Name(), name) {
			folded = entry.Name()
		}
	}

	// Everything below has to open the requested name. When it does not exist
	// there is nothing to resolve, and this also keeps the scan further down
	// off the common path.
	requested, err := os.Lstat(filepath.Join(dir, name))
	if err != nil {
		return "", false
	}

	if folded != "" {
		existing, err := os.Lstat(filepath.Join(dir, folded))
		if err != nil || !os.SameFile(requested, existing) {
			return "", false
		}
		return folded, true
	}

	// The listing never names it, yet it opens: an alias the directory does not
	// enumerate, such as a Windows 8.3 short name. Reading the spelling back is
	// impossible, so find the entry it refers to instead. Without this,
	// C:\Users\RUNNER~1 and C:\Users\runner~1 each keep the caller's spelling
	// and one directory canonicalizes to two different strings.
	return nameOfSameFile(dir, entries, requested)
}

// nameOfSameFile returns the entry of dir that names the same file as
// requested, identifying it by the file itself rather than by its spelling.
func nameOfSameFile(dir string, entries []os.DirEntry, requested os.FileInfo) (string, bool) {
	for _, entry := range entries {
		existing, err := os.Lstat(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		if os.SameFile(requested, existing) {
			return entry.Name(), true
		}
	}
	return "", false
}

// canonicalVolume normalizes a Windows drive letter, which is case-insensitive
// and carries no on-disk casing to read back. UNC volumes and the empty Unix
// volume keep the caller's spelling.
func canonicalVolume(volume string) string {
	if len(volume) == 2 && volume[1] == ':' {
		return strings.ToUpper(volume)
	}
	return volume
}
