package storage

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// newTestStoreWithData creates a temp store seeded with docs, tasks, and memories
// for structural traversal testing.
func newTestStoreWithData(t *testing.T) *Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())

	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("structural-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()

	// Create spec doc.
	if err := store.Docs.Create(&models.Doc{
		Path:      "specs/auth",
		Title:     "Auth Spec",
		Content:   "# Auth Spec\n\nAuthentication specification.\n\nDepends on @doc/specs/base{depends}.",
		Tags:      []string{"spec", "approved"},
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc specs/auth: %v", err)
	}

	// Create base spec doc.
	if err := store.Docs.Create(&models.Doc{
		Path:      "specs/base",
		Title:     "Base Spec",
		Content:   "# Base Spec\n\nBase specification.",
		Tags:      []string{"spec"},
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc specs/base: %v", err)
	}

	// Create 3 tasks implementing the auth spec.
	for _, td := range []struct {
		id, title string
	}{
		{"task01", "Implement JWT"},
		{"task02", "Implement OAuth"},
		{"task03", "Implement RBAC"},
	} {
		if err := store.Tasks.Create(&models.Task{
			ID:        td.id,
			Title:     td.title,
			Status:    "in-progress",
			Priority:  "high",
			Spec:      "specs/auth",
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			t.Fatalf("create task %s: %v", td.id, err)
		}
	}

	// Create a blocked chain: taskA blocked-by taskB, taskB blocked-by taskC.
	if err := store.Tasks.Create(&models.Task{
		ID:          "taskA",
		Title:       "Task A",
		Status:      "blocked",
		Priority:    "high",
		Description: "Blocked by @task-taskB{blocked-by}",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create taskA: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID:          "taskB",
		Title:       "Task B",
		Status:      "blocked",
		Priority:    "medium",
		Description: "Blocked by @task-taskC{blocked-by}",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create taskB: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID:        "taskC",
		Title:     "Task C",
		Status:    "todo",
		Priority:  "low",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create taskC: %v", err)
	}

	// Create a task with parent.
	if err := store.Tasks.Create(&models.Task{
		ID:        "child1",
		Title:     "Child Task",
		Status:    "todo",
		Priority:  "medium",
		Parent:    "task01",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create child1: %v", err)
	}

	// Create a doc with inline ref to a deleted doc (unresolved).
	if err := store.Docs.Create(&models.Doc{
		Path:      "specs/current",
		Title:     "Current Spec",
		Content:   "Depends on @doc/specs/deleted-feature{depends}.",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc specs/current: %v", err)
	}

	return store
}

// Scenario 1: Find tasks implementing a spec (inbound, field-backed).
func TestStructuralResolve_InboundImplements(t *testing.T) {
	store := newTestStoreWithData(t)

	result, err := store.StructuralResolve("@doc/specs/auth{implements}", models.StructuralParams{
		Direction: "inbound",
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	if result.Root.Kind != "doc" || result.Root.ID != "specs/auth" {
		t.Fatalf("root = %+v, want doc:specs/auth", result.Root)
	}

	// Should find 3 tasks with implements relation, all field-backed.
	implementsEdges := filterEdges(result.Edges, "implements")
	if len(implementsEdges) != 3 {
		t.Fatalf("expected 3 implements edges, got %d: %+v", len(implementsEdges), result.Edges)
	}
	for _, e := range implementsEdges {
		if e.Origin != models.OriginFieldBacked {
			t.Errorf("edge %s->%s origin = %q, want field-backed", e.Source.ID, e.Target.ID, e.Origin)
		}
		if e.Direction != "inbound" {
			t.Errorf("edge direction = %q, want inbound", e.Direction)
		}
		if e.Depth != 1 {
			t.Errorf("edge depth = %d, want 1", e.Depth)
		}
		if !e.Resolved {
			t.Errorf("edge resolved = false, want true")
		}
	}
}

// Scenario 2: Multi-hop traversal — blocked chain.
func TestStructuralResolve_MultiHopBlockedChain(t *testing.T) {
	store := newTestStoreWithData(t)

	result, err := store.StructuralResolve("@task-taskA{blocked-by}", models.StructuralParams{
		Direction:     "outbound",
		Depth:         2,
		RelationTypes: []string{"blocked-by"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	if result.Root.Kind != "task" || result.Root.ID != "taskA" {
		t.Fatalf("root = %+v, want task:taskA", result.Root)
	}

	// Depth 1: taskA -> taskB (blocked-by), Depth 2: taskB -> taskC (blocked-by).
	blockedEdges := filterEdges(result.Edges, "blocked-by")
	if len(blockedEdges) != 2 {
		t.Fatalf("expected 2 blocked-by edges, got %d: %+v", len(blockedEdges), result.Edges)
	}

	// Check depth annotations.
	depthMap := map[int]bool{}
	for _, e := range blockedEdges {
		depthMap[e.Depth] = true
		if e.Origin != models.OriginInline {
			t.Errorf("edge origin = %q, want inline", e.Origin)
		}
	}
	if !depthMap[1] || !depthMap[2] {
		t.Errorf("expected depths 1 and 2, got %v", depthMap)
	}
}

func TestStructuralResolve_CanonicalAndLegacyRefs(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("canonical-ref-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{
		ID:          "source",
		Title:       "Source",
		Status:      "todo",
		Priority:    "medium",
		Description: "See @task/target{related}, @memory-note{follows}, and @decision/20260618-1024-use-qdrant-as-default-vector-db{depends}.",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create source task: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{ID: "target", Title: "Target", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("create target task: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{ID: "mem001", Title: "Note", Layer: models.MemoryLayerProject, Category: "pattern", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("create memory: %v", err)
	}
	if err := store.Decisions.Create(&models.DecisionEntry{
		ID:        "20260618-1024-use-qdrant-as-default-vector-db",
		Title:     "Use Qdrant as default vector DB",
		Status:    models.DecisionStatusAccepted,
		Sources:   []string{"@task/source"},
		CreatedAt: now,
		UpdatedAt: now,
	}, DecisionCreateOptions{Now: now}); err != nil {
		t.Fatalf("create decision: %v", err)
	}

	result, err := store.StructuralResolve("@task/source", models.StructuralParams{
		Direction: "outbound",
		Depth:     1,
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	wantTargets := map[string]bool{
		"task:target":   false,
		"memory:mem001": false,
		"decision:20260618-1024-use-qdrant-as-default-vector-db": false,
	}
	for _, edge := range result.Edges {
		key := edge.Target.Kind + ":" + edge.Target.ID
		if _, ok := wantTargets[key]; ok {
			wantTargets[key] = true
		}
	}
	for target, found := range wantTargets {
		if !found {
			t.Fatalf("missing structural target %s in edges: %+v", target, result.Edges)
		}
	}
}

// Scenario 3: Mixed origins — deduplication (field-backed wins over inline).
func TestStructuralResolve_MixedOriginDedup(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("dedup-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()

	// Doc.
	if err := store.Docs.Create(&models.Doc{
		Path:      "specs/api",
		Title:     "API Spec",
		Content:   "# API Spec",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}

	// Task with spec field (field-backed) AND inline ref (inline).
	if err := store.Tasks.Create(&models.Task{
		ID:          "taskX",
		Title:       "Task X",
		Status:      "todo",
		Priority:    "medium",
		Spec:        "specs/api",
		Description: "Implements @doc/specs/api{implements}",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	result, err := store.StructuralResolve("@doc/specs/api{implements}", models.StructuralParams{
		Direction:     "inbound",
		RelationTypes: []string{"implements"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	// Should have exactly 1 implements edge (deduped), with field-backed origin.
	implementsEdges := filterEdges(result.Edges, "implements")
	if len(implementsEdges) != 1 {
		t.Fatalf("expected 1 deduped implements edge, got %d: %+v", len(implementsEdges), implementsEdges)
	}
	if implementsEdges[0].Origin != models.OriginFieldBacked {
		t.Errorf("origin = %q, want field-backed (higher priority)", implementsEdges[0].Origin)
	}
}

// Scenario 4: Filtered traversal by entity type.
func TestStructuralResolve_EntityTypeFilter(t *testing.T) {
	store := newTestStoreWithData(t)

	result, err := store.StructuralResolve("@doc/specs/auth{references}", models.StructuralParams{
		Direction:   "inbound",
		EntityTypes: []string{"task"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	// All edges should point to/from tasks only.
	for _, e := range result.Edges {
		otherKind := e.Source.Kind
		if e.Source.Kind == result.Root.Kind && e.Source.ID == result.Root.ID {
			otherKind = e.Target.Kind
		}
		if otherKind != "task" {
			t.Errorf("expected only task entities, got %s:%s", otherKind, e.Source.ID)
		}
	}
}

// Scenario 5: Unresolved edge.
func TestStructuralResolve_UnresolvedEdge(t *testing.T) {
	store := newTestStoreWithData(t)

	result, err := store.StructuralResolve("@doc/specs/current{depends}", models.StructuralParams{
		Direction: "outbound",
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	if len(result.Unresolved) == 0 {
		t.Fatal("expected at least 1 unresolved edge")
	}

	found := false
	for _, u := range result.Unresolved {
		if u.Reason == "entity not found" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected unresolved edge with reason 'entity not found', got %+v", result.Unresolved)
	}
}

// Scenario 6: Depth limit respected.
func TestStructuralResolve_DepthLimit(t *testing.T) {
	store := newTestStoreWithData(t)

	// With depth=1, should only get taskA->taskB, not taskB->taskC.
	result, err := store.StructuralResolve("@task-taskA{blocked-by}", models.StructuralParams{
		Direction:     "outbound",
		Depth:         1,
		RelationTypes: []string{"blocked-by"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	blockedEdges := filterEdges(result.Edges, "blocked-by")
	if len(blockedEdges) != 1 {
		t.Fatalf("expected 1 blocked-by edge at depth 1, got %d", len(blockedEdges))
	}
	if blockedEdges[0].Depth != 1 {
		t.Errorf("edge depth = %d, want 1", blockedEdges[0].Depth)
	}
}

// Scenario 7: Doc rename preserves edges.
func TestStructuralResolve_DocRenamePreservesEdges(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("rename-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()

	// Create doc.
	doc := &models.Doc{
		Path:      "specs/old-name",
		Title:     "Old Name Spec",
		Content:   "# Old Name Spec",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create doc: %v", err)
	}

	// Create 2 tasks with spec field pointing to old name.
	for _, id := range []string{"renT1", "renT2"} {
		if err := store.Tasks.Create(&models.Task{
			ID:        id,
			Title:     "Rename Task " + id,
			Status:    "todo",
			Priority:  "medium",
			Spec:      "specs/old-name",
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			t.Fatalf("create task %s: %v", id, err)
		}
	}

	// Rename doc.
	doc.Path = "specs/new-name"
	doc.UpdatedAt = time.Now().UTC()
	if err := store.Docs.Rename("specs/old-name", doc); err != nil {
		t.Fatalf("rename doc: %v", err)
	}
	// Rewrite references (this is what the MCP handler does).
	if err := store.Docs.RewriteDocReferences("specs/old-name", "specs/new-name", store.Tasks, store.Memory); err != nil {
		t.Fatalf("rewrite refs: %v", err)
	}

	// Structural resolve on new name should find the 2 tasks.
	result, err := store.StructuralResolve("@doc/specs/new-name{implements}", models.StructuralParams{
		Direction:     "inbound",
		RelationTypes: []string{"implements"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	implementsEdges := filterEdges(result.Edges, "implements")
	if len(implementsEdges) != 2 {
		t.Fatalf("expected 2 implements edges after rename, got %d: %+v", len(implementsEdges), result.Edges)
	}
}

// Test outbound traversal from a task.
func TestStructuralResolve_OutboundFromTask(t *testing.T) {
	store := newTestStoreWithData(t)

	result, err := store.StructuralResolve("@task-task01{spec}", models.StructuralParams{
		Direction: "outbound",
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	// task01 has spec=specs/auth, so should have outbound spec and implements edges.
	specEdges := filterEdges(result.Edges, "spec")
	if len(specEdges) == 0 {
		t.Fatal("expected at least 1 spec edge outbound from task01")
	}
	for _, e := range specEdges {
		if e.Target.Kind != "doc" || e.Target.ID != "specs/auth" {
			t.Errorf("spec edge target = %s:%s, want doc:specs/auth", e.Target.Kind, e.Target.ID)
		}
	}
}

// Test parent relation (field-backed).
func TestStructuralResolve_ParentRelation(t *testing.T) {
	store := newTestStoreWithData(t)

	result, err := store.StructuralResolve("@task-child1{parent}", models.StructuralParams{
		Direction:     "outbound",
		RelationTypes: []string{"parent"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	parentEdges := filterEdges(result.Edges, "parent")
	if len(parentEdges) != 1 {
		t.Fatalf("expected 1 parent edge, got %d", len(parentEdges))
	}
	if parentEdges[0].Target.ID != "task01" {
		t.Errorf("parent target = %s, want task01", parentEdges[0].Target.ID)
	}
	if parentEdges[0].Origin != models.OriginFieldBacked {
		t.Errorf("parent origin = %q, want field-backed", parentEdges[0].Origin)
	}
}

// Test direction=both.
func TestStructuralResolve_BothDirection(t *testing.T) {
	store := newTestStoreWithData(t)

	result, err := store.StructuralResolve("@task-taskB{blocked-by}", models.StructuralParams{
		Direction:     "both",
		RelationTypes: []string{"blocked-by"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	// taskB has: inbound blocked-by from taskA, outbound blocked-by to taskC.
	if len(result.Edges) < 2 {
		t.Fatalf("expected at least 2 edges with both direction, got %d: %+v", len(result.Edges), result.Edges)
	}

	directions := map[string]bool{}
	for _, e := range result.Edges {
		directions[e.Direction] = true
	}
	if !directions["inbound"] || !directions["outbound"] {
		t.Errorf("expected both inbound and outbound edges, got directions: %v", directions)
	}
}

// Test backward compatibility: no structural params returns error-free.
func TestStructuralResolve_InvalidRef(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("invalid-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	_, err := store.StructuralResolve("not-a-ref", models.StructuralParams{Direction: "outbound"})
	if err == nil {
		t.Fatal("expected error for invalid ref")
	}
}

// Test depth clamping.
func TestStructuralParams_Normalize(t *testing.T) {
	p := models.StructuralParams{Depth: 5}
	p.Normalize()
	if p.Depth != 3 {
		t.Errorf("depth = %d, want 3 (clamped)", p.Depth)
	}
	if p.Direction != "outbound" {
		t.Errorf("direction = %q, want outbound (default)", p.Direction)
	}

	p2 := models.StructuralParams{}
	p2.Normalize()
	if p2.Depth != 1 {
		t.Errorf("depth = %d, want 1 (default)", p2.Depth)
	}
}

// Test IsStructural detection.
func TestStructuralParams_IsStructural(t *testing.T) {
	if (models.StructuralParams{}).IsStructural() {
		t.Error("empty params should not be structural")
	}
	if !(models.StructuralParams{Direction: "inbound"}).IsStructural() {
		t.Error("direction=inbound should be structural")
	}
	if !(models.StructuralParams{Depth: 2}).IsStructural() {
		t.Error("depth=2 should be structural")
	}
	if !(models.StructuralParams{RelationTypes: []string{"spec"}}).IsStructural() {
		t.Error("relationTypes should be structural")
	}
	if !(models.StructuralParams{EntityTypes: []string{"task"}}).IsStructural() {
		t.Error("entityTypes should be structural")
	}
}

// filterEdges returns edges matching the given relation.
func filterEdges(edges []models.StructuralEdge, relation string) []models.StructuralEdge {
	var out []models.StructuralEdge
	for _, e := range edges {
		if e.Relation == relation {
			out = append(out, e)
		}
	}
	return out
}
