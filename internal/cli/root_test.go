package cli

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestExecuteWithUpdateNoticeSkipsMachineReadableModes(t *testing.T) {
	t.Setenv("CI", "")
	t.Setenv("NO_UPDATE_CHECK", "")

	for _, args := range [][]string{{"task", "list", "--plain"}, {"--json", "task", "list"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			var output strings.Builder
			checked := false
			ran := false

			err := executeWithUpdateNotice(args, func() error {
				ran = true
				return nil
			}, func() string {
				checked = true
				return "update notice"
			}, time.Second, &output)
			if err != nil {
				t.Fatalf("executeWithUpdateNotice returned error: %v", err)
			}
			if !ran {
				t.Fatal("expected command to run")
			}
			if checked {
				t.Fatal("did not expect update checker to run")
			}
			if output.Len() != 0 {
				t.Fatalf("unexpected update output: %q", output.String())
			}
		})
	}
}

func TestExecuteWithUpdateNoticeReturnsImmediatelyOnError(t *testing.T) {
	t.Setenv("CI", "")
	t.Setenv("NO_UPDATE_CHECK", "")

	wantErr := errors.New("command failed")
	blocked := make(chan struct{})
	var output strings.Builder
	start := time.Now()

	err := executeWithUpdateNotice([]string{"task", "list"}, func() error {
		return wantErr
	}, func() string {
		<-blocked
		return "update notice"
	}, 250*time.Millisecond, &output)
	close(blocked)

	if !errors.Is(err, wantErr) {
		t.Fatalf("got error %v, want %v", err, wantErr)
	}
	if elapsed := time.Since(start); elapsed >= 100*time.Millisecond {
		t.Fatalf("error path waited for update checker: %s", elapsed)
	}
	if output.Len() != 0 {
		t.Fatalf("unexpected update output: %q", output.String())
	}
}

func TestExecuteWithUpdateNoticeReturnsImmediatelyOnCancellation(t *testing.T) {
	t.Setenv("CI", "")
	t.Setenv("NO_UPDATE_CHECK", "")

	blocked := make(chan struct{})
	var output strings.Builder
	start := time.Now()

	err := executeWithUpdateNotice([]string{"task", "list"}, func() error {
		return ErrCommandCancelled
	}, func() string {
		<-blocked
		return "update notice"
	}, 250*time.Millisecond, &output)
	close(blocked)

	if !errors.Is(err, ErrCommandCancelled) {
		t.Fatalf("got error %v, want cancellation", err)
	}
	if elapsed := time.Since(start); elapsed >= 100*time.Millisecond {
		t.Fatalf("cancellation path waited for update checker: %s", elapsed)
	}
	if output.Len() != 0 {
		t.Fatalf("unexpected update output: %q", output.String())
	}
}

func TestExecuteWithUpdateNoticePrintsSuccessfulNotice(t *testing.T) {
	t.Setenv("CI", "")
	t.Setenv("NO_UPDATE_CHECK", "")

	var output strings.Builder
	err := executeWithUpdateNotice([]string{"task", "list"}, func() error {
		return nil
	}, func() string {
		return "update notice"
	}, time.Second, &output)
	if err != nil {
		t.Fatalf("executeWithUpdateNotice returned error: %v", err)
	}
	if got := output.String(); got != "update notice" {
		t.Fatalf("got output %q, want update notice", got)
	}
}
