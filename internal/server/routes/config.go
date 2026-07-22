package routes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/agents/opencode"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// ConfigRoutes handles /api/config endpoints.
type ConfigRoutes struct {
	store        *storage.Store
	mgr          *storage.Manager
	capabilities TaskRouteCapabilities
}

func (cr *ConfigRoutes) getStore() *storage.Store {
	if cr.mgr != nil {
		return cr.mgr.GetStore()
	}
	return cr.store
}

// Register wires the config routes onto r.
func (cr *ConfigRoutes) Register(r chi.Router) {
	r.Get("/config", cr.get)
	r.Post("/config", cr.save)
	r.Patch("/config", cr.save)
}

// get returns the full project configuration.
//
// GET /api/config
func (cr *ConfigRoutes) get(w http.ResponseWriter, r *http.Request) {
	project, err := cr.getStore().Config.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, cr.configResponse(project))
}

func (cr *ConfigRoutes) configResponse(project *models.Project) map[string]interface{} {
	// The UI expects a flat config: { name, id, statuses, statusColors, ... }.
	// Flatten settings into the top-level object and always expose effective
	// lifecycle policy plus trusted read-only capabilities.
	flat := map[string]interface{}{
		"name":          project.Name,
		"id":            project.ID,
		"createdAt":     project.CreatedAt,
		"taskLifecycle": project.Settings.EffectiveTaskLifecycle(),
		"capabilities": map[string]bool{
			"taskHardDelete": cr.capabilities.HardDelete,
		},
	}
	s := project.Settings
	if s.DefaultAssignee != "" {
		flat["defaultAssignee"] = s.DefaultAssignee
	}
	if s.DefaultPriority != "" {
		flat["defaultPriority"] = s.DefaultPriority
	}
	if s.DefaultLabels != nil {
		flat["defaultLabels"] = s.DefaultLabels
	}
	if s.TimeFormat != "" {
		flat["timeFormat"] = s.TimeFormat
	}
	if len(s.Statuses) > 0 {
		flat["statuses"] = s.Statuses
	}
	if s.StatusColors != nil {
		flat["statusColors"] = s.StatusColors
	}
	if s.VisibleColumns != nil {
		flat["visibleColumns"] = s.VisibleColumns
	}
	if s.ServerPort != 0 {
		flat["serverPort"] = s.ServerPort
	}
	if s.OpenCodeServerConfig != nil {
		flat["opencodeServer"] = s.OpenCodeServerConfig
	}
	// opencodeModels: project-level overrides user-level.
	// If the project has no opencodeModels, fall back to user-level preferences.
	if s.OpenCodeModels != nil {
		flat["opencodeModels"] = s.OpenCodeModels
	} else {
		userPrefs := storage.NewUserPrefsStore()
		if up, err := userPrefs.Load(); err == nil && up.OpenCodeModels != nil {
			flat["opencodeModels"] = up.OpenCodeModels
		}
	}
	if s.Platforms != nil {
		flat["platforms"] = s.Platforms
	}
	if s.EnableChatUI != nil {
		flat["enableChatUI"] = *s.EnableChatUI
	}
	flat["opencodeInstalled"] = opencode.DetectOpenCode().Installed
	if s.RuntimeMemory != nil {
		flat["runtimeMemory"] = s.RuntimeMemory
	}
	if s.SemanticSearch != nil {
		flat["semanticSearch"] = s.SemanticSearch
	}
	if s.LSP != nil {
		flat["lsp"] = s.LSP
	}
	if s.CodeIntelligenceIgnore != nil {
		flat["codeIntelligenceIgnore"] = s.CodeIntelligenceIgnore
	}
	if s.GitTrackingMode != "" {
		flat["gitTrackingMode"] = s.GitTrackingMode
	}
	if s.Editor != "" {
		flat["editor"] = s.Editor
	}

	return map[string]interface{}{
		"config": flat,
	}
}

// save writes new project settings.
//
// POST /api/config
func (cr *ConfigRoutes) save(w http.ResponseWriter, r *http.Request) {
	project, err := cr.getStore().Config.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "load config: "+err.Error())
		return
	}

	var payload map[string]json.RawMessage
	if err := decodeJSON(r, &payload); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if err := applyProjectConfigUpdate(project, payload); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if err := project.Settings.Validate(); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if err := cr.getStore().Config.Save(project); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if r.Method == http.MethodPost {
		// POST is the legacy full-config save API. Preserve its exact response
		// contract for existing clients; PATCH owns the new effective envelope.
		respondJSON(w, http.StatusOK, project)
		return
	}
	respondJSON(w, http.StatusOK, cr.configResponse(project))
}

func applyProjectConfigUpdate(project *models.Project, payload map[string]json.RawMessage) error {
	if raw, ok := payload["name"]; ok {
		if err := json.Unmarshal(raw, &project.Name); err != nil {
			return err
		}
	}
	if raw, ok := payload["settings"]; ok {
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(raw, &nested); err != nil {
			return err
		}
		if err := applySettingsUpdate(&project.Settings, nested); err != nil {
			return err
		}
	}
	return applySettingsUpdate(&project.Settings, payload)
}

