package cli

import (
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func TestProviderSettingsForAPIAndOllamaRemainMinimal(t *testing.T) {
	for _, provider := range []string{"api", "ollama"} {
		ss := &models.SemanticSearchSettings{Enabled: true, Provider: provider, Model: "embed-model"}
		if ss.HuggingFaceID != "" || ss.Dimensions != 0 || ss.MaxTokens != 0 {
			t.Fatalf("expected %s provider config to remain provider/model only, got %#v", provider, ss)
		}
	}
}
