package lsp

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var ErrExtensionAlreadyRegistered = errors.New("extension already registered for another language")

// PathMatcherKind identifies the path signal used by a registry matcher.
type PathMatcherKind string

const (
	PathMatcherSuffix  PathMatcherKind = "suffix"
	PathMatcherExact   PathMatcherKind = "exact_name"
	PathMatcherShebang PathMatcherKind = "shebang"
)

// PathMatcher describes one ordered language-routing signal. Higher priority
// matchers win. Equal-priority matchers use deterministic specificity and
// lexical tie-breaks, so registration order never changes routing.
//
// ExplicitOnly keeps a matcher available for direct file requests while
// preventing the matching path from making a language auto-detected.
type PathMatcher struct {
	Kind         PathMatcherKind
	Pattern      string
	Priority     int
	ExplicitOnly bool
}

type Language struct {
	ID         string
	Name       string
	Extensions []string
	Binaries   []Binary
	Matchers   []PathMatcher
	LazyStart  bool
}

type Binary struct {
	Name      string
	Args      []string
	CheckArgs []string
}

type ServerCommand struct {
	Language    string
	Name        string
	Path        string
	Args        []string
	Backend     string
	ProjectPath string
	LogPath     string
	Attempts    []BackendAttempt
}

type Registry struct {
	languages []Language
	byID      map[string]Language
	byExt     map[string]Language
	matchers  []registeredPathMatcher
}

type registeredPathMatcher struct {
	language Language
	matcher  PathMatcher
}

func NewRegistry(languages []Language) *Registry {
	if languages == nil {
		languages = BuiltinLanguages()
	}
	r := &Registry{byID: make(map[string]Language), byExt: make(map[string]Language)}
	for _, lang := range languages {
		_ = r.Register(lang)
	}
	return r
}

func NewEmptyRegistry() *Registry {
	return NewRegistry([]Language{})
}

