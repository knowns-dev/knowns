package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/term"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var runtimeInternalCmd = &cobra.Command{
	Use:    "__runtime",
	Short:  "Internal shared runtime",
	Hidden: true,
}

var runtimeRunCmd = &cobra.Command{
	Use:    "run",
	Short:  "Run the internal shared runtime",
	Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runtimequeue.RunDaemon(cmd.Context(), search.ExecuteRuntimeJob, startRuntimeWatcher)
	},
}

var runtimeDaemonStatusCmd = &cobra.Command{
	Use:    "status",
	Short:  "Show shared runtime daemon status",
	Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		status, err := runtimequeue.LoadStatus()
		if err != nil {
			return err
		}
		if isJSON(cmd) || isPlain(cmd) {
			printJSON(status)
			return nil
		}
		fmt.Printf("Runtime running: %v\n", status.Running)
		fmt.Printf("PID: %d\n", status.PID)
		fmt.Printf("Clients: %d\n", len(status.Clients))
		fmt.Printf("Projects: %d\n", len(status.Project))
		return nil
	},
}

var runtimeCmd = &cobra.Command{
	Use:   "runtime",
	Short: "Install and inspect runtime adapters",
}

var runtimeInstallCmd = &cobra.Command{
	Use:   "install <runtime>",
	Short: "Install a runtime memory adapter",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		opts := runtimeinstall.DefaultOptions()
		if err := runtimeinstall.Install(args[0], opts); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Installed %s runtime adapter.\n", args[0])
		return nil
	},
}

var runtimeUninstallCmd = &cobra.Command{
	Use:   "uninstall <runtime>",
	Short: "Remove a runtime memory adapter",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		opts := runtimeinstall.DefaultOptions()
		if err := runtimeinstall.Uninstall(args[0], opts); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Removed %s runtime adapter.\n", args[0])
		return nil
	},
}

var runtimeStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show supported runtime adapter status",
	RunE: func(cmd *cobra.Command, args []string) error {
		statuses, err := runtimeinstall.StatusAll(runtimeinstall.DefaultOptions())
		if err != nil {
			return err
		}
		runtimeinstall.SortStatuses(statuses)
		if isJSON(cmd) {
			printJSON(statuses)
			return nil
		}
		if isPlain(cmd) {
			for _, status := range statuses {
				fmt.Fprintf(cmd.OutOrStdout(), "%s\t%s\t%s\tavailable=%v\n", status.Runtime, status.HookKind, status.State, status.Available)
			}
			return nil
		}
		for _, status := range statuses {
			fmt.Fprintf(cmd.OutOrStdout(), "%s\n", status.DisplayName)
			fmt.Fprintf(cmd.OutOrStdout(), "  Kind: %s\n", status.HookKind)
			fmt.Fprintf(cmd.OutOrStdout(), "  State: %s\n", status.State)
			fmt.Fprintf(cmd.OutOrStdout(), "  Available: %v\n", status.Available)
			if len(status.Details) > 0 {
				fmt.Fprintf(cmd.OutOrStdout(), "  Details: %s\n", strings.Join(status.Details, "; "))
			}
		}
		return nil
	},
}

var runtimePsCmd = &cobra.Command{
	Use:   "ps",
	Short: "Show what the shared runtime is doing (status, leases, jobs)",
	RunE:  runRuntimePs,
}

func runRuntimePs(cmd *cobra.Command, args []string) error {
	watch, _ := cmd.Flags().GetBool("watch")
	interval, _ := cmd.Flags().GetDuration("interval")
	if interval <= 0 {
		interval = 2 * time.Second
	}

	render := func() error {
		status, err := runtimequeue.LoadStatus()
		if err != nil {
			return err
		}
		if isJSON(cmd) {
			store, _ := getStoreErr()
			svcStatuses := services.DetectAll(store)
			printJSON(map[string]any{
				"status":   status,
				"services": svcStatuses,
				"projects": collectProjectJobs(status),
			})
			return nil
		}
		if watch {
			fmt.Print("\033[2J\033[H") // clear + home
		}
		renderRuntimePs(cmd, status, isPlain(cmd))
		return nil
	}

	if !watch {
		return render()
	}
	for {
		if err := render(); err != nil {
			return err
		}
		select {
		case <-cmd.Context().Done():
			return nil
		case <-time.After(interval):
		}
	}
}

