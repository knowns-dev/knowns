package lsp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

type Location struct {
	URI   string `json:"uri"`
	Range Range  `json:"range"`
}

type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

type Diagnostic struct {
	Range    Range  `json:"range"`
	Severity int    `json:"severity,omitempty"`
	Message  string `json:"message"`
}

type DocumentSymbol struct {
	Name           string           `json:"name"`
	Detail         string           `json:"detail,omitempty"`
	Kind           int              `json:"kind"`
	Range          Range            `json:"range"`
	SelectionRange Range            `json:"selectionRange"`
	Children       []DocumentSymbol `json:"children,omitempty"`
}

type TextEdit struct {
	Range   Range  `json:"range"`
	NewText string `json:"newText"`
}

type TextDocumentEdit struct {
	TextDocument struct {
		URI     string `json:"uri"`
		Version *int   `json:"version"`
	} `json:"textDocument"`
	Edits []TextEdit `json:"edits"`
}

type WorkspaceEdit struct {
	Changes         map[string][]TextEdit `json:"changes"`
	DocumentChanges []TextDocumentEdit    `json:"documentChanges"`
}

// AllChanges returns a unified map of URI → edits, merging both Changes and DocumentChanges.
func (w *WorkspaceEdit) AllChanges() map[string][]TextEdit {
	if len(w.Changes) > 0 {
		return w.Changes
	}
	result := make(map[string][]TextEdit)
	for _, dc := range w.DocumentChanges {
		result[dc.TextDocument.URI] = append(result[dc.TextDocument.URI], dc.Edits...)
	}
	return result
}

func (s *Server) Definition(ctx context.Context, path string, line, col int) (Location, error) {
	locs, err := s.locations(ctx, "textDocument/definition", path, line, col)
	if err != nil {
		return Location{}, err
	}
	if len(locs) == 0 {
		return Location{}, fmt.Errorf("definition not found")
	}
	return locs[0], nil
}

func (s *Server) References(ctx context.Context, path string, line, col int) ([]Location, error) {
	params := positionParams(path, line, col)
	params["context"] = map[string]any{"includeDeclaration": false}
	return s.locationsWithParams(ctx, "textDocument/references", params)
}

func (s *Server) Implementations(ctx context.Context, path string, line, col int) ([]Location, error) {
	return s.locations(ctx, "textDocument/implementation", path, line, col)
}
func (s *Server) Diagnostics(ctx context.Context, path string) ([]Diagnostic, error) {
	if err := s.Start(ctx); err != nil {
		return nil, err
	}
	if err := s.files.Open(path); err != nil {
		return nil, err
	}
	defer func() { _ = s.files.Close(path) }()

	return s.cachedDiagnostics(path), nil
}

func (s *Server) DocumentSymbols(ctx context.Context, path string) ([]DocumentSymbol, error) {
	if err := s.Start(ctx); err != nil {
		return nil, err
	}
	if err := s.files.Open(path); err != nil {
		return nil, err
	}
	defer func() { _ = s.files.Close(path) }()

	params := map[string]any{"textDocument": map[string]any{"uri": fileURI(path)}}
	var raw json.RawMessage
	if err := s.request(ctx, "textDocument/documentSymbol", params, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	// Try flat SymbolInformation format first (gopls uses this)
	var flat []struct {
		Name          string   `json:"name"`
		Kind          int      `json:"kind"`
		Location      Location `json:"location"`
		ContainerName string   `json:"containerName,omitempty"`
	}
	if err := json.Unmarshal(raw, &flat); err == nil && len(flat) > 0 && flat[0].Location.URI != "" {
		symbols := make([]DocumentSymbol, 0, len(flat))
		for _, item := range flat {
			symbols = append(symbols, DocumentSymbol{
				Name:           item.Name,
				Kind:           item.Kind,
				Range:          item.Location.Range,
				SelectionRange: item.Location.Range,
			})
		}
		return symbols, nil
	}
	// Try hierarchical DocumentSymbol format
	var symbols []DocumentSymbol
	if err := json.Unmarshal(raw, &symbols); err != nil {
		return nil, err
	}
	return symbols, nil
}

func (s *Server) Rename(ctx context.Context, path string, line, col int, newName string) (*WorkspaceEdit, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		lines := strings.Split(string(data), "\n")
		if line >= 0 && line < len(lines) {
			col = utf16Col([]byte(lines[line]), col)
		}
	}
	params := positionParams(path, line, col)
	params["newName"] = newName
	var edit WorkspaceEdit
	if err := s.request(ctx, "textDocument/rename", params, &edit); err != nil {
		return nil, err
	}
	return &edit, nil
}

