package lsp

import (
	"reflect"
	"testing"
)

func TestServerStatus_String(t *testing.T) {
	tests := []struct {
		status ServerStatus
		want   string
	}{
		{StatusNotInstalled, "not_installed"},
		{StatusInstalled, "installed"},
		{StatusStarting, "starting"},
		{StatusRunning, "running"},
		{StatusCrashed, "crashed"},
		{StatusDisabled, "disabled"},
		{ServerStatus(99), "unknown"},
	}
	for _, tt := range tests {
		if got := tt.status.String(); got != tt.want {
			t.Errorf("ServerStatus(%d).String() = %q, want %q", tt.status, got, tt.want)
		}
	}
}

func TestBaseAdapter_IsIgnoredDir(t *testing.T) {
	b := BaseAdapter{}
	if b.IsIgnoredDir("node_modules") {
		t.Error("BaseAdapter.IsIgnoredDir should return false by default")
	}
	if b.IsIgnoredDir("") {
		t.Error("BaseAdapter.IsIgnoredDir should return false for empty string")
	}
}

func TestBaseAdapter_NormalizeSymbolName(t *testing.T) {
	b := BaseAdapter{}
	cases := []string{"MyFunc", "some_var", "CamelCase", ""}
	for _, name := range cases {
		if got := b.NormalizeSymbolName(name); got != name {
			t.Errorf("BaseAdapter.NormalizeSymbolName(%q) = %q, want %q", name, got, name)
		}
	}
}

func TestBaseAdapter_SupportsImplementation(t *testing.T) {
	b := BaseAdapter{}
	if !b.SupportsImplementation() {
		t.Error("BaseAdapter.SupportsImplementation should return true by default")
	}
}

func TestBaseAdapter_SupportsReferences(t *testing.T) {
	b := BaseAdapter{}
	if !b.SupportsReferences() {
		t.Error("BaseAdapter.SupportsReferences should return true by default")
	}
}

func TestLanguageAdapterExcludesRuntimeSessionOperations(t *testing.T) {
	adapterType := reflect.TypeOf((*LanguageAdapter)(nil)).Elem()
	for _, name := range []string{
		"Start",
		"Stop",
		"WithFile",
		"WaitReady",
		"Definition",
		"References",
		"Diagnostics",
		"DocumentSymbols",
		"Rename",
	} {
		if _, ok := adapterType.MethodByName(name); ok {
			t.Fatalf("LanguageAdapter includes runtime/session method %q; keep lifecycle/protocol behavior in Session", name)
		}
	}
}

func TestInstallGuide_Construction(t *testing.T) {
	g := InstallGuide{
		Command:   "go install golang.org/x/tools/gopls@latest",
		URL:       "https://pkg.go.dev/golang.org/x/tools/gopls",
		KnownsCmd: "knowns lsp install go",
		Notes:     "Requires Go 1.21+",
	}
	if g.Command == "" || g.URL == "" || g.KnownsCmd == "" || g.Notes == "" {
		t.Error("InstallGuide fields should be populated")
	}
}

func TestRuntimeDependency_Construction(t *testing.T) {
	d := RuntimeDependency{
		ID:          "gopls",
		PlatformID:  "darwin-arm64",
		URL:         "https://example.com/gopls.tar.gz",
		SHA256:      "abc123",
		ArchiveType: "tar.gz",
		BinaryName:  "gopls",
		ExtractPath: "gopls/bin/gopls",
	}
	if d.ID == "" || d.PlatformID == "" || d.URL == "" {
		t.Error("RuntimeDependency fields should be populated")
	}
}

func TestPrerequisite_Construction(t *testing.T) {
	p := Prerequisite{
		Name:        "Java JDK 17+",
		CheckCmd:    "java -version",
		InstallHint: "Install from https://adoptium.net",
	}
	if p.Name == "" || p.CheckCmd == "" || p.InstallHint == "" {
		t.Error("Prerequisite fields should be populated")
	}
}

func TestBinaryCandidate_Construction(t *testing.T) {
	bc := BinaryCandidate{
		Name:      "gopls",
		Args:      []string{"serve"},
		CheckArgs: []string{"version"},
	}
	if bc.Name == "" {
		t.Error("BinaryCandidate.Name should be populated")
	}
	if len(bc.Args) != 1 || bc.Args[0] != "serve" {
		t.Error("BinaryCandidate.Args should contain expected values")
	}
	if len(bc.CheckArgs) != 1 || bc.CheckArgs[0] != "version" {
		t.Error("BinaryCandidate.CheckArgs should contain expected values")
	}
}