type projectSnapshot struct {
	Root    string                  `json:"root"`
	Running []runtimequeue.Job      `json:"running"`
	Queued  []runtimequeue.Job      `json:"queued"`
	Recent  []runtimequeue.JobResult `json:"recent"`
}

func collectProjectJobs(status *runtimequeue.Status) []projectSnapshot {
	out := make([]projectSnapshot, 0, len(status.Project))
	for _, p := range status.Project {
		queue, err := runtimequeue.LoadQueue(p.ProjectRoot)
		if err != nil {
			continue
		}
		snap := projectSnapshot{Root: p.ProjectRoot}
		for _, job := range queue.Jobs {
			if job.StartedAt != nil {
				snap.Running = append(snap.Running, *job)
			} else {
				snap.Queued = append(snap.Queued, *job)
			}
		}
		snap.Recent = queue.Recent
		out = append(out, snap)
	}
	return out
}

func renderRuntimePs(cmd *cobra.Command, status *runtimequeue.Status, plain bool) {
	w := cmd.OutOrStdout()

	if plain {
		renderRuntimePsPlain(cmd, status)
		return
	}

	// ── Header ──────────────────────────────────────────────
	header := "● running"
	tag := StyleSuccess.Render(header)
	if !status.Running {
		header = "○ stopped"
		tag = StyleWarning.Render(header)
	}
	uptime := ""
	_ = uptime
	fmt.Fprintf(w, "%s  %s  %s\n\n",
		StyleBold.Render("Runtime"),
		tag,
		StyleDim.Render(fmt.Sprintf("pid=%d  v%s", status.PID, status.Version)))

	// ── Services box ────────────────────────────────────────
	store, _ := getStoreErr()
	svcStatuses := services.DetectAll(store)
	servicesLines := formatServiceLines(svcStatuses)
	fmt.Fprintln(w, renderBox(fmt.Sprintf("Services (%d)", len(svcStatuses)), servicesLines))
	fmt.Fprintln(w)

	if !status.Running && len(status.Clients) == 0 && len(status.Project) == 0 {
		return
	}

	// ── Clients box ─────────────────────────────────────────
	if len(status.Clients) > 0 {
		var lines []string
		for _, lease := range status.Clients {
			age := time.Since(lease.UpdatedAt).Round(time.Second)
			pidStr := fmt.Sprintf("pid=%d", lease.PID)
			if lease.PID == 0 {
				pidStr = StyleWarning.Render("pid=?")
			}
			lines = append(lines,
				fmt.Sprintf("%s %s  %s  %s",
					RenderBadge(strings.ToUpper(lease.ClientKind), colorBlue),
					StyleBold.Render(projectDisplayName(lease.ProjectRoot)),
					StyleDim.Render(pidStr),
					StyleDim.Render("age="+age.String())))
		}
		fmt.Fprintln(w, renderBox(fmt.Sprintf("Clients (%d)", len(status.Clients)), lines))
		fmt.Fprintln(w)
	}

	// ── Jobs box ────────────────────────────────────────────
	snapshots := collectProjectJobs(status)
	var runningJobs, queuedJobs, recentJobs, failedJobs int
	for _, s := range snapshots {
		runningJobs += len(s.Running)
		queuedJobs += len(s.Queued)
		recentJobs += len(s.Recent)
		for _, r := range s.Recent {
			if !r.Success {
				failedJobs++
			}
		}
	}

	now := time.Now().UTC()
	// Allocate columns based on available width.
	// Layout: "X  KIND_14  TARGET_*  DUR_7  ERR_*"
	tw := terminalWidth() - 6 // box borders + padding
	if tw < 50 {
		tw = 50
	}
	kindW := 14
	durW := 9
	const fixedSpacing = 2 + 2 + 2 + 2 // separators between cols
	targetW := tw - 1 /*mark*/ - kindW - durW - fixedSpacing - 4
	if targetW < 18 {
		targetW = 18
	}
	errW := tw - 1 - kindW - targetW - durW - fixedSpacing - 4
	if errW < 12 {
		errW = 12
	}

	var jobLines []string
	for _, snap := range snapshots {
		if len(snap.Running) == 0 && len(snap.Queued) == 0 && len(snap.Recent) == 0 {
			continue
		}
		project := projectDisplayName(snap.Root)
		for _, job := range snap.Running {
			dur := ""
			if job.StartedAt != nil {
				dur = now.Sub(*job.StartedAt).Round(time.Second).String()
			}
			progress := "running=" + dur
			if job.Total > 0 {
				pct := job.Processed * 100 / job.Total
				phase := job.Phase
				if phase == "" {
					phase = "working"
				}
				progress = fmt.Sprintf("%s %d/%d (%d%%)  %s", phase, job.Processed, job.Total, pct, dur)
			} else if job.Phase != "" {
				progress = job.Phase + "  " + dur
			}
			jobLines = append(jobLines,
				fmt.Sprintf("%s  %s  %s  %s",
					StyleInfo.Render("▶"),
					padRight(string(job.Kind), kindW),
					padRight(shortenTarget(project+"/"+job.Target, targetW), targetW),
					StyleDim.Render(progress)))
		}
		for _, job := range snap.Queued {
			wait := now.Sub(job.RequestedAt).Round(time.Second)
			jobLines = append(jobLines,
				fmt.Sprintf("%s  %s  %s  %s",
					StyleDim.Render("⋯"),
					padRight(string(job.Kind), kindW),
					padRight(shortenTarget(project+"/"+job.Target, targetW), targetW),
					StyleDim.Render("queued="+wait.String())))
		}
		if n := len(snap.Recent); n > 0 {
			limit := n
			if limit > 3 {
				limit = 3
			}
			for _, r := range snap.Recent[n-limit:] {
				mark := StyleSuccess.Render("✓")
				detail := ""
				if !r.Success {
					mark = StyleError.Render("✗")
					detail = "  " + StyleError.Render(truncate(r.Error, errW))
				}
				dur := r.CompletedAt.Sub(r.StartedAt).Round(time.Millisecond)
				jobLines = append(jobLines,
					fmt.Sprintf("%s  %s  %s  %s%s",
						mark,
						padRight(string(r.Kind), kindW),
						padRight(shortenTarget(project+"/"+r.Target, targetW), targetW),
						StyleDim.Render(padRight(dur.String(), durW)),
						detail))
			}
		}
	}

	jobsTitle := fmt.Sprintf("Jobs — %d running · %d queued · %d recent",
		runningJobs, queuedJobs, recentJobs)
	if failedJobs > 0 {
		jobsTitle += "  " + StyleError.Render(fmt.Sprintf("(%d failed)", failedJobs))
	}
	if len(jobLines) == 0 {
		jobLines = []string{StyleDim.Render("(no activity)")}
	}
	fmt.Fprintln(w, renderBox(jobsTitle, jobLines))
}

