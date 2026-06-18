package references

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/howznguyen/knowns/internal/models"
)

var taskReferenceRE = regexp.MustCompile(`^@task-[A-Za-z0-9.-]+(?:\{[a-z-]+\})?`)
var memoryReferenceRE = regexp.MustCompile(`^@memory-[A-Za-z0-9-]+(?:\{[a-z-]+\})?`)
var docRangeSuffixRE = regexp.MustCompile(`:(\d+)-(\d+)$`)
var docLineSuffixRE = regexp.MustCompile(`:(\d+)$`)

var slashNamespaces = map[string]string{
	"task/":     "task",
	"memory/":   "memory",
	"decision/": "decision",
	"doc/":      "doc",
	"template/": "template",
}

var allowedRelations = map[string]struct{}{
	"implements":    {},
	"depends":       {},
	"blocked-by":    {},
	"follows":       {},
	"related":       {},
	"parent":        {},
	"spec":          {},
	"imported-from": {},
	"template-for":  {},
	models.SemanticReferenceRelationReferences: {},
}

// AllRelationKinds returns the full allowlist of relation kinds.
func AllRelationKinds() []string {
	kinds := make([]string, 0, len(allowedRelations))
	for k := range allowedRelations {
		kinds = append(kinds, k)
	}
	return kinds
}

func AllowedRelation(relation string) bool {
	_, ok := allowedRelations[relation]
	return ok
}

func Extract(content string) []models.SemanticReference {
	refs := []models.SemanticReference{}
	inCodeBlock := false

	for i := 0; i < len(content); {
		if isLineStart(content, i) && strings.HasPrefix(content[i:], "```") {
			inCodeBlock = !inCodeBlock
			i += 3
			continue
		}
		if inCodeBlock {
			i++
			continue
		}
		if content[i] != '@' {
			i++
			continue
		}

		match := extractReferenceAt(content[i:])
		if match == "" {
			i++
			continue
		}

		ref, ok := Parse(match)
		if ok {
			refs = append(refs, ref)
		}
		i += len(match)
	}
	return refs
}

func Parse(raw string) (models.SemanticReference, bool) {
	raw = strings.TrimSpace(trimTrailingPunctuation(raw))
	if raw == "" || !strings.HasPrefix(raw, "@") {
		return models.SemanticReference{}, false
	}

	body := raw[1:]
	relation := models.SemanticReferenceRelationReferences
	explicitRelation := false
	validRelation := true

	if open := strings.LastIndex(body, "{"); open >= 0 && strings.HasSuffix(body, "}") {
		relation = body[open+1 : len(body)-1]
		body = body[:open]
		explicitRelation = true
		validRelation = AllowedRelation(relation)
	}

	ref := models.SemanticReference{
		Raw:              raw,
		Relation:         relation,
		ExplicitRelation: explicitRelation,
		ValidRelation:    validRelation,
	}

	switch {
	case strings.HasPrefix(body, "task-"):
		ref.Type = "task"
		ref.Target = strings.TrimPrefix(body, "task-")
		ref.Legacy = true
	case strings.HasPrefix(body, "memory-"):
		ref.Type = "memory"
		ref.Target = strings.TrimPrefix(body, "memory-")
		ref.Legacy = true
	case strings.HasPrefix(body, "doc/"):
		ref.Type = "doc"
		ref.Target, ref.Fragment = parseDocTarget(strings.TrimPrefix(body, "doc/"))
	default:
		for prefix, typ := range slashNamespaces {
			if !strings.HasPrefix(body, prefix) {
				continue
			}
			ref.Type = typ
			target := strings.TrimPrefix(body, prefix)
			if typ == "doc" {
				ref.Target, ref.Fragment = parseDocTarget(target)
			} else {
				ref.Target = trimTrailingPunctuation(strings.TrimSpace(target))
			}
			break
		}
		if ref.Type == "" {
			return models.SemanticReference{}, false
		}
	}

	if strings.TrimSpace(ref.Target) == "" {
		return models.SemanticReference{}, false
	}

	ref.Canonical = canonicalReference(ref)
	return ref, true
}

func canonicalReference(ref models.SemanticReference) string {
	body := "@" + ref.Type + "/" + ref.Target
	if ref.Fragment != nil {
		body += ref.Fragment.Raw
	}
	if ref.ExplicitRelation {
		body += "{" + ref.Relation + "}"
	}
	return body
}

func parseDocTarget(value string) (string, *models.DocReferenceFragment) {
	value = strings.TrimSpace(value)
	fragment := &models.DocReferenceFragment{}

	if idx := strings.Index(value, "#"); idx >= 0 {
		fragment.Raw = value[idx:]
		fragment.Heading = value[idx+1:]
		value = value[:idx]
	} else if m := docRangeSuffixRE.FindStringSubmatch(value); m != nil {
		fragment.Raw = m[0]
		fragment.RangeStart, _ = strconv.Atoi(m[1])
		fragment.RangeEnd, _ = strconv.Atoi(m[2])
		value = strings.TrimSuffix(value, m[0])
	} else if m := docLineSuffixRE.FindStringSubmatch(value); m != nil {
		fragment.Raw = m[0]
		fragment.Line, _ = strconv.Atoi(m[1])
		value = strings.TrimSuffix(value, m[0])
	}

	value = trimTrailingPunctuation(value)
	if fragment.Raw == "" {
		fragment = nil
	}
	return value, fragment
}

