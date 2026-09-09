package permissions

import (
	"testing"
)

func TestProjectSet_AllowedWhenStoreUninitialized(t *testing.T) {
	// When store is not yet initialized, project.set is a bootstrap action
	// and must be allowed.
	storeInitialized := false
	mw := NewGuardMiddleware(
		func() *PermissionConfig { return nil },
		func() bool { return storeInitialized },
	)

	result, err := callTool(mw, "project", "set", map[string]any{"path": "/tmp/test-project"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Errorf("expected project.set to be allowed before store initialization, got error")
	}
}

func TestProjectSet_BlockedWhenStoreInitialized(t *testing.T) {
	// When store is already initialized, project.set is NOT exempt from the
	// permission guard, and must be blocked under default policy (admin capability).
	storeInitialized := true
	mw := NewGuardMiddleware(
		func() *PermissionConfig { return nil },
		func() bool { return storeInitialized },
	)

	result, err := callTool(mw, "project", "set", map[string]any{"path": "/tmp/attacker-project"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected project.set to be blocked once store is initialized, but got success")
	}

	denial := parseDenial(t, result)
	if denial == nil {
		t.Fatal("expected structured denial payload")
	}
	if denial.Capability != CapAdmin {
		t.Errorf("expected capability=%s, got %s", CapAdmin, denial.Capability)
	}
}

func TestProjectStatus_AlwaysAllowed(t *testing.T) {
	// Read-only project inspection actions remain allowed even when store is initialized.
	storeInitialized := true
	mw := NewGuardMiddleware(
		func() *PermissionConfig { return nil },
		func() bool { return storeInitialized },
	)

	for _, action := range []string{"current", "status", "detect"} {
		result, err := callTool(mw, "project", action, map[string]any{})
		if err != nil {
			t.Fatalf("action %s: unexpected error: %v", action, err)
		}
		if result.IsError {
			t.Errorf("action %s: expected to be allowed, got error", action)
		}
	}
}
