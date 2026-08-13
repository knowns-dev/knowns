package cli

import "errors"

var ErrCommandCancelled = errors.New("command cancelled")

type commandExitError struct {
	code int
	err  error
}

func (e *commandExitError) Error() string {
	if e.err != nil {
		return e.err.Error()
	}
	return "command completed with a non-zero status"
}

func (e *commandExitError) Unwrap() error {
	return e.err
}

// ExitCode maps CLI errors to process exit codes. Commands without a custom
// contract retain the historical exit code 1.
func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *commandExitError
	if errors.As(err, &exitErr) {
		return exitErr.code
	}
	return 1
}
