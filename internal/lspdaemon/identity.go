package lspdaemon

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

const maxKeyBaseLen = 48

// ProjectIdentity is the canonical daemon identity for one project root.
type ProjectIdentity struct {
	Root string `json:"root"`
	Key  string `json:"key"`
}

// IdentifyProject resolves root to a canonical filesystem identity and stable
// filesystem-safe key.
func IdentifyProject(root string) (ProjectIdentity, error) {
	canonical, err := CanonicalRoot(root)
	if err != nil {
		return ProjectIdentity{}, err
	}
	return ProjectIdentity{
		Root: canonical,
		Key:  KeyForRoot(canonical),
	}, nil
}

// CanonicalRoot resolves root with filepath.Abs and best-effort symlink
// evaluation. Missing paths still return their absolute cleaned form.
func CanonicalRoot(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("project root is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve project root: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.Clean(abs), nil
}

// KeyForRoot returns a stable filesystem-safe project key for a canonical root.
func KeyForRoot(canonicalRoot string) string {
	clean := filepath.Clean(canonicalRoot)
	base := sanitizeKeyPart(filepath.Base(clean))
	if base == "" {
		base = "project"
	}
	if len(base) > maxKeyBaseLen {
		base = strings.Trim(base[:maxKeyBaseLen], "-._")
		if base == "" {
			base = "project"
		}
	}

	hashInput := clean
	if runtime.GOOS == "windows" {
		hashInput = strings.ToLower(hashInput)
	}
	sum := sha256.Sum256([]byte(hashInput))
	return fmt.Sprintf("%s-%s", base, hex.EncodeToString(sum[:])[:16])
}

// SameRoot reports whether two already-canonical roots represent the same
// project root on the current platform.
func SameRoot(a, b string) bool {
	cleanA := filepath.Clean(a)
	cleanB := filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(cleanA, cleanB)
	}
	return cleanA == cleanB
}

func sanitizeKeyPart(value string) string {
	value = strings.ToLower(value)
	var builder strings.Builder
	lastDash := false
	for _, r := range value {
		safe := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.'
		if safe {
			builder.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(builder.String(), "-._")
}
