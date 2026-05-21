package lsp

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestFileSyncRefCounting(t *testing.T) {
	var opens, closes atomic.Int32
	fs := NewFileSync(func(string) error { opens.Add(1); return nil }, func(string) error { closes.Add(1); return nil })
	fs.SetTTL(20 * time.Millisecond)

	if err := fs.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if opens.Load() != 1 || fs.RefCount("a.go") != 2 {
		t.Fatalf("open refs = %d/%d, want 1/2", opens.Load(), fs.RefCount("a.go"))
	}
	if err := fs.Close("a.go"); err != nil {
		t.Fatal(err)
	}
	if closes.Load() != 0 || fs.RefCount("a.go") != 1 {
		t.Fatalf("close refs = %d/%d, want 0/1", closes.Load(), fs.RefCount("a.go"))
	}
	if err := fs.Close("a.go"); err != nil {
		t.Fatal(err)
	}
	if closes.Load() != 0 || fs.RefCount("a.go") != 0 {
		t.Fatalf("close refs = %d/%d, want 0/0 before TTL", closes.Load(), fs.RefCount("a.go"))
	}
	waitForClose(t, &closes, 1)
}

func TestFileSyncKeepsFileOpenUntilTTLExpires(t *testing.T) {
	var opens, closes atomic.Int32
	fs := NewFileSync(func(string) error { opens.Add(1); return nil }, func(string) error { closes.Add(1); return nil })
	fs.SetTTL(50 * time.Millisecond)

	if err := fs.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Close("a.go"); err != nil {
		t.Fatal(err)
	}
	if opens.Load() != 1 || closes.Load() != 0 {
		t.Fatalf("opens/closes = %d/%d, want 1/0 before TTL", opens.Load(), closes.Load())
	}
}

func TestFileSyncClosesAfterTTLExpires(t *testing.T) {
	var closes atomic.Int32
	fs := NewFileSync(nil, func(string) error { closes.Add(1); return nil })
	fs.SetTTL(10 * time.Millisecond)

	if err := fs.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Close("a.go"); err != nil {
		t.Fatal(err)
	}
	waitForClose(t, &closes, 1)
}

func TestFileSyncReopenBeforeTTLCancelsClose(t *testing.T) {
	var opens, closes atomic.Int32
	fs := NewFileSync(func(string) error { opens.Add(1); return nil }, func(string) error { closes.Add(1); return nil })
	fs.SetTTL(30 * time.Millisecond)

	if err := fs.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Close("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if opens.Load() != 1 || closes.Load() != 0 || fs.RefCount("a.go") != 1 {
		t.Fatalf("opens/closes/refs = %d/%d/%d, want 1/0/1", opens.Load(), closes.Load(), fs.RefCount("a.go"))
	}
}

func TestFileSyncCloseAllClosesImmediately(t *testing.T) {
	var closes atomic.Int32
	fs := NewFileSync(nil, func(string) error { closes.Add(1); return nil })
	fs.SetTTL(time.Hour)

	if err := fs.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Open("b.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Close("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := fs.CloseAll(); err != nil {
		t.Fatal(err)
	}
	if closes.Load() != 2 || fs.RefCount("a.go") != 0 || fs.RefCount("b.go") != 0 {
		t.Fatalf("closes/refs = %d/%d/%d, want 2/0/0", closes.Load(), fs.RefCount("a.go"), fs.RefCount("b.go"))
	}
}

func waitForClose(t *testing.T, closes *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if closes.Load() == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("closes = %d, want %d", closes.Load(), want)
}