func formatServiceLines(ss []services.ServiceStatus) []string {
	var lines []string
	for _, s := range ss {
		bullet := "○"
		style := StyleDim
		if s.Status == "running" {
			bullet = "●"
			style = StyleSuccess
		}
		name := style.Render(s.Name)

		var detail string
		switch {
		case s.Status == "running":
			parts := []string{StyleDim.Render(s.Status)}
			if s.PID > 0 {
				parts = append(parts, StyleDim.Render(fmt.Sprintf("pid=%d", s.PID)))
			}
			if s.Port > 0 {
				parts = append(parts, StyleDim.Render(fmt.Sprintf(":%d", s.Port)))
			}
			if s.Uptime > 0 {
				parts = append(parts, StyleDim.Render(fmt.Sprintf("uptime=%s", humanDuration(s.Uptime))))
			}
			if version := s.Details["version"]; version != "" {
				parts = append(parts, StyleDim.Render(fmt.Sprintf("v=%s", shorten(version))))
			}
			if url := s.Details["url"]; url != "" {
				parts = append(parts, StyleDim.Render(url))
			}
			detail = strings.Join(parts, "  ")
		default:
			statusStr := s.Status
			if s.Status == "stopped" {
				statusStr = "stopped"
			}
			reason := s.Details["reason"]
			if reason == "" {
				reason = s.Details["note"]
			}
			if reason != "" {
				detail = StyleDim.Render(statusStr + " (" + reason + ")")
			} else {
				detail = StyleDim.Render(statusStr)
			}
		}

		// Append type-specific details
		if s.Type == "embedding" && s.Details["model"] != "" {
			detail += "  " + StyleDim.Render("model="+s.Details["model"])
		}
		if s.Type == "opencode" && s.Details["mode"] != "" {
			detail += "  " + StyleDim.Render("mode="+s.Details["mode"])
		}

		lines = append(lines, fmt.Sprintf("  %s %s  %s", bullet, name, detail))
	}
	if len(lines) == 0 {
		lines = []string{StyleDim.Render("  (no services)")}
	}
	return lines
}

