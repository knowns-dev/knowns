package mcp

import (
	"context"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/server"
)

func newLifecycleHooks(auditStore *storage.AuditStore, getRoot func() string, getLSPManager func() *lsp.Manager, getStore func() *storage.Store) *server.Hooks {
	hooks := newAuditHooks(auditStore, getRoot)
	hooks.AddOnRegisterSession(func(ctx context.Context, session server.ClientSession) {
		mgr := getLSPManager()
		if mgr == nil {
			return
		}
		startCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := mgr.ClientConnected(startCtx); err != nil {
			mcpLog.Printf("lsp start skipped: %v", err)
			return
		}

		// Persist detected languages to config
		store := getStore()
		if store == nil {
			return
		}
		active := mgr.ActiveLanguages()
		if len(active) == 0 {
			return
		}
		project, err := store.Config.Load()
		if err != nil {
			return
		}
		if project.Settings.LSP == nil {
			enabled := true
			project.Settings.LSP = &models.LSPSettings{Enabled: &enabled, Languages: map[string]models.LSPLanguageSettings{}}
		}
		if project.Settings.LSP.Languages == nil {
			project.Settings.LSP.Languages = map[string]models.LSPLanguageSettings{}
		}
		changed := false
		enabled := true
		for _, lang := range active {
			if _, exists := project.Settings.LSP.Languages[lang]; !exists {
				project.Settings.LSP.Languages[lang] = models.LSPLanguageSettings{Enabled: &enabled}
				changed = true
			}
		}
		if changed {
			enabledLSP := true
			project.Settings.LSP.Enabled = &enabledLSP
			_ = store.Config.Save(project)
		}
	})
	hooks.AddOnUnregisterSession(func(ctx context.Context, session server.ClientSession) {
		mgr := getLSPManager()
		if mgr == nil {
			return
		}
		stopCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := mgr.ClientDisconnected(stopCtx); err != nil {
			mcpLog.Printf("lsp stop skipped: %v", err)
		}
	})
	return hooks
}