func extractReferenceAt(content string) string {
	switch {
	case strings.HasPrefix(content, "@doc/"):
		return extractDocReferenceAt(content)
	case strings.HasPrefix(content, "@task/"):
		return extractNamespacedReferenceAt(content, len("@task/"))
	case strings.HasPrefix(content, "@memory/"):
		return extractNamespacedReferenceAt(content, len("@memory/"))
	case strings.HasPrefix(content, "@decision/"):
		return extractNamespacedReferenceAt(content, len("@decision/"))
	case strings.HasPrefix(content, "@template/"):
		return extractNamespacedReferenceAt(content, len("@template/"))
	case strings.HasPrefix(content, "@task-"):
		return taskReferenceRE.FindString(content)
	case strings.HasPrefix(content, "@memory-"):
		return memoryReferenceRE.FindString(content)
	default:
		return ""
	}
}

func extractDocReferenceAt(content string) string {
	i := len("@doc/")
	if i >= len(content) || !isDocPathChar(rune(content[i])) {
		return ""
	}

	for i < len(content) {
		r := rune(content[i])
		switch {
		case isDocPathChar(r):
			i++
		case r == '#':
			next := consumeDocHeading(content, i)
			if next == i {
				return content[:i]
			}
			i = next
		case r == ':':
			next := consumeDocLineSuffix(content, i)
			if next == i {
				return content[:i]
			}
			i = next
		case r == '{':
			next := consumeRelationSuffix(content, i)
			if next == i {
				return content[:i]
			}
			i = next
			return content[:i]
		default:
			return content[:i]
		}
	}

	return content[:i]
}

func extractNamespacedReferenceAt(content string, i int) string {
	if i >= len(content) || !isNamespacedTargetChar(rune(content[i])) {
		return ""
	}

	for i < len(content) {
		r := rune(content[i])
		switch {
		case isNamespacedTargetChar(r):
			i++
		case r == '{':
			next := consumeRelationSuffix(content, i)
			if next == i {
				return content[:i]
			}
			i = next
			return content[:i]
		default:
			return content[:i]
		}
	}

	return content[:i]
}

func consumeDocHeading(content string, start int) int {
	i := start + 1
	for i < len(content) {
		r := rune(content[i])
		if !isDocHeadingChar(r) {
			break
		}
		i++
	}
	if i == start+1 {
		return start
	}
	return i
}

func consumeDocLineSuffix(content string, start int) int {
	i := start + 1
	rangeSeparatorSeen := false
	digitsBeforeSeparator := 0
	digitsAfterSeparator := 0

	for i < len(content) {
		r := rune(content[i])
		switch {
		case r >= '0' && r <= '9':
			if rangeSeparatorSeen {
				digitsAfterSeparator++
			} else {
				digitsBeforeSeparator++
			}
			i++
		case r == '-' && !rangeSeparatorSeen && digitsBeforeSeparator > 0:
			rangeSeparatorSeen = true
			i++
		default:
			goto done
		}
	}

done:
	if digitsBeforeSeparator == 0 || (rangeSeparatorSeen && digitsAfterSeparator == 0) {
		return start
	}
	return i
}

func consumeRelationSuffix(content string, start int) int {
	i := start + 1
	for i < len(content) {
		r := rune(content[i])
		if (r >= 'a' && r <= 'z') || r == '-' {
			i++
			continue
		}
		break
	}
	if i == start+1 || i >= len(content) || content[i] != '}' {
		return start
	}
	return i + 1
}

func isDocPathChar(r rune) bool {
	return (r >= 'A' && r <= 'Z') ||
		(r >= 'a' && r <= 'z') ||
		(r >= '0' && r <= '9') ||
		r == '/' ||
		r == '_' ||
		r == '-' ||
		r == '.'
}

func isDocHeadingChar(r rune) bool {
	return (r >= 'A' && r <= 'Z') ||
		(r >= 'a' && r <= 'z') ||
		(r >= '0' && r <= '9') ||
		r == '_' ||
		r == '-' ||
		r == '.'
}

func isNamespacedTargetChar(r rune) bool {
	return (r >= 'A' && r <= 'Z') ||
		(r >= 'a' && r <= 'z') ||
		(r >= '0' && r <= '9') ||
		r == '/' ||
		r == '_' ||
		r == '-' ||
		r == '.'
}

func isLineStart(content string, i int) bool {
	if i == 0 {
		return true
	}
	return content[i-1] == '\n'
}

func trimTrailingPunctuation(value string) string {
	return strings.TrimRightFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune(".,;:!?`'\"", r)
	})
}
