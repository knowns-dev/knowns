package routes

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
)

func TestValidateSemanticSearchCapability(t *testing.T) {
	unsupported := search.LocalONNXCapabilityForPlatform("darwin", "amd64", "")

	tests := []struct {
		name     string
		settings *models.SemanticSearchSettings
		wantErr  bool
	}{
		{
			name: "disabled local configuration remains readable",
			settings: &models.SemanticSearchSettings{
				Enabled:  false,
				Provider: "local",
			},
		},
		{
			name: "Ollama remains available",
			settings: &models.SemanticSearchSettings{
				Enabled:  true,
				Provider: "ollama",
				Model:    "nomic-embed-text",
			},
		},
		{
			name: "API remains available",
			settings: &models.SemanticSearchSettings{
				Enabled:  true,
				Provider: "api",
				Model:    "text-embedding-3-small",
			},
		},
		{
			name: "local ONNX is rejected",
			settings: &models.SemanticSearchSettings{
				Enabled:  true,
				Provider: "local",
				Model:    "gte-small",
			},
			wantErr: true,
		},
		{
			name: "empty provider retains local semantics",
			settings: &models.SemanticSearchSettings{
				Enabled: true,
				Model:   "gte-small",
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateSemanticSearchCapability(test.settings, unsupported)
			if test.wantErr {
				if err == nil || !strings.Contains(err.Error(), "Ollama") {
					t.Fatalf("error = %v, want actionable local ONNX error", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestSemanticSearchUpdateRequested(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]json.RawMessage
		want    bool
	}{
		{
			name:    "direct semantic patch",
			payload: map[string]json.RawMessage{"semanticSearch": json.RawMessage(`{"provider":"ollama"}`)},
			want:    true,
		},
		{
			name:    "nested legacy settings",
			payload: map[string]json.RawMessage{"settings": json.RawMessage(`{"semanticSearch":{"provider":"api"}}`)},
			want:    true,
		},
		{
			name:    "unrelated patch remains writable",
			payload: map[string]json.RawMessage{"name": json.RawMessage(`"Intel project"`)},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := semanticSearchUpdateRequested(test.payload); got != test.want {
				t.Fatalf("semanticSearchUpdateRequested() = %v, want %v", got, test.want)
			}
		})
	}
}
