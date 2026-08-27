package cli

import (
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// initStep represents a single task step in the init process. The download-step
// variant that used to share this type (url/dst/postHook, driven through a
// bubbletea progress UI) was removed with the local ONNX model download flow
// (spec ollama-only-embedding FR-1); every remaining init step is a plain task.
type initStep struct {
	label string
	run   func() error
}

// spinnerFrames for the simple goroutine-based spinner.
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// runTaskStepAnimated runs a single task step with spinner animation.
func runTaskStepAnimated(step *initStep) error {
	var stopped atomic.Bool

	go func() {
		i := 0
		for !stopped.Load() {
			frame := StyleDim.Render(spinnerFrames[i%len(spinnerFrames)])
			fmt.Fprintf(os.Stderr, "\r  %s %s", frame, step.label)
			time.Sleep(80 * time.Millisecond)
			i++
		}
	}()

	err := step.run()
	stopped.Store(true)
	// Small pause so spinner is visible even for instant tasks
	time.Sleep(80 * time.Millisecond)

	// Clear spinner line and print final result
	clearLine := fmt.Sprintf("\r  %s %s", "  ", strings.Repeat(" ", len(step.label)+2))
	fmt.Fprint(os.Stderr, clearLine)

	if err != nil {
		fmt.Fprintf(os.Stderr, "\r  %s %s %s\n",
			StyleWarning.Render("✗"), step.label, StyleWarning.Render(err.Error()))
	} else {
		fmt.Fprintf(os.Stderr, "\r  %s %s\n",
			StyleSuccess.Render("✓"), step.label)
	}

	return err
}

// runInitSteps runs all steps sequentially with animated UI, using a
// goroutine spinner (no bubbletea, no escape sequence leak).
func runInitSteps(steps []initStep) error {
	for i := range steps {
		if err := runTaskStepAnimated(&steps[i]); err != nil {
			return err
		}
	}
	return nil
}
