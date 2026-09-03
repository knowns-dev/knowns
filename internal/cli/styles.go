package cli

import (
	"fmt"
	"image/color"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"charm.land/bubbles/v2/progress"
	"charm.land/lipgloss/v2"
)

// ─── Color constants (ANSI 256 basic) ────────────────────────────────

var (
	colorGreen   = lipgloss.Color("2")
	colorRed     = lipgloss.Color("1")
	colorYellow  = lipgloss.Color("3")
	colorCyan    = lipgloss.Color("6")
	colorBlue    = lipgloss.Color("4")
	colorMagenta = lipgloss.Color("5")
	colorPurple  = lipgloss.Color("13")
	colorGray    = lipgloss.Color("8")
)

// ─── Brand color ─────────────────────────────────────────────────────

// KnownsBrand is the primary Knowns navy blue used for progress bars and accents.
const KnownsBrand = "#1e3a5f"

// KnownsBrandLight is the secondary lighter blue for gradient endpoints.
const KnownsBrandLight = "#4a90d9"

// NewBrandProgressBar creates a progress bar with the Knowns brand gradient.
// Use this for all progress bars in the CLI for consistent styling.
func NewBrandProgressBar(opts ...progress.Option) progress.Model {
	defaults := []progress.Option{
		progress.WithColors(lipgloss.Color(KnownsBrand), lipgloss.Color(KnownsBrandLight)),
		progress.WithWidth(40),
	}
	return progress.New(append(defaults, opts...)...)
}

// spinnerFramesBrand are the braille spinner frames used by RunWithSpinner.
var spinnerFramesBrand = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// RunWithSpinner runs fn with a spinner animation showing label.
// On success prints ✓ label, on error prints ✗ label: error.
// Returns the error from fn.
func RunWithSpinner(label string, fn func() error) error {
	var stopped atomic.Bool

	go func() {
		i := 0
		for !stopped.Load() {
			frame := StyleDim.Render(spinnerFramesBrand[i%len(spinnerFramesBrand)])
			fmt.Fprintf(os.Stderr, "\r  %s %s", frame, label)
			time.Sleep(80 * time.Millisecond)
			i++
		}
	}()

	err := fn()
	stopped.Store(true)
	time.Sleep(80 * time.Millisecond)

	// Clear spinner line.
	clearLine := fmt.Sprintf("\r  %s %s", "  ", strings.Repeat(" ", len(label)+2))
	fmt.Fprint(os.Stderr, clearLine)

	if err != nil {
		fmt.Fprintf(os.Stderr, "\r  %s %s: %s\n",
			StyleWarning.Render("✗"), label, StyleWarning.Render(err.Error()))
	} else {
		fmt.Fprintf(os.Stderr, "\r  %s %s\n",
			StyleSuccess.Render("✓"), label)
	}

	return err
}

// ─── Semantic styles ─────────────────────────────────────────────────

var (
	StyleSuccess = lipgloss.NewStyle().Foreground(colorGreen)
	StyleError   = lipgloss.NewStyle().Foreground(colorRed)
	StyleWarning = lipgloss.NewStyle().Foreground(colorYellow)
	StyleInfo    = lipgloss.NewStyle().Foreground(colorCyan)
	StyleDim     = lipgloss.NewStyle().Foreground(colorGray)
	StyleBold    = lipgloss.NewStyle().Bold(true)
)

// ─── Element styles ──────────────────────────────────────────────────

var (
	StyleTitle = lipgloss.NewStyle().Bold(true).Foreground(colorCyan)
	StyleID    = lipgloss.NewStyle().Foreground(colorCyan)
	StyleLabel = lipgloss.NewStyle().Foreground(colorMagenta)
	StyleKey   = lipgloss.NewStyle().Bold(true)
)

// ─── Status / Priority helpers ───────────────────────────────────────

// StatusStyle returns the appropriate style for a given status.
func StatusStyle(status string) lipgloss.Style {
	if plainOutput.Load() {
		return lipgloss.NewStyle()
	}
	switch status {
	case "done":
		return lipgloss.NewStyle().Foreground(colorGreen)
	case "in-progress":
		return lipgloss.NewStyle().Foreground(colorCyan)
	case "in-review":
		return lipgloss.NewStyle().Foreground(colorBlue)
	case "blocked":
		return lipgloss.NewStyle().Foreground(colorRed)
	case "on-hold":
		return lipgloss.NewStyle().Foreground(colorYellow)
	case "urgent":
		return lipgloss.NewStyle().Bold(true).Foreground(colorRed)
	default: // "todo"
		return lipgloss.NewStyle().Foreground(colorGray)
	}
}

