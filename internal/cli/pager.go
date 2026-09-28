package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

// isTTY returns true if stdout is a terminal.
func isTTY() bool {
	return isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())
}

// printContent writes rendered content to stdout.
//
// It replaces renderOrPage, which diverted to an interactive pager when stdout was
// a terminal and printed directly otherwise, so every command using it rendered one
// way for a person and another for a pipe. Nothing branches on the terminal here.
func printContent(content string) error {
	fmt.Print(content)
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

// plainPageRequested reports whether the caller explicitly asked for a page of a
// plain listing, via --page or --page-size.
//
// Plain listings used to cap at defaultPlainItemLimit whether or not anyone asked.
// The styled path never did, so `knowns task list` showed all 32 done tasks while
// `knowns task list --plain` showed 20 and mentioned the rest only in a trailing
// PAGE line. The truncated half was the one labelled "for AI agents", which is
// backwards: the consumer least able to notice a missing footer was the one being
// silently given a subset. Paging now happens only when it is asked for.
func plainPageRequested(cmd any) bool {
	c, ok := cmd.(*cobra.Command)
	if !ok {
		return false
	}
	for _, name := range []string{"page", "page-size"} {
		if f := c.Root().PersistentFlags().Lookup(name); f != nil && f.Changed {
			return true
		}
		if f := c.Flags().Lookup(name); f != nil && f.Changed {
			return true
		}
	}
	return false
}
