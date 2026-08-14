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

func TestSuppressTUICancel(t *testing.T) {
	resetSuppressedTUICancel()
	t.Cleanup(resetSuppressedTUICancel)

	if err := suppressTUICancel(ErrCommandCancelled); err != nil {
		t.Fatalf("direct cancellation returned %v, want nil", err)
	}
	if err := suppressTUICancel(errors.Join(errors.New("tui stopped"), ErrCommandCancelled)); err != nil {
		t.Fatalf("wrapped cancellation returned %v, want nil", err)
	}

	wantErr := errors.New("render failed")
	if err := suppressTUICancel(wantErr); !errors.Is(err, wantErr) {
		t.Fatalf("non-cancellation error = %v, want %v", err, wantErr)
	}
}
