package cli

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/spf13/cobra"
)

// --- memory migrate ---

var memoryMigrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Freeze the claim boundary of memories the system is guessing at",
	Long: "Injection shows only a memory's claim. When an entry carries no " +
		models.MemoryDetailMarker + " the claim is taken from the first paragraph, " +
		"which is a guess nobody made deliberately and which a later edit to the " +
		"opening paragraph can move without anyone noticing.\n\n" +
		"Without flags this previews the entries in that state. --write inserts the " +
		"marker exactly where the split happens today, so what gets injected does " +
		"not change; only who decided it does.",
	RunE: runMemoryMigrate,
}

// memoryMigrateCandidate is one entry whose claim boundary is being guessed.
type memoryMigrateCandidate struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Layer       string `json:"layer"`
	Claim       string `json:"claim"`
	ClaimBytes  int    `json:"claimBytes"`
	DetailBytes int    `json:"detailBytes"`
	Migrated    bool   `json:"migrated,omitempty"`
}

func runMemoryMigrate(cmd *cobra.Command, args []string) error {
	store := getStore()
	write, _ := cmd.Flags().GetBool("write")
	layer, _ := cmd.Flags().GetString("layer")
	allStatuses, _ := cmd.Flags().GetBool("all-statuses")

	layers := []string{models.MemoryLayerProject, models.MemoryLayerGlobal}
	if layer != "" {
		if !models.ValidPersistentMemoryLayer(layer) {
			return fmt.Errorf("layer must be 'project' or 'global'")
		}
		// Both layers are scanned by default. The entries that need this are
		// split across the two, and a project-only default would silently leave
		// half of them guessing.
		layers = []string{layer}
	}

	candidates := make([]memoryMigrateCandidate, 0)
	for _, l := range layers {
		entries, err := store.Memory.ListPersistent(l)
		if err != nil {
			return fmt.Errorf("list %s memories: %w", l, err)
		}
		for _, entry := range entries {
			if entry == nil {
				continue
			}
			// Default to what can actually be injected. An archived entry's
			// boundary costs nothing to leave guessed, and rewriting content
			// nobody reads is a change without a reason. --all-statuses covers
			// the case where one is about to be brought back.
			if !allStatuses && !entry.CurrentForDefaultRetrieval() {
				continue
			}
			info := models.InspectMemoryClaim(entry.Content)
			if info.Source != models.MemoryClaimSourceFirstParagraph {
				continue
			}
			candidate := memoryMigrateCandidate{
				ID: entry.ID, Title: entry.Title, Layer: entry.Layer,
				Claim: info.Claim, ClaimBytes: len(info.Claim), DetailBytes: info.DetailBytes,
			}
			if write {
				updated, changed := models.InsertMemoryDetailMarker(entry.Content)
				if changed {
					entry.Content = updated
					// UpdatedAt is preserved: this is a reformat, and letting it
					// bump would raise the recency bonus on every migrated entry
					// and reorder retrieval as a side effect of a cleanup.
					if err := store.Memory.UpdateContentPreservingTimestamp(entry); err != nil {
						return fmt.Errorf("update memory %s: %w", entry.ID, err)
					}
					search.BestEffortIndexMemory(store, entry.ID)
					candidate.Migrated = true
				}
			}
			candidates = append(candidates, candidate)
		}
	}

	if isJSON(cmd) {
		printJSON(map[string]any{"write": write, "count": len(candidates), "memories": candidates})
		return nil
	}
	printMemoryMigratePlain(cmd, candidates, write)
	return nil
}

func printMemoryMigratePlain(cmd *cobra.Command, candidates []memoryMigrateCandidate, write bool) {
	var pb strings.Builder
	if len(candidates) == 0 {
		fmt.Fprintln(&pb, "No memories are guessing at their claim boundary")
		printPaged(cmd, pb.String())
		return
	}
	verb := "Would insert"
	if write {
		verb = "Inserted"
	}
	fmt.Fprintf(&pb, "%s %s in %d %s:\n\n", verb, models.MemoryDetailMarker, len(candidates), pluralMemories(len(candidates)))
	for _, c := range candidates {
		fmt.Fprintf(&pb, "MEMORY: %s\n", c.ID)
		fmt.Fprintf(&pb, "  TITLE: %s\n", c.Title)
		fmt.Fprintf(&pb, "  LAYER: %s\n", c.Layer)
		fmt.Fprintf(&pb, "  CLAIM (%db shown, %db hidden): %s\n\n", c.ClaimBytes, c.DetailBytes, c.Claim)
	}
	if !write {
		fmt.Fprintln(&pb, "Nothing was written. Re-run with --write to freeze these boundaries.")
	}
	printPaged(cmd, pb.String())
}

func pluralMemories(n int) string {
	if n == 1 {
		return "memory"
	}
	return "memories"
}

func init() {
	memoryMigrateCmd.Flags().Bool("write", false, "Insert the marker instead of only previewing")
	memoryMigrateCmd.Flags().String("layer", "", "Limit to one layer: project or global (default: both)")
	memoryMigrateCmd.Flags().Bool("all-statuses", false, "Include non-active memory statuses")
	memoryCmd.AddCommand(memoryMigrateCmd)
}
