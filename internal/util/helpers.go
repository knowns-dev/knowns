package util

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// IDMax is 36^6 = 2,176,782,336
	IDMax = 2176782336
	// IDLength is the length of generated IDs
	IDLength = 6
)

var nonAlphanumericRe = regexp.MustCompile(`[^a-zA-Z0-9\s-]`)
var multiSpaceRe = regexp.MustCompile(`\s+`)

// GenerateID creates a 6-character base36 ID.
func GenerateID() string {
	n, err := rand.Int(rand.Reader, big.NewInt(IDMax))
	if err != nil {
		// Fallback to timestamp-based
		n = big.NewInt(time.Now().UnixNano() % IDMax)
	}
	id := strconv.FormatInt(n.Int64(), 36)
	for len(id) < IDLength {
		id = "0" + id
	}
	return id
}

// SanitizeTitle removes non-alphanumeric chars for filenames.
func SanitizeTitle(title string) string {
	s := nonAlphanumericRe.ReplaceAllString(title, "")
	s = multiSpaceRe.ReplaceAllString(s, "-")
	s = strings.TrimRight(s, "-")
	if s == "" {
		s = "untitled"
	}
	return s
}

// ParseDuration parses duration strings like "2h", "30m", "1h30m" into seconds.
func ParseDuration(s string) (int, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 0, fmt.Errorf("empty duration string")
	}

	total := 0
	current := ""

	for _, ch := range s {
		switch {
		case ch >= '0' && ch <= '9':
			current += string(ch)
		case ch == 'h':
			if current == "" {
				return 0, fmt.Errorf("invalid duration: missing number before 'h'")
			}
			n, err := strconv.Atoi(current)
			if err != nil {
				return 0, fmt.Errorf("invalid hours: %s", current)
			}
			total += n * 3600
			current = ""
		case ch == 'm':
			if current == "" {
				return 0, fmt.Errorf("invalid duration: missing number before 'm'")
			}
			n, err := strconv.Atoi(current)
			if err != nil {
				return 0, fmt.Errorf("invalid minutes: %s", current)
			}
			total += n * 60
			current = ""
		case ch == 's':
			if current == "" {
				return 0, fmt.Errorf("invalid duration: missing number before 's'")
			}
			n, err := strconv.Atoi(current)
			if err != nil {
				return 0, fmt.Errorf("invalid seconds: %s", current)
			}
			total += n
			current = ""
		default:
			return 0, fmt.Errorf("unexpected character: %c", ch)
		}
	}

	// If there's a trailing number without unit, treat as minutes
	if current != "" {
		n, err := strconv.Atoi(current)
		if err != nil {
			return 0, fmt.Errorf("invalid number: %s", current)
		}
		total += n * 60
	}

	return total, nil
}

// FormatDuration formats seconds into human-readable string like "1h 30m".
func FormatDuration(seconds int) string {
	if seconds <= 0 {
		return "0m"
	}
	h := seconds / 3600
	m := (seconds % 3600) / 60

	if h > 0 && m > 0 {
		return fmt.Sprintf("%dh %dm", h, m)
	} else if h > 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dm", m)
}

// NowISO returns the current time in ISO format.
func NowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// DefaultStatuses returns the default list of task statuses.
func DefaultStatuses() []string {
	return []string{"todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"}
}

// ValidPriorities returns valid priority values.
func ValidPriorities() []string {
	return []string{"low", "medium", "high"}
}

// Contains checks if a slice contains a string.
func Contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// Truncate shortens a string to maxLen, adding "..." if truncated.
func Truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}
