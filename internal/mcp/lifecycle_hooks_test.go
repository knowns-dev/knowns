package mcp

import "testing"

func TestLifecycleHooksDoNotRegisterLSPStartupHooks(t *testing.T) {
	hooks := newLifecycleHooks(nil, func() string { return "" })
	if hooks == nil {
		t.Fatal("hooks = nil")
	}
	if len(hooks.OnRegisterSession) != 0 {
		t.Fatalf("register session hooks = %d, want 0", len(hooks.OnRegisterSession))
	}
	if len(hooks.OnUnregisterSession) != 0 {
		t.Fatalf("unregister session hooks = %d, want 0", len(hooks.OnUnregisterSession))
	}
}