func BuiltinLanguages() []Language {
	return []Language{
		{ID: "go", Name: "Go", Extensions: []string{".go"}, Binaries: []Binary{{Name: "gopls", Args: []string{"serve"}, CheckArgs: []string{"version"}}}},
		{ID: "typescript", Name: "TypeScript", Extensions: []string{".ts"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "typescriptreact", Name: "TSX", Extensions: []string{".tsx"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "javascript", Name: "JavaScript", Extensions: []string{".js"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "javascriptreact", Name: "JSX", Extensions: []string{".jsx"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "python", Name: "Python", Extensions: []string{".py"}, Binaries: []Binary{{Name: "pylsp", CheckArgs: []string{"--version"}}, {Name: "pyright-langserver", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "rust", Name: "Rust", Extensions: []string{".rs"}, Binaries: []Binary{{Name: "rust-analyzer", CheckArgs: []string{"--version"}}}},
		{ID: DartLanguageID, Name: "Dart", Extensions: []string{".dart"}, Binaries: []Binary{{Name: "dart", Args: []string{"language-server"}, CheckArgs: []string{"--version"}}}},
	}
}

func (r *Registry) Register(lang Language) error {
	lang.ID = strings.TrimSpace(lang.ID)
	lang.Name = strings.TrimSpace(lang.Name)
	lang.Extensions = normalizeRegistryExtensions(lang.Extensions)
	lang.Matchers = normalizePathMatchers(lang.Extensions, lang.Matchers)
	if lang.ID == "" || len(lang.Matchers) == 0 {
		return nil
	}
	if r.byID == nil {
		r.byID = make(map[string]Language)
	}
	if r.byExt == nil {
		r.byExt = make(map[string]Language)
	}

	for _, ext := range lang.Extensions {
		if owner, ok := r.byExt[ext]; ok && owner.ID != lang.ID {
			return fmt.Errorf("%w: %s is owned by %s", ErrExtensionAlreadyRegistered, ext, owner.ID)
		}
	}

	for ext, owner := range r.byExt {
		if owner.ID == lang.ID {
			delete(r.byExt, ext)
		}
	}
	if _, exists := r.byID[lang.ID]; exists {
		for i := range r.languages {
			if r.languages[i].ID == lang.ID {
				r.languages[i] = lang
				break
			}
		}
	} else {
		r.languages = append(r.languages, lang)
	}
	r.byID[lang.ID] = lang
	for _, ext := range lang.Extensions {
		r.byExt[ext] = lang
	}
	r.rebuildMatchers()
	return nil
}

func (r *Registry) Languages() []Language {
	return append([]Language(nil), r.languages...)
}

// Language returns a registered language by stable ID.
func (r *Registry) Language(id string) (Language, bool) {
	lang, ok := r.byID[id]
	return lang, ok
}

// ForPath resolves an explicit file request. Auto-detection-only exclusions
// do not apply here, but .knowns remains a hard routing boundary.
func (r *Registry) ForPath(path string) (Language, bool) {
	return r.matchPath(path, false)
}

// ForDetection resolves a path while honoring matchers that are explicit-only.
func (r *Registry) ForDetection(path string) (Language, bool) {
	return r.matchPath(path, true)
}

func (r *Registry) HasExtension(path string) bool {
	_, ok := r.ForPath(path)
	return ok
}

func (r *Registry) matchPath(path string, detection bool) (Language, bool) {
	if hasPathSegment(path, ".knowns") {
		return Language{}, false
	}

	firstLine := ""
	firstLineLoaded := false
	for _, candidate := range r.matchers {
		matcher := candidate.matcher
		matched := false
		switch matcher.Kind {
		case PathMatcherSuffix:
			matched = strings.HasSuffix(strings.ToLower(normalizedPath(path)), matcher.Pattern)
		case PathMatcherExact:
			matched = strings.EqualFold(pathBase(path), matcher.Pattern)
		case PathMatcherShebang:
			// Shebang routing is intentionally limited to extensionless files.
			// Files with an extension should resolve through suffix matchers and
			// should not add a filesystem read to repository-wide detection.
			if filepath.Ext(pathBase(path)) != "" {
				break
			}
			if !firstLineLoaded {
				firstLine = readFirstLine(path)
				firstLineLoaded = true
			}
			matched = shebangInterpreter(firstLine) == matcher.Pattern
		}
		if !matched {
			continue
		}
		if detection && matcher.ExplicitOnly {
			return Language{}, false
		}
		return candidate.language, true
	}
	return Language{}, false
}

func (r *Registry) rebuildMatchers() {
	r.matchers = r.matchers[:0]
	for _, lang := range r.languages {
		for _, matcher := range lang.Matchers {
			r.matchers = append(r.matchers, registeredPathMatcher{language: lang, matcher: matcher})
		}
	}
	sort.SliceStable(r.matchers, func(i, j int) bool {
		left := r.matchers[i]
		right := r.matchers[j]
		if left.matcher.Priority != right.matcher.Priority {
			return left.matcher.Priority > right.matcher.Priority
		}
		if len(left.matcher.Pattern) != len(right.matcher.Pattern) {
			return len(left.matcher.Pattern) > len(right.matcher.Pattern)
		}
		if left.matcher.Kind != right.matcher.Kind {
			return pathMatcherKindRank(left.matcher.Kind) < pathMatcherKindRank(right.matcher.Kind)
		}
		if left.matcher.Pattern != right.matcher.Pattern {
			return left.matcher.Pattern < right.matcher.Pattern
		}
		return left.language.ID < right.language.ID
	})
}

func normalizePathMatchers(extensions []string, matchers []PathMatcher) []PathMatcher {
	all := make([]PathMatcher, 0, len(extensions)+len(matchers))
	for _, ext := range extensions {
		all = append(all, PathMatcher{Kind: PathMatcherSuffix, Pattern: ext})
	}
	all = append(all, matchers...)

	seen := make(map[string]struct{}, len(all))
	out := make([]PathMatcher, 0, len(all))
	for _, matcher := range all {
		matcher.Pattern = strings.ToLower(strings.TrimSpace(matcher.Pattern))
		if matcher.Pattern == "" {
			continue
		}
		switch matcher.Kind {
		case PathMatcherSuffix:
			// Preserve legacy extension normalization while accepting compound
			// suffixes such as .tf.json.
			if !strings.HasPrefix(matcher.Pattern, ".") {
				matcher.Pattern = "." + matcher.Pattern
			}
		case PathMatcherExact, PathMatcherShebang:
		default:
			continue
		}
		key := fmt.Sprintf("%s\x00%s\x00%d\x00%t", matcher.Kind, matcher.Pattern, matcher.Priority, matcher.ExplicitOnly)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, matcher)
	}
	return out
}

func pathMatcherKindRank(kind PathMatcherKind) int {
	switch kind {
	case PathMatcherExact:
		return 0
	case PathMatcherSuffix:
		return 1
	case PathMatcherShebang:
		return 2
	default:
		return 3
	}
}

func normalizedPath(path string) string {
	return strings.ReplaceAll(path, "\\", "/")
}

func pathBase(path string) string {
	normalized := strings.TrimRight(normalizedPath(path), "/")
	if idx := strings.LastIndexByte(normalized, '/'); idx >= 0 {
		return normalized[idx+1:]
	}
	return normalized
}

func hasPathSegment(path, segment string) bool {
	for _, part := range strings.Split(normalizedPath(path), "/") {
		if strings.EqualFold(part, segment) {
			return true
		}
	}
	return false
}

func readFirstLine(path string) string {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		// Reject directories, devices, FIFOs, sockets, and every symlink before
		// opening. In particular, an extensionless symlink must never make
		// routing follow a potentially blocking FIFO or device target.
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	openedInfo, err := f.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		// Defend against the path changing after Lstat and before Open. Never
		// read when the opened handle is no longer the same regular file.
		return ""
	}
	buf := make([]byte, 1024)
	n, err := f.Read(buf)
	if err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	line := string(buf[:n])
	if idx := strings.IndexAny(line, "\r\n"); idx >= 0 {
		line = line[:idx]
	}
	return line
}

func shebangInterpreter(line string) string {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "#!") {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(line, "#!")))
	if len(fields) == 0 {
		return ""
	}
	interpreter := strings.ToLower(filepath.Base(fields[0]))
	if interpreter != "env" {
		return interpreter
	}
	for _, field := range fields[1:] {
		if strings.HasPrefix(field, "-") || strings.Contains(field, "=") {
			continue
		}
		return strings.ToLower(filepath.Base(field))
	}
	return ""
}

func normalizeRegistryExtensions(extensions []string) []string {
	if len(extensions) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(extensions))
	out := make([]string, 0, len(extensions))
	for _, ext := range extensions {
		ext = strings.ToLower(strings.TrimSpace(ext))
		if ext == "" {
			continue
		}
		if _, ok := seen[ext]; ok {
			continue
		}
		seen[ext] = struct{}{}
		out = append(out, ext)
	}
	return out
}