// PriorityStyle returns the appropriate style for a given priority.
func PriorityStyle(priority string) lipgloss.Style {
	if plainOutput.Load() {
		return lipgloss.NewStyle()
	}
	switch priority {
	case "high":
		return lipgloss.NewStyle().Foreground(colorRed)
	case "low":
		return lipgloss.NewStyle().Foreground(colorGray)
	default: // "medium"
		return lipgloss.NewStyle().Foreground(colorYellow)
	}
}

// RenderStatusBadge renders a status string with its appropriate color.
func RenderStatusBadge(status string) string {
	return StatusStyle(status).Render(status)
}

// RenderPriorityBadge renders a priority string with its appropriate color.
func RenderPriorityBadge(priority string) string {
	return PriorityStyle(priority).Render(priority)
}

// ─── Render helpers ──────────────────────────────────────────────────

// RenderSuccess renders a green checkmark + message.
func RenderSuccess(msg string) string {
	return StyleSuccess.Render("✓ " + msg)
}

// RenderError renders a red cross + message.
func RenderError(msg string) string {
	return StyleError.Render("✗ " + msg)
}

// RenderKeyValue renders a styled "key: value" pair.
func RenderKeyValue(key, value string) string {
	return fmt.Sprintf("%s %s", StyleDim.Render(key+":"), value)
}

// RenderLabels renders labels joined with commas, each in magenta.
func RenderLabels(labels []string) string {
	if len(labels) == 0 {
		return ""
	}
	styled := make([]string, len(labels))
	for i, l := range labels {
		styled[i] = StyleLabel.Render(l)
	}
	return strings.Join(styled, StyleDim.Render(", "))
}

// RenderTags renders tags in magenta (alias for labels).
func RenderTags(tags []string) string {
	return RenderLabels(tags)
}

// RenderSeparator renders a horizontal line in dim gray.
func RenderSeparator(width int) string {
	return StyleDim.Render(strings.Repeat("─", width))
}

// RenderACCheckbox renders an acceptance criterion with index and checkbox.
func RenderACCheckbox(index int, text string, completed bool) string {
	num := StyleDim.Render(fmt.Sprintf("%d.", index))
	if completed {
		return fmt.Sprintf("  %s %s %s", num, StyleSuccess.Render("[✓]"), StyleDim.Render(text))
	}
	return fmt.Sprintf("  %s %s %s", num, StyleDim.Render("[ ]"), text)
}

// RenderSectionHeader renders a bold section header.
func RenderSectionHeader(title string) string {
	return StyleBold.Render(title)
}

// RenderBadge renders text in a colored badge style.
func RenderBadge(text string, c color.Color) string {
	return lipgloss.NewStyle().Foreground(c).Render("[" + text + "]")
}

// RenderTableHeader renders a table header row with bold styling.
func RenderTableHeader(columns ...string) string {
	styled := make([]string, len(columns))
	for i, col := range columns {
		styled[i] = StyleBold.Render(col)
	}
	return strings.Join(styled, "")
}

// ─── Additional render helpers ───────────────────────────────────────

// RenderWarning renders a yellow warning message.
func RenderWarning(msg string) string {
	return StyleWarning.Render("⚠ " + msg)
}

// RenderInfo renders a cyan info message.
func RenderInfo(msg string) string {
	return StyleInfo.Render("ℹ " + msg)
}

// RenderHint renders a dim hint/instruction message.
func RenderHint(msg string) string {
	return StyleDim.Render("  " + msg)
}

// RenderCmd renders a command suggestion in cyan.
func RenderCmd(cmd string) string {
	return StyleInfo.Render(cmd)
}

// RenderDim renders text in dim gray.
func RenderDim(msg string) string {
	return StyleDim.Render(msg)
}

// RenderCount renders a label with a styled count, e.g. "Models (3)".
func RenderCount(label string, count int) string {
	return fmt.Sprintf("%s %s", StyleBold.Render(label), StyleDim.Render(fmt.Sprintf("(%d)", count)))
}

// RenderField renders a styled "  key: value" line for detail views.
func RenderField(key, value string) string {
	return fmt.Sprintf("  %s %s", StyleDim.Render(key+":"), value)
}

// RenderNextSteps renders a "Next steps:" section with numbered items.
func RenderNextSteps(steps ...string) string {
	var b strings.Builder
	b.WriteString(StyleBold.Render("Next steps:"))
	b.WriteString("\n")
	for i, s := range steps {
		b.WriteString(fmt.Sprintf("  %s %s\n", StyleDim.Render(fmt.Sprintf("%d.", i+1)), s))
	}
	return b.String()
}
