package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
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
		return runtimequeue.RunDaemonWithOptions(cmd.Context(), runtimequeue.DaemonOptions{
			Executor:       search.ExecuteRuntimeJob,
			WatcherFactory: startRuntimeWatcher,
			ReloadHandler:  search.ReloadDefaultSemanticRuntime,
		})
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
	Short: "Install and inspect runtime hooks and status integrations",
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
	Short: "Show runtime hook and integration installation state",
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
	Short: "Show live runtime processes and jobs, not readiness or integration status",
	Long: `Show live shared runtime status: managed services, connected clients,
current queue activity, and bounded recent job failures.

Use this for process and queue visibility. For project readiness, use knowns status.
For diagnostics and remediation, use knowns doctor. For runtime hook or plugin
installation state, use knowns runtime status. For raw logs, use knowns runtime logs.`,
	RunE: runRuntimePs,
}

var runtimeReloadCmd = &cobra.Command{
	Use:   "reload",
	Short: "Reload shared runtime semantic providers and config",
	RunE:  runRuntimeReload,
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
		opts := runtimePsOptionsFromCmd(cmd)
		snapshots := collectProjectJobs(status)
		summary := summarizeRuntimePs(status, snapshots, opts.FailureLimit)
		semantic := search.ObservedSemanticRuntimeStatus()
		reload, _ := runtimequeue.LoadReloadStatus()

		if isJSON(cmd) {
			store, _ := getStoreErr()
			svcStatuses := services.DetectAll(store)
			printJSON(map[string]any{
				"status":   status,
				"services": svcStatuses,
				"projects": snapshots,
				"summary":  summary,
				"options":  opts,
				"semantic": semantic,
				"reload":   reload,
			})
			return nil
		}
		if watch {
			fmt.Print("\033[2J\033[H") // clear + home
		}
		var svcStatuses []services.ServiceStatus
		if !isPlain(cmd) {
			store, _ := getStoreErr()
			svcStatuses = services.DetectAll(store)
		}
		renderRuntimePs(cmd, status, svcStatuses, snapshots, summary, opts, semantic, reload, isPlain(cmd))
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

func runRuntimeReload(cmd *cobra.Command, args []string) error {
	wait, _ := cmd.Flags().GetBool("wait")
	timeout, _ := cmd.Flags().GetDuration("timeout")
	status, err := runtimequeue.LoadStatus()
	if err != nil {
		return err
	}
	running := status.Running && runtimequeue.IsRunning()
	semantic := search.ObservedSemanticRuntimeStatus()
	var readiness *search.SemanticIndexReadiness
	if store, err := getStoreErr(); err == nil {
		r := search.ResolveSemanticIndexReadiness(store)
		readiness = &r
	}
	remediation := ""
	if readiness != nil {
		remediation = semanticReindexRemediation(*readiness)
	}

	if !running {
		payload := map[string]any{
			"running":      false,
			"requested":    false,
			"acknowledged": false,
			"noop":         true,
			"semantic":     semantic,
			"readiness":    readiness,
			"remediation":  remediation,
		}
		if isJSON(cmd) {
			printJSON(payload)
			return nil
		}
		w := cmd.OutOrStdout()
		if isPlain(cmd) {
			fmt.Fprintln(w, "reload	noop	running=false	acknowledged=false")
			for _, line := range formatSemanticRuntimePlainLines(semantic, runtimequeue.ReloadStatus{}) {
				fmt.Fprintln(w, line)
			}
			if readiness != nil {
				fmt.Fprintln(w, formatSemanticIndexReadinessPlainLine(*readiness))
			}
			if remediation != "" {
				fmt.Fprintf(w, "remediation\t%s\n", remediation)
			}
			return nil
		}
		fmt.Fprintln(w, StyleDim.Render("Runtime is not running; no reload request was needed."))
		fmt.Fprintln(w, StyleDim.Render("The next runtime start, job, or search will read the latest semantic settings."))
		for _, line := range formatSemanticIndexReadinessLines(readiness, true) {
			fmt.Fprintln(w, line)
		}
		return nil
	}

	request, err := runtimequeue.RequestReload()
	if err != nil {
		return err
	}
	reload := runtimequeue.ReloadStatus{}
	acknowledged := false
	if wait {
		reload, err = runtimequeue.WaitForReload(request.ID, timeout)
		if err != nil {
			return err
		}
		acknowledged = true
		semantic = search.ObservedSemanticRuntimeStatus()
	} else if loaded, err := runtimequeue.LoadReloadStatus(); err == nil && loaded.RequestID == request.ID {
		reload = loaded
		acknowledged = loaded.Success
	}

	payload := map[string]any{
		"running":      true,
		"pid":          status.PID,
		"requested":    true,
		"request":      request,
		"acknowledged": acknowledged,
		"reload":       reload,
		"semantic":     semantic,
		"readiness":    readiness,
		"remediation":  remediation,
		"noop":         false,
	}
	if isJSON(cmd) {
		printJSON(payload)
		return nil
	}

	w := cmd.OutOrStdout()
	if isPlain(cmd) {
		fmt.Fprintf(w, "reload\trequested\trunning=true\tpid=%d\trequestId=%s\tacknowledged=%v\n", status.PID, request.ID, acknowledged)
		if acknowledged {
			fmt.Fprintf(w, "reload-ack\tgeneration=%d\tprocessedAt=%s\trequestId=%s\n", reload.Generation, reload.ProcessedAt.Format(time.RFC3339), reload.RequestID)
		}
		for _, line := range formatSemanticRuntimePlainLines(semantic, reload) {
			fmt.Fprintln(w, line)
		}
		if readiness != nil {
			fmt.Fprintln(w, formatSemanticIndexReadinessPlainLine(*readiness))
		}
		if remediation != "" {
			fmt.Fprintf(w, "remediation\t%s\n", remediation)
		}
		return nil
	}

	if acknowledged {
		fmt.Fprintf(w, "%s Runtime reload acknowledged by daemon pid=%d.\n", StyleSuccess.Render("✓"), status.PID)
		fmt.Fprintf(w, "%s generation=%d request=%s\n", StyleDim.Render("Reload"), reload.Generation, reload.RequestID)
	} else {
		fmt.Fprintf(w, "%s Runtime reload requested for daemon pid=%d.\n", StyleSuccess.Render("✓"), status.PID)
		fmt.Fprintf(w, "%s request=%s; use --wait to block until acknowledged.\n", StyleDim.Render("Reload"), request.ID)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, renderBox("Semantic runtime", formatSemanticRuntimeLines(semantic, reload, true)))
	for _, line := range formatSemanticIndexReadinessLines(readiness, true) {
		fmt.Fprintln(w, line)
	}
	return nil
}

type projectSnapshot struct {
	Root    string                   `json:"root"`
	Running []runtimequeue.Job       `json:"running"`
	Queued  []runtimequeue.Job       `json:"queued"`
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

const (
	defaultRuntimePsClientLimit  = 6
	defaultRuntimePsFailureLimit = 3
)

type runtimePsOptions struct {
	ShowJobs     bool `json:"showJobs"`
	Tail         int  `json:"tail"`
	FailedOnly   bool `json:"failedOnly"`
	All          bool `json:"all"`
	ClientLimit  int  `json:"clientLimit"`
	FailureLimit int  `json:"failureLimit"`
}

type runtimePsSummary struct {
	Clients     int                       `json:"clients"`
	Projects    int                       `json:"projects"`
	RunningJobs int                       `json:"runningJobs"`
	QueuedJobs  int                       `json:"queuedJobs"`
	RecentJobs  int                       `json:"recentJobs"`
	FailedJobs  int                       `json:"failedJobs"`
	Failures    []runtimePsFailureSummary `json:"failures,omitempty"`
}

type runtimePsFailureSummary struct {
	Project         string `json:"project"`
	Kind            string `json:"kind"`
	Target          string `json:"target,omitempty"`
	Error           string `json:"error"`
	Count           int    `json:"count"`
	LastDuration    string `json:"lastDuration,omitempty"`
	Remediation     string `json:"remediation,omitempty"`
	lastCompletedAt time.Time
}

type runtimePsRecentRow struct {
	Project string
	Result  runtimequeue.JobResult
}

func runtimePsOptionsFromCmd(cmd *cobra.Command) runtimePsOptions {
	showJobs, _ := cmd.Flags().GetBool("jobs")
	failedOnly, _ := cmd.Flags().GetBool("failed")
	all, _ := cmd.Flags().GetBool("all")
	tail, _ := cmd.Flags().GetInt("tail")
	clientLimit, _ := cmd.Flags().GetInt("clients")
	failureLimit, _ := cmd.Flags().GetInt("failures")
	if tail < 0 {
		tail = 0
	}
	if clientLimit < 0 {
		clientLimit = 0
	}
	if failureLimit < 0 {
		failureLimit = 0
	}
	if all || failedOnly || cmd.Flags().Changed("tail") {
		showJobs = true
	}
	if all {
		tail = 0
	}
	return runtimePsOptions{
		ShowJobs:     showJobs,
		Tail:         tail,
		FailedOnly:   failedOnly,
		All:          all,
		ClientLimit:  clientLimit,
		FailureLimit: failureLimit,
	}
}

func summarizeRuntimePs(status *runtimequeue.Status, snapshots []projectSnapshot, failureLimit int) runtimePsSummary {
	summary := runtimePsSummary{Clients: len(status.Clients), Projects: len(snapshots)}
	for _, snap := range snapshots {
		summary.RunningJobs += len(snap.Running)
		summary.QueuedJobs += len(snap.Queued)
		summary.RecentJobs += len(snap.Recent)
		for _, result := range snap.Recent {
			if !result.Success {
				summary.FailedJobs++
			}
		}
	}
	if failureLimit > 0 {
		summary.Failures = summarizeRuntimeFailures(snapshots, failureLimit)
	}
	return summary
}

func summarizeRuntimeFailures(snapshots []projectSnapshot, limit int) []runtimePsFailureSummary {
	groups := make(map[string]*runtimePsFailureSummary)
	for _, snap := range snapshots {
		project := projectDisplayName(snap.Root)
		for _, result := range snap.Recent {
			if result.Success {
				continue
			}
			errSummary := runtimePsErrorSummary(result.Error)
			key := strings.Join([]string{project, string(result.Kind), result.Target, errSummary}, "\x00")
			group := groups[key]
			if group == nil {
				group = &runtimePsFailureSummary{
					Project:     project,
					Kind:        string(result.Kind),
					Target:      result.Target,
					Error:       errSummary,
					Remediation: runtimePsRemediation(result.Error),
				}
				groups[key] = group
			}
			group.Count++
			if result.CompletedAt.After(group.lastCompletedAt) {
				group.lastCompletedAt = result.CompletedAt
				group.LastDuration = result.CompletedAt.Sub(result.StartedAt).Round(time.Millisecond).String()
			}
		}
	}
	failures := make([]runtimePsFailureSummary, 0, len(groups))
	for _, group := range groups {
		failures = append(failures, *group)
	}
	sort.Slice(failures, func(i, j int) bool {
		if !failures[i].lastCompletedAt.Equal(failures[j].lastCompletedAt) {
			return failures[i].lastCompletedAt.After(failures[j].lastCompletedAt)
		}
		return failures[i].Count > failures[j].Count
	})
	if limit > 0 && len(failures) > limit {
		failures = failures[:limit]
	}
	return failures
}

func runtimePsErrorSummary(errText string) string {
	errText = strings.Join(strings.Fields(strings.ReplaceAll(errText, "\n", " ")), " ")
	if errText == "" {
		return "unknown error"
	}
	knownFragments := []string{
		"semantic runtime unavailable",
		"embedding model",
		"provider is unavailable",
	}
	for _, fragment := range knownFragments {
		if idx := strings.Index(errText, fragment); idx >= 0 {
			return truncate(errText[idx:], 180)
		}
	}
	if idx := strings.LastIndex(errText, ": "); idx >= 0 && idx+2 < len(errText) {
		return truncate(errText[idx+2:], 180)
	}
	return truncate(errText, 180)
}

func runtimePsRemediation(errText string) string {
	lower := strings.ToLower(errText)
	switch {
	case strings.Contains(lower, "semantic runtime unavailable") || strings.Contains(lower, "index is empty"):
		return "knowns search --reindex"
	default:
		return ""
	}
}

func recentRuntimeRows(snapshots []projectSnapshot, opts runtimePsOptions) []runtimePsRecentRow {
	rows := make([]runtimePsRecentRow, 0)
	for _, snap := range snapshots {
		project := projectDisplayName(snap.Root)
		for _, result := range snap.Recent {
			if opts.FailedOnly && result.Success {
				continue
			}
			rows = append(rows, runtimePsRecentRow{Project: project, Result: result})
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].Result.CompletedAt.After(rows[j].Result.CompletedAt)
	})
	if !opts.All && opts.Tail > 0 && len(rows) > opts.Tail {
		rows = rows[:opts.Tail]
	}
	return rows
}

func renderRuntimePs(cmd *cobra.Command, status *runtimequeue.Status, svcStatuses []services.ServiceStatus, snapshots []projectSnapshot, summary runtimePsSummary, opts runtimePsOptions, semantic search.SemanticRuntimeStatus, reload runtimequeue.ReloadStatus, plain bool) {
	w := cmd.OutOrStdout()

	if plain {
		renderRuntimePsPlain(cmd, status, snapshots, summary, opts, semantic, reload)
		return
	}

	header := "● running"
	tag := StyleSuccess.Render(header)
	if !status.Running {
		header = "○ stopped"
		tag = StyleWarning.Render(header)
	}
	fmt.Fprintf(w, "%s  %s  %s\n\n",
		StyleBold.Render("Runtime"),
		tag,
		StyleDim.Render(fmt.Sprintf("pid=%d  %s", status.PID, status.Version)))

	servicesLines := formatServiceSummaryLines(svcStatuses)
	fmt.Fprintln(w, renderBox(fmt.Sprintf("Services (%d)", len(servicesLines)), servicesLines))
	fmt.Fprintln(w)

	fmt.Fprintln(w, renderBox("Semantic runtime", formatSemanticRuntimeLines(semantic, reload, true)))
	fmt.Fprintln(w)
	if len(status.Watchers) > 0 {
		fmt.Fprintln(w, renderBox(fmt.Sprintf("Knowledge watchers (%d)", len(status.Watchers)), formatRuntimeWatcherLines(status.Watchers)))
		fmt.Fprintln(w)
	}

	if len(status.Clients) > 0 && opts.ClientLimit > 0 {
		fmt.Fprintln(w, renderBox(fmt.Sprintf("Clients (%d)", len(status.Clients)), formatRuntimeClientLines(status.Clients, opts.ClientLimit)))
		fmt.Fprintln(w)
	}

	activityLines := []string{
		fmt.Sprintf("Clients   %d", summary.Clients),
		fmt.Sprintf("Running   %d", summary.RunningJobs),
		fmt.Sprintf("Queued    %d", summary.QueuedJobs),
	}
	recentLine := fmt.Sprintf("Recent    %d total", summary.RecentJobs)
	if summary.FailedJobs > 0 {
		recentLine += StyleError.Render(fmt.Sprintf("  %d failed", summary.FailedJobs))
	}
	activityLines = append(activityLines, recentLine)
	fmt.Fprintln(w, renderBox("Activity", activityLines))

	if opts.ShowJobs {
		fmt.Fprintln(w)
		jobLines := formatRuntimeJobDetailLines(snapshots, opts, true)
		if len(jobLines) == 0 {
			jobLines = []string{StyleDim.Render("(no matching jobs)")}
		}
		fmt.Fprintln(w, renderBox(runtimeJobsTitle(summary, opts), jobLines))
		return
	}

	if len(summary.Failures) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintln(w, renderBox("Recent failures", formatRuntimeFailureLines(summary.Failures, true)))
	}

	fmt.Fprintln(w)
	fmt.Fprintln(w, renderBox("Use", []string{
		"knowns runtime ps --jobs --tail 20       show recent job detail",
		"knowns runtime ps --failed              show recent failures only",
		"knowns runtime ps --clients 10 --failures 5  tune compact limits",
		"knowns doctor --scope runtime,search    diagnose with remediation",
	}))
}

