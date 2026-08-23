package server

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
)

type fakeLSPRuntimeStatusClient struct {
	leaseStatuses   []lsp.LanguageRuntimeStatus
	runtimeStatuses []lsp.LanguageRuntimeStatus
	leaseErr        error
	leaseCalls      int
	runtimeCalls    int
}

func (c *fakeLSPRuntimeStatusClient) AcquireLease(context.Context, string, time.Duration) ([]lsp.LanguageRuntimeStatus, error) {
	c.leaseCalls++
	return c.leaseStatuses, c.leaseErr
}

func (c *fakeLSPRuntimeStatusClient) RuntimeStatuses(context.Context) ([]lsp.LanguageRuntimeStatus, error) {
	c.runtimeCalls++
	return c.runtimeStatuses, nil
}

func TestFetchLSPRuntimeStatusesReusesLeaseSnapshot(t *testing.T) {
	t.Parallel()

	leaseSnapshot := []lsp.LanguageRuntimeStatus{{ID: "csharp", RunningState: lsp.RuntimeRunningRunning}}
	client := &fakeLSPRuntimeStatusClient{
		leaseStatuses:   leaseSnapshot,
		runtimeStatuses: []lsp.LanguageRuntimeStatus{{ID: "go"}},
	}

	got, err := fetchLSPRuntimeStatuses(context.Background(), client, true)
	if err != nil {
		t.Fatalf("fetch LSP runtime statuses: %v", err)
	}
	if !reflect.DeepEqual(got, leaseSnapshot) {
		t.Fatalf("statuses = %+v, want lease snapshot %+v", got, leaseSnapshot)
	}
	if client.leaseCalls != 1 || client.runtimeCalls != 0 {
		t.Fatalf("calls = lease:%d runtime:%d, want lease:1 runtime:0", client.leaseCalls, client.runtimeCalls)
	}
}

func TestFetchLSPRuntimeStatusesFallsBackAfterLeaseFailure(t *testing.T) {
	t.Parallel()

	runtimeSnapshot := []lsp.LanguageRuntimeStatus{{ID: "typescript", RunningState: lsp.RuntimeRunningRunning}}
	client := &fakeLSPRuntimeStatusClient{
		leaseErr:        errors.New("lease unavailable"),
		runtimeStatuses: runtimeSnapshot,
	}

	got, err := fetchLSPRuntimeStatuses(context.Background(), client, true)
	if err != nil {
		t.Fatalf("fetch LSP runtime statuses: %v", err)
	}
	if !reflect.DeepEqual(got, runtimeSnapshot) {
		t.Fatalf("statuses = %+v, want runtime snapshot %+v", got, runtimeSnapshot)
	}
	if client.leaseCalls != 1 || client.runtimeCalls != 1 {
		t.Fatalf("calls = lease:%d runtime:%d, want lease:1 runtime:1", client.leaseCalls, client.runtimeCalls)
	}
}