func renderRuntimePsPlain(cmd *cobra.Command, status *runtimequeue.Status) {
	w := cmd.OutOrStdout()
	state := "running"
	if !status.Running {
		state = "stopped"
	}
	fmt.Fprintf(w, "runtime\t%s\tpid=%d\tversion=%s\n", state, status.PID, status.Version)

	for _, lease := range status.Clients {
		age := time.Since(lease.UpdatedAt).Round(time.Second)
		fmt.Fprintf(w, "client\t%s\t%s\tpid=%d\tage=%s\n",
			lease.ClientKind, filepath.Base(lease.ProjectRoot), lease.PID, age)
	}

	snapshots := collectProjectJobs(status)
	now := time.Now().UTC()
	for _, snap := range snapshots {
		project := filepath.Base(snap.Root)
		for _, job := range snap.Running {
			dur := ""
			if job.StartedAt != nil {
				dur = now.Sub(*job.StartedAt).Round(time.Second).String()
			}
			progress := ""
			if job.Total > 0 {
				progress = fmt.Sprintf("%s=%d/%d", job.Phase, job.Processed, job.Total)
			} else if job.Phase != "" {
				progress = job.Phase
			}
			fmt.Fprintf(w, "running\t%s\t%s\t%s\t%s\t%s\n",
				project, job.Kind, shorten(job.Target), dur, progress)
		}
		for _, job := range snap.Queued {
			wait := now.Sub(job.RequestedAt).Round(time.Second)
			fmt.Fprintf(w, "queued\t%s\t%s\t%s\t%s\n",
				project, job.Kind, shorten(job.Target), wait)
		}
		for _, r := range snap.Recent {
			mark := "ok"
			if !r.Success {
				mark = "fail"
			}
			dur := r.CompletedAt.Sub(r.StartedAt).Round(time.Millisecond)
			fmt.Fprintf(w, "recent\t%s\t%s\t%s\t%s\t%s\t%s\n",
				project, r.Kind, shorten(r.Target), mark, dur, r.Error)
		}
	}
}

// renderBox draws a rounded box around `lines` with `title` in the top border.
func renderBox(title string, lines []string) string {
	maxWidth := terminalWidth() - 1
	if maxWidth < 40 {
		maxWidth = 40
	}
	if maxWidth > 140 {
		maxWidth = 140
	}
	innerWidth := lipgloss.Width(title) + 4
	for _, l := range lines {
		if w := lipgloss.Width(l); w+2 > innerWidth {
			innerWidth = w + 2
		}
	}
	if innerWidth > maxWidth-2 {
		innerWidth = maxWidth - 2
	}

	top := "┌─ " + StyleBold.Render(title) + " " +
		strings.Repeat("─", max(0, innerWidth-lipgloss.Width(title)-3)) + "┐"
	bot := "└" + strings.Repeat("─", innerWidth) + "┘"

	var b strings.Builder
	b.WriteString(StyleDim.Render(top) + "\n")
	for _, l := range lines {
		w := lipgloss.Width(l)
		contentMax := innerWidth - 2
		if w > contentMax {
			l = truncateVisible(l, contentMax)
			w = lipgloss.Width(l)
		}
		pad := contentMax - w
		if pad < 0 {
			pad = 0
		}
		b.WriteString(StyleDim.Render("│ ") + l + strings.Repeat(" ", pad) + StyleDim.Render(" │") + "\n")
	}
	b.WriteString(StyleDim.Render(bot))
	return b.String()
}

