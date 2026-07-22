package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"github.com/howznguyen/knowns/internal/models"
)

// writeJSON marshals v to indented JSON and writes it atomically to path.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWrite(path, data)
}

// readJSON reads and unmarshals a JSON file into v.
func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// atomicWrite writes data to a temporary file then renames it over dst.
func atomicWrite(dst string, data []byte) error {
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("atomicWrite: mkdir %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-knowns-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, dst)
}

// sanitizeTitle converts a task title into the filename-safe slug used in the
// task filename format:  task-{id} - {SanitizedTitle}.md
// Matches the TypeScript implementation behavior.
func sanitizeTitle(title string) string {
	var b strings.Builder
	prevHyphen := false
	count := 0
	for _, r := range title {
		if count >= 50 {
			break
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevHyphen = false
			count++
		} else {
			if !prevHyphen {
				b.WriteRune('-')
				prevHyphen = true
				count++
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// taskFilename returns the canonical filename for a task.
func taskFilename(id, title string) string {
	return "task-" + id + " - " + sanitizeTitle(title) + ".md"
}

// extractSection returns the content between <!-- SECTION:TYPE:BEGIN --> /
// <!-- SECTION:TYPE:END --> markers (new format) or the older
// <!-- BEGIN:type --> / <!-- END:type --> markers.
func extractSection(content, sectionType string) string {
	upper := strings.ToUpper(sectionType)
	newBegin := "<!-- SECTION:" + upper + ":BEGIN -->"
	newEnd := "<!-- SECTION:" + upper + ":END -->"
	if s := extractBetween(content, newBegin, newEnd); s != "" {
		return s
	}
	lower := strings.ToLower(sectionType)
	oldBegin := "<!-- BEGIN:" + lower + " -->"
	oldEnd := "<!-- END:" + lower + " -->"
	return extractBetween(content, oldBegin, oldEnd)
}

// extractBetween returns the trimmed text found between two marker strings.
// It also strips any nested/duplicate markers from the extracted content.
func extractBetween(content, begin, end string) string {
	start := strings.Index(content, begin)
	if start == -1 {
		return ""
	}
	start += len(begin)
	stop := strings.Index(content[start:], end)
	if stop == -1 {
		return ""
	}
	result := strings.TrimSpace(content[start : start+stop])
	// Strip any duplicate/nested markers that may have been introduced.
	result = strings.ReplaceAll(result, begin, "")
	result = strings.ReplaceAll(result, end, "")
	return strings.TrimSpace(result)
}

// extractAC parses acceptance criteria from the AC block.
func extractAC(content string) []models.AcceptanceCriterion {
	block := extractBetween(content, "<!-- AC:BEGIN -->", "<!-- AC:END -->")
	if block == "" {
		return nil
	}
	// Match lines like: - [ ] #1 text  or  - [x] #2 text
	re := regexp.MustCompile(`(?m)^-\s+\[([ xX])\]\s+(?:#\d+\s+)?(.+)$`)
	matches := re.FindAllStringSubmatch(block, -1)
	var result []models.AcceptanceCriterion
	for _, m := range matches {
		completed := m[1] == "x" || m[1] == "X"
		result = append(result, models.AcceptanceCriterion{
			Text:      strings.TrimSpace(m[2]),
			Completed: completed,
		})
	}
	return result
}

// renderAC formats acceptance criteria into the body of an AC block.
func renderAC(criteria []models.AcceptanceCriterion) string {
	if len(criteria) == 0 {
		return ""
	}
	var b strings.Builder
	for i, ac := range criteria {
		check := " "
		if ac.Completed {
			check = "x"
		}
		fmt.Fprintf(&b, "- [%s] #%d %s\n", check, i+1, ac.Text)
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderSection wraps content in SECTION markers.
// Strips any existing markers from content first to prevent double-wrapping.
func renderSection(sectionType, content string) string {
	upper := strings.ToUpper(sectionType)
	begin := "<!-- SECTION:" + upper + ":BEGIN -->"
	end := "<!-- SECTION:" + upper + ":END -->"
	// Strip existing markers to prevent double-wrapping.
	content = strings.ReplaceAll(content, begin, "")
	content = strings.ReplaceAll(content, end, "")
	content = strings.TrimSpace(content)
	if content == "" {
		return begin + "\n" + end
	}
	return begin + "\n" + content + "\n" + end
}

// splitFrontmatter splits a markdown document into the YAML frontmatter block
// and the body that follows the closing "---".
func splitFrontmatter(content string) (yamlBlock, body string) {
	// Strip UTF-8 BOM if present.
	content = strings.TrimPrefix(content, "\xef\xbb\xbf")
	if !strings.HasPrefix(content, "---") {
		return "", content
	}
	rest := content[3:]
	// Skip newline after opening ---
	if strings.HasPrefix(rest, "\r\n") {
		rest = rest[2:]
	} else if strings.HasPrefix(rest, "\n") {
		rest = rest[1:]
	}
	idx := strings.Index(rest, "\n---")
	if idx == -1 {
		return "", content
	}
	// With CRLF input idx points at the LF in "\r\n---". Exclude the CR so
	// callers that rejoin the frontmatter do not produce "\r\r\n".
	yamlBlock = strings.TrimSuffix(rest[:idx], "\r")
	body = rest[idx+4:]
	// Skip newline after closing ---
	if strings.HasPrefix(body, "\r\n") {
		body = body[2:]
	} else if strings.HasPrefix(body, "\n") {
		body = body[1:]
	}
	return yamlBlock, body
}

// setNestedKey sets a dot-notation key in a nested map.
func setNestedKey(m map[string]any, key string, value any) {
	parts := strings.SplitN(key, ".", 2)
	if len(parts) == 1 {
		m[key] = value
		return
	}
	sub, ok := m[parts[0]].(map[string]any)
	if !ok {
		sub = make(map[string]any)
	}
	setNestedKey(sub, parts[1], value)
	m[parts[0]] = sub
}

// getNestedKey retrieves a dot-notation key from a nested map.
func getNestedKey(m map[string]any, key string) (any, bool) {
	parts := strings.SplitN(key, ".", 2)
	v, ok := m[parts[0]]
	if !ok {
		return nil, false
	}
	if len(parts) == 1 {
		return v, true
	}
	sub, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	return getNestedKey(sub, parts[1])
}
