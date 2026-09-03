package cli

import (
	"os"
	"sync/atomic"

	"charm.land/lipgloss/v2"
)

// plainOutput reports whether ANSI styling is suppressed for this invocation.
var plainOutput atomic.Bool

// PlainOutput reports whether styling is currently suppressed.
func PlainOutput() bool { return plainOutput.Load() }

// plainStyleTargets are every package-level style that carries color or weight.
// SetPlainOutput swaps them wholesale, which is what lets one call cover all
// ~640 render sites without touching them.
var plainStyleTargets = []*lipgloss.Style{
	&StyleSuccess, &StyleError, &StyleWarning, &StyleInfo, &StyleDim, &StyleBold,
	&StyleTitle, &StyleID, &StyleLabel, &StyleKey,
}

// styledDefaults snapshots the styles as declared, so plain mode is reversible
// without restating the declarations (which would just reintroduce drift).
var styledDefaults = func() []lipgloss.Style {
	out := make([]lipgloss.Style, len(plainStyleTargets))
	for i, p := range plainStyleTargets {
		out[i] = *p
	}
	return out
}()

// SetPlainOutput turns ANSI styling off (or back on) for the whole CLI.
//
// lipgloss v2 renders full-fidelity ANSI unconditionally and downsamples at the
// output layer (lipgloss.Writer). This CLI prints through fmt.Print*, which
// bypasses that layer entirely, so neither --plain nor NO_COLOR could take
// effect. Style is a plain value type, so clearing the package-level styles is
// the one choke point that reaches every call site.
func SetPlainOutput(on bool) {
	plainOutput.Store(on)
	blank := lipgloss.NewStyle()
	for i, p := range plainStyleTargets {
		if on {
			*p = blank
			continue
		}
		*p = styledDefaults[i]
	}
}

// noColorRequested reports whether the environment asks for uncolored output,
// per the NO_COLOR convention: set and non-empty, whatever the value.
func noColorRequested() bool { return os.Getenv("NO_COLOR") != "" }

// init applies NO_COLOR before anything can render. PersistentPreRun is too
// late for --help, which cobra serves without running it.
func init() {
	if noColorRequested() {
		SetPlainOutput(true)
	}
}
