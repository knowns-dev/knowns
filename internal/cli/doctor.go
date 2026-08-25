package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/doctor"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

type doctorCommandDependencies struct {
	findStore func() (*storage.Store, error)
	checkers  func(*storage.Store) []doctor.Checker
	run       func(context.Context, doctor.RunOptions, []doctor.Checker) (doctor.Result, error)
}

func defaultDoctorCommandDependencies() doctorCommandDependencies {
	return doctorCommandDependencies{
		findStore: findDoctorStore,
		checkers: func(store *storage.Store) []doctor.Checker {
			checkers := doctor.FoundationCheckers(store)
			if store != nil {
				checkers = append(checkers, doctor.LocalCheckers(store)...)
			}
			return append(checkers, doctor.NetworkCheckers(store)...)
		},
		run: doctor.Run,
	}
}

func newDoctorCmd(deps doctorCommandDependencies) *cobra.Command {
	defaults := defaultDoctorCommandDependencies()
	if deps.findStore == nil {
		deps.findStore = defaults.findStore
	}
	if deps.checkers == nil {
		deps.checkers = defaults.checkers
	}
	if deps.run == nil {
		deps.run = defaults.run
	}

	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "Diagnose project and local integration health",
		Long: `Run read-only diagnostics for the active Knowns project.

Every applicable check runs, including bounded probes of the configured
embedding provider. Use --scope to select diagnostic areas and --verbose to
show passing and skipped checks.`,
		Args: func(cmd *cobra.Command, args []string) error {
			if err := cobra.NoArgs(cmd, args); err != nil {
				return doctorEngineError(err)
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runDoctor(cmd, deps)
		},
	}
	cmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return doctorEngineError(err)
	})
	cmd.Flags().Bool("verbose", false, "Show passing and skipped checks")
	cmd.Flags().Bool("strict", false, "Return exit code 1 when the verdict is degraded")
	cmd.Flags().StringSlice("scope", nil, "Diagnostic scope (repeatable or comma-separated)")
	return cmd
}

func runDoctor(cmd *cobra.Command, deps doctorCommandDependencies) error {
	scopeValues, err := cmd.Flags().GetStringSlice("scope")
	if err != nil {
		return doctorEngineError(err)
	}
	scopes, err := parseDoctorScopes(scopeValues)
	if err != nil {
		return doctorEngineError(err)
	}

	store, err := deps.findStore()
	if err != nil {
		return doctorEngineError(fmt.Errorf("initialize doctor: %w", err))
	}
	strict, _ := cmd.Flags().GetBool("strict")
	result, err := deps.run(cmd.Context(), doctor.RunOptions{
		Project: doctor.ProjectFromStore(store),
		Scopes:  scopes,
		Strict:  strict,
	}, deps.checkers(store))
	if err != nil {
		return doctorEngineError(fmt.Errorf("run doctor: %w", err))
	}

	verbose, _ := cmd.Flags().GetBool("verbose")
	switch {
	case isJSON(cmd):
		err = renderDoctorJSON(cmd.OutOrStdout(), result)
	case isPlain(cmd):
		renderDoctorPlain(cmd.OutOrStdout(), result, verbose)
	default:
		renderDoctorStyled(cmd.OutOrStdout(), result, verbose)
	}
	if err != nil {
		return doctorEngineError(fmt.Errorf("render doctor result: %w", err))
	}

	if code := result.ExitCode(); code != 0 {
		// A valid diagnostic result has already been rendered. Suppress Cobra's
		// generic error and usage text so JSON/plain output stays machine-safe.
		cmd.SilenceErrors = true
		cmd.SilenceUsage = true
		return &commandExitError{code: code}
	}
	return nil
}

func doctorEngineError(err error) error {
	return &commandExitError{code: 2, err: err}
}

func findDoctorStore() (*storage.Store, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	root, err := storage.FindProjectRoot(cwd)
	if err != nil {
		return nil, nil
	}
	return storage.NewStore(root), nil
}

func parseDoctorScopes(values []string) ([]doctor.Scope, error) {
	if len(values) == 0 {
		return nil, nil
	}
	seen := make(map[doctor.Scope]bool)
	scopes := make([]doctor.Scope, 0, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			scope := doctor.Scope(strings.TrimSpace(part))
			if scope == "" {
				continue
			}
			if !scope.Valid() {
				return nil, fmt.Errorf("unknown doctor scope %q", scope)
			}
			if !seen[scope] {
				seen[scope] = true
				scopes = append(scopes, scope)
			}
		}
	}
	return scopes, nil
}

