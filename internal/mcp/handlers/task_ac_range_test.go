package handlers

import (
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

// TestCheckACRejectsOutOfRange guards a silent data defect: checking criteria a
// Task does not have used to report success and change nothing, so a Task could
// be marked done against acceptance criteria that were never recorded.
func TestCheckACRejectsOutOfRange(t *testing.T) {
	task := &models.Task{}
	err := applyACCompletion(task, []int{1, 2, 3}, true)
	if err == nil {
		t.Fatal("checking criteria on a task with none returned no error")
	}
	if !strings.Contains(err.Error(), "out of range") {
		t.Fatalf("error = %v, want it to name the range problem", err)
	}
}

func TestCheckACAppliesInRangeIndexes(t *testing.T) {
	task := &models.Task{AcceptanceCriteria: []models.AcceptanceCriterion{
		{Text: "one"}, {Text: "two"}, {Text: "three"},
	}}
	if err := applyACCompletion(task, []int{1, 3}, true); err != nil {
		t.Fatalf("applyACCompletion: %v", err)
	}
	if !task.AcceptanceCriteria[0].Completed || task.AcceptanceCriteria[2].Completed != true {
		t.Fatal("in-range indexes were not applied")
	}
	if task.AcceptanceCriteria[1].Completed {
		t.Fatal("an unnamed criterion was modified")
	}
	if err := applyACCompletion(task, []int{0}, true); err == nil {
		t.Fatal("index 0 accepted; indexes are 1-based")
	}
}