// truncateVisible trims rendered string to roughly `max` visible columns, adding …
func truncateVisible(s string, max int) string {
	if lipgloss.Width(s) <= max {
		return s
	}
	// Walk runes, but treat escape sequences as zero-width.
	var b strings.Builder
	visible := 0
	inEsc := false
	for _, r := range s {
		if r == '\x1b' {
			inEsc = true
			b.WriteRune(r)
			continue
		}
		if inEsc {
			b.WriteRune(r)
			if r == 'm' {
				inEsc = false
			}
			continue
		}
		if visible >= max-1 {
			b.WriteRune('…')
			break
		}
		b.WriteRune(r)
		visible++
	}
	// Reset any open style just in case.
	b.WriteString("\x1b[0m")
	return b.String()
}

func padRight(s string, n int) string {
	w := lipgloss.Width(s)
	if w >= n {
		return s
	}
	return s + strings.Repeat(" ", n-w)
}

func shortenTarget(s string, max int) string {
	if s == "" {
		return "-"
	}
	if len(s) <= max {
		return s
	}
	return "…" + s[len(s)-(max-1):]
}

func projectDisplayName(root string) string {
	base := filepath.Base(root)
	if base == ".knowns" {
		return filepath.Base(filepath.Dir(root))
	}
	return base
}

// terminalWidth returns the current terminal width, or 100 as a safe default.
func terminalWidth() int {
	if w, _, err := term.GetSize(os.Stdout.Fd()); err == nil && w > 0 {
		return w
	}
	if raw := os.Getenv("COLUMNS"); raw != "" {
		var w int
		if _, err := fmt.Sscanf(raw, "%d", &w); err == nil && w > 0 {
			return w
		}
	}
	return 100
}

func humanDuration(d time.Duration) string {
	d = d.Round(time.Second)
	h := int(d / time.Hour)
	m := int(d % time.Hour / time.Minute)
	s := int(d % time.Minute / time.Second)
	switch {
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm %ds", m, s)
	default:
		return fmt.Sprintf("%ds", s)
	}
}

func shorten(s string) string {
	if s == "" {
		return "-"
	}
	if len(s) > 50 {
		return "…" + s[len(s)-49:]
	}
	return s
}

var runtimeStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Request the shared runtime to shut down gracefully",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !runtimequeue.IsRunning() {
			fmt.Fprintln(cmd.OutOrStdout(), "Runtime is not running.")
			return nil
		}
		if err := runtimequeue.RequestShutdown(10 * time.Second); err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Runtime stopped.")
		return nil
	},
}

func startRuntimeWatcher(ctx context.Context, storeRoot string) error {
	store := storage.NewStore(storeRoot)
	return StartCodeWatcher(ctx, store, filepath.Dir(storeRoot), watchDebounceMs)
}

var runtimeLogsCmd = &cobra.Command{
	Use:   "logs",
	Short: "Show runtime / MCP server log files",
	RunE:  runRuntimeLogs,
}