func applySettingsUpdate(settings *models.ProjectSettings, payload map[string]json.RawMessage) error {
	if raw, ok := payload["taskLifecycle"]; ok {
		if err := applyTaskLifecycleSettingsUpdate(settings, raw); err != nil {
			return err
		}
	}
	if raw, ok := payload["defaultAssignee"]; ok {
		if err := json.Unmarshal(raw, &settings.DefaultAssignee); err != nil {
			return err
		}
	}
	if raw, ok := payload["defaultPriority"]; ok {
		if err := json.Unmarshal(raw, &settings.DefaultPriority); err != nil {
			return err
		}
	}
	if raw, ok := payload["defaultLabels"]; ok {
		if err := json.Unmarshal(raw, &settings.DefaultLabels); err != nil {
			return err
		}
	}
	if raw, ok := payload["timeFormat"]; ok {
		if err := json.Unmarshal(raw, &settings.TimeFormat); err != nil {
			return err
		}
	}
	if raw, ok := payload["gitTrackingMode"]; ok {
		if err := json.Unmarshal(raw, &settings.GitTrackingMode); err != nil {
			return err
		}
	}
	if raw, ok := payload["statuses"]; ok {
		if err := json.Unmarshal(raw, &settings.Statuses); err != nil {
			return err
		}
	}
	if raw, ok := payload["statusColors"]; ok {
		if err := json.Unmarshal(raw, &settings.StatusColors); err != nil {
			return err
		}
	}
	if raw, ok := payload["visibleColumns"]; ok {
		if err := json.Unmarshal(raw, &settings.VisibleColumns); err != nil {
			return err
		}
	}
	if raw, ok := payload["serverPort"]; ok {
		if err := json.Unmarshal(raw, &settings.ServerPort); err != nil {
			return err
		}
	}
	if raw, ok := payload["semanticSearch"]; ok {
		if string(raw) == "null" {
			settings.SemanticSearch = nil
		} else {
			cfg := new(models.SemanticSearchSettings)
			if err := json.Unmarshal(raw, cfg); err != nil {
				return err
			}
			settings.SemanticSearch = cfg
		}
	}
	if raw, ok := payload["opencodeServer"]; ok {
		if string(raw) == "null" {
			settings.OpenCodeServerConfig = nil
		} else {
			cfg := new(models.OpenCodeServerConfig)
			if err := json.Unmarshal(raw, cfg); err != nil {
				return err
			}
			settings.OpenCodeServerConfig = cfg
		}
	}
	if raw, ok := payload["opencodeModels"]; ok {
		if string(raw) == "null" {
			settings.OpenCodeModels = nil
		} else {
			cfg := new(models.OpenCodeModelSettings)
			if err := json.Unmarshal(raw, cfg); err != nil {
				return err
			}
			settings.OpenCodeModels = cfg
		}
	}
	if raw, ok := payload["runtimeMemory"]; ok {
		if string(raw) == "null" {
			settings.RuntimeMemory = nil
		} else {
			cfg := new(models.RuntimeMemorySettings)
			if err := json.Unmarshal(raw, cfg); err != nil {
				return err
			}
			settings.RuntimeMemory = cfg
		}
	}
	if raw, ok := payload["lsp"]; ok {
		if string(raw) == "null" {
			settings.LSP = nil
		} else {
			cfg := new(models.LSPSettings)
			if err := json.Unmarshal(raw, cfg); err != nil {
				return err
			}
			settings.LSP = cfg
		}
	}
	if raw, ok := payload["codeIntelligenceIgnore"]; ok {
		if err := json.Unmarshal(raw, &settings.CodeIntelligenceIgnore); err != nil {
			return err
		}
	}
	if raw, ok := payload["editor"]; ok {
		if err := json.Unmarshal(raw, &settings.Editor); err != nil {
			return err
		}
	}
	if raw, ok := payload["enableChatUI"]; ok {
		var v bool
		if err := json.Unmarshal(raw, &v); err != nil {
			return err
		}
		settings.EnableChatUI = &v
	}
	return nil
}

func applyTaskLifecycleSettingsUpdate(settings *models.ProjectSettings, raw json.RawMessage) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("settings.taskLifecycle: must be an object")
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("settings.taskLifecycle: %w", err)
	}
	if payload == nil {
		return fmt.Errorf("settings.taskLifecycle: must be an object")
	}

	effective := settings.EffectiveTaskLifecycle()
	for field, value := range payload {
		switch field {
		case "excludeDoneFromDefaultRetrieval":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return fmt.Errorf("settings.taskLifecycle.%s: must be a boolean", field)
			}
			if err := json.Unmarshal(value, &effective.ExcludeDoneFromDefaultRetrieval); err != nil {
				return fmt.Errorf("settings.taskLifecycle.%s: %w", field, err)
			}
		case "autoArchive":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return fmt.Errorf("settings.taskLifecycle.%s: must be a boolean", field)
			}
			if err := json.Unmarshal(value, &effective.AutoArchive); err != nil {
				return fmt.Errorf("settings.taskLifecycle.%s: %w", field, err)
			}
		case "archiveAfter":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return fmt.Errorf("settings.taskLifecycle.%s: must be a duration string", field)
			}
			if err := json.Unmarshal(value, &effective.ArchiveAfter); err != nil {
				return fmt.Errorf("settings.taskLifecycle.%s: %w", field, err)
			}
		case "purgeAfter":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				effective.PurgeAfter = nil
				continue
			}
			var purgeAfter string
			if err := json.Unmarshal(value, &purgeAfter); err != nil {
				return fmt.Errorf("settings.taskLifecycle.%s: %w", field, err)
			}
			effective.PurgeAfter = &purgeAfter
		default:
			return fmt.Errorf("settings.taskLifecycle.%s: unknown field", field)
		}
	}

	candidate := *settings
	candidate.TaskLifecycle = &effective
	if err := candidate.Validate(); err != nil {
		return err
	}
	settings.TaskLifecycle = &effective
	return nil
}
