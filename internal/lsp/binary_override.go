package lsp

import (
	"fmt"
	"strings"
)

func selectBinaryCandidateOverride(override string, candidates []BinaryCandidate) (BinaryCandidate, error) {
	if strings.TrimSpace(override) != override || override == "" {
		return BinaryCandidate{}, invalidBinaryOverride(override)
	}
	for _, candidate := range candidates {
		if candidate.Name == override {
			return candidate, nil
		}
	}
	return BinaryCandidate{}, invalidBinaryOverride(override)
}

func selectBinaryOverride(override string, candidates []Binary) (Binary, error) {
	if strings.TrimSpace(override) != override || override == "" {
		return Binary{}, invalidBinaryOverride(override)
	}
	for _, candidate := range candidates {
		if candidate.Name == override {
			return candidate, nil
		}
	}
	return Binary{}, invalidBinaryOverride(override)
}

func invalidBinaryOverride(override string) error {
	return fmt.Errorf("binary override %q must match a registered language-server binary", override)
}
