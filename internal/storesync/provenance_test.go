package storesync

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestStaleWriteAfterSyncExplainsItselfAndRecoveryWorks(t *testing.T) {
	_, a, b := twoMachines(t, "shop-web")
	ctx := context.Background()
	storeA := storage.NewStore(filepath.Join(a.clone(), "shop-web"))
	storeB := storage.NewStore(filepath.Join(b.clone(), "shop-web"))
	for _, s := range []*storage.Store{storeA, storeB} {
		if err := s.Init("shop-web"); err != nil {
			t.Fatal(err)
		}
	}
	if err := storeA.MutateDocWithHistory(ctx, nil, &models.Doc{Path: "arch", Title: "Architecture", Content: "v1"}, storage.DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)
	b.tickAfter(31 * time.Second)

	stale, err := storeB.Docs.Get("arch") // B's agent reads v1
	if err != nil {
		t.Fatal(err)
	}
	cur, _ := storeA.Docs.Get("arch")
	next := *cur
	next.Content = "v2 from A"
	if err := storeA.MutateDocWithHistory(ctx, cur, &next, storage.DocMutationOptions{ExpectedHash: storage.CanonicalDocHash(cur)}); err != nil {
		t.Fatal(err)
	}
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)
	b.tickAfter(31 * time.Second) // v2 arrives on B

	mine := *stale
	mine.Content = "B's edit based on v1"
	err = storeB.MutateDocWithHistory(ctx, stale, &mine, storage.DocMutationOptions{ExpectedHash: storage.CanonicalDocHash(stale)})
	var explained *storage.SyncConflictError
	if !errors.As(err, &explained) {
		t.Fatalf("expected a sync-explained conflict, got %v", err)
	}
	msg := err.Error()
	for _, want := range []string{"a@example.com", "store sync", b.clock.UTC().Format("2006-01-02"), "Reread"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message must name %q: %s", want, msg)
		}
	}
	for _, banned := range []string{"force", "overwrite"} {
		if strings.Contains(strings.ToLower(msg), banned) {
			t.Fatalf("message must not suggest %q: %s", banned, msg)
		}
	}
	var conflict *storage.MutationConflictError
	if !errors.As(err, &conflict) || !errors.Is(err, storage.ErrHistoryConflict) {
		t.Fatal("the explained error must still be a history conflict for existing callers")
	}

	// AC-21: following only the message text succeeds on the next attempt.
	fresh, err := storeB.Docs.Get("arch")
	if err != nil {
		t.Fatal(err)
	}
	retry := *fresh
	retry.Content = fresh.Content + "\n\nB's edit"
	if err := storeB.MutateDocWithHistory(ctx, fresh, &retry, storage.DocMutationOptions{ExpectedHash: storage.CanonicalDocHash(fresh)}); err != nil {
		t.Fatalf("rereading and reapplying must succeed: %v", err)
	}

	// Once changed locally, a later stale write is an ordinary conflict.
	err = storeB.MutateDocWithHistory(ctx, fresh, &retry, storage.DocMutationOptions{ExpectedHash: storage.CanonicalDocHash(fresh)})
	if errors.As(err, &explained) {
		t.Fatalf("a conflict against a local write must not be blamed on sync: %v", err)
	}
}
