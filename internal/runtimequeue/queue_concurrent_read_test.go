package runtimequeue

import (
	"sync"
	"testing"
	"time"
)

// LoadQueue reads without the queue lock, and on Windows a rename over a file
// someone has open fails with "Access is denied". Pollers such as WaitForJob
// must not be able to fail a concurrent queue update, or be failed by one.
func TestUpdateQueueSurvivesConcurrentReaders(t *testing.T) {
	t.Setenv(EnvRuntimeRoot, t.TempDir())
	storeRoot := t.TempDir()

	if err := updateQueue(storeRoot, func(*QueueState) error { return nil }); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	readErrs := make(chan error, 4)
	var readers sync.WaitGroup
	for range 4 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				if _, err := LoadQueue(storeRoot); err != nil {
					readErrs <- err
					return
				}
				time.Sleep(time.Millisecond)
			}
		}()
	}

	var updateErr error
	for range 200 {
		if updateErr = updateQueue(storeRoot, func(*QueueState) error { return nil }); updateErr != nil {
			break
		}
	}
	close(done)
	readers.Wait()
	close(readErrs)

	if updateErr != nil {
		t.Errorf("updateQueue: %v", updateErr)
	}
	for err := range readErrs {
		t.Errorf("LoadQueue: %v", err)
	}
}
