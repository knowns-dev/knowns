package memoryreview

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

const (
	ResultCreated        = "created"
	ResultReviewRequired = "review_required"
	ResultResolved       = "resolved"

	ResolutionUpdateExisting           = "update_existing"
	ResolutionArchiveExistingCreateNew = "archive_existing_create_new"
	ResolutionCreateProposed           = "create_proposed"
	ResolutionRejectNew                = "reject_new"
	ResolutionMergeExisting            = "merge_existing"

	defaultReviewLimit     = 5
	defaultReviewThreshold = 0.72
)

var AllowedResolutions = []string{
	ResolutionUpdateExisting,
	ResolutionArchiveExistingCreateNew,
	ResolutionCreateProposed,
	ResolutionRejectNew,
	ResolutionMergeExisting,
}

type SemanticSearchFunc func(candidate *models.MemoryEntry, limit int) ([]Match, error)

type Service struct {
	Store           *storage.Store
	Now             func() time.Time
	SemanticSearch  SemanticSearchFunc
	ReviewThreshold float64
	ReviewLimit     int
}

type AddOptions struct {
	SkipReview bool
	Status     string
}

type ResolveOptions struct {
	Resolution     string
	TargetID       string
	Status         string
	RejectedReason string
}

type Result struct {
	Status             string              `json:"status"`
	Resolution         string              `json:"resolution,omitempty"`
	Candidate          *models.MemoryEntry `json:"candidate,omitempty"`
	Matches            []Match             `json:"matches,omitempty"`
	AllowedResolutions []string            `json:"allowedResolutions,omitempty"`
	Memory             *models.MemoryEntry `json:"memory,omitempty"`
	ChangedIDs         []string            `json:"changedIds,omitempty"`
}

type Match struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Layer     string   `json:"layer"`
	Category  string   `json:"category,omitempty"`
	Status    string   `json:"status,omitempty"`
	Score     float64  `json:"score"`
	MatchedBy []string `json:"matchedBy,omitempty"`
	Snippet   string   `json:"snippet,omitempty"`
	Tags      []string `json:"tags,omitempty"`
}

func New(store *storage.Store) *Service {
	return &Service{Store: store}
}

func (s *Service) Add(candidate *models.MemoryEntry, opts AddOptions) (*Result, error) {
	entry, err := s.normalizeCandidate(candidate, firstNonEmpty(opts.Status, models.MemoryStatusProposed))
	if err != nil {
		return nil, err
	}
	if !opts.SkipReview {
		review, err := s.Review(entry)
		if err != nil {
			return nil, err
		}
		if review != nil && len(review.Matches) > 0 {
			return review, nil
		}
	}
	return s.create(entry, ResultCreated, "")
}

func (s *Service) Review(candidate *models.MemoryEntry) (*Result, error) {
	entry, err := s.normalizeCandidate(candidate, models.MemoryStatusProposed)
	if err != nil {
		return nil, err
	}
	matches := make([]Match, 0)
	if semanticMatches, err := s.semanticMatches(entry); err == nil {
		matches = append(matches, semanticMatches...)
	}
	matches = append(matches, s.lexicalMatches(entry)...)
	matches = mergeMatches(matches, s.threshold())
	if len(matches) == 0 {
		return nil, nil
	}
	if len(matches) > s.limit() {
		matches = matches[:s.limit()]
	}
	return &Result{
		Status:             ResultReviewRequired,
		Candidate:          entry,
		Matches:            matches,
		AllowedResolutions: append([]string(nil), AllowedResolutions...),
	}, nil
}

func (s *Service) Resolve(candidate *models.MemoryEntry, opts ResolveOptions) (*Result, error) {
	if opts.Resolution == "" {
		return nil, fmt.Errorf("resolution is required")
	}
	switch opts.Resolution {
	case ResolutionUpdateExisting:
		return s.updateExisting(candidate, opts)
	case ResolutionArchiveExistingCreateNew:
		return s.archiveExistingCreateNew(candidate, opts)
	case ResolutionCreateProposed:
		input := cloneMemory(candidate)
		if input == nil {
			input = &models.MemoryEntry{}
		}
		input.Status = models.MemoryStatusProposed
		entry, err := s.normalizeCandidate(input, models.MemoryStatusProposed)
		if err != nil {
			return nil, err
		}
		return s.create(entry, ResultResolved, opts.Resolution)
	case ResolutionRejectNew:
		input := cloneMemory(candidate)
		if input == nil {
			input = &models.MemoryEntry{}
		}
		input.Status = models.MemoryStatusRejected
		entry, err := s.normalizeCandidate(input, models.MemoryStatusRejected)
		if err != nil {
			return nil, err
		}
		if opts.RejectedReason != "" {
			entry.RejectedReason = opts.RejectedReason
		}
		if entry.RejectedReason == "" {
			entry.RejectedReason = "rejected_by_review"
		}
		return s.create(entry, ResultResolved, opts.Resolution)
	case ResolutionMergeExisting:
		return s.mergeExisting(candidate, opts)
	default:
		return nil, fmt.Errorf("unsupported memory review resolution: %s", opts.Resolution)
	}
}

