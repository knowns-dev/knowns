package doctor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/util"
	"github.com/howznguyen/knowns/internal/validate"
)

func ProjectFromStore(store *storage.Store) ProjectInfo {
	if store == nil {
		return InactiveProject()
	}
	projectPath := filepath.Dir(store.Root)
	info := ProjectInfo{
		Active:        true,
		Name:          filepath.Base(projectPath),
		Path:          projectPath,
		KnownsVersion: util.Version,
	}
	if project, err := store.Config.Load(); err == nil && project.Name != "" {
		info.Name = project.Name
	}
	return info
}

func FoundationCheckers(store *storage.Store) []Checker {
	return []Checker{
		projectActiveChecker(store),
		projectConfigChecker(store),
		projectStorageChecker(store),
		projectMigrationChecker(store),
		validationSummaryChecker(store),
	}
}

func projectActiveChecker(store *storage.Store) Checker {
	return Checker{
		ID:    "project.active",
		Scope: ScopeProject,
		Check: func(context.Context) (CheckResult, error) {
			if store == nil {
				return CheckResult{
					Status:  StatusFail,
					Summary: "No active Knowns project",
					Evidence: Evidence{
						"active": false,
					},
					Remediation: &Remediation{
						Description: "Initialize a Knowns project in the current workspace.",
						Command:     "knowns init",
					},
				}, nil
			}
			info := ProjectFromStore(store)
			return CheckResult{
				Status:  StatusPass,
				Summary: "Active Knowns project detected",
				Evidence: Evidence{
					"active": true,
					"name":   info.Name,
					"path":   info.Path,
				},
			}, nil
		},
	}
}

func projectConfigChecker(store *storage.Store) Checker {
	return Checker{
		ID:    "project.config",
		Scope: ScopeProject,
		Check: func(context.Context) (CheckResult, error) {
			if store == nil {
				return skippedForMissingProject(), nil
			}
			configPath := filepath.Join(store.Root, "config.json")
			project, err := store.Config.Load()
			if err != nil {
				return CheckResult{
					Status:  StatusFail,
					Summary: "Project configuration is unreadable or invalid",
					Evidence: Evidence{
						"path":      configPath,
						"errorCode": "config_invalid",
					},
					Remediation: &Remediation{
						Description: "Repair .knowns/config.json or restore it from version control.",
					},
				}, nil
			}
			return CheckResult{
				Status:  StatusPass,
				Summary: "Project configuration is readable and valid",
				Evidence: Evidence{
					"path": configPath,
					"name": project.Name,
				},
			}, nil
		},
	}
}

// projectMigrationChecker reports FR-21/AC-30: a project whose committed
// config still carries a schema version behind storage.CurrentSchemaVersion()
// names `knowns migrate` as the remediation, so the command is discoverable
// from `knowns doctor` without reading release notes. It reads
// project.SchemaVersion directly (storage.NeedsMigration/PendingMigrations),
// the same fields the FR-4 per-command banner and `knowns migrate` itself
// read, so this check can never disagree with them about whether a project
// needs migration.
func projectMigrationChecker(store *storage.Store) Checker {
	return Checker{
		ID:    "project.migration",
		Scope: ScopeProject,
		Check: func(context.Context) (CheckResult, error) {
			if store == nil {
				return skippedForMissingProject(), nil
			}
			project, err := store.Config.Load()
			if err != nil {
				return CheckResult{}, err
			}
			if !storage.NeedsMigration(project) {
				return CheckResult{
					Status:  StatusPass,
					Summary: "Project configuration schema is current",
					Evidence: Evidence{
						"schemaVersion": project.SchemaVersion,
					},
				}, nil
			}
			pending := storage.PendingMigrations(project.SchemaVersion)
			return CheckResult{
				Status:  StatusWarn,
				Summary: "Project configuration needs migration",
				Evidence: Evidence{
					"schemaVersion":  project.SchemaVersion,
					"currentVersion": storage.CurrentSchemaVersion(),
					"pendingCount":   len(pending),
				},
				Remediation: &Remediation{
					Description: "Upgrade the project configuration to the current schema version. Preview with `knowns migrate`, then apply with `knowns migrate --write`.",
					Command:     "knowns migrate",
				},
			}, nil
		},
	}
}

func projectStorageChecker(store *storage.Store) Checker {
	return Checker{
		ID:    "project.storage",
		Scope: ScopeProject,
		Check: func(context.Context) (CheckResult, error) {
			if store == nil {
				return skippedForMissingProject(), nil
			}
			info, err := os.Stat(store.Root)
			if err != nil || !info.IsDir() {
				return CheckResult{
					Status:  StatusFail,
					Summary: "Knowns storage root is unavailable",
					Evidence: Evidence{
						"path":      store.Root,
						"errorCode": "storage_root_unavailable",
					},
					Remediation: &Remediation{
						Description: "Restore the .knowns directory or initialize the project again.",
						Command:     "knowns init",
					},
				}, nil
			}
			if _, err := os.ReadDir(store.Root); err != nil {
				return CheckResult{
					Status:  StatusFail,
					Summary: "Knowns storage root is not readable",
					Evidence: Evidence{
						"path":      store.Root,
						"mode":      info.Mode().Perm().String(),
						"errorCode": "storage_root_unreadable",
					},
					Remediation: &Remediation{
						Description: "Restore read permissions for the .knowns directory.",
					},
				}, nil
			}

			required := []string{"tasks", "docs", "templates"}
			missing := make([]string, 0)
			for _, name := range required {
				entry, statErr := os.Stat(filepath.Join(store.Root, name))
				if statErr != nil || !entry.IsDir() {
					missing = append(missing, name)
				}
			}
			sort.Strings(missing)
			evidence := Evidence{
				"path": store.Root,
				"mode": info.Mode().Perm().String(),
			}
			if len(missing) > 0 {
				evidence["missingPaths"] = missing
				return CheckResult{
					Status:   StatusWarn,
					Summary:  fmt.Sprintf("%d Knowns storage directories are missing", len(missing)),
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Recreate the missing Knowns storage directories.",
						Command:     "knowns init",
					},
				}, nil
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  "Knowns storage paths are readable",
				Evidence: evidence,
			}, nil
		},
	}
}

func validationSummaryChecker(store *storage.Store) Checker {
	return Checker{
		ID:    "validation.summary",
		Scope: ScopeValidation,
		Check: func(context.Context) (CheckResult, error) {
			if store == nil {
				return skippedForMissingProject(), nil
			}
			result := validate.Run(store, validate.Options{Scope: "all", Fix: false})
			evidence := Evidence{
				"errors":   result.ErrorCount,
				"warnings": result.WarningCount,
				"info":     result.InfoCount,
			}
			switch {
			case result.ErrorCount > 0:
				return CheckResult{
					Status:   StatusFail,
					Summary:  fmt.Sprintf("Validation found %d errors and %d warnings", result.ErrorCount, result.WarningCount),
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Inspect and resolve the detailed validation issues.",
						Command:     "knowns validate",
					},
				}, nil
			case result.WarningCount > 0:
				return CheckResult{
					Status:   StatusWarn,
					Summary:  fmt.Sprintf("Validation found %d warnings", result.WarningCount),
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Inspect the detailed validation warnings.",
						Command:     "knowns validate",
					},
				}, nil
			default:
				return CheckResult{
					Status:   StatusPass,
					Summary:  "Validation passed",
					Evidence: evidence,
				}, nil
			}
		},
	}
}

func skippedForMissingProject() CheckResult {
	return CheckResult{
		Status:     StatusSkip,
		Summary:    "Check requires an active project",
		SkipReason: "project_inactive",
	}
}
