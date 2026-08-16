package cli

import (
	"os"
	"strings"

	"charm.land/glamour/v2"
	"charm.land/lipgloss/v2"
)

const minMarkdownRenderWidth = 20

type markdownBodyRenderer func(string) string
type styledMarkdownDetailRenderer func(width int, style string) string

func passthroughMarkdown(input string) string {
	return input
}

func markdownDisplayWidth() int {
	return markdownViewportWidth(terminalWidth())
}

func markdownViewportWidth(viewportWidth int) int {
	width := viewportWidth - 2
	if width < minMarkdownRenderWidth {
		return minMarkdownRenderWidth
	}
	return width
}

func terminalMarkdownStyle() string {
	if os.Getenv("TERM") == "dumb" {
		return "ascii"
	}
	if lipgloss.HasDarkBackground(os.Stdin, os.Stdout) {
		return "dark"
	}
	return "light"
}

func newLazyMarkdownDetailRenderer(render styledMarkdownDetailRenderer) func(width int) string {
	style := ""
	return func(viewportWidth int) string {
		if style == "" {
			style = terminalMarkdownStyle()
		}
		return render(markdownViewportWidth(viewportWidth), style)
	}
}

func newTerminalMarkdownBodyRenderer(width int, style string) markdownBodyRenderer {
	if width < minMarkdownRenderWidth {
		width = minMarkdownRenderWidth
	}

	renderer, err := glamour.NewTermRenderer(
		glamour.WithStylePath(style),
		glamour.WithWordWrap(width),
	)
	if err != nil {
		return passthroughMarkdown
	}

	return func(input string) string {
		if strings.TrimSpace(input) == "" {
			return input
		}
		rendered, err := renderer.Render(input)
		if err != nil {
			return input
		}
		return strings.Trim(rendered, "\n")
	}
}