func runRuntimeLogs(cmd *cobra.Command, args []string) error {
	follow, _ := cmd.Flags().GetBool("follow")
	tailN, _ := cmd.Flags().GetInt("tail")
	source, _ := cmd.Flags().GetString("source")

	var paths []struct{ name, path string }
	switch source {
	case "runtime":
		paths = append(paths, struct{ name, path string }{"runtime", runtimequeue.RuntimeLogPath()})
	case "mcp":
		paths = append(paths, struct{ name, path string }{"mcp", runtimequeue.MCPLogPath()})
	case "", "all":
		paths = append(paths,
			struct{ name, path string }{"runtime", runtimequeue.RuntimeLogPath()},
			struct{ name, path string }{"mcp", runtimequeue.MCPLogPath()},
		)
	default:
		return fmt.Errorf("unknown --source %q (want runtime|mcp|all)", source)
	}

	w := cmd.OutOrStdout()
	for _, p := range paths {
		if _, err := os.Stat(p.path); os.IsNotExist(err) {
			fmt.Fprintf(w, "%s %s (no log yet)\n", StyleDim.Render("·"), p.path)
			continue
		}
		if !isPlain(cmd) {
			fmt.Fprintf(w, "%s %s\n",
				RenderBadge(strings.ToUpper(p.name), colorBlue),
				StyleDim.Render(p.path))
		}
		if err := tailFile(w, p.path, tailN); err != nil {
			return err
		}
	}

	if !follow {
		return nil
	}
	return followFiles(cmd.Context(), w, paths)
}

func tailFile(w io.Writer, path string, n int) error {
	if n <= 0 {
		n = 50
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	lines := make([]string, 0, n)
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if len(lines) == n {
			lines = lines[1:]
		}
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	for _, l := range lines {
		fmt.Fprintln(w, l)
	}
	return nil
}

func followFiles(ctx context.Context, w io.Writer, paths []struct{ name, path string }) error {
	type tailState struct {
		name string
		path string
		f    *os.File
		size int64
	}
	states := make([]*tailState, 0, len(paths))
	for _, p := range paths {
		f, err := os.Open(p.path)
		if err != nil {
			continue
		}
		info, err := f.Stat()
		if err != nil {
			_ = f.Close()
			continue
		}
		_, _ = f.Seek(info.Size(), io.SeekStart)
		states = append(states, &tailState{p.name, p.path, f, info.Size()})
	}
	defer func() {
		for _, s := range states {
			_ = s.f.Close()
		}
	}()

	prefix := len(states) > 1
	buf := make([]byte, 32*1024)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			for _, s := range states {
				info, err := os.Stat(s.path)
				if err != nil {
					continue
				}
				if info.Size() < s.size {
					_, _ = s.f.Seek(0, io.SeekStart)
					s.size = 0
				}
				for {
					n, err := s.f.Read(buf)
					if n > 0 {
						s.size += int64(n)
						if prefix {
							for _, line := range strings.SplitAfter(string(buf[:n]), "\n") {
								if line == "" {
									continue
								}
								fmt.Fprintf(w, "%s %s",
									StyleDim.Render("["+s.name+"]"), line)
							}
						} else {
							_, _ = w.Write(buf[:n])
						}
					}
					if err == io.EOF || n == 0 {
						break
					}
					if err != nil {
						break
					}
				}
			}
		}
	}
}

func init() {
	runtimeInternalCmd.AddCommand(runtimeRunCmd)
	runtimeInternalCmd.AddCommand(runtimeDaemonStatusCmd)
	runtimeCmd.AddCommand(runtimeInstallCmd)
	runtimeCmd.AddCommand(runtimeUninstallCmd)
	runtimeCmd.AddCommand(runtimeStatusCmd)
	runtimeCmd.AddCommand(runtimePsCmd)
	runtimeCmd.AddCommand(runtimeStopCmd)
	runtimeCmd.AddCommand(runtimeLogsCmd)

	runtimePsCmd.Flags().BoolP("watch", "w", false, "Refresh continuously")
	runtimePsCmd.Flags().Duration("interval", 2*time.Second, "Refresh interval when --watch is set")

	runtimeLogsCmd.Flags().BoolP("follow", "f", false, "Follow new log lines")
	runtimeLogsCmd.Flags().IntP("tail", "n", 50, "Number of trailing lines to show")
	runtimeLogsCmd.Flags().StringP("source", "s", "all", "Which log to read: runtime|mcp|all")

	rootCmd.AddCommand(runtimeInternalCmd)
	rootCmd.AddCommand(runtimeCmd)
}