func renderDoctorJSON(w io.Writer, result doctor.Result) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func renderDoctorPlain(w io.Writer, result doctor.Result, verbose bool) {
	fmt.Fprintln(w, "Knowns Doctor")
	renderDoctorIdentity(w, result)
	fmt.Fprintf(w, "Verdict: %s\n", strings.ToUpper(string(result.Verdict)))
	fmt.Fprintf(w, "Summary: %d pass, %d warn, %d fail, %d skip\n",
		result.Summary.Pass, result.Summary.Warn, result.Summary.Fail, result.Summary.Skip)
	renderDoctorChecks(w, result.Checks, verbose, false)
}

func renderDoctorStyled(w io.Writer, result doctor.Result, verbose bool) {
	fmt.Fprintln(w, StyleBold.Render("Knowns Doctor"))
	if result.Project.Active {
		fmt.Fprintf(w, "%s %s\n", StyleDim.Render("Project:"),
			StyleInfo.Render(fmt.Sprintf("%s (%s)", result.Project.Name, result.Project.Path)))
	} else {
		fmt.Fprintf(w, "%s %s\n", StyleDim.Render("Project:"), StyleWarning.Render("no active project"))
	}
	fmt.Fprintf(w, "%s %s\n", StyleDim.Render("Version:"), result.Project.KnownsVersion)
	fmt.Fprintf(w, "%s %s\n", StyleDim.Render("Verdict:"), styledDoctorVerdict(result.Verdict))
	fmt.Fprintf(w, "%s %d pass, %d warn, %d fail, %d skip\n",
		StyleDim.Render("Summary:"), result.Summary.Pass, result.Summary.Warn,
		result.Summary.Fail, result.Summary.Skip)
	renderDoctorChecks(w, result.Checks, verbose, true)
}

func renderDoctorIdentity(w io.Writer, result doctor.Result) {
	if result.Project.Active {
		fmt.Fprintf(w, "Project: %s (%s)\n", result.Project.Name, result.Project.Path)
	} else {
		fmt.Fprintln(w, "Project: no active project")
	}
	fmt.Fprintf(w, "Version: %s\n", result.Project.KnownsVersion)
}

func renderDoctorChecks(w io.Writer, checks []doctor.CheckResult, verbose, styled bool) {
	visible := make([]doctor.CheckResult, 0, len(checks))
	for _, check := range checks {
		if verbose || check.Status == doctor.StatusWarn || check.Status == doctor.StatusFail {
			visible = append(visible, check)
		}
	}
	if len(visible) == 0 {
		return
	}

	fmt.Fprintln(w)
	if styled {
		fmt.Fprintln(w, StyleBold.Render("Checks"))
	} else {
		fmt.Fprintln(w, "Checks:")
	}
	for _, check := range visible {
		status := strings.ToUpper(string(check.Status))
		if styled {
			status = styledDoctorStatus(check.Status)
		}
		fmt.Fprintf(w, "  %s [%s] %s\n", status, check.ID, check.Summary)
		// A reason is the check explaining, in its own words, why it reached
		// this verdict. Burying it behind --verbose leaves the default output
		// stating a problem without ever saying what it is.
		if reason, ok := check.Evidence["reason"].(string); ok && strings.TrimSpace(reason) != "" {
			fmt.Fprintf(w, "    Reason: %s\n", reason)
		}
		if verbose && len(check.Evidence) > 0 {
			fmt.Fprintf(w, "    Evidence: %s\n", formatDoctorEvidence(check.Evidence))
		}
		if check.SkipReason != "" {
			fmt.Fprintf(w, "    Skip reason: %s\n", check.SkipReason)
		}
		if check.Remediation != nil {
			fmt.Fprintf(w, "    Remediation: %s\n", check.Remediation.Description)
			if check.Remediation.Command != "" {
				fmt.Fprintf(w, "    Run: %s\n", check.Remediation.Command)
			}
		}
	}
}

func styledDoctorVerdict(verdict doctor.Verdict) string {
	switch verdict {
	case doctor.VerdictHealthy:
		return StyleSuccess.Render(strings.ToUpper(string(verdict)))
	case doctor.VerdictDegraded:
		return StyleWarning.Render(strings.ToUpper(string(verdict)))
	default:
		return StyleError.Render(strings.ToUpper(string(verdict)))
	}
}

func styledDoctorStatus(status doctor.Status) string {
	label := strings.ToUpper(string(status))
	switch status {
	case doctor.StatusPass:
		return StyleSuccess.Render(label)
	case doctor.StatusWarn:
		return StyleWarning.Render(label)
	case doctor.StatusFail:
		return StyleError.Render(label)
	default:
		return StyleDim.Render(label)
	}
}

func formatDoctorEvidence(evidence doctor.Evidence) string {
	keys := make([]string, 0, len(evidence))
	for key := range evidence {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		value, err := json.Marshal(evidence[key])
		if err != nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%s", key, value))
	}
	return strings.Join(parts, ", ")
}

var doctorCmd = newDoctorCmd(doctorCommandDependencies{})

func init() {
	rootCmd.AddCommand(doctorCmd)
}
