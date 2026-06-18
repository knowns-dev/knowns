package adapters

import (
	"reflect"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestAdaptersSatisfyLanguageAdapter(t *testing.T) {
	var _ lsp.LanguageAdapter = NewGoAdapter()
	var _ lsp.LanguageAdapter = NewTypeScriptAdapter()
	var _ lsp.LanguageAdapter = NewPythonAdapter()
	var _ lsp.LanguageAdapter = NewRustAnalyzerAdapter()
	var _ lsp.LanguageAdapter = NewClangdAdapter()
	var _ lsp.LanguageAdapter = NewJdtlsAdapter()
	var _ lsp.LanguageAdapter = NewRoslynAdapter()
	var _ lsp.LanguageAdapter = NewDartAdapter()
	var _ lsp.LanguageAdapter = NewRubyLspAdapter()
	var _ lsp.LanguageAdapter = NewIntelephenseAdapter()
	var _ lsp.LanguageAdapter = NewScssAdapter()
}

func TestAdapterMetadata(t *testing.T) {
	tests := []struct {
		name        string
		adapter     lsp.LanguageAdapter
		id          string
		displayName string
		extensions  []string
		canInstall  bool
	}{
		{name: "go", adapter: NewGoAdapter(), id: "go", displayName: "Go", extensions: []string{".go"}, canInstall: false},
		{name: "typescript", adapter: NewTypeScriptAdapter(), id: "typescript", displayName: "TypeScript", extensions: []string{".ts", ".tsx", ".js", ".jsx"}, canInstall: true},
		{name: "python", adapter: NewPythonAdapter(), id: "python", displayName: "Python", extensions: []string{".py"}, canInstall: true},
		{name: "rust", adapter: NewRustAnalyzerAdapter(), id: "rust", displayName: "Rust", extensions: []string{".rs"}, canInstall: true},
		{name: "c_cpp", adapter: NewClangdAdapter(), id: "c_cpp", displayName: "C/C++", extensions: []string{".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"}, canInstall: true},
		{name: "java", adapter: NewJdtlsAdapter(), id: "java", displayName: "Java", extensions: []string{".java"}, canInstall: true},
		{name: "csharp", adapter: NewRoslynAdapter(), id: "csharp", displayName: "C#", extensions: []string{".cs"}, canInstall: true},
		{name: "dart", adapter: NewDartAdapter(), id: "dart", displayName: "Dart", extensions: []string{".dart"}, canInstall: false},
		{name: "ruby", adapter: NewRubyLspAdapter(), id: "ruby", displayName: "Ruby", extensions: []string{".rb", ".rake", ".gemspec"}, canInstall: true},
		{name: "php", adapter: NewIntelephenseAdapter(), id: "php", displayName: "PHP", extensions: []string{".php"}, canInstall: true},
		{name: "scss", adapter: NewScssAdapter(), id: "scss", displayName: "SCSS/Sass/CSS", extensions: []string{".scss", ".sass", ".css"}, canInstall: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.adapter.ID(); got != tt.id {
				t.Fatalf("ID() = %q, want %q", got, tt.id)
			}
			if got := tt.adapter.Name(); got != tt.displayName {
				t.Fatalf("Name() = %q, want %q", got, tt.displayName)
			}
			if got := tt.adapter.Extensions(); !reflect.DeepEqual(got, tt.extensions) {
				t.Fatalf("Extensions() = %#v, want %#v", got, tt.extensions)
			}
			guide := tt.adapter.InstallGuide()
			if guide.Command == "" && guide.KnownsCmd == "" && guide.URL == "" && guide.Notes == "" {
				t.Fatalf("InstallGuide() is empty")
			}
			if got := tt.adapter.CanInstall(); got != tt.canInstall {
				t.Fatalf("CanInstall() = %v, want %v", got, tt.canInstall)
			}
		})
	}
}

func TestAllAdapters(t *testing.T) {
	adapters := AllAdapters()
	if len(adapters) != 11 {
		t.Fatalf("AllAdapters() returned %d adapters, want 11", len(adapters))
	}
	ids := make(map[string]bool, len(adapters))
	for _, adapter := range adapters {
		ids[adapter.ID()] = true
	}
	for _, id := range []string{"go", "typescript", "python", "rust", "c_cpp", "java", "csharp", "dart", "ruby", "php", "scss"} {
		if !ids[id] {
			t.Fatalf("AllAdapters() missing %q", id)
		}
	}
}