func FindSymbolPosition(path, query string) (int, int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}
	pattern, err := regexp.Compile(`\b` + regexp.QuoteMeta(query) + `\b`)
	if err != nil {
		return 0, 0, err
	}
	lines := strings.Split(string(data), "\n")
	inBlockComment := false
	for lineNo, line := range lines {
		searchLine, nextInBlock := codeOnlyLine(line, inBlockComment)
		inBlockComment = nextInBlock
		matches := pattern.FindAllStringIndex(searchLine, -1)
		for _, match := range matches {
			if symbolBoundary(searchLine, match[0], len(query)) {
				return lineNo, utf16Col([]byte(line), match[0]), nil
			}
		}
	}
	return 0, 0, fmt.Errorf("symbol %q not found in %s", query, path)
}

func Snippet(path string, line int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	if line < 0 || line >= len(lines) {
		return ""
	}
	return strings.TrimSpace(lines[line])
}

func NameAt(path string, line, col int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	if line < 0 || line >= len(lines) || col < 0 || col >= len(lines[line]) {
		return ""
	}
	start, end := col, col
	for start > 0 && isSymbolRune(rune(lines[line][start-1])) {
		start--
	}
	for end < len(lines[line]) && isSymbolRune(rune(lines[line][end])) {
		end++
	}
	return lines[line][start:end]
}
func (s *Server) locations(ctx context.Context, method, path string, line, col int) ([]Location, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		lines := strings.Split(string(data), "\n")
		if line >= 0 && line < len(lines) {
			col = utf16Col([]byte(lines[line]), col)
		}
	}
	return s.locationsWithParams(ctx, method, positionParams(path, line, col))
}
func (s *Server) locationsWithParams(ctx context.Context, method string, params map[string]any) ([]Location, error) {
	var raw json.RawMessage
	if err := s.request(ctx, method, params, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	if raw[0] == '[' {
		var links []struct {
			TargetURI            string `json:"targetUri"`
			TargetRange          Range  `json:"targetRange"`
			TargetSelectionRange Range  `json:"targetSelectionRange"`
		}
		if err := json.Unmarshal(raw, &links); err == nil && len(links) > 0 && links[0].TargetURI != "" {
			locs := make([]Location, 0, len(links))
			for _, link := range links {
				rng := link.TargetSelectionRange
				if rng == (Range{}) {
					rng = link.TargetRange
				}
				locs = append(locs, Location{URI: link.TargetURI, Range: rng})
			}
			return locs, nil
		}
		var locs []Location
		if err := json.Unmarshal(raw, &locs); err != nil {
			return nil, err
		}
		return locs, nil
	}
	var loc Location
	if err := json.Unmarshal(raw, &loc); err != nil {
		return nil, err
	}
	return []Location{loc}, nil
}

func positionParams(path string, line, col int) map[string]any {
	return map[string]any{
		"textDocument": map[string]any{"uri": fileURI(path)},
		"position":     map[string]any{"line": line, "character": col},
	}
}

func sameFileURI(uri, path string) bool {
	return SameFileURI(uri, path)
}

func codeOnlyLine(line string, inBlockComment bool) (string, bool) {
	out := []rune(line)
	for i := range out {
		out[i] = ' '
	}
	inString := false
	var quote rune
	escaped := false
	runes := []rune(line)
	for i := 0; i < len(runes); i++ {
		if inBlockComment {
			if i+1 < len(runes) && runes[i] == '*' && runes[i+1] == '/' {
				inBlockComment = false
				i++
			}
			continue
		}
		if inString {
			if !escaped && runes[i] == quote {
				inString = false
			}
			escaped = !escaped && runes[i] == '\\' && quote != '`'
			continue
		}
		if i+1 < len(runes) && runes[i] == '/' && runes[i+1] == '/' {
			break
		}
		if i+1 < len(runes) && runes[i] == '/' && runes[i+1] == '*' {
			inBlockComment = true
			i++
			continue
		}
		if runes[i] == '"' || runes[i] == '\'' || runes[i] == '`' {
			inString = true
			quote = runes[i]
			escaped = false
			continue
		}
		out[i] = runes[i]
	}
	return string(out), inBlockComment
}

func utf16Col(line []byte, byteOffset int) int {
	if byteOffset > len(line) {
		byteOffset = len(line)
	}
	col := 0
	for i := 0; i < byteOffset; {
		r, size := utf8.DecodeRune(line[i:])
		if r > 0xFFFF {
			col += 2
		} else {
			col++
		}
		i += size
	}
	return col
}

func symbolBoundary(line string, start, length int) bool {
	beforeOK := start == 0 || !isSymbolRune(rune(line[start-1]))
	end := start + length
	afterOK := end >= len(line) || !isSymbolRune(rune(line[end]))
	return beforeOK && afterOK
}

func isSymbolRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r)
}
