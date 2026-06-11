package cli

import (
	"regexp"
	"strings"

	"github.com/howznguyen/knowns/internal/search"
)

// Go

var goFuncRe = regexp.MustCompile(`^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)`)
var goTypeRe = regexp.MustCompile(`^type\s+(\w+)\s+(struct|interface)`)
var goVarRe = regexp.MustCompile(`^(?:var|const)\s+(\w+)`)
var goCommentRe = regexp.MustCompile(`^//\s*(.*)`)

func extractGoSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := goFuncRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Function", Container: extractReceiver(trimmed),
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, goCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
		}
		if m := goTypeRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: m[2], Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, goCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
		}
		if m := goVarRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Variable", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, goCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
		}
	}
	return summaries
}

func extractReceiver(line string) string {
	start := strings.Index(line, "(")
	end := strings.Index(line, ")")
	if start == -1 || end == -1 || end <= start {
		return ""
	}
	parts := strings.Fields(line[start+1 : end])
	if len(parts) >= 2 {
		return strings.Trim(parts[len(parts)-1], "*")
	}
	return ""
}

// TypeScript / JavaScript

var tsClassRe = regexp.MustCompile(`^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)`)
var tsInterfaceRe = regexp.MustCompile(`^(?:export\s+)?interface\s+(\w+)`)
var tsTypeRe = regexp.MustCompile(`^(?:export\s+)?type\s+(\w+)\s*=`)
var tsFunctionRe = regexp.MustCompile(`^(?:export\s+)?(?:async\s+)?function\s+(\w+)`)
var tsMethodRe = regexp.MustCompile(`^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>\[\]| ]+)?\s*{`)
var tsConstRe = regexp.MustCompile(`^(?:export\s+)?const\s+(\w+)\s*=`)
var tsLetRe = regexp.MustCompile(`^(?:export\s+)?let\s+(\w+)\s*=`)
var tsArrowRe = regexp.MustCompile(`^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)`)
var tsCommentRe = regexp.MustCompile(`^\s*//\s*(.*)`)
var tsDocRe = regexp.MustCompile(`^\s*\*\s*(.*)`)

func extractTSSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inClass := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if m := tsClassRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Class", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := tsInterfaceRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Interface", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := tsTypeRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Type", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := tsFunctionRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Function", Container: inClass,
				Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if inClass != "" {
			if m := tsMethodRe.FindStringSubmatch(line); m != nil {
				name := m[1]
				if name == "if" || name == "for" || name == "while" || name == "switch" || name == "catch" || name == "constructor" {
					continue
				}
				summaries = append(summaries, search.CodeSummary{
					Name: name, Kind: "Method", Container: inClass,
					Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
					Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
				})
				continue
			}
		}
		if m := tsArrowRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Function", Container: inClass,
				Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := tsConstRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Constant", Container: inClass,
				Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := tsLetRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Variable", Container: inClass,
				Path: relPath, Package: pkg, Comments: extractTSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

func extractTSComments(lines []string, symbolLine int) string {
	var comments []string
	for i := symbolLine - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			break
		}
		if m := tsDocRe.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else if m := tsCommentRe.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else if trimmed == "*/" || trimmed == "/**" {
			continue
		} else {
			break
		}
	}
	return strings.Join(comments, " ")
}

// Python

var pyDefRe = regexp.MustCompile(`^(?:async\s+)?def\s+(\w+)\s*\(`)
var pyClassRe = regexp.MustCompile(`^class\s+(\w+)`)
var pyCommentRe = regexp.MustCompile(`^#\s*(.*)`)

func extractPythonSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inClass := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := pyClassRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Class", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, pyCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := pyDefRe.FindStringSubmatch(trimmed); m != nil {
			kind := "Function"
			if strings.HasPrefix(trimmed, "async ") {
				kind = "AsyncFunction"
			}
			if m[1] == "__init__" {
				kind = "Constructor"
			} else if strings.HasPrefix(m[1], "__") && strings.HasSuffix(m[1], "__") {
				kind = "DunderMethod"
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: kind, Container: inClass,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, pyCommentRe),
				Signature: extractColonSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

// Rust

var rustFnRe = regexp.MustCompile(`^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)`)
var rustStructRe = regexp.MustCompile(`^(?:pub\s+)?struct\s+(\w+)`)
var rustEnumRe = regexp.MustCompile(`^(?:pub\s+)?enum\s+(\w+)`)
var rustTraitRe = regexp.MustCompile(`^(?:pub\s+)?trait\s+(\w+)`)
var rustImplRe = regexp.MustCompile(`^impl(?:\s+<[^>]+>)?\s+(\w+)`)
var rustConstRe = regexp.MustCompile(`^(?:pub\s+)?const\s+(\w+)`)
var rustCommentRe = regexp.MustCompile(`^\s*//[/!]?\s*(.*)`)

func extractRustSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inImpl := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := rustStructRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Struct", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rustCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inImpl = ""
			continue
		}
		if m := rustEnumRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Enum", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rustCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := rustTraitRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Trait", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rustCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := rustImplRe.FindStringSubmatch(trimmed); m != nil {
			inImpl = m[1]
			continue
		}
		if m := rustFnRe.FindStringSubmatch(trimmed); m != nil {
			container := inImpl
			if container == "" {
				container = pkg
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Function", Container: container,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rustCommentRe),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := rustConstRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Constant", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rustCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

// C#

var csNamespaceRe = regexp.MustCompile(`^namespace\s+([\w.]+)`)
var csClassRe = regexp.MustCompile(`^(?:public|private|protected|internal|sealed|abstract|static\s+)*class\s+(\w+)`)
var csInterfaceRe = regexp.MustCompile(`^(?:public|private|protected|internal)\s+interface\s+(\w+)`)
var csStructRe = regexp.MustCompile(`^(?:public|private|protected|internal)\s+struct\s+(\w+)`)
var csEnumRe = regexp.MustCompile(`^(?:public|private|protected|internal)\s+enum\s+(\w+)`)
var csMethodRe = regexp.MustCompile(`^\s*(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|readonly\s+)*\s*(?:[\w<>\[\],\s]+)\s+(\w+)\s*\([^)]*\)`)
var csPropertyRe = regexp.MustCompile(`^\s*(?:public|private|protected|internal|static)\s+([\w<>\[\]]+)\s+(\w+)\s*\{`)
var csCommentRe = regexp.MustCompile(`^\s*//\s*(.*)`)
var csDocRe = regexp.MustCompile(`^\s*///\s*<[^>]*>\s*(.*)`)

func extractCSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	namespace := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inClass := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := csNamespaceRe.FindStringSubmatch(trimmed); m != nil {
			namespace = m[1]
			continue
		}
		if m := csClassRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Class", Container: namespace,
				Path: relPath, Package: namespace, Comments: extractCSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := csInterfaceRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Interface", Container: namespace,
				Path: relPath, Package: namespace, Comments: extractCSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := csStructRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Struct", Container: namespace,
				Path: relPath, Package: namespace, Comments: extractCSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := csEnumRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Enum", Container: namespace,
				Path: relPath, Package: namespace, Comments: extractCSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := csMethodRe.FindStringSubmatch(trimmed); m != nil {
			kind := "Method"
			if m[1] == inClass {
				kind = "Constructor"
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: kind, Container: inClass,
				Path: relPath, Package: namespace, Comments: extractCSComments(lines, i),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := csPropertyRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[2], Kind: "Property", Container: inClass,
				Path: relPath, Package: namespace, Comments: extractCSComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

func extractCSComments(lines []string, symbolLine int) string {
	var comments []string
	for i := symbolLine - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			break
		}
		if m := csDocRe.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else if m := csCommentRe.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else {
			break
		}
	}
	return strings.Join(comments, " ")
}

// Java

var javaPackageRe = regexp.MustCompile(`^package\s+([\w.]+)`)
var javaClassRe = regexp.MustCompile(`^(?:public|private|protected|abstract|final|static\s+)*\s*class\s+(\w+)`)
var javaInterfaceRe = regexp.MustCompile(`^(?:public|private|protected)\s+interface\s+(\w+)`)
var javaEnumRe = regexp.MustCompile(`^(?:public|private|protected)\s+enum\s+(\w+)`)
var javaRecordRe = regexp.MustCompile(`^(?:public|private|protected)\s+record\s+(\w+)`)
var javaMethodRe = regexp.MustCompile(`^\s*(?:public|private|protected|static|final|abstract|synchronized|native|strictfp\s+)*\s*(?:[\w<>\[\],\s]+)\s+(\w+)\s*\([^)]*\)`)
var javaCommentRe = regexp.MustCompile(`^\s*//\s*(.*)`)
var javaDocRe = regexp.MustCompile(`^\s*\*\s*(.*)`)

func extractJavaSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inClass := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := javaPackageRe.FindStringSubmatch(trimmed); m != nil {
			pkg = m[1]
			continue
		}
		if m := javaClassRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Class", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractJavaComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := javaInterfaceRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Interface", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractJavaComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := javaEnumRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Enum", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractJavaComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := javaRecordRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Record", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractJavaComments(lines, i),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := javaMethodRe.FindStringSubmatch(trimmed); m != nil {
			kind := "Method"
			if m[1] == inClass {
				kind = "Constructor"
			} else if m[1] == "main" {
				kind = "Function"
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: kind, Container: inClass,
				Path: relPath, Package: pkg, Comments: extractJavaComments(lines, i),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

func extractJavaComments(lines []string, symbolLine int) string {
	var comments []string
	for i := symbolLine - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			break
		}
		if m := javaDocRe.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else if m := javaCommentRe.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else {
			break
		}
	}
	return strings.Join(comments, " ")
}

// Kotlin

var kotlinPackageRe = regexp.MustCompile(`^package\s+([\w.]+)`)
var kotlinClassRe = regexp.MustCompile(`^(?:abstract|data|sealed|enum|inner\s+)*\s*class\s+(\w+)`)
var kotlinObjectRe = regexp.MustCompile(`^(?:companion\s+)?object\s+(\w*)`)
var kotlinInterfaceRe = regexp.MustCompile(`^interface\s+(\w+)`)
var kotlinFunRe = regexp.MustCompile(`^\s*(?:suspend\s+)?(?:fun)\s+(\w+)`)
var kotlinCommentRe = regexp.MustCompile(`^\s*//\s*(.*)`)

func extractKotlinSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inClass := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := kotlinPackageRe.FindStringSubmatch(trimmed); m != nil {
			pkg = m[1]
			continue
		}
		if m := kotlinClassRe.FindStringSubmatch(trimmed); m != nil {
			kind := "Class"
			if strings.HasPrefix(trimmed, "enum ") {
				kind = "Enum"
			} else if strings.HasPrefix(trimmed, "sealed ") {
				kind = "SealedClass"
			} else if strings.HasPrefix(trimmed, "data ") {
				kind = "DataClass"
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: kind, Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, kotlinCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := kotlinObjectRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: "object", Kind: "Object", Container: inClass,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, kotlinCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := kotlinInterfaceRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Interface", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, kotlinCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := kotlinFunRe.FindStringSubmatch(trimmed); m != nil {
			kind := "Function"
			container := inClass
			if strings.HasPrefix(trimmed, "fun ") {
				container = pkg
			}
			if strings.HasPrefix(trimmed, "suspend fun ") {
				kind = "SuspendFunction"
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: kind, Container: container,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, kotlinCommentRe),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

// C / C++

var cppClassRe = regexp.MustCompile(`^(?:class|struct)\s+(\w+)`)
var cppEnumRe = regexp.MustCompile(`^enum\s+(?:class\s+)?(\w+)`)
var cppFnRe = regexp.MustCompile(`^(?:[\w:*&<>\[\]]+\s+)+(\w+)\s*\([^)]*\)`)
var cppCommentRe = regexp.MustCompile(`^\s*//\s*(.*)`)

func extractCppSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	var summaries []search.CodeSummary
	inClass := ""
	inNamespace := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "namespace ") {
			parts := strings.Fields(trimmed)
			if len(parts) >= 2 {
				inNamespace = parts[1]
			}
			continue
		}
		if m := cppClassRe.FindStringSubmatch(trimmed); m != nil {
			kind := "Class"
			if strings.HasPrefix(trimmed, "struct ") {
				kind = "Struct"
			}
			container := inNamespace
			if container != "" {
				container = inNamespace + "::"
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: kind, Container: container,
				Path: relPath, Package: inNamespace, Comments: extractLineComments(lines, i, cppCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := cppEnumRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Enum", Container: inNamespace,
				Path: relPath, Package: inNamespace, Comments: extractLineComments(lines, i, cppCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := cppFnRe.FindStringSubmatch(trimmed); m != nil {
			container := inClass
			if container == "" {
				container = inNamespace
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Function", Container: container,
				Path: relPath, Package: inNamespace, Comments: extractLineComments(lines, i, cppCommentRe),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

// PHP

var phpClassRe = regexp.MustCompile(`^(?:abstract|final)?\s*(class|interface|trait)\s+(\w+)`)
var phpFnRe = regexp.MustCompile(`^\s*(?:public|private|protected|static|abstract|final\s+)*\s*function\s+(\w+)`)
var phpCommentRe = regexp.MustCompile(`^\s*//\s*(.*)`)

func extractPHPSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	var summaries []search.CodeSummary
	inClass := ""
	namespace := search.PackageFromPath(relPath)

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "namespace ") {
			parts := strings.Fields(trimmed)
			if len(parts) >= 2 {
				namespace = strings.TrimSuffix(parts[1], ";")
			}
			continue
		}
		if m := phpClassRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[2], Kind: titleCase(m[1]), Container: namespace,
				Path: relPath, Package: namespace, Comments: extractLineComments(lines, i, phpCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[2]
			continue
		}
		if m := phpFnRe.FindStringSubmatch(trimmed); m != nil {
			container := inClass
			if container == "" {
				container = namespace
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Function", Container: container,
				Path: relPath, Package: namespace, Comments: extractLineComments(lines, i, phpCommentRe),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

// Ruby

var rubyClassRe = regexp.MustCompile(`^\s*class\s+([\w:]+)`)
var rubyModuleRe = regexp.MustCompile(`^\s*module\s+([\w:]+)`)
var rubyDefRe = regexp.MustCompile(`^\s*def\s+(?:self\.)?(\w+)`)
var rubyCommentRe = regexp.MustCompile(`^\s*#\s*(.*)`)

func extractRubySymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inClass := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := rubyClassRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Class", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rubyCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := rubyModuleRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Module", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rubyCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inClass = m[1]
			continue
		}
		if m := rubyDefRe.FindStringSubmatch(trimmed); m != nil {
			kind := "Method"
			if inClass == "" {
				kind = "Function"
			}
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: kind, Container: inClass,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, rubyCommentRe),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

// Swift

var swiftClassRe = regexp.MustCompile(`^(?:public|private|internal|fileprivate|open\s+)*(class|struct|enum|actor)\s+(\w+)`)
var swiftProtocolRe = regexp.MustCompile(`^(?:public|private|internal|fileprivate|open\s+)*protocol\s+(\w+)`)
var swiftExtensionRe = regexp.MustCompile(`^extension\s+(\w+)`)
var swiftFuncRe = regexp.MustCompile(`^\s*(?:public|private|internal|mutating|async\s+)*(?:func)\s+(\w+)`)
var swiftCommentRe = regexp.MustCompile(`^\s*//\s*(.*)`)

func extractSwiftSymbols(relPath, source string) []search.CodeSummary {
	lines := strings.Split(source, "\n")
	pkg := search.PackageFromPath(relPath)
	var summaries []search.CodeSummary
	inType := ""

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := swiftClassRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[2], Kind: titleCase(m[1]), Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, swiftCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			inType = m[2]
			continue
		}
		if m := swiftProtocolRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Protocol", Container: pkg,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, swiftCommentRe),
				StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
		if m := swiftExtensionRe.FindStringSubmatch(trimmed); m != nil {
			inType = m[1]
			continue
		}
		if m := swiftFuncRe.FindStringSubmatch(trimmed); m != nil {
			summaries = append(summaries, search.CodeSummary{
				Name: m[1], Kind: "Function", Container: inType,
				Path: relPath, Package: pkg, Comments: extractLineComments(lines, i, swiftCommentRe),
				Signature: extractBraceSignature(lines, i), StartLine: i + 1, EndLine: i + 1,
			})
			continue
		}
	}
	return summaries
}

// titleCase capitalizes first letter of s. Replaces deprecated strings.Title.
func titleCase(s string) string {
	if s == "" {
		return ""
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func extractLineComments(lines []string, symbolLine int, re *regexp.Regexp) string {
	var comments []string
	for i := symbolLine - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			break
		}
		if m := re.FindStringSubmatch(trimmed); m != nil {
			comments = append([]string{m[1]}, comments...)
		} else {
			break
		}
	}
	return strings.Join(comments, " ")
}

func extractBraceSignature(lines []string, lineIdx int) string {
	if lineIdx < 0 || lineIdx >= len(lines) {
		return ""
	}
	line := strings.TrimSpace(lines[lineIdx])
	if idx := strings.Index(line, "{"); idx > 0 {
		return strings.TrimSpace(line[:idx])
	}
	return line
}

func extractColonSignature(lines []string, lineIdx int) string {
	if lineIdx < 0 || lineIdx >= len(lines) {
		return ""
	}
	line := strings.TrimSpace(lines[lineIdx])
	if idx := strings.Index(line, ":"); idx > 0 {
		return strings.TrimSpace(line[:idx])
	}
	return line
}
