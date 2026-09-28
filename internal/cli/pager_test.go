package cli

import (
	"errors"
	"testing"
)

func TestCommandCancellationSentinel(t *testing.T) {
	wrapped := errors.New("other error")
	if errors.Is(wrapped, ErrCommandCancelled) {
		t.Fatal("unrelated error matched cancellation sentinel")
	}
}
