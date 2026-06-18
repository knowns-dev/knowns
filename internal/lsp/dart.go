package lsp

import (
	"os"
	"path/filepath"
	"strings"
)

const DartLanguageID = "dart"

type DartProjectSelection struct {
	Path string
	Kind string
}

func DiscoverDartProject(root string) DartProjectSelection {
	if root == "" {
		return DartProjectSelection{}
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		rootAbs = root
	}
	var firstDart string
	var selected DartProjectSelection
	_ = filepath.WalkDir(rootAbs, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", ".knowns", ".dart_tool", "build", "node_modules", "vendor":
				if path != rootAbs {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if firstDart == "" && strings.EqualFold(filepath.Ext(path), ".dart") {
			firstDart = path
		}
		if strings.EqualFold(filepath.Ext(path), ".dart") {
			candidate := discoverDartProjectForFile(rootAbs, path)
			if candidate.Kind == "pubspec" && selected.Kind != "pubspec" {
				selected = candidate
			}
			if candidate.Kind == "analysis_options" && selected.Path == "" {
				selected = candidate
			}
		}
		return nil
	})
	if selected.Path != "" {
		return selected
	}
	if firstDart == "" {
		return DartProjectSelection{}
	}
	return DartProjectSelection{Path: rootAbs, Kind: "root"}
}

func discoverDartProjectForFile(rootAbs, path string) DartProjectSelection {
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if fileExists(filepath.Join(dir, "pubspec.yaml")) {
			return DartProjectSelection{Path: dir, Kind: "pubspec"}
		}
		if fileExists(filepath.Join(dir, "analysis_options.yaml")) {
			return DartProjectSelection{Path: dir, Kind: "analysis_options"}
		}
		if samePath(dir, rootAbs) || dir == filepath.Dir(dir) {
			break
		}
	}
	return DartProjectSelection{}
}

func ParseDartSDKVersion(output string) string {
	output = strings.TrimSpace(output)
	if output == "" {
		return ""
	}
	const prefix = "Dart SDK version:"
	if strings.HasPrefix(output, prefix) {
		output = strings.TrimSpace(strings.TrimPrefix(output, prefix))
	}
	fields := strings.Fields(output)
	if len(fields) == 0 {
		return ""
	}
	return strings.Trim(fields[0], ",")
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func samePath(a, b string) bool {
	aa, errA := filepath.Abs(a)
	bb, errB := filepath.Abs(b)
	if errA == nil {
		a = aa
	}
	if errB == nil {
		b = bb
	}
	return filepath.Clean(a) == filepath.Clean(b)
}
