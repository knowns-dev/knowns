package mcp

import (
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/server"
)

func newLifecycleHooks(auditStore *storage.AuditStore, getRoot func() string) *server.Hooks {
	return newAuditHooks(auditStore, getRoot)
}
