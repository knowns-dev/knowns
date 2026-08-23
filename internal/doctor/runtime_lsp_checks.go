package doctor

import (
	"context"
	"fmt"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func runtimeCheckers(store *storage.Store, snapshot *serviceSnapshot) []Checker {
	return []Checker{{
		ID:      "runtime.managed-services",
		Scope:   ScopeRuntime,
		Timeout: 5 * defaultCheckTimeout,
		Check: func(context.Context) (CheckResult, error) {
			if store == nil {
				return skippedForMissingProject(), nil
			}
			// Knowns manages no runtime service of its own any more. The
			// snapshot is still read so a failing service probe surfaces as a
			// checker error instead of a silent skip.
			if _, err := snapshot.get(); err != nil {
				return CheckResult{}, err
			}
			return CheckResult{
				Status:     StatusSkip,
				Summary:    "No configured managed runtime services",
				SkipReason: "not_configured",
			}, nil
		},
	}}
}

func lspCheckers(store *storage.Store, project *projectSnapshot, snapshot *lspSnapshot, ids []string) []Checker {
	checkers := make([]Checker, 0, len(ids))
	for _, id := range ids {
		languageID := id
		checkers = append(checkers, Checker{
			ID:      "lsp." + languageID,
			Scope:   ScopeLSP,
			Timeout: 5 * defaultCheckTimeout,
			Check: func(ctx context.Context) (CheckResult, error) {
				if store == nil {
					return skippedForMissingProject(), nil
				}
				cfg, err := project.get()
				if err != nil {
					return CheckResult{}, err
				}
				if cfg.Settings.LSP != nil && cfg.Settings.LSP.Enabled != nil && !*cfg.Settings.LSP.Enabled {
					return CheckResult{
						Status:     StatusSkip,
						Summary:    "LSP is disabled",
						SkipReason: "config_disabled",
					}, nil
				}
				statuses, err := snapshot.get(ctx)
				if err != nil {
					return CheckResult{}, err
				}
				status, ok := findLSPStatus(statuses, languageID)
				if !ok {
					return CheckResult{
						Status:     StatusSkip,
						Summary:    "Language is not applicable",
						SkipReason: "not_detected",
					}, nil
				}
				explicit := languageExplicitlyConfigured(cfg, languageID)
				if !status.Enabled {
					return CheckResult{
						Status:     StatusSkip,
						Summary:    fmt.Sprintf("%s LSP is disabled", status.Name),
						Evidence:   lspEvidence(status),
						SkipReason: "config_disabled",
					}, nil
				}
				if !status.Detected && !explicit {
					return CheckResult{
						Status:     StatusSkip,
						Summary:    fmt.Sprintf("%s is not detected in this project", status.Name),
						Evidence:   lspEvidence(status),
						SkipReason: "not_detected",
					}, nil
				}
				if status.InstallState == lsp.RuntimeInstallNotInstalled || status.InstallState == lsp.RuntimeInstallError {
					command := status.InstallCmd
					if command == "" {
						command = "knowns lsp install " + languageID
					}
					return CheckResult{
						Status:   StatusWarn,
						Summary:  fmt.Sprintf("%s language server is unavailable", status.Name),
						Evidence: lspEvidence(status),
						Remediation: &Remediation{
							Description: fmt.Sprintf("Install or repair the %s language server.", status.Name),
							Command:     command,
						},
					}, nil
				}
				if status.RunningState == lsp.RuntimeRunningCrashed || len(status.MissingCapabilities) > 0 {
					return CheckResult{
						Status:   StatusWarn,
						Summary:  fmt.Sprintf("%s language server is degraded", status.Name),
						Evidence: lspEvidence(status),
						Remediation: &Remediation{
							Description: "Inspect the language-server status and repair the reported capability gap.",
							Command:     "knowns lsp list",
						},
					}, nil
				}
				return CheckResult{
					Status:   StatusPass,
					Summary:  fmt.Sprintf("%s language server is available", status.Name),
					Evidence: lspEvidence(status),
				}, nil
			},
		})
	}
	return checkers
}

func findLSPStatus(statuses []lsp.LanguageRuntimeStatus, id string) (lsp.LanguageRuntimeStatus, bool) {
	for _, status := range statuses {
		if status.ID == id {
			return status, true
		}
	}
	return lsp.LanguageRuntimeStatus{}, false
}

func languageExplicitlyConfigured(project *models.Project, id string) bool {
	if project == nil || project.Settings.LSP == nil {
		return false
	}
	_, ok := project.Settings.LSP.Languages[id]
	return ok
}

func lspEvidence(status lsp.LanguageRuntimeStatus) Evidence {
	evidence := Evidence{
		"language":       status.ID,
		"enabled":        status.Enabled,
		"detected":       status.Detected,
		"installState":   status.InstallState,
		"runningState":   status.RunningState,
		"readinessState": status.ReadinessState,
	}
	if status.Backend != "" {
		evidence["backend"] = status.Backend
	}
	if status.Version != "" {
		evidence["version"] = status.Version
	}
	if status.Source != "" {
		evidence["source"] = status.Source
	}
	if len(status.MissingCapabilities) > 0 {
		evidence["missingCapabilities"] = append([]string(nil), status.MissingCapabilities...)
	}
	if status.DaemonState != "" {
		evidence["daemonState"] = status.DaemonState
	}
	if status.Owner != "" {
		evidence["owner"] = status.Owner
	}
	if status.DaemonPID > 0 {
		evidence["daemonPid"] = status.DaemonPID
	}
	if len(status.Capabilities) > 0 {
		evidence["capabilities"] = append([]string(nil), status.Capabilities...)
	}
	return evidence
}
