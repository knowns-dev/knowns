package lsp

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestResolveDotnet10UsesConfiguredPath(t *testing.T) {
	cfg := Config{Languages: map[string]LanguageConfig{
		CSharpLanguageID: {Settings: map[string]any{"dotnetPath": "/opt/dotnet/dotnet"}},
	}}
	path, err := ResolveDotnet10(context.Background(), cfg, nil, func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "/opt/dotnet/dotnet" || len(args) != 1 || args[0] != "--version" {
			t.Fatalf("runCommand = %s %#v", name, args)
		}
		return []byte("10.0.100"), nil
	}, "/tmp/csharp.log")
	if err != nil {
		t.Fatalf("ResolveDotnet10 failed: %v", err)
	}
	if path != "/opt/dotnet/dotnet" {
		t.Fatalf("path = %q, want configured dotnet", path)
	}
}

func TestResolveDotnet10RunsConfiguredBootstrap(t *testing.T) {
	cfg := Config{Languages: map[string]LanguageConfig{
		CSharpLanguageID: {Settings: map[string]any{"dotnetBootstrapCommand": "install-dotnet --channel 10.0"}},
	}}
	installed := false
	path, err := ResolveDotnet10(context.Background(), cfg, func(name string) (string, error) {
		if name == "dotnet" && installed {
			return "/tmp/dotnet", nil
		}
		return "", errors.New("missing")
	}, func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "install-dotnet" {
			installed = true
			if len(args) != 2 || args[0] != "--channel" || args[1] != "10.0" {
				t.Fatalf("bootstrap args = %#v", args)
			}
			return []byte("ok"), nil
		}
		if name == "/tmp/dotnet" {
			return []byte("10.0.1"), nil
		}
		t.Fatalf("unexpected command %s %#v", name, args)
		return nil, nil
	}, "/tmp/csharp.log")
	if err != nil {
		t.Fatalf("ResolveDotnet10 failed: %v", err)
	}
	if path != "/tmp/dotnet" {
		t.Fatalf("path = %q, want bootstrapped dotnet", path)
	}
}

func TestResolveDotnet10MissingReturnsActionableRuntimeError(t *testing.T) {
	_, err := ResolveDotnet10(context.Background(), Config{}, func(string) (string, error) {
		return "", errors.New("missing")
	}, nil, "/tmp/csharp.log")
	if err == nil {
		t.Fatal("expected missing .NET error")
	}
	runtimeErr, ok := err.(*RuntimeError)
	if !ok {
		t.Fatalf("error type = %T, want RuntimeError", err)
	}
	if runtimeErr.Code != "dotnet_10_missing" || runtimeErr.LogPath != "/tmp/csharp.log" {
		t.Fatalf("runtime error = %#v", runtimeErr)
	}
	if !strings.Contains(runtimeErr.Remediation, "dotnetPath") {
		t.Fatalf("remediation = %q, want config guidance", runtimeErr.Remediation)
	}
}