func (s *Service) updateExisting(candidate *models.MemoryEntry, opts ResolveOptions) (*Result, error) {
	if opts.TargetID == "" {
		return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
	}
	if candidate != nil {
		if candidate.Confidence != "" && !models.ValidMemoryConfidence(candidate.Confidence) {
			return nil, fmt.Errorf("invalid memory confidence: %q", candidate.Confidence)
		}
		if candidate.TTLDays < 0 {
			return nil, fmt.Errorf("ttlDays must be non-negative")
		}
	}
	existing, err := s.Store.Memory.Get(opts.TargetID)
	if err != nil {
		return nil, err
	}
	updated := cloneMemory(existing)
	if candidate != nil {
		if candidate.Title != "" {
			updated.Title = candidate.Title
		}
		if candidate.Category != "" {
			updated.Category = candidate.Category
		}
		if candidate.Content != "" {
			updated.Content = candidate.Content
		}
		if candidate.Tags != nil {
			updated.Tags = append([]string(nil), candidate.Tags...)
		}
		if candidate.Confidence != "" {
			updated.Confidence = candidate.Confidence
		}
		if candidate.Sources != nil {
			updated.Sources = append([]string(nil), candidate.Sources...)
		}
		if candidate.TTLDays > 0 {
			updated.TTLDays = candidate.TTLDays
		}
	}
	if opts.Status != "" {
		if !models.ValidMemoryStatus(opts.Status) {
			return nil, fmt.Errorf("invalid memory status: %q", opts.Status)
		}
		updated.Status = opts.Status
	}
	now := s.now()
	updated.LastVerified = now
	updated.UpdatedAt = now
	if err := s.Store.Memory.Update(updated); err != nil {
		return nil, err
	}
	return &Result{Status: ResultResolved, Resolution: opts.Resolution, Memory: updated, ChangedIDs: []string{updated.ID}}, nil
}

func (s *Service) archiveExistingCreateNew(candidate *models.MemoryEntry, opts ResolveOptions) (*Result, error) {
	if opts.TargetID == "" {
		return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
	}
	status := firstNonEmpty(opts.Status, models.MemoryStatusProposed)
	input := cloneMemory(candidate)
	if input == nil {
		input = &models.MemoryEntry{}
	}
	input.Status = status
	replacement, err := s.normalizeCandidate(input, status)
	if err != nil {
		return nil, err
	}
	existing, err := s.Store.Memory.Get(opts.TargetID)
	if err != nil {
		return nil, err
	}
	archived := cloneMemory(existing)
	archived.Status = models.MemoryStatusArchived
	archived.UpdatedAt = s.now()
	if err := s.Store.Memory.Update(archived); err != nil {
		return nil, err
	}
	if replacement.ID == archived.ID {
		replacement.ID = ""
	}
	created, err := s.create(replacement, ResultResolved, opts.Resolution)
	if err != nil {
		return nil, err
	}
	created.ChangedIDs = append([]string{archived.ID}, created.ChangedIDs...)
	return created, nil
}

func (s *Service) mergeExisting(candidate *models.MemoryEntry, opts ResolveOptions) (*Result, error) {
	if opts.TargetID == "" {
		return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
	}
	if _, err := s.Store.Memory.Get(opts.TargetID); err != nil {
		return nil, err
	}
	if candidate != nil && candidate.ID != "" {
		if existing, err := s.Store.Memory.Get(candidate.ID); err == nil {
			merged := cloneMemory(existing)
			merged.Status = models.MemoryStatusMerged
			merged.MergedInto = opts.TargetID
			merged.LastVerified = s.now()
			if err := s.Store.Memory.Update(merged); err != nil {
				return nil, err
			}
			return &Result{Status: ResultResolved, Resolution: opts.Resolution, Memory: merged, ChangedIDs: []string{merged.ID}}, nil
		}
	}
	input := cloneMemory(candidate)
	if input == nil {
		input = &models.MemoryEntry{}
	}
	input.Status = models.MemoryStatusMerged
	tombstone, err := s.normalizeCandidate(input, models.MemoryStatusMerged)
	if err != nil {
		return nil, err
	}
	tombstone.MergedInto = opts.TargetID
	tombstone.LastVerified = s.now()
	return s.create(tombstone, ResultResolved, opts.Resolution)
}

