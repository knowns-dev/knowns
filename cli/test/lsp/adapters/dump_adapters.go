//go:build ignore

// Dumps the observable metadata of every built-in LSP adapter as JSON so the TypeScript port can be
// diffed against it. Regenerate the golden file with:
//
//	go run cli/test/lsp/adapters/dump_adapters.go > cli/test/lsp/adapters/go-dump.json
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
)

var ignoredProbes = []string{"vendor", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", "target", "cmake-build-debug", "cmake-build-release", ".cache", ".gradle", ".idea", "out", "bin", "obj", ".vs", "packages", ".dart_tool", ".pub", ".packages", ".build", ".swiftpm", "DerivedData", "Pods", ".bundle", "tmp", "storage", "bootstrap/cache", ".git", "generated", "testdata", ".terraform", "src", "Sources"}

var syncProbes = []string{"main.tf", "vars.tfvars", "net.tf.json", `C:\repo\X.TFVARS.JSON`, "a.ts", "a.tsx", "a.js", "a.jsx", "A.JSX", `C:\r\i.JS`, "x.d.ts", "x.py"}

func nz[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func main() {
	settingsCases := map[string]map[string]any{
		"nil":     nil,
		"empty":   {},
		"initopt": {"initializationOptions": map[string]any{"foo": "bar"}},
		"flat":    {"a": 1.0},
	}
	var out []map[string]any
	for _, a := range adapters.AllAdapters() {
		entry := map[string]any{
			"id":                    a.ID(),
			"name":                  a.Name(),
			"extensions":            nz(a.Extensions()),
			"binaries":              nz(a.Binaries()),
			"prerequisites":         nz(a.Prerequisites()),
			"installGuide":          a.InstallGuide(),
			"canInstall":            a.CanInstall(),
			"runtimeDeps":           nz(a.RuntimeDeps()),
			"defaultArgs":           nz(a.DefaultArgs()),
			"supportsImplementation": a.SupportsImplementation(),
			"supportsReferences":    a.SupportsReferences(),
		}
		var ignored []string
		for _, n := range ignoredProbes {
			if a.IsIgnoredDir(n) {
				ignored = append(ignored, n)
			}
		}
		entry["ignoredDirs"] = nz(ignored)
		params := map[string]any{}
		opts := map[string]any{}
		for k, s := range settingsCases {
			params[k] = a.InitializeParams("/nonexistent/project", s)
			opts[k] = a.InitializationOptions(s)
		}
		entry["initializeParams"] = params
		entry["initializationOptions"] = opts
		if p, ok := a.(lsp.PathMatcherAdapter); ok {
			var ms []map[string]any
			for _, m := range p.PathMatchers() {
				ms = append(ms, map[string]any{"kind": string(m.Kind), "pattern": m.Pattern, "priority": m.Priority, "explicitOnly": m.ExplicitOnly})
			}
			entry["pathMatchers"] = nz(ms)
		}
		if p, ok := a.(lsp.LazyStartAdapter); ok {
			entry["lazyStart"] = p.LazyStart()
		}
		if p, ok := a.(lsp.CapabilityBaselineProvider); ok {
			cp := p.CapabilityProfile()
			entry["capabilityProfile"] = map[string]any{"required": nz(cp.Required), "legacyPushDiagnostics": cp.LegacyPushDiagnostics, "enforceAdvertised": cp.EnforceAdvertised}
		}
		if p, ok := a.(lsp.PathDocumentSyncAdapter); ok {
			sync := map[string]any{}
			for _, path := range syncProbes {
				o := p.DocumentSyncForPath(path)
				sync[path] = map[string]any{"languageID": o.LanguageID, "suppress": o.Suppress}
			}
			entry["documentSync"] = sync
		}
		if p, ok := a.(lsp.PathCapabilityAdapter); ok {
			caps := map[string]any{}
			for _, path := range syncProbes {
				for _, action := range []string{"", "definition"} {
					d, handled := p.PathCapabilityForAction(path, action, "")
					caps[path+"|"+action] = map[string]any{"handled": handled, "supported": d.Supported, "explanation": d.Explanation, "capabilities": nz(d.Capabilities), "advertised": nz(d.AdvertisedCapabilities)}
				}
			}
			entry["pathCapability"] = caps
		}
		out = append(out, entry)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
