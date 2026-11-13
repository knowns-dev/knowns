//go:build ignore

// Test helper for the TypeScript storage tests. It drives the REAL Go storage code (not a copy of
// its algorithm), so lock and path behaviour is compared against the code the 0.34.1 binary runs.
//
// Build (from the repository root; the `ignore` tag keeps it out of `go build ./...`):
//
//	go build -o /tmp/knowns-go-helper ./cli/test/helpers/go-helper.go
//
// Commands (each prints one line per event on stdout):
//
//	hold <storeRoot> <holdMs> [relPath...]
//	    Takes the locks WithSyncLocks takes for relPaths (no relPaths: the task lifecycle lock),
//	    prints HELD, holds them for holdMs, prints RELEASED.
//	hold-migration <storeRoot> <holdMs>
//	    Same, for the decision/memory migration lock.
//	try <storeRoot> <timeoutMs> [relPath...]
//	    Tries to take the same locks within timeoutMs. Prints ACQUIRED <elapsedMs> or
//	    TIMEOUT <elapsedMs>.
//	try-migration <storeRoot> <timeoutMs>
//	safepath <resolve|project|real> <root> <path>
//	    Prints OK <resolved> or ERR <message>.
//	canonical <path>
//	    Prints util.CanonicalPath(path).
//	memhash <storeRoot> <layer> <id>
//	    Prints storage.CanonicalMemoryHash of the persisted memory.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/howznguyen/knowns/internal/safepath"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/util"
)

func ms(s string) time.Duration {
	n, err := strconv.Atoi(s)
	if err != nil {
		fmt.Println("ERR bad number", s)
		os.Exit(2)
	}
	return time.Duration(n) * time.Millisecond
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("ERR usage")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "hold":
		store := storage.NewStore(os.Args[2])
		hold := ms(os.Args[3])
		rels := os.Args[4:]
		body := func() error {
			fmt.Println("HELD")
			time.Sleep(hold)
			fmt.Println("RELEASED")
			return nil
		}
		var err error
		if len(rels) == 0 {
			err = store.WithTaskLifecycleTransaction(context.Background(), func(*storage.TaskLifecycleTransaction) error { return body() })
		} else {
			err = store.WithSyncLocks(context.Background(), rels, body)
		}
		if err != nil {
			fmt.Println("ERR", err)
			os.Exit(1)
		}
	case "hold-migration":
		store := storage.NewStore(os.Args[2])
		hold := ms(os.Args[3])
		err := store.WithDecisionMemoryMigrationLock(context.Background(), func() error {
			fmt.Println("HELD")
			time.Sleep(hold)
			fmt.Println("RELEASED")
			return nil
		})
		if err != nil {
			fmt.Println("ERR", err)
			os.Exit(1)
		}
	case "try", "try-migration":
		store := storage.NewStore(os.Args[2])
		ctx, cancel := context.WithTimeout(context.Background(), ms(os.Args[3]))
		defer cancel()
		start := time.Now()
		body := func() error {
			fmt.Printf("ACQUIRED %d\n", time.Since(start).Milliseconds())
			return nil
		}
		var err error
		switch {
		case os.Args[1] == "try-migration":
			err = store.WithDecisionMemoryMigrationLock(ctx, body)
		case len(os.Args) > 4:
			err = store.WithSyncLocks(ctx, os.Args[4:], body)
		default:
			err = store.WithTaskLifecycleTransaction(ctx, func(*storage.TaskLifecycleTransaction) error { return body() })
		}
		if err != nil {
			fmt.Printf("TIMEOUT %d %v\n", time.Since(start).Milliseconds(), err)
		}
	case "safepath":
		var got string
		var err error
		switch os.Args[2] {
		case "resolve":
			got, err = safepath.Resolve(os.Args[3], os.Args[4])
		case "project":
			got, err = safepath.ResolveProject(os.Args[3], os.Args[4])
		case "real":
			got, err = safepath.ResolveProjectReal(os.Args[3], os.Args[4])
		}
		if err != nil {
			fmt.Println("ERR", err)
		} else {
			fmt.Println("OK", got)
		}
	case "canonical":
		fmt.Println(util.CanonicalPath(os.Args[2]))
	case "memhash":
		// memhash <storeRoot> <layer> <id>: CanonicalMemoryHash of a persisted memory.
		store := storage.NewStore(os.Args[2])
		entry, err := store.Memory.GetInLayer(os.Args[4], os.Args[3])
		if err != nil {
			fmt.Println("ERR", err)
			os.Exit(1)
		}
		if len(os.Args) > 5 && os.Args[5] == "dump" {
			raw, _ := json.Marshal(entry)
			fmt.Println(string(raw))
		}
		fmt.Println(storage.CanonicalMemoryHash(entry))
	default:
		fmt.Println("ERR unknown command", os.Args[1])
		os.Exit(2)
	}
}