func formatRuntimeClientLines(clients []runtimequeue.Lease, limit int) []string {
	lines := make([]string, 0, len(clients))
	for i, lease := range clients {
		if limit > 0 && i >= limit {
			lines = append(lines, StyleDim.Render(fmt.Sprintf("… %d more clients", len(clients)-limit)))
			break
		}
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
	if len(lines) == 0 {
		return []string{StyleDim.Render("(no clients)")}
	}
	return lines
}

func formatRuntimeWatcherLines(watchers []runtimequeue.WatcherStatus) []string {
	lines := make([]string, 0, len(watchers))
	for _, watcher := range watchers {
		state := "stopped"
		if watcher.Active {
			state = "active"
		}
		if watcher.GracePending {
			state = "grace"
		}
		line := fmt.Sprintf("%s  demand=%d  state=%s", projectDisplayName(watcher.ProjectRoot), watcher.Demand, state)
		if watcher.GracePending && !watcher.GraceUntil.IsZero() {
			line += "  until=" + watcher.GraceUntil.Format(time.RFC3339)
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return []string{StyleDim.Render("(no knowledge watchers)")}
	}
	return lines
}

func runtimeJobsTitle(summary runtimePsSummary, opts runtimePsOptions) string {
	title := fmt.Sprintf("Jobs — %d running · %d queued · %d recent", summary.RunningJobs, summary.QueuedJobs, summary.RecentJobs)
	if summary.FailedJobs > 0 {
		title += fmt.Sprintf(" · %d failed", summary.FailedJobs)
	}
	if opts.FailedOnly {
		title += " · failed only"
	}
	if !opts.All && opts.Tail > 0 {
		title += fmt.Sprintf(" · tail %d", opts.Tail)
	}
	if opts.All {
		title += " · all"
	}
	return title
}

func formatRuntimeJobDetailLines(snapshots []projectSnapshot, opts runtimePsOptions, styled bool) []string {
	var lines []string
	now := time.Now().UTC()
	kindW := 14
	targetW := 40
	if tw := terminalWidth(); tw > 0 {
		targetW = tw - 65
		if targetW < 24 {
			targetW = 24
		}
		if targetW > 72 {
			targetW = 72
		}
	}

	mark := func(label, status string) string {
		if !styled {
			return label
		}
		switch status {
		case "running":
			return StyleInfo.Render(label)
		case "queued":
			return StyleDim.Render(label)
		case "fail":
			return StyleError.Render(label)
		default:
			return StyleSuccess.Render(label)
		}
	}

	if !opts.FailedOnly {
		for _, snap := range snapshots {
			project := projectDisplayName(snap.Root)
			for _, job := range snap.Running {
				dur := ""
				if job.StartedAt != nil {
					dur = now.Sub(*job.StartedAt).Round(time.Second).String()
				}
				progress := "running=" + dur
				if job.Total > 0 {
					pct := 0
					if job.Total > 0 {
						pct = job.Processed * 100 / job.Total
					}
					phase := job.Phase
					if phase == "" {
						phase = "working"
					}
					progress = fmt.Sprintf("%s %d/%d (%d%%) %s", phase, job.Processed, job.Total, pct, dur)
				} else if job.Phase != "" {
					progress = job.Phase + " " + dur
				}
				lines = append(lines, fmt.Sprintf("%s  %s  %s  %s",
					mark("▶", "running"),
					padRight(string(job.Kind), kindW),
					padRight(shortenTarget(project+"/"+job.Target, targetW), targetW),
					styleRuntimeDetail(progress, styled)))
			}
			for _, job := range snap.Queued {
				wait := now.Sub(job.RequestedAt).Round(time.Second)
				lines = append(lines, fmt.Sprintf("%s  %s  %s  %s",
					mark("⋯", "queued"),
					padRight(string(job.Kind), kindW),
					padRight(shortenTarget(project+"/"+job.Target, targetW), targetW),
					styleRuntimeDetail("queued="+wait.String(), styled)))
			}
		}
	}

	for _, row := range recentRuntimeRows(snapshots, opts) {
		result := row.Result
		status := "ok"
		glyph := "✓"
		detail := ""
		if !result.Success {
			status = "fail"
			glyph = "✗"
			detail = "  " + runtimePsErrorSummary(result.Error)
			if remediation := runtimePsRemediation(result.Error); remediation != "" {
				detail += "  run: " + remediation
			}
		}
		dur := result.CompletedAt.Sub(result.StartedAt).Round(time.Millisecond)
		if styled && !result.Success {
			detail = "  " + StyleError.Render(strings.TrimSpace(detail))
		}
		lines = append(lines, fmt.Sprintf("%s  %s  %s  %s%s",
			mark(glyph, status),
			padRight(string(result.Kind), kindW),
			padRight(shortenTarget(row.Project+"/"+result.Target, targetW), targetW),
			styleRuntimeDetail(padRight(dur.String(), 9), styled),
			detail))
	}
	return lines
}

func formatRuntimeFailureLines(failures []runtimePsFailureSummary, styled bool) []string {
	lines := make([]string, 0, len(failures)*2)
	for _, failure := range failures {
		prefix := "✗"
		if styled {
			prefix = StyleError.Render(prefix)
		}
		target := failure.Target
		if target == "" {
			target = "-"
		}
		repeated := ""
		if failure.Count > 1 {
			repeated = fmt.Sprintf("  repeated %dx", failure.Count)
		}
		line := fmt.Sprintf("%s  %s  %s/%s%s  %s",
			prefix,
			failure.Kind,
			failure.Project,
			shortenTarget(target, 24),
			repeated,
			failure.Error)
		lines = append(lines, line)
		if failure.Remediation != "" {
			remediation := "Run: " + failure.Remediation
			if styled {
				remediation = StyleDim.Render(remediation)
			}
			lines = append(lines, "   "+remediation)
		}
	}
	return lines
}

func styleRuntimeDetail(value string, styled bool) string {
	if styled {
		return StyleDim.Render(value)
	}
	return value
}

func formatServiceSummaryLines(ss []services.ServiceStatus) []string {
	var nonLSP []services.ServiceStatus
	var lspStatuses []services.ServiceStatus
	for _, service := range ss {
		if service.Type == "lsp" {
			lspStatuses = append(lspStatuses, service)
			continue
		}
		nonLSP = append(nonLSP, service)
	}
	lines := formatServiceLines(nonLSP)
	if len(lspStatuses) > 0 {
		lines = append(lines, formatLSPSummaryLine(lspStatuses))
	}
	if len(lines) == 0 {
		return []string{StyleDim.Render("  (no services)")}
	}
	return lines
}

func formatLSPSummaryLine(ss []services.ServiceStatus) string {
	running, installed, notInstalled, errors, disabled := 0, 0, 0, 0, 0
	for _, service := range ss {
		switch service.Status {
		case "running":
			running++
		case "error":
			errors++
		case "disabled":
			disabled++
		}
		switch service.Details["install_state"] {
		case "installed":
			installed++
		case "not_installed":
			notInstalled++
		}
	}
	bullet := "○"
	name := StyleDim.Render("LSP")
	if running > 0 {
		bullet = "●"
		name = StyleSuccess.Render("LSP")
	}
	parts := []string{StyleDim.Render(fmt.Sprintf("%d languages", len(ss)))}
	if running > 0 {
		parts = append(parts, StyleDim.Render(fmt.Sprintf("%d running", running)))
	}
	if installed > 0 {
		parts = append(parts, StyleDim.Render(fmt.Sprintf("%d installed", installed)))
	}
	if notInstalled > 0 {
		parts = append(parts, StyleDim.Render(fmt.Sprintf("%d not installed", notInstalled)))
	}
	if errors > 0 {
		parts = append(parts, StyleError.Render(fmt.Sprintf("%d error", errors)))
	}
	if disabled > 0 {
		parts = append(parts, StyleDim.Render(fmt.Sprintf("%d disabled", disabled)))
	}
	parts = append(parts, StyleDim.Render("detail: knowns lsp list"))
	return fmt.Sprintf("  %s %s  %s", bullet, name, strings.Join(parts, "  "))
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
		if s.Type == "embedding" {
			parts := embeddingServiceParts(s)
			if len(parts) > 0 {
				detail += "  " + strings.Join(parts, "  ")
			}
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

func embeddingServiceParts(s services.ServiceStatus) []string {
	var parts []string
	add := func(key, label string) {
		if value := s.Details[key]; value != "" {
			parts = append(parts, StyleDim.Render(label+"="+shorten(value)))
		}
	}
	add("provider", "provider")
	add("model", "model")
	add("dimensions", "dims")
	if loaded := s.Details["runtime_loaded"]; loaded != "" {
		parts = append(parts, StyleDim.Render("loaded="+loaded))
	}
	if sessions := s.Details["active_sessions"]; sessions != "" {
		parts = append(parts, StyleDim.Render("sessions="+sessions))
	}
	if consumers := s.Details["consumers"]; consumers != "" {
		parts = append(parts, StyleDim.Render(fmt.Sprintf("consumers=%d", countCommaList(consumers))))
	}
	if idle := s.Details["idle_unload_after"]; idle != "" {
		parts = append(parts, StyleDim.Render("idle="+shorten(idle)))
	}
	if queued := s.Details["queued_jobs"]; queued != "" {
		parts = append(parts, StyleDim.Render("queued="+queued))
	}
	if running := s.Details["running_jobs"]; running != "" {
		parts = append(parts, StyleDim.Render("jobs="+running))
	}
	if s.Details["degraded"] == "true" {
		parts = append(parts, StyleError.Render("degraded"))
	}
	if errMsg := s.Details["last_error"]; errMsg != "" {
		parts = append(parts, StyleError.Render("error="+shorten(errMsg)))
	} else if errMsg := s.Details["error"]; errMsg != "" {
		parts = append(parts, StyleError.Render("error="+shorten(errMsg)))
	}
	add("runtime_log", "log")
	return parts
}

func countCommaList(value string) int {
	if value == "" {
		return 0
	}
	count := 0
	for _, part := range strings.Split(value, ",") {
		if strings.TrimSpace(part) != "" {
			count++
		}
	}
	return count
}

func semanticRuntimeIdentity(entry search.SemanticRuntimeEntryInfo) string {
	if entry.ProviderIdentity != "" {
		return entry.ProviderIdentity
	}
	parts := []string{entry.Provider, entry.Model}
	if entry.Dimensions > 0 {
		parts = append(parts, fmt.Sprintf("%d", entry.Dimensions))
	}
	return strings.Join(parts, "/")
}

func formatSemanticRuntimeLines(status search.SemanticRuntimeStatus, reload runtimequeue.ReloadStatus, styled bool) []string {
	state := fmt.Sprintf("Enabled   %t", status.Enabled)
	if !status.Enabled && status.DisabledBy != "" {
		state += "  disabledBy=" + status.DisabledBy
	}
	if styled && !status.Enabled {
		state = StyleDim.Render(state)
	}
	lines := []string{state, fmt.Sprintf("Entries   %d", len(status.Entries))}
	if status.IdleTimeout > 0 {
		lines = append(lines, fmt.Sprintf("Idle      %s", status.IdleTimeout))
	}
	for _, entry := range status.Entries {
		identity := semanticRuntimeIdentity(entry)
		detail := fmt.Sprintf("Provider  %s  model=%s  dims=%d  identity=%s", entry.Provider, entry.Model, entry.Dimensions, identity)
		if !entry.Loaded {
			detail += "  loaded=false"
		}
		if entry.ActiveSessions > 0 {
			detail += fmt.Sprintf("  sessions=%d", entry.ActiveSessions)
		}
		if len(entry.StoreConsumers) > 0 {
			detail += fmt.Sprintf("  consumers=%d", len(entry.StoreConsumers))
		}
		lines = append(lines, detail)
	}
	if len(status.Entries) == 0 {
		lines = append(lines, "Provider  no loaded providers")
	}
	generation := status.ReloadGeneration
	processedAt := status.LastReloadAt
	requestID := status.ReloadRequestID
	if reload.Generation > generation {
		generation = reload.Generation
		processedAt = reload.ProcessedAt
		requestID = reload.RequestID
	}
	if generation > 0 || !processedAt.IsZero() || requestID != "" {
		reloadLine := fmt.Sprintf("Reload    generation=%d", generation)
		if !processedAt.IsZero() {
			reloadLine += "  processedAt=" + processedAt.Format(time.RFC3339)
		}
		if requestID != "" {
			reloadLine += "  requestId=" + requestID
		}
		lines = append(lines, reloadLine)
	}
	return lines
}

func formatSemanticRuntimePlainLines(status search.SemanticRuntimeStatus, reload runtimequeue.ReloadStatus) []string {
	fields := []string{
		"semantic",
		fmt.Sprintf("enabled=%t", status.Enabled),
		fmt.Sprintf("entries=%d", len(status.Entries)),
	}
	if status.DisabledBy != "" {
		fields = append(fields, "disabledBy="+status.DisabledBy)
	}
	if len(status.Entries) == 0 {
		fields = append(fields, "loaded=false")
	} else {
		entry := status.Entries[0]
		fields = append(fields,
			"provider="+entry.Provider,
			"model="+entry.Model,
			fmt.Sprintf("dimensions=%d", entry.Dimensions),
			"identity="+semanticRuntimeIdentity(entry),
			fmt.Sprintf("loaded=%t", entry.Loaded),
		)
		if entry.ActiveSessions > 0 {
			fields = append(fields, fmt.Sprintf("sessions=%d", entry.ActiveSessions))
		}
		if len(entry.StoreConsumers) > 0 {
			fields = append(fields, fmt.Sprintf("consumers=%d", len(entry.StoreConsumers)))
		}
	}
	lines := []string{strings.Join(fields, "\t")}
	generation := status.ReloadGeneration
	processedAt := status.LastReloadAt
	requestID := status.ReloadRequestID
	if reload.Generation > generation {
		generation = reload.Generation
		processedAt = reload.ProcessedAt
		requestID = reload.RequestID
	}
	if generation > 0 || !processedAt.IsZero() || requestID != "" {
		reloadFields := []string{"reload", fmt.Sprintf("generation=%d", generation)}
		if !processedAt.IsZero() {
			reloadFields = append(reloadFields, "processedAt="+processedAt.Format(time.RFC3339))
		}
		if requestID != "" {
			reloadFields = append(reloadFields, "requestId="+requestID)
		}
		lines = append(lines, strings.Join(reloadFields, "\t"))
	}
	return lines
}

func semanticReindexRemediation(readiness search.SemanticIndexReadiness) string {
	if !readiness.Enabled || readiness.OptedOut {
		return ""
	}
	if readiness.Stale || readiness.Degraded || !readiness.Ready {
		return "knowns search --reindex"
	}
	return ""
}

func formatSemanticIndexReadinessLines(readiness *search.SemanticIndexReadiness, styled bool) []string {
	if readiness == nil {
		return nil
	}
	status := "ready"
	if !readiness.Enabled || readiness.OptedOut {
		status = "keyword-only"
	} else if readiness.Stale {
		status = "stale"
	} else if readiness.Degraded || !readiness.Ready {
		status = "needs reindex"
	}
	line := fmt.Sprintf("Index     %s  backend=%s  mode=%s  chunks=%d", status, readiness.Backend, readiness.Mode, readiness.ChunkCount)
	if readiness.Model != "" {
		line += "  model=" + readiness.Model
	}
	if readiness.Dimensions > 0 {
		line += fmt.Sprintf("  dims=%d", readiness.Dimensions)
	}
	if readiness.IndexedAt != nil {
		line += "  indexedAt=" + readiness.IndexedAt.Format(time.RFC3339)
	}
	if readiness.Reason != "" {
		line += "  reason=" + readiness.Reason
	}
	lines := []string{line}
	if remediation := semanticReindexRemediation(*readiness); remediation != "" {
		warning := "Reindex   semantic index may not match current embedding identity; run: " + remediation
		if styled {
			warning = StyleWarning.Render(warning)
		}
		lines = append(lines, warning)
	}
	return lines
}

func formatSemanticIndexReadinessPlainLine(readiness search.SemanticIndexReadiness) string {
	fields := []string{
		"index",
		fmt.Sprintf("enabled=%t", readiness.Enabled),
		"backend=" + readiness.Backend,
		"mode=" + readiness.Mode,
		fmt.Sprintf("ready=%t", readiness.Ready),
		fmt.Sprintf("stale=%t", readiness.Stale),
		fmt.Sprintf("degraded=%t", readiness.Degraded),
		fmt.Sprintf("chunks=%d", readiness.ChunkCount),
	}
	if readiness.Model != "" {
		fields = append(fields, "model="+readiness.Model)
	}
	if readiness.Dimensions > 0 {
		fields = append(fields, fmt.Sprintf("dimensions=%d", readiness.Dimensions))
	}
	if readiness.ChunkVersion > 0 {
		fields = append(fields, fmt.Sprintf("chunkVersion=%d", readiness.ChunkVersion))
	}
	if readiness.IndexedAt != nil {
		fields = append(fields, "indexedAt="+readiness.IndexedAt.Format(time.RFC3339))
	}
	if readiness.Reason != "" {
		fields = append(fields, "reason="+readiness.Reason)
	}
	return strings.Join(fields, "\t")
}

func renderRuntimePsPlain(cmd *cobra.Command, status *runtimequeue.Status, snapshots []projectSnapshot, summary runtimePsSummary, opts runtimePsOptions, semantic search.SemanticRuntimeStatus, reload runtimequeue.ReloadStatus) {
	w := cmd.OutOrStdout()
	state := "running"
	if !status.Running {
		state = "stopped"
	}
	fmt.Fprintf(w, "runtime\t%s\tpid=%d\tversion=%s\n", state, status.PID, status.Version)
	for _, line := range formatSemanticRuntimePlainLines(semantic, reload) {
		fmt.Fprintln(w, line)
	}
	for _, watcher := range status.Watchers {
		state := "stopped"
		if watcher.Active {
			state = "active"
		}
		if watcher.GracePending {
			state = "grace"
		}
		fmt.Fprintf(w, "watcher\t%s\tdemand=%d\tstate=%s", filepath.Base(watcher.ProjectRoot), watcher.Demand, state)
		if watcher.GracePending && !watcher.GraceUntil.IsZero() {
			fmt.Fprintf(w, "\tuntil=%s", watcher.GraceUntil.Format(time.RFC3339))
		}
		fmt.Fprintln(w)
	}
	fmt.Fprintf(w, "activity\tclients=%d\tprojects=%d\trunning=%d\tqueued=%d\trecent=%d\tfailed=%d\n",
		summary.Clients, summary.Projects, summary.RunningJobs, summary.QueuedJobs, summary.RecentJobs, summary.FailedJobs)

	clientLimit := opts.ClientLimit
	if clientLimit > len(status.Clients) {
		clientLimit = len(status.Clients)
	}
	if clientLimit < 0 {
		clientLimit = 0
	}
	for i, lease := range status.Clients {
		if i >= clientLimit {
			if clientLimit > 0 {
				fmt.Fprintf(w, "clients-more\tcount=%d\n", len(status.Clients)-clientLimit)
			}
			break
		}
		age := time.Since(lease.UpdatedAt).Round(time.Second)
		fmt.Fprintf(w, "client\t%s\t%s\tpid=%d\tage=%s\n",
			lease.ClientKind, filepath.Base(lease.ProjectRoot), lease.PID, age)
	}

	if opts.ShowJobs {
		now := time.Now().UTC()
		if !opts.FailedOnly {
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
			}
		}
		for _, row := range recentRuntimeRows(snapshots, opts) {
			mark := "ok"
			if !row.Result.Success {
				mark = "fail"
			}
			dur := row.Result.CompletedAt.Sub(row.Result.StartedAt).Round(time.Millisecond)
			errText := ""
			if !row.Result.Success {
				errText = runtimePsErrorSummary(row.Result.Error)
			}
			fmt.Fprintf(w, "recent\t%s\t%s\t%s\t%s\t%s\t%s\n",
				row.Project, row.Result.Kind, shorten(row.Result.Target), mark, dur, errText)
		}
		return
	}

	for _, failure := range summary.Failures {
		target := failure.Target
		if target == "" {
			target = "-"
		}
		fmt.Fprintf(w, "failure\t%s\t%s\t%s\tcount=%d\tduration=%s\terror=%s\n",
			failure.Project, failure.Kind, target, failure.Count, failure.LastDuration, failure.Error)
		if failure.Remediation != "" {
			fmt.Fprintf(w, "remediation\t%s\n", failure.Remediation)
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
	watchCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	store := storage.NewStore(storeRoot)
	enqueueIndex := func(result storage.ReconcileResult) error {
		if search.ResolveSemanticIndexReadiness(store).Backend != "qdrant" {
			kind := runtimequeue.JobIndexDoc
			if result.Operation == storage.LifecycleOperationDelete || result.Operation == storage.LifecycleOperationHardDelete {
				kind = runtimequeue.JobRemoveDoc
			}
			target := strings.TrimSuffix(strings.TrimPrefix(filepath.ToSlash(result.Path), "docs/"), ".md")
			if result.EntityType == "task" {
				kind, target = runtimequeue.JobIndexTask, result.EntityID
				if result.Operation == storage.LifecycleOperationDelete || result.Operation == storage.LifecycleOperationHardDelete {
					kind = runtimequeue.JobRemoveTask
				}
			}
			_, err := runtimequeue.Enqueue(storeRoot, kind, target)
			return err
		}
		path := result.CurrentPath
		if path == "" {
			path = result.Path
		}
		_, err := runtimequeue.EnqueueQdrantIntent(storeRoot, runtimequeue.QdrantIntent{
			EntityType: result.EntityType, EntityID: result.EntityID,
			Revision: result.Revision, Operation: result.Operation,
			CanonicalHash: result.NewHash, Path: path,
			PreviousPath: result.PreviousPath, BatchID: result.BatchID,
		})
		return err
	}
	// Code and knowledge watchers share the runtime lease, but knowledge
	// events are handed to a bounded serialized reconciler worker. The
	// fsnotify goroutine never appends history or touches an index.
	reconciler, err := storage.NewFilesystemReconciler(storeRoot, enqueueIndex)
	if err != nil {
		return err
	}
	// Reconcile offline edits before opening the event stream. This makes the
	// startup boundary durable and hands off targeted indexing before fresh
	// watcher events are accepted.
	if _, err := reconciler.ReconcileLifecycleWithOptions(watchCtx, true, storage.LifecycleOptions{Source: "watcher-startup", Wait: true}); err != nil {
		return err
	}
	var hintMu sync.Mutex
	pending := make(map[string]storage.ReconcileHint)
	wake := make(chan struct{}, 1)
	resolved := make(chan []storage.ReconcileHint, 1)
	workerDone := make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-wake:
				hintMu.Lock()
				batch := make([]storage.ReconcileHint, 0, len(pending))
				for path, hint := range pending {
					batch = append(batch, hint)
					delete(pending, path)
				}
				hintMu.Unlock()
				select {
				case resolved <- batch:
				case <-watchCtx.Done():
					return
				}
			}
		}
	}()
	go func() {
		defer workers.Done()
		for {
			select {
			case <-watchCtx.Done():
				return
			case batch := <-resolved:
				if _, err := reconciler.ReconcileLifecycleBatchWithOptions(watchCtx, storage.LifecycleBatch{Source: "watcher", Hints: batch, Limit: storage.DefaultLifecycleBatchLimit}, true, true); err != nil {
					fmt.Fprintf(os.Stderr, "knowledge reconciliation error: %v\n", err)
				}
			}
		}
	}()
	go func() { workers.Wait(); close(workerDone) }()
	knowledgeErr := make(chan error, 1)
	go func() {
		knowledgeErr <- StartKnowledgeWatcher(watchCtx, storeRoot, func(batch []storage.ReconcileHint) error {
			hintMu.Lock()
			defer hintMu.Unlock()
			for _, hint := range batch {
				if len(pending) >= 4096 {
					if _, exists := pending[hint.Path]; !exists {
						return fmt.Errorf("knowledge hint queue capacity exceeded (4096); retry reconciliation")
					}
				}
				pending[hint.Path] = hint
			}
			select {
			case wake <- struct{}{}:
			default:
			}
			return nil
		})
	}()
	codeErr := make(chan error, 1)
	go func() { codeErr <- StartCodeWatcher(watchCtx, store, filepath.Dir(storeRoot), watchDebounceMs) }()
	select {
	case <-ctx.Done():
		<-workerDone
		return nil
	case err := <-knowledgeErr:
		cancel()
		<-workerDone
		return err
	case err := <-codeErr:
		cancel()
		<-workerDone
		return err
	}
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
	runtimeCmd.AddCommand(runtimeReloadCmd)
	runtimeCmd.AddCommand(runtimeStopCmd)
	runtimeCmd.AddCommand(runtimeLogsCmd)

	runtimePsCmd.Flags().BoolP("watch", "w", false, "Refresh continuously")
	runtimePsCmd.Flags().Duration("interval", 2*time.Second, "Refresh interval when --watch is set")
	runtimePsCmd.Flags().Bool("jobs", false, "Show detailed runtime job history")
	runtimePsCmd.Flags().Int("tail", 10, "Number of recent jobs to show when job details are enabled")
	runtimePsCmd.Flags().Bool("failed", false, "Show only failed recent jobs")
	runtimePsCmd.Flags().Bool("all", false, "Show all retained recent jobs")
	runtimePsCmd.Flags().Int("clients", defaultRuntimePsClientLimit, "Number of connected clients to show in compact output (0 hides client rows)")
	runtimePsCmd.Flags().Int("failures", defaultRuntimePsFailureLimit, "Number of grouped recent failures to show in compact output (0 hides failure rows)")

	runtimeReloadCmd.Flags().Bool("wait", false, "Wait until runtime acknowledges reload")
	runtimeReloadCmd.Flags().Duration("timeout", 10*time.Second, "Maximum time to wait for reload acknowledgement")

	runtimeLogsCmd.Flags().BoolP("follow", "f", false, "Follow new log lines")
	runtimeLogsCmd.Flags().IntP("tail", "n", 50, "Number of trailing lines to show")
	runtimeLogsCmd.Flags().StringP("source", "s", "all", "Which log to read: runtime|mcp|all")

	rootCmd.AddCommand(runtimeInternalCmd)
	rootCmd.AddCommand(runtimeCmd)
}
