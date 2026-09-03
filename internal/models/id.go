package models

import (
	"fmt"
	"math/rand/v2"
	"regexp"
	"strings"
)

const (
	// base36Chars is the alphabet used by the 6-character task ID.
	base36Chars = "0123456789abcdefghijklmnopqrstuvwxyz"

	// base36Max is 36^6 = 2 176 782 336 – the exclusive upper bound for a
	// 6-character base-36 value.
	base36Max = 36 * 36 * 36 * 36 * 36 * 36 // 2_176_782_336

	// crockfordBase32Chars omits I, L, O, and U to keep generated task IDs
	// readable when copied between terminals, documents, and issue trackers.
	crockfordBase32Chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

	// crockfordBase32Max is 32^6, the exclusive upper bound for a six-character
	// Crockford Base32 suffix.
	crockfordBase32Max = 32 * 32 * 32 * 32 * 32 * 32
)

// taskIDPrefixRE constrains a prefix to a delimiter-safe ASCII namespace:
// 2-8 alphanumeric characters beginning with a letter.
var taskIDPrefixRE = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,7}$`)

// NewTaskID generates a random 6-character base-36 task ID.
//
// The algorithm mirrors the TypeScript implementation:
//
//	value = random(0, 36^6)
//	id    = value.toString(36).padStart(6, "0")
func NewTaskID() string {
	value := rand.N(uint64(base36Max)) //nolint:gosec – IDs are not security tokens
	return encodeBase36(int(value), 6)
}

// NormalizeTaskIDPrefix validates and canonicalizes a task ID prefix. An empty
// value is allowed and means that no prefixed default is configured.
func NormalizeTaskIDPrefix(prefix string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(prefix))
	if normalized == "" {
		return "", nil
	}
	if !taskIDPrefixRE.MatchString(normalized) {
		return "", fmt.Errorf("task ID prefix must be 2-8 alphanumeric characters and start with a letter")
	}
	return normalized, nil
}

// NewPrefixedTaskID returns an ID in the form PREFIX-XXXXXX, where the suffix
// uses uppercase Crockford Base32.
func NewPrefixedTaskID(prefix string) (string, error) {
	normalized, err := NormalizeTaskIDPrefix(prefix)
	if err != nil {
		return "", err
	}
	if normalized == "" {
		return "", fmt.Errorf("task ID prefix is required")
	}

	value := rand.N(uint64(crockfordBase32Max)) //nolint:gosec – IDs are not security tokens
	return normalized + "-" + encodeBase(int(value), 6, crockfordBase32Chars), nil
}

// encodeBase36 encodes n in base-36 and left-pads the result with '0' to the
// requested minimum width.
func encodeBase36(n, width int) string {
	return encodeBase(n, width, base36Chars)
}

// encodeBase encodes n using alphabet and left-pads the result with the first
// alphabet character to the requested minimum width.
func encodeBase(n, width int, alphabet string) string {
	if n == 0 {
		return strings.Repeat(alphabet[:1], width)
	}

	buf := make([]byte, 0, width)
	base := len(alphabet)
	for n > 0 {
		buf = append(buf, alphabet[n%base])
		n /= base
	}

	// Reverse
	for i, j := 0, len(buf)-1; i < j; i, j = i+1, j-1 {
		buf[i], buf[j] = buf[j], buf[i]
	}

	s := string(buf)
	if len(s) < width {
		s = strings.Repeat(alphabet[:1], width-len(s)) + s
	}
	return s
}

// nonAlphanumRE matches characters that are not letters, digits, or hyphens.
var nonAlphanumRE = regexp.MustCompile(`[^a-zA-Z0-9\s\-]`)

// multiSpaceRE matches one or more consecutive whitespace characters.
var multiSpaceRE = regexp.MustCompile(`\s+`)

// SanitizeTitle strips characters that are unsafe in file names from title,
// then collapses whitespace runs to a single hyphen. The result is safe to
// embed in a path component.
//
// Example:
//
//	SanitizeTitle("Fix bug: auth/login")  →  "Fix-bug-authlogin"
func SanitizeTitle(title string) string {
	clean := nonAlphanumRE.ReplaceAllString(title, "")
	clean = multiSpaceRE.ReplaceAllString(clean, "-")
	return clean
}

// TaskFileName returns the canonical file name for a task: the ID and nothing
// else.
//
// The title used to be part of the name. That made a directory listing
// readable, but it put a copy of a mutable field into a path that is never
// rewritten, so a renamed task advertised its old title for the rest of its
// life. Readers that need the title read the frontmatter, which is always
// current.
//
// Files written under the older forms, "task-{id} - {slug}.md" and
// "task-{id}.md", are still located and read; see taskFileMatches in the
// storage package.
//
// Example:
//
//	TaskFileName("abc123")     →  "abc123.md"
//	TaskFileName("KN-7F3K9M")  →  "KN-7F3K9M.md"
func TaskFileName(id string) string {
	return id + ".md"
}
