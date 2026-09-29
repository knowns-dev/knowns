package storesync

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// A fetch that rewrites a Doc while many local mutations of that Doc run must
// never tear it: every mutation succeeds completely or fails with a conflict,
// and the Doc parses after every operation (AC-19, AC-28).
func TestFetchRewritingADocNeverTearsLocalMutations(t *testing.T) {
	requireGit(t)
	isolateGit(t)
	remote := bareRemote(t)
	m := newMachine(t, "b")
	m.link(remote, "shop-web")
	folder := filepath.Join(m.clone(), "shop-web")
	store := storage.NewStore(folder)
	if err := store.Init("shop-web"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.MutateDocWithHistory(ctx, nil, &models.Doc{Path: "shared", Title: "Shared", Content: "version upstream-a"}, storage.DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	git(t, m.clone(), "add", "-A")
	git(t, m.clone(), "commit", "--quiet", "-m", "a")
	revA := trim(git(t, m.clone(), "rev-parse", "HEAD"))
	cur, _ := store.Docs.Get("shared")
	next := *cur
	next.Content = "version upstream-b"
	if err := store.MutateDocWithHistory(ctx, cur, &next, storage.DocMutationOptions{ExpectedHash: storage.CanonicalDocHash(cur)}); err != nil {
		t.Fatal(err)
	}
	git(t, m.clone(), "commit", "--quiet", "-am", "b")
	revB := trim(git(t, m.clone(), "rev-parse", "HEAD"))

	const writers, perWriter = 8, 125 // 1000 local mutations
	var succeeded, conflicted atomic.Int64
	var failures []string
	var failMu sync.Mutex
	fail := func(format string, args ...any) {
		failMu.Lock()
		failures = append(failures, fmt.Sprintf(format, args...))
		failMu.Unlock()
	}
	parsesUnderLock := func() {
		_ = store.WithSyncLocks(ctx, []string{"docs/shared.md"}, func() error {
			if _, err := store.Docs.Get("shared"); err != nil {
				fail("doc does not parse after an operation: %v", err)
			}
			return nil
		})
	}

	done := make(chan struct{})
	var fetcher sync.WaitGroup
	fetcher.Add(1)
	go func() { // the sync rewriting the file, under the same locks
		defer fetcher.Done()
		svc := m.svc
		for i := 0; ; i++ {
			select {
			case <-done:
				return
			default:
			}
			rev := revA
			if i%2 == 1 {
				rev = revB
			}
			err := svc.withEntityLocks(ctx, m.clone(), []string{"shop-web/docs/shared.md"}, func() error {
				_, err := Git(ctx, m.clone(), 0, nil, "checkout", rev, "--", "shop-web/docs/shared.md")
				return err
			})
			if err != nil {
				fail("fetch rewrite: %v", err)
			}
			parsesUnderLock()
		}
	}()

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				cur, err := store.Docs.Get("shared")
				if err != nil {
					// A read outside any lock can race the rewrite; retry.
					i--
					continue
				}
				next := *cur
				next.Content = fmt.Sprintf("local %d-%d", w, i)
				err = store.MutateDocWithHistory(ctx, cur, &next, storage.DocMutationOptions{ExpectedHash: storage.CanonicalDocHash(cur)})
				var conflict *storage.MutationConflictError
				switch {
				case err == nil:
					succeeded.Add(1)
				case errors.As(err, &conflict):
					conflicted.Add(1)
				default:
					fail("mutation neither succeeded nor conflicted: %v", err)
				}
				parsesUnderLock()
			}
		}(w)
	}
	wg.Wait()
	close(done)
	fetcher.Wait()

	if len(failures) > 0 {
		t.Fatalf("%d failures, first: %s", len(failures), failures[0])
	}
	if succeeded.Load()+conflicted.Load() != writers*perWriter {
		t.Fatalf("accounted %d of %d mutations", succeeded.Load()+conflicted.Load(), writers*perWriter)
	}
	if succeeded.Load() == 0 {
		t.Fatal("no mutation succeeded; the test is not exercising writes")
	}
	t.Logf("mutations: %d succeeded, %d conflicted", succeeded.Load(), conflicted.Load())
}

func trim(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
