package cli

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

// ─── pager model ─────────────────────────────────────────────────────

type pagerKeyMap struct {
	Quit key.Binding
}

type pagerModel struct {
	viewport  viewport.Model
	title     string
	content   string
	ready     bool
	cancelled bool
	keyMap    pagerKeyMap
}

func isCancelKey(key string) bool {
	return key == "ctrl+c"
}

func newPagerModel(title, content string) pagerModel {
	km := pagerKeyMap{
		Quit: key.NewBinding(
			key.WithKeys("q", "esc", "ctrl+c"),
			key.WithHelp("q", "quit"),
		),
	}
	return pagerModel{
		title:   title,
		content: content,
		keyMap:  km,
	}
}

func (m pagerModel) Init() tea.Cmd {
	return nil
}

func (m pagerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if key.Matches(msg, m.keyMap.Quit) {
			m.cancelled = isCancelKey(msg.String())
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		headerHeight := 2 // title + separator
		footerHeight := 2 // separator + info
		if !m.ready {
			m.viewport = viewport.New(
				viewport.WithWidth(msg.Width),
				viewport.WithHeight(msg.Height-headerHeight-footerHeight),
			)
			m.viewport.MouseWheelEnabled = true
			m.viewport.SetContent(m.content)
			m.ready = true
		} else {
			m.viewport.SetWidth(msg.Width)
			m.viewport.SetHeight(msg.Height - headerHeight - footerHeight)
		}
	}

	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	cmds = append(cmds, cmd)

	return m, tea.Batch(cmds...)
}

func (m pagerModel) View() tea.View {
	if !m.ready {
		v := tea.NewView("Loading...")
		v.AltScreen = true
		return v
	}

	width := m.viewport.Width()

	// Header
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(colorCyan)
	header := titleStyle.Render(m.title)
	sep := RenderSeparator(width)

	// Footer
	pct := m.viewport.ScrollPercent()
	info := StyleDim.Render(fmt.Sprintf(" %3.0f%% ", pct*100))
	helpText := StyleDim.Render("q: quit • ↑↓/PgUp/PgDn: scroll")
	gap := max(0, width-lipgloss.Width(info)-lipgloss.Width(helpText))
	footerLine := info + strings.Repeat(" ", gap) + helpText

	v := tea.NewView(fmt.Sprintf("%s\n%s\n%s\n%s\n%s",
		header,
		sep,
		m.viewport.View(),
		sep,
		footerLine,
	))
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	return v
}

// ─── public API ──────────────────────────────────────────────────────

// RunPager launches the fullscreen viewport TUI pager.
func RunPager(title, content string) error {
	m := newPagerModel(title, content)
	p := tea.NewProgram(m)
	result, err := p.Run()
	if err != nil {
		return err
	}
	if result.(pagerModel).cancelled {
		return ErrCommandCancelled
	}
	return nil
}

// isTTY returns true if stdout is a terminal.
func isTTY() bool {
	return isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())
}

// renderOrPage shows content in the TUI pager if stdout is a TTY and pager is
// not disabled, otherwise prints directly to stdout.
func renderOrPage(cmd any, title, content string) error {
	if !isTTY() || isPagerDisabled(cmd) {
		fmt.Print(content)
		return nil
	}
	if err := RunPager(title, content); err != nil {
		if errors.Is(err, ErrCommandCancelled) {
			return err
		}
		// Fallback to direct print on TUI error.
		fmt.Print(content)
	}
	return nil
}

// defaultPageSize is the default number of lines per page for --page pagination.
const defaultPageSize = 50

// printPaged prints content with optional --page N pagination (for plain/AI output).
// If --page is not set (0), prints everything. Otherwise prints the requested page
// and a PAGE footer so the AI knows how to fetch more.
func printPaged(cmd any, content string) {
	page, pageSize := getPageOpts(cmd)
	if page <= 0 {
		fmt.Print(content)
		return
	}

	lines := strings.Split(content, "\n")
	// Remove trailing empty line from Split
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	totalLines := len(lines)
	totalPages := (totalLines + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}

	if page > totalPages {
		fmt.Printf("PAGE: %d/%d (no more content)\n", page, totalPages)
		return
	}

	start := (page - 1) * pageSize
	end := start + pageSize
	if end > totalLines {
		end = totalLines
	}

	for _, line := range lines[start:end] {
		fmt.Println(line)
	}
	fmt.Printf("\nPAGE: %d/%d (lines %d-%d of %d, page-size %d)\n", page, totalPages, start+1, end, totalLines, pageSize)
}

// defaultPlainItemLimit is the default number of items shown in plain list mode.
// When there are more items than this and no --page flag, only the first N items
// are shown with a hint to use --page 2 for more.
const defaultPlainItemLimit = 20

// getPageOpts reads --page and --page-size flags from the command.
func getPageOpts(cmd any) (page, pageSize int) {
	pageSize = defaultPageSize
	c, ok := cmd.(*cobra.Command)
	if !ok {
		return 0, pageSize
	}
	p, _ := c.Root().PersistentFlags().GetInt("page")
	if p <= 0 {
		p, _ = c.Flags().GetInt("page")
	}
	ps, _ := c.Root().PersistentFlags().GetInt("page-size")
	if ps <= 0 {
		ps, _ = c.Flags().GetInt("page-size")
	}
	if ps > 0 {
		pageSize = ps
	}
	return p, pageSize
}
