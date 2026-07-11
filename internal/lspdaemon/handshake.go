package lspdaemon

import (
	"errors"
	"fmt"
)

var (
	ErrProjectMismatch = errors.New("lsp daemon project identity mismatch")
	ErrTokenMismatch   = errors.New("lsp daemon token mismatch")
)

// Handshake is the project identity and token presented by a local client.
type Handshake struct {
	ProjectRoot string `json:"project_root"`
	Token       string `json:"token"`
}

// ValidateHandshake rejects clients that do not match the daemon's canonical
// project root and token.
func ValidateHandshake(expected ProjectIdentity, expectedToken string, request Handshake) error {
	requestRoot, err := CanonicalRoot(request.ProjectRoot)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrProjectMismatch, err)
	}
	if !SameRoot(expected.Root, requestRoot) {
		return ErrProjectMismatch
	}
	if expectedToken == "" || request.Token == "" || !TokenEqual(expectedToken, request.Token) {
		return ErrTokenMismatch
	}
	return nil
}
