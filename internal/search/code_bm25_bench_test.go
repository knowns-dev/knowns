package search

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func BenchmarkCodeBM25Search(b *testing.B) {
	root := findProjectRoot(b)
	files, err := filepath.Glob(filepath.Join(root, "internal", "**", "*.go"))
	if err != nil {
		b.Fatal(err)
	}
	if len(files) == 0 {
		b.Skip("no Go files found")
	}
	if len(files) > 50 {
		files = files[:50]
	}

	var allSummaries []CodeSummary
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		rel, _ := filepath.Rel(root, f)
		summaries := extractGoSymbolsFromSource(filepath.ToSlash(rel), string(data))
		allSummaries = append(allSummaries, summaries...)
	}

	if len(allSummaries) == 0 {
		b.Skip("no symbols found")
	}

	scorer := NewCodeBM25Scorer(allSummaries)
	b.ReportAllocs()
	b.ResetTimer()

	queries := []string{"login auth", "handleCodeDefinition", "Server", "BM25"}
	for _, q := range queries {
		b.Run(q, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, _ = scorer.Search(q, 20)
			}
		})
	}
}

var goFuncRe = regexp.MustCompile(`^(func\s+\(\s*\w+\s+\*?\w+\s*\)\s+)?func\s+(\w+)`)
var goTypeRe = regexp.MustCompile(`^(type\s+)(\w+)\s+(struct|interface)`)
var goCommentRe = regexp.MustCompile(`^//\s*(.*)`)

func extractGoSymbolsFromSource(relPath, source string) []CodeSummary {
	lines := strings.Split(source, "\n")
		pkg := PackageFromPath(relPath)
	var summaries []CodeSummary

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		if m := goFuncRe.FindStringSubmatch(trimmed); m != nil {
			name := m[2]
			receiver := ""
			if m[1] != "" {
				parts := strings.Fields(m[1])
				if len(parts) >= 2 {
					receiver = strings.Trim(parts[len(parts)-1], "*)")
				}
			}
			summary := CodeSummary{
				Name:      name,
				Kind:      "Function",
				Container: receiver,
				Path:      relPath,
				Package:   pkg,
				Comments:  extractGoComments(lines, i),
				StartLine: i + 1,
				EndLine:   i + 1,
			}
			summaries = append(summaries, summary)
		}

		if m := goTypeRe.FindStringSubmatch(trimmed); m != nil {
			summary := CodeSummary{
				Name:      m[2],
				Kind:      m[3],
				Container: pkg,
				Path:      relPath,
				Package:   pkg,
				Comments:  extractGoComments(lines, i),
				StartLine: i + 1,
				EndLine:   i + 1,
			}
			summaries = append(summaries, summary)
		}
	}
	return summaries
}

func extractGoComments(lines []string, symbolLine int) string {
	var comments []string
	for i := symbolLine - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			break
		}
		if m := goCommentRe.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else {
			break
		}
	}
	return strings.Join(comments, " ")
}

func findProjectRoot(b *testing.B) string {
	dir, err := os.Getwd()
	if err != nil {
		b.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	b.Fatal("could not find project root")
	return ""
}
