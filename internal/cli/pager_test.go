package cli

import (
	"errors"
	"testing"
)

func TestIsCancelKey(t *testing.T) {
	if !isCancelKey("ctrl+c") {
		t.Fatal("expected ctrl+c to be recognized as cancellation")
	}
	for _, key := range []string{"q", "esc"} {
		if isCancelKey(key) {
			t.Fatalf("did not expect %q to be recognized as cancellation", key)
		}
	}
}

func TestCommandCancellationSentinel(t *testing.T) {
	wrapped := errors.New("other error")
	if errors.Is(wrapped, ErrCommandCancelled) {
		t.Fatal("unrelated error matched cancellation sentinel")
	}
}
