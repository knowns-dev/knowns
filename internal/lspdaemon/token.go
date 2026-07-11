package lspdaemon

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const tokenByteLen = 32

var ErrEmptyToken = errors.New("lsp daemon token is empty")

// EnsureToken reads the existing project token or creates a new user-only
// token file when one does not exist.
func EnsureToken(paths Paths) (string, error) {
	token, err := readTokenWithRetry(paths)
	if err == nil {
		_ = os.Chmod(paths.TokenPath, 0o600)
		return token, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := paths.EnsureDir(); err != nil {
		return "", err
	}
	token, err = generateToken()
	if err != nil {
		return "", err
	}
	tmpPath := paths.TokenPath + "." + token[:12] + ".tmp"
	file, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		_ = os.Remove(tmpPath)
		file, err = os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	}
	if err != nil {
		return "", err
	}
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := file.WriteString(token + "\n"); err != nil {
		_ = file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	_ = os.Chmod(tmpPath, 0o600)
	if err := os.Link(tmpPath, paths.TokenPath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return readTokenWithRetry(paths)
		}
		return "", err
	}
	cleanupTmp = true
	_ = os.Chmod(paths.TokenPath, 0o600)
	return token, nil
}

func readTokenWithRetry(paths Paths) (string, error) {
	var lastErr error
	for i := 0; i < 20; i++ {
		token, err := ReadToken(paths)
		if !errors.Is(err, ErrEmptyToken) {
			return token, err
		}
		lastErr = err
		time.Sleep(10 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = ErrEmptyToken
	}
	return "", lastErr
}

// ReadToken reads and trims the project daemon token.
func ReadToken(paths Paths) (string, error) {
	data, err := os.ReadFile(paths.TokenPath)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", ErrEmptyToken
	}
	return token, nil
}

// TokenEqual compares daemon tokens without short-circuiting on token content.
func TokenEqual(expected, actual string) bool {
	expectedHash := sha256.Sum256([]byte(expected))
	actualHash := sha256.Sum256([]byte(actual))
	lengthEqual := subtle.ConstantTimeEq(int32(len(expected)), int32(len(actual)))
	contentEqual := subtle.ConstantTimeCompare(expectedHash[:], actualHash[:])
	return lengthEqual&contentEqual == 1
}

func generateToken() (string, error) {
	var raw [tokenByteLen]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate daemon token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}
