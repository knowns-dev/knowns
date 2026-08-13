package cli

import (
	"fmt"
	"io"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/list"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// ─── list item ───────────────────────────────────────────────────────

// listItem wraps any item for display in the interactive list.
type listItem struct {
	id          string // task ID or doc path
	title       string
	description string // subtitle line (status, priority, tags, etc.)
	detail      string // pre-rendered detail content shown on Enter
}

func (i listItem) Title() string       { return i.title }
func (i listItem) Description() string { return i.description }
func (i listItem) FilterValue() string { return i.title + " " + i.id }

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

	width := m.Width() - 4 // account for padding

	// Cursor and styling
	var titleLine, descLine string
	if index == m.Index() {
		cursor := StyleInfo.Render("> ")
		id := StyleID.Render("[" + li.id + "]")
		title := li.title
		if lipgloss.Width(li.id)+lipgloss.Width(li.title)+6 > width {
			maxTitle := width - lipgloss.Width(li.id) - 6
			if maxTitle > 3 {
				title = truncate(title, maxTitle)
			}
		}
		titleLine = cursor + id + " " + StyleBold.Render(title)
		descLine = "    " + li.description
	} else {
		id := StyleDim.Render("[" + li.id + "]")
		title := li.title
		if lipgloss.Width(li.id)+lipgloss.Width(li.title)+6 > width {
			maxTitle := width - lipgloss.Width(li.id) - 6
			if maxTitle > 3 {
				title = truncate(title, maxTitle)
			}
		}
		titleLine = "  " + id + " " + title
		descLine = "    " + StyleDim.Render(li.description)
	}

	fmt.Fprintln(w, titleLine)
	fmt.Fprint(w, descLine)
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
		m.list.SetSize(msg.Width, msg.Height)
		if !m.ready {
			m.viewport = viewport.New(
				viewport.WithWidth(msg.Width),
				viewport.WithHeight(msg.Height-4), // header + footer
			)
			m.viewport.MouseWheelEnabled = true
			m.ready = true
		} else {
			m.viewport.SetWidth(msg.Width)
			m.viewport.SetHeight(msg.Height - 4)
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
			case key.Matches(msg, key.NewBinding(key.WithKeys("q", "ctrl+c"))):
				m.cancelled = msg.String() == "ctrl+c"
				return m, tea.Quit
			case key.Matches(msg, key.NewBinding(key.WithKeys("enter"))):
				selected := m.list.SelectedItem()
				if selected != nil {
					if li, ok := selected.(listItem); ok && li.detail != "" {
						m.viewport.SetContent(li.detail)
						m.viewport.GotoTop()
						m.state = stateDetail
						return m, nil
					}
				}
			}
		case stateDetail:
			switch {
			case key.Matches(msg, key.NewBinding(key.WithKeys("q", "ctrl+c"))):
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
			v := tea.NewView("Loading...")
			v.AltScreen = true
			return v
		}

		selected := m.list.SelectedItem()
		title := m.title
		if selected != nil {
			if li, ok := selected.(listItem); ok {
				title = li.id + " — " + li.title
			}
		}

		width := m.viewport.Width()
		titleStyle := lipgloss.NewStyle().Bold(true).Foreground(colorCyan)
		header := titleStyle.Render(title)
		sep := RenderSeparator(width)

		pct := m.viewport.ScrollPercent()
		info := StyleDim.Render(fmt.Sprintf(" %3.0f%% ", pct*100))
		helpText := StyleDim.Render("esc: back • ↑↓/PgUp/PgDn: scroll • q: quit")
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