func TestPhase1AdapterPrerequisites(t *testing.T) {
	tests := []struct {
		name    string
		adapter lsp.LanguageAdapter
		want    []lsp.Prerequisite
	}{
		{name: "c_cpp", adapter: NewClangdAdapter(), want: nil},
		{name: "java", adapter: NewJdtlsAdapter(), want: []lsp.Prerequisite{{Name: "Java JDK 17+", CheckCmd: "java -version", InstallHint: "Install JDK 17+ from https://adoptium.net/"}}},
		{name: "csharp", adapter: NewRoslynAdapter(), want: []lsp.Prerequisite{{Name: ".NET SDK 10+", CheckCmd: "dotnet --version", InstallHint: "Install .NET SDK 10+ from https://dotnet.microsoft.com/download"}}},
		{name: "dart", adapter: NewDartAdapter(), want: []lsp.Prerequisite{{Name: "Dart SDK", CheckCmd: "dart --version", InstallHint: "Install Dart SDK from https://dart.dev/get-dart"}}},
		{name: "ruby", adapter: NewRubyLspAdapter(), want: []lsp.Prerequisite{{Name: "Ruby 3.1+", CheckCmd: "ruby --version", InstallHint: "Install Ruby 3.1+ from https://www.ruby-lang.org/en/downloads/"}}},
		{name: "php", adapter: NewIntelephenseAdapter(), want: []lsp.Prerequisite{{Name: "Node.js 18+", CheckCmd: "node --version", InstallHint: "Install Node.js 18+ from https://nodejs.org/"}}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.adapter.Prerequisites(); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("Prerequisites() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestDartAdapterCommand(t *testing.T) {
	adapter := NewDartAdapter()
	binaries := adapter.Binaries()
	if len(binaries) != 1 {
		t.Fatalf("Binaries() returned %d candidates, want 1", len(binaries))
	}
	if binaries[0].Name != "dart" || !reflect.DeepEqual(binaries[0].Args, []string{"language-server"}) {
		t.Fatalf("dart candidate = %#v, want dart language-server", binaries[0])
	}
	if !reflect.DeepEqual(adapter.DefaultArgs(), []string{"language-server"}) {
		t.Fatalf("DefaultArgs() = %#v, want language-server", adapter.DefaultArgs())
	}
	if adapter.CanInstall() {
		t.Fatal("CanInstall() = true, want false for SDK-managed Dart")
	}
}

func TestNPMAdaptersUseManagedRuntimeDependencies(t *testing.T) {
	for _, adapter := range []lsp.LanguageAdapter{
		NewTypeScriptAdapter(),
		NewIntelephenseAdapter(),
		NewScssAdapter(),
	} {
		t.Run(adapter.ID(), func(t *testing.T) {
			deps := adapter.RuntimeDeps()
			if len(deps) == 0 {
				t.Fatal("RuntimeDeps() is empty")
			}
			if deps[0].Source != "npm" || deps[0].ArchiveType != "npm" {
				t.Fatalf("dependency source = %q/%q, want npm/npm", deps[0].Source, deps[0].ArchiveType)
			}
			if deps[0].BinaryName == "" {
				t.Fatal("dependency BinaryName is empty")
			}
		})
	}
}

func TestCSharpAdapterBackendCandidates(t *testing.T) {
	adapter := NewRoslynAdapter()
	binaries := adapter.Binaries()
	if len(binaries) != 3 {
		t.Fatalf("Binaries() returned %d candidates, want 3", len(binaries))
	}
	if binaries[0].Name != "roslyn-ls" || len(binaries[0].Args) != 0 {
		t.Fatalf("roslyn candidate = %#v, want roslyn-ls without default args", binaries[0])
	}
	if binaries[1].Name != "csharp-ls" || len(binaries[1].Args) != 0 {
		t.Fatalf("csharp-ls candidate = %#v, want no args; csharp-ls uses stdio by default", binaries[1])
	}
	if binaries[2].Name != "omnisharp" || !reflect.DeepEqual(binaries[2].Args, []string{"--languageserver"}) {
		t.Fatalf("omnisharp candidate = %#v, want --languageserver", binaries[2])
	}
	if got := adapter.DefaultArgs(); len(got) != 0 {
		t.Fatalf("DefaultArgs() = %#v, want no generic C# args", got)
	}
}

func TestInitializationOptionsFromConfig(t *testing.T) {
	settings := map[string]any{"initializationOptions": map[string]any{"foo": "bar"}}
	for _, adapter := range AllAdapters() {
		options := adapter.InitializationOptions(settings)
		if options["foo"] != "bar" {
			t.Fatalf("%s InitializationOptions() did not pass config options", adapter.ID())
		}
		params := adapter.InitializeParams("/tmp/project", settings)
		initOptions, ok := params["initializationOptions"].(map[string]any)
		if !ok || initOptions["foo"] != "bar" {
			t.Fatalf("%s InitializeParams() did not include initializationOptions", adapter.ID())
		}
	}
}