func (s *Service) create(entry *models.MemoryEntry, status, resolution string) (*Result, error) {
	if s.Store == nil || s.Store.Memory == nil {
		return nil, fmt.Errorf("memory store unavailable")
	}
	if err := s.Store.Memory.Create(entry); err != nil {
		return nil, err
	}
	result := &Result{Status: status, Memory: entry, ChangedIDs: []string{entry.ID}}
	if resolution != "" {
		result.Resolution = resolution
	}
	return result, nil
}

func (s *Service) normalizeCandidate(candidate *models.MemoryEntry, defaultStatus string) (*models.MemoryEntry, error) {
	if s.Store == nil || s.Store.Memory == nil {
		return nil, fmt.Errorf("memory store unavailable")
	}
	entry := cloneMemory(candidate)
	if entry == nil {
		entry = &models.MemoryEntry{}
	}
	entry.Title = strings.TrimSpace(entry.Title)
	entry.Content = strings.TrimSpace(entry.Content)
	entry.Category = strings.TrimSpace(entry.Category)
	entry.Layer = strings.TrimSpace(entry.Layer)
	if entry.Layer == "" {
		entry.Layer = models.MemoryLayerProject
	}
	if !models.ValidPersistentMemoryLayer(entry.Layer) {
		return nil, fmt.Errorf("invalid memory layer: %q", entry.Layer)
	}
	if entry.Status == "" {
		entry.Status = defaultStatus
	}
	if entry.Status != "" && !models.ValidMemoryStatus(entry.Status) {
		return nil, fmt.Errorf("invalid memory status: %q", entry.Status)
	}
	if entry.Confidence != "" && !models.ValidMemoryConfidence(entry.Confidence) {
		return nil, fmt.Errorf("invalid memory confidence: %q", entry.Confidence)
	}
	if entry.TTLDays < 0 {
		return nil, fmt.Errorf("ttlDays must be non-negative")
	}
	if entry.Tags == nil {
		entry.Tags = []string{}
	}
	now := s.now()
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = now
	}
	if entry.UpdatedAt.IsZero() {
		entry.UpdatedAt = now
	}
	return entry, nil
}

func (s *Service) semanticMatches(candidate *models.MemoryEntry) ([]Match, error) {
	if s.SemanticSearch != nil {
		return s.SemanticSearch(candidate, s.limit())
	}
	embedder, vecStore, err := search.InitSemantic(s.Store)
	if err != nil {
		return nil, err
	}
	if embedder != nil {
		defer embedder.Close()
	}
	if vecStore != nil {
		defer vecStore.Close()
	}
	engine := search.NewEngine(s.Store, embedder, vecStore)
	results, err := engine.Search(search.SearchOptions{
		Query: candidateSearchText(candidate),
		Type:  "memory",
		Mode:  string(search.ModeSemantic),
		Limit: s.limit(),
	})
	if err != nil {
		return nil, err
	}
	matches := make([]Match, 0, len(results))
	for _, result := range results {
		if result.ID == "" || result.ID == candidate.ID || !contains(result.MatchedBy, "semantic") {
			continue
		}
		if result.Score < s.threshold() {
			continue
		}
		entry, err := s.Store.Memory.Get(result.ID)
		if err != nil || !entry.CurrentForDefaultRetrieval() {
			continue
		}
		matches = append(matches, matchFromEntry(entry, result.Score, append([]string(nil), result.MatchedBy...), result.Snippet))
	}
	return matches, nil
}

func (s *Service) lexicalMatches(candidate *models.MemoryEntry) []Match {
	entries, err := s.Store.Memory.ListPersistent("")
	if err != nil {
		return nil
	}
	matches := make([]Match, 0)
	for _, entry := range entries {
		if entry.ID == candidate.ID || !entry.CurrentForDefaultRetrieval() {
			continue
		}
		score, reasons := lexicalScore(candidate, entry)
		if score < s.threshold() {
			continue
		}
		matches = append(matches, matchFromEntry(entry, score, reasons, entry.Content))
	}
	sortMatches(matches)
	return matches
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) threshold() float64 {
	if s.ReviewThreshold > 0 {
		return s.ReviewThreshold
	}
	return defaultReviewThreshold
}

func (s *Service) limit() int {
	if s.ReviewLimit > 0 {
		return s.ReviewLimit
	}
	return defaultReviewLimit
}

