package handlers

import (
	"strings"
	"testing"
)

// TestUnknownTaskArgumentIsRejected covers what silent argument dropping cost.
// `create` never accepted acceptance criteria, so passing them returned success
// and discarded them, and the Task went on to be marked done against criteria
// that were never recorded. An argument the action does not accept is now an
// error naming the argument.
func TestUnknownTaskArgumentIsRejected(t *testing.T) {
	err := validateTaskArgs("create", map[string]any{"title": "t", "nonsense": 1})
	if err == nil {
		t.Fatal("an unknown argument was accepted")
	}
	if !strings.Contains(err.Error(), "nonsense") {
		t.Fatalf("error = %v, want it to name the rejected argument", err)
	}
}

// A privilege-shaped argument is refused before dispatch, so it can never reach
// a handler that might be tempted to read it.
func TestSpoofedAuthorizationArgumentIsRejected(t *testing.T) {
	err := validateTaskArgs("hard_delete", map[string]any{
		"taskId": "x", "confirmed": true, "reason": "spoof", "authorized": true,
	})
	if err == nil || !strings.Contains(err.Error(), "authorized") {
		t.Fatalf("error = %v, want the spoofed argument refused", err)
	}
}

// A parameter valid on another action is still wrong here. This is the exact
// shape of the original defect: addAc is real, but it was real only on update.
func TestParameterValidOnAnotherActionIsRejected(t *testing.T) {
	if err := validateTaskArgs("get", map[string]any{"taskId": "x", "addAc": []string{"a"}}); err == nil {
		t.Fatal("addAc accepted on get")
	}
	if err := validateTaskArgs("create", map[string]any{"title": "t", "addAc": []string{"a"}}); err != nil {
		t.Fatalf("create must now accept acceptance criteria: %v", err)
	}
}

// Every action the tool dispatches must declare its parameters, or validation
// silently passes everything through for that action.
func TestEveryDispatchedActionDeclaresParams(t *testing.T) {
	for _, action := range []string{
		"create", "get", "update", "delete", "list", "history", "board",
		"archive", "unarchive", "batch_archive", "batch_unarchive", "hard_delete",
	} {
		if _, ok := taskActionParams[action]; !ok {
			t.Errorf("action %q has no declared parameters", action)
		}
	}
}

// TestCreatePersistsAcceptanceCriteria proves the handler stores the criteria
// rather than merely accepting the argument. This is the defect that lost five
// criteria on a real task: create returned success and wrote none of them.
func TestCreatePersistsAcceptanceCriteria(t *testing.T) {
	getStore := newMCPPrefixStore(t, "")
	id := mcpCreatedTaskID(t, getStore, map[string]any{
		"title": "Create with criteria",
		"addAc": []any{"first criterion", "second criterion"},
	})
	task, err := getStore().Tasks.Get(id)
	if err != nil {
		t.Fatalf("Get(%s): %v", id, err)
	}
	if len(task.AcceptanceCriteria) != 2 {
		t.Fatalf("acceptance criteria = %#v, want the two passed to create", task.AcceptanceCriteria)
	}
	if task.AcceptanceCriteria[0].Text != "first criterion" || task.AcceptanceCriteria[1].Text != "second criterion" {
		t.Fatalf("criteria text = %#v", task.AcceptanceCriteria)
	}
	if task.AcceptanceCriteria[0].Completed || task.AcceptanceCriteria[1].Completed {
		t.Fatal("newly created criteria must start unchecked")
	}
}
