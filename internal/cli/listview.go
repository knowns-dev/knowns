package cli

import (
	"fmt"
	"io"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/list"
	"charm.land/bubbles/v2/paginator"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// ─── list item ───────────────────────────────────────────────────────

// listItem wraps any item for display in the interactive list.
type listItem struct {
	id             string // task ID or doc path
	title          string
	description    string // subtitle line (status, priority, tags, etc.)
	detail         string // static detail content shown on Enter
	detailRenderer func(width int) string
}

func (i listItem) Title() string       { return i.title }
func (i listItem) Description() string { return i.description }
func (i listItem) FilterValue() string {
	return strings.Join([]string{
		normalizeListLine(i.title),
		normalizeListLine(i.id),
		normalizeListLine(ansi.Strip(i.description)),
	}, " ")
}

func (i listItem) detailContent(width int) (string, bool) {
	if i.detailRenderer != nil {
		return i.detailRenderer(width), true
	}
	return i.detail, i.detail != ""
}

func joinListMetadata(parts ...string) string {
	nonEmpty := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.TrimSpace(ansi.Strip(part)) != "" {
			nonEmpty = append(nonEmpty, part)
		}
	}
	return strings.Join(nonEmpty, StyleDim.Render(" · "))
}

func normalizeListLine(value string) string {
	value = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(value)
	return strings.Join(strings.Fields(value), " ")
}

func truncateListLine(value string, width int) string {
	if width <= 0 {
		return ""
	}
	return ansi.Truncate(normalizeListLine(value), width, "…")
}

// ─── custom delegate ─────────────────────────────────────────────────

type listItemDelegate struct{}

func (d listItemDelegate) Height() int                             { return 2 }
func (d listItemDelegate) Spacing() int                            { return 0 }
func (d listItemDelegate) Update(_ tea.Msg, _ *list.Model) tea.Cmd { return nil }
func (d listItemDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	li, ok := item.(listItem)
	if !ok {
		return
	}

	width := max(1, m.Width()-4) // account for list padding
	titleLine, descLine := renderListItemLines(li, width, index == m.Index())

	fmt.Fprintln(w, titleLine)
	fmt.Fprint(w, descLine)
}

func renderListItemLines(item listItem, width int, selected bool) (string, string) {
	width = max(1, width)
	marker := "  "
	if selected {
		marker = StyleInfo.Render("▌ ")
	}

	titleWidth := max(1, width-ansi.StringWidth(marker))
	title := truncateListLine(item.title, titleWidth)
	if selected {
		title = StyleBold.Render(title)
	}
	titleLine := marker + title

	indent := "  "
	metadataWidth := max(1, width-ansi.StringWidth(indent))
	id := normalizeListLine(item.id)
	description := normalizeListLine(item.description)

	if description == "" {
		idStyle := StyleDim
		if selected {
			idStyle = StyleID
		}
		return ansi.Truncate(titleLine, width, "…"), indent + idStyle.Render(truncateListLine(id, metadataWidth))
	}

	idBudget := min(ansi.StringWidth(id), max(8, metadataWidth*2/5))
	idText := truncateListLine(id, idBudget)
	separator := StyleDim.Render(" · ")
	descriptionWidth := max(1, metadataWidth-ansi.StringWidth(idText)-ansi.StringWidth(separator))
	descriptionText := truncateListLine(description, descriptionWidth)

	idStyle := StyleDim
	if selected {
		idStyle = StyleID
	}
	descLine := indent + idStyle.Render(idText) + separator + descriptionText
	return ansi.Truncate(titleLine, width, "…"), ansi.Truncate(descLine, width, "…")
}

// ─── list view model ─────────────────────────────────────────────────

type listViewState int

const (
	stateList listViewState = iota
	stateDetail
)

type listViewModel struct {
	list      list.Model
	viewport  viewport.Model
	state     listViewState
	title     string
	ready     bool
	cancelled bool
	width     int
	height    int
}

func (m *listViewModel) refreshSelectedDetail() bool {
	selected := m.list.SelectedItem()
	if selected == nil {
		return false
	}
	li, ok := selected.(listItem)
	if !ok {
		return false
	}
	detail, ok := li.detailContent(m.viewport.Width())
	if !ok {
		return false
	}
	m.viewport.SetContent(detail)
	return true
}

var (
	listOpenBinding = key.NewBinding(
		key.WithKeys("enter"),
		key.WithHelp("enter", "open"),
	)
	listQuitBinding = key.NewBinding(
		key.WithKeys("q", "ctrl+c"),
		key.WithHelp("q", "quit"),
	)
)