func lexicalScore(candidate, existing *models.MemoryEntry) (float64, []string) {
	candidateTitle := normalizedText(candidate.Title)
	existingTitle := normalizedText(existing.Title)
	candidateContent := normalizedText(candidate.Content)
	existingContent := normalizedText(existing.Content)
	candidateAll := normalizedText(candidateSearchText(candidate))
	existingAll := normalizedText(candidateSearchText(existing))

	best := 0.0
	var reasons []string
	if candidateTitle != "" && candidateTitle == existingTitle {
		best = math.Max(best, 0.98)
		reasons = append(reasons, "lexical:title")
	}
	if candidateContent != "" && candidateContent == existingContent {
		best = math.Max(best, 1.0)
		reasons = append(reasons, "lexical:content")
	}
	for label, score := range map[string]float64{
		"lexical:title_tokens":   tokenSimilarity(candidateTitle, existingTitle),
		"lexical:content_tokens": tokenSimilarity(candidateContent, existingContent),
		"lexical:combined":       tokenSimilarity(candidateAll, existingAll),
	} {
		if score > best {
			best = score
		}
		if score >= defaultReviewThreshold {
			reasons = append(reasons, label)
		}
	}
	if candidate.Category != "" && strings.EqualFold(candidate.Category, existing.Category) && best > 0 {
		best = math.Min(1, best+0.05)
		reasons = append(reasons, "lexical:category")
	}
	if len(reasons) == 0 && best >= defaultReviewThreshold {
		reasons = append(reasons, "lexical")
	}
	return best, reasons
}

func tokenSimilarity(a, b string) float64 {
	left := tokenSet(a)
	right := tokenSet(b)
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	intersection := 0
	for token := range left {
		if right[token] {
			intersection++
		}
	}
	union := len(left) + len(right) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

func tokenSet(text string) map[string]bool {
	tokens := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	out := make(map[string]bool, len(tokens))
	for _, token := range tokens {
		if len(token) < 3 {
			continue
		}
		out[token] = true
	}
	return out
}

func mergeMatches(matches []Match, threshold float64) []Match {
	byID := make(map[string]Match, len(matches))
	for _, match := range matches {
		if match.ID == "" || match.Score < threshold {
			continue
		}
		existing, ok := byID[match.ID]
		if !ok || match.Score > existing.Score {
			match.MatchedBy = appendUnique(existing.MatchedBy, match.MatchedBy...)
			byID[match.ID] = match
			continue
		}
		existing.MatchedBy = appendUnique(existing.MatchedBy, match.MatchedBy...)
		byID[match.ID] = existing
	}
	merged := make([]Match, 0, len(byID))
	for _, match := range byID {
		merged = append(merged, match)
	}
	sortMatches(merged)
	return merged
}

func sortMatches(matches []Match) {
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Score != matches[j].Score {
			return matches[i].Score > matches[j].Score
		}
		return matches[i].Title < matches[j].Title
	})
}

func matchFromEntry(entry *models.MemoryEntry, score float64, matchedBy []string, snippet string) Match {
	return Match{
		ID:        entry.ID,
		Title:     entry.Title,
		Layer:     entry.Layer,
		Category:  entry.Category,
		Status:    entry.Status,
		Score:     score,
		MatchedBy: matchedBy,
		Snippet:   truncate(strings.TrimSpace(snippet), 220),
		Tags:      append([]string(nil), entry.Tags...),
	}
}

func cloneMemory(entry *models.MemoryEntry) *models.MemoryEntry {
	if entry == nil {
		return nil
	}
	clone := *entry
	clone.Tags = append([]string(nil), entry.Tags...)
	clone.Sources = append([]string(nil), entry.Sources...)
	clone.LifecycleMetadataMissing = append([]string(nil), entry.LifecycleMetadataMissing...)
	if entry.Metadata != nil {
		clone.Metadata = make(map[string]string, len(entry.Metadata))
		for key, value := range entry.Metadata {
			clone.Metadata[key] = value
		}
	}
	return &clone
}

func candidateSearchText(entry *models.MemoryEntry) string {
	if entry == nil {
		return ""
	}
	return strings.TrimSpace(strings.Join([]string{entry.Title, entry.Category, strings.Join(entry.Tags, " "), entry.Content}, "\n"))
}

func normalizedText(text string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(text))), " ")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func appendUnique(existing []string, values ...string) []string {
	seen := make(map[string]bool, len(existing)+len(values))
	out := make([]string, 0, len(existing)+len(values))
	for _, value := range existing {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func truncate(text string, maxLen int) string {
	if maxLen <= 0 || len(text) <= maxLen {
		return text
	}
	return strings.TrimSpace(text[:maxLen]) + "..."
}
