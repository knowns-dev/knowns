// Package storesync keeps knowledge store clones in sync with their remotes
// from inside the shared runtime (store spec D3).
package storesync

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// DefaultGitTimeout bounds every Git operation so an unreachable remote fails
// instead of hanging the runtime.
const DefaultGitTimeout = 2 * time.Minute

// GitError is a failed Git invocation with its standard error.
type GitError struct {
	Args   []string
	Stderr string
	Err    error
}

func (e *GitError) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" && e.Err != nil {
		msg = e.Err.Error()
	}
	return msg
}

func (e *GitError) Unwrap() error { return e.Err }

// Git runs git in dir without any interactive credential prompt: HTTPS
// prompts are disabled and SSH runs in batch mode, so a missing credential
// fails fast with Git's own message (store spec D4). Knowns never passes a
// credential; Git uses the machine's ssh-agent or credential helper.
func Git(ctx context.Context, dir string, timeout time.Duration, env []string, args ...string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		timeout = DefaultGitTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	sshCommand := os.Getenv("GIT_SSH_COMMAND")
	if sshCommand == "" {
		sshCommand = "ssh"
	}
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GCM_INTERACTIVE=never",
		"GIT_SSH_COMMAND="+sshCommand+" -o BatchMode=yes -o ConnectTimeout=15",
	)
	cmd.Env = append(cmd.Env, env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", &GitError{Args: args, Stderr: fmt.Sprintf("git %s timed out after %s", args[0], timeout), Err: ctx.Err()}
		}
		return "", &GitError{Args: args, Stderr: stderr.String(), Err: err}
	}
	return stdout.String(), nil
}

// FailureClass is how the sync loop reacts to a failed remote operation.
type FailureClass int

const (
	// FailureUnreachable is a network or remote outage: keep commits queued
	// and retry on the next interval (FR-16).
	FailureUnreachable FailureClass = iota
	// FailureCredential is a missing or rejected credential: pause the store
	// with an actionable message (FR-17).
	FailureCredential
	// FailureRejected is a push the remote refused because it is behind:
	// fetch, rebase and retry (FR-8).
	FailureRejected
)

// ClassifyFailure sorts a Git error message into a FailureClass.
func ClassifyFailure(message string) FailureClass {
	s := strings.ToLower(message)
	for _, marker := range []string{"non-fast-forward", "fetch first", "[rejected]", "updates were rejected", "stale info"} {
		if strings.Contains(s, marker) {
			return FailureRejected
		}
	}
	for _, marker := range []string{
		"authentication failed", "could not read username", "could not read password",
		"terminal prompts disabled", "permission denied (publickey", "host key verification failed",
		"access denied", "http 401", "http 403", "error: 401", "error: 403", "returned error: 401", "returned error: 403",
		"invalid username or password", "repository not found",
	} {
		if strings.Contains(s, marker) {
			return FailureCredential
		}
	}
	return FailureUnreachable
}