func newListViewModel(title string, items []listItem) listViewModel {
	// Convert to list.Item slice
	listItems := make([]list.Item, len(items))
	for i, item := range items {
		listItems[i] = item
	}

	delegate := listItemDelegate{}
	l := list.New(listItems, delegate, 0, 0)
	l.Title = title
	l.SetShowStatusBar(true)
	l.SetShowHelp(true)
	l.SetFilteringEnabled(true)
	l.DisableQuitKeybindings()
	l.Paginator.Type = paginator.Arabic
	l.AdditionalShortHelpKeys = func() []key.Binding {
		return []key.Binding{listOpenBinding, listQuitBinding}
	}
	l.AdditionalFullHelpKeys = func() []key.Binding {
		return []key.Binding{listOpenBinding, listQuitBinding}
	}

	// Style the title
	l.Styles.Title = lipgloss.NewStyle().Bold(true).Foreground(colorCyan)

	return listViewModel{
		list:  l,
		title: title,
		state: stateList,
	}
}

func (m listViewModel) Init() tea.Cmd {
	return nil
}

func (m listViewModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.list.SetSize(max(1, msg.Width), max(1, msg.Height))
		if !m.ready {
			m.viewport = viewport.New(
				viewport.WithWidth(max(1, msg.Width)),
				viewport.WithHeight(max(1, msg.Height-4)), // header + footer
			)
			m.viewport.MouseWheelEnabled = true
			m.ready = true
		} else {
			m.viewport.SetWidth(max(1, msg.Width))
			m.viewport.SetHeight(max(1, msg.Height-4))
		}
		if m.state == stateDetail {
			m.refreshSelectedDetail()
		}
		return m, nil

	case tea.KeyPressMsg:
		switch m.state {
		case stateList:
			// Don't intercept keys when filtering
			if m.list.FilterState() == list.Filtering {
				break
			}
			switch {
			case key.Matches(msg, listQuitBinding):
				m.cancelled = msg.String() == "ctrl+c"
				return m, tea.Quit
			case key.Matches(msg, listOpenBinding):
				if m.refreshSelectedDetail() {
					m.viewport.GotoTop()
					m.state = stateDetail
					return m, nil
				}
			}
		case stateDetail:
			switch {
			case key.Matches(msg, listQuitBinding):
				m.cancelled = msg.String() == "ctrl+c"
				return m, tea.Quit
			case key.Matches(msg, key.NewBinding(key.WithKeys("esc", "backspace"))):
				m.state = stateList
				return m, nil
			default:
				var cmd tea.Cmd
				m.viewport, cmd = m.viewport.Update(msg)
				return m, cmd
			}
		}
	}

	// Pass to list model in list state
	if m.state == stateList {
		var cmd tea.Cmd
		m.list, cmd = m.list.Update(msg)
		return m, cmd
	}

	// Pass to viewport in detail state
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
}

func (m listViewModel) View() tea.View {
	switch m.state {
	case stateDetail:
		if !m.ready {
			v := tea.NewView("Loading…")
			v.AltScreen = true
			return v
		}

		selected := m.list.SelectedItem()
		title := m.title
		if selected != nil {
			if li, ok := selected.(listItem); ok {
				title = li.id + " · " + li.title
			}
		}

		width := m.viewport.Width()
		titleStyle := lipgloss.NewStyle().Bold(true).Foreground(colorCyan)
		header := titleStyle.Render(truncateListLine(title, width))
		sep := RenderSeparator(width)

		pct := m.viewport.ScrollPercent()
		info := StyleDim.Render(fmt.Sprintf(" %3.0f%% ", pct*100))
		help := "esc back · ↑↓/PgUp/PgDn scroll · q quit"
		if width < 56 {
			help = "esc back · q quit"
		}
		helpText := StyleDim.Render(truncateListLine(help, max(1, width-lipgloss.Width(info))))
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

	default:
		v := tea.NewView(m.list.View())
		v.AltScreen = true
		v.MouseMode = tea.MouseModeCellMotion
		return v
	}
}

func RunListView(title string, items []listItem) error {
	m := newListViewModel(title, items)
	p := tea.NewProgram(m)
	result, err := p.Run()
	if err != nil {
		return err
	}
	if result.(listViewModel).cancelled {
		return ErrCommandCancelled
	}
	return nil
}
