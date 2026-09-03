package decisionreview

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

	ResolutionSupersedeExisting = "supersede_existing"
	ResolutionCreateDraft       = "create_draft"
	ResolutionLinkAsRelated     = "link_as_related"
	ResolutionRejectNew         = "reject_new"
	ResolutionAcceptNew         = "accept_new"

	MatchDuplicate = "duplicate"
	MatchConflict  = "conflict"

	defaultReviewLimit     = 5
	defaultReviewThreshold = 0.72
)

var AllowedResolutions = []string{
	ResolutionSupersedeExisting,
	ResolutionLinkAsRelated,
	ResolutionRejectNew,
}

var ReadyResolutions = []string{
	ResolutionAcceptNew,
	ResolutionRejectNew,
}

type SemanticSearchFunc func(candidate *models.DecisionEntry, limit int) ([]Match, error)

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

type AcceptOptions struct {
	Supersedes []string
}

type ResolveOptions struct {
	CandidateID   string
	Resolution    string
	TargetID      string
	ReplacementID string
	Status        string
}

type Result struct {
	Status              string                  `json:"status"`
	Resolution          string                  `json:"resolution,omitempty"`
	Candidate           *models.DecisionEntry   `json:"candidate,omitempty"`
	Matches             []Match                 `json:"matches,omitempty"`
	AllowedResolutions  []string                `json:"allowedResolutions,omitempty"`
	Decision            *models.DecisionEntry   `json:"decision,omitempty"`
	Superseded          *models.DecisionEntry   `json:"superseded,omitempty"`
	Current             *models.DecisionEntry   `json:"current,omitempty"`
	ChangedIDs          []string                `json:"changedIds,omitempty"`
	SupersededDecisions []*models.DecisionEntry `json:"supersededDecisions,omitempty"`
	PendingVerification bool                    `json:"pendingVerification,omitempty"`
}

type Match struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Status    string   `json:"status,omitempty"`
	Score     float64  `json:"score"`
	Kind      string   `json:"kind,omitempty"`
	MatchedBy []string `json:"matchedBy,omitempty"`
	Snippet   string   `json:"snippet,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	// Hash pins the matched decision's content as the reviewer saw it.
	Hash string `json:"hash,omitempty"`
}

func New(store *storage.Store) *Service {
	return &Service{Store: store}
}

func (s *Service) Add(candidate *models.DecisionEntry, opts AddOptions) (*Result, error) {
	entry, err := s.normalizeCandidate(candidate, opts.Status)
	if err != nil {
		return nil, err
	}
	if entry.Status != models.DecisionStatusDraft {
		return nil, fmt.Errorf("new System Decisions must start as draft; create the draft, link evidence, then accept it after verification")
	}
	if opts.SkipReview {
		return s.create(entry, ResultCreated, "")
	}
	matches, blockers, err := s.evaluateCandidate(entry)
	if err != nil {
		return nil, err
	}
	s.applyReviewMetadata(entry, matches, blockers)
	created, err := s.create(entry, ResultCreated, "")
	if err != nil {
		return nil, err
	}
	if entry.ReviewState != models.DecisionReviewStateNeedsResolution {
		return created, nil
	}
	return &Result{
		Status:             ResultReviewRequired,
		Candidate:          entry,
		Decision:           entry,
		Matches:            matches,
		AllowedResolutions: append([]string(nil), entry.ReviewAllowedResolutions...),
		ChangedIDs:         []string{entry.ID},
	}, nil
}

// Accept verifies linked evidence and transitions a draft System Decision to
// current guidance. Replacement supersession, when requested, is committed in
// the same storage transaction as acceptance.
func (s *Service) Accept(id string, opts AcceptOptions) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("decision ID is required")
	}
	entry, err := s.Store.Decisions.Get(id)
	if err != nil {
		return nil, err
	}
	if entry.Status == models.DecisionStatusDraft {
		matches, blockers, err := s.evaluateCandidate(entry)
		if err != nil {
			return nil, err
		}
		s.applyReviewMetadata(entry, matches, blockers)
		if err := s.Store.Decisions.Update(entry); err != nil {
			return nil, err
		}
		if len(blockers) > 0 {
			return nil, fmt.Errorf("%s", blockers[0])
		}
		if len(matches) > 0 && len(opts.Supersedes) == 0 {
			return nil, fmt.Errorf("decision %q needs duplicate/conflict resolution before acceptance", id)
		}
	}
	evidence, err := s.verificationEvidence(entry)
	if err != nil {
		return nil, err
	}
	accepted, superseded, err := s.Store.Decisions.Accept(id, evidence, opts.Supersedes, s.now())
	if err != nil {
		return nil, err
	}
	changed := []string{accepted.ID}
	for _, old := range superseded {
		changed = append(changed, old.ID)
	}
	result := &Result{
		Status:              ResultResolved,
		Decision:            accepted,
		Current:             accepted,
		SupersededDecisions: superseded,
		ChangedIDs:          changed,
	}
	if len(superseded) > 0 {
		result.Superseded = superseded[0]
	}
	return result, nil
}

func (s *Service) Review(candidate *models.DecisionEntry) (*Result, error) {
	entry, err := s.normalizeCandidate(candidate, "")
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

// ReviewCandidates returns unresolved persisted candidates. Legacy Decision
// Memory migration drafts remain isolated from the normal review inbox.
func (s *Service) ReviewCandidates() ([]*models.DecisionEntry, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	entries, err := s.Store.Decisions.List()
	if err != nil {
		return nil, err
	}
	candidates := make([]*models.DecisionEntry, 0)
	for _, entry := range entries {
		if entry.Status != models.DecisionStatusDraft || decisionHasTag(entry, "legacy-memory-migration") {
			continue
		}
		if entry.ReviewState == "" {
			entry, err = s.RefreshCandidate(entry.ID)
			if err != nil {
				return nil, err
			}
		}
		if entry.CandidateForReviewInbox() {
			candidates = append(candidates, entry)
		}
	}
	return candidates, nil
}

// RefreshCandidate reruns review checks after evidence or provenance changes
// and persists the new actionable state.
func (s *Service) RefreshCandidate(id string) (*models.DecisionEntry, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	entry, err := s.Store.Decisions.Get(strings.TrimSpace(id))
	if err != nil {
		return nil, err
	}
	if entry.Status != models.DecisionStatusDraft {
		return entry, nil
	}
	matches, blockers, err := s.evaluateCandidate(entry)
	if err != nil {
		return nil, err
	}
	s.applyReviewMetadata(entry, matches, blockers)
	if err := s.Store.Decisions.Update(entry); err != nil {
		return nil, err
	}
	return s.Store.Decisions.Get(entry.ID)
}

func (s *Service) evaluateCandidate(entry *models.DecisionEntry) ([]Match, []string, error) {
	review, err := s.Review(entry)
	if err != nil {
		return nil, nil, err
	}
	var matches []Match
	if review != nil {
		matches = append(matches, review.Matches...)
	}
	var blockers []string
	if _, err := s.verificationEvidence(entry); err != nil {
		blockers = append(blockers, candidateRepairGuidance(err.Error()))
	}
	return matches, blockers, nil
}

func (s *Service) applyReviewMetadata(entry *models.DecisionEntry, matches []Match, blockers []string) {
	if entry == nil {
		return
	}
	entry.ReviewBlockers = appendUnique(nil, blockers...)
	entry.ReviewMatches = persistedMatches(matches)
	entry.ReviewAllowedResolutions = nil
	switch {
	case len(entry.ReviewBlockers) > 0:
		entry.ReviewState = models.DecisionReviewStateNeedsEvidence
	case len(entry.ReviewMatches) > 0:
		entry.ReviewState = models.DecisionReviewStateNeedsResolution
		entry.ReviewAllowedResolutions = append([]string(nil), AllowedResolutions...)
	default:
		entry.ReviewState = models.DecisionReviewStateReadyForReview
		entry.ReviewAllowedResolutions = append([]string(nil), ReadyResolutions...)
	}
	evaluatedAt := s.now().UTC()
	entry.ReviewEvaluatedAt = &evaluatedAt
	// Record which state was judged, not only when. The hash is taken after
	// the review fields are set and deliberately excludes them, so writing the
	// review cannot invalidate its own watermark.
	entry.ReviewEvaluatedHash = storage.CanonicalDecisionHash(entry)
}

func candidateRepairGuidance(message string) string {
	message = strings.TrimSpace(message)
	message = strings.ReplaceAll(message, `decision ""`, "candidate")
	if message == "" {
		return "Review evidence could not be verified; add a readable source and completed linked task, then retry."
	}
	return message
}

func persistedMatches(matches []Match) []models.DecisionReviewMatch {
	persisted := make([]models.DecisionReviewMatch, 0, len(matches))
	for _, match := range matches {
		persisted = append(persisted, models.DecisionReviewMatch{
			ID:        match.ID,
			Title:     match.Title,
			Status:    match.Status,
			Score:     match.Score,
			Hash:      match.Hash,
			Kind:      match.Kind,
			MatchedBy: append([]string(nil), match.MatchedBy...),
			Snippet:   strings.Join(strings.Fields(match.Snippet), " "),
			Tags:      append([]string(nil), match.Tags...),
		})
	}
	return persisted
}

func (s *Service) Resolve(candidate *models.DecisionEntry, opts ResolveOptions) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if opts.Resolution == "" {
		return nil, fmt.Errorf("resolution is required")
	}
	candidateID := strings.TrimSpace(opts.CandidateID)
	if candidateID == "" && candidate != nil && candidate.ID != "" && candidate.ID != opts.TargetID {
		if _, err := s.Store.Decisions.Get(candidate.ID); err == nil {
			candidateID = candidate.ID
		}
	}
	if candidateID != "" {
		return s.resolvePersistedCandidate(candidateID, opts)
	}
	switch opts.Resolution {
	case ResolutionSupersedeExisting:
		return s.supersedeExisting(candidate, opts)
	case ResolutionCreateDraft:
		input := cloneDecision(candidate)
		if input == nil {
			input = &models.DecisionEntry{}
		}
		input.Status = models.DecisionStatusDraft
		entry, err := s.normalizeCandidate(input, models.DecisionStatusDraft)
		if err != nil {
			return nil, err
		}
		return s.create(entry, ResultResolved, opts.Resolution)
	case ResolutionLinkAsRelated:
		return s.linkAsRelated(candidate, opts)
	case ResolutionRejectNew:
		input := cloneDecision(candidate)
		if input == nil {
			input = &models.DecisionEntry{}
		}
		input.Status = models.DecisionStatusRejected
		entry, err := s.normalizeCandidate(input, models.DecisionStatusRejected)
		if err != nil {
			return nil, err
		}
		return s.create(entry, ResultResolved, opts.Resolution)
	default:
		return nil, fmt.Errorf("unsupported decision review resolution: %s", opts.Resolution)
	}
}

func (s *Service) resolvePersistedCandidate(candidateID string, opts ResolveOptions) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	candidate, err := s.Store.Decisions.Get(candidateID)
	if err != nil {
		return nil, err
	}
	switch opts.Resolution {
	case ResolutionAcceptNew:
		if candidate.Status == models.DecisionStatusAccepted {
			return s.Accept(candidate.ID, AcceptOptions{})
		}
		candidate, err = s.RefreshCandidate(candidate.ID)
		if err != nil {
			return nil, err
		}
		if candidate.ReviewState != models.DecisionReviewStateReadyForReview {
			return nil, fmt.Errorf("decision %q is %s; accept_new requires ready_for_review", candidate.ID, candidate.ReviewState)
		}
		result, err := s.Accept(candidate.ID, AcceptOptions{})
		if err == nil {
			result.Resolution = opts.Resolution
		}
		return result, err

	case ResolutionSupersedeExisting:
		if strings.TrimSpace(opts.TargetID) == "" {
			return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
		}
		if candidate.Status == models.DecisionStatusAccepted {
			return s.Accept(candidate.ID, AcceptOptions{Supersedes: []string{opts.TargetID}})
		}
		candidate, err = s.RefreshCandidate(candidate.ID)
		if err != nil {
			return nil, err
		}
		if candidate.ReviewState == models.DecisionReviewStateNeedsEvidence {
			return nil, fmt.Errorf("decision %q needs evidence before replacement", candidate.ID)
		}
		if !candidateHasReviewMatch(candidate, opts.TargetID) {
			return nil, fmt.Errorf("target decision %q is not a persisted review match for candidate %q", opts.TargetID, candidate.ID)
		}
		result, err := s.Accept(candidate.ID, AcceptOptions{Supersedes: []string{opts.TargetID}})
		if err == nil {
			result.Resolution = opts.Resolution
		}
		return result, err

	case ResolutionLinkAsRelated:
		if strings.TrimSpace(opts.TargetID) == "" {
			return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
		}
		if candidate.Status == models.DecisionStatusDraft {
			candidate, err = s.RefreshCandidate(candidate.ID)
			if err != nil {
				return nil, err
			}
			if candidate.ReviewState == models.DecisionReviewStateNeedsEvidence {
				return nil, fmt.Errorf("decision %q needs evidence before linking", candidate.ID)
			}
			if !candidateHasReviewMatch(candidate, opts.TargetID) {
				return nil, fmt.Errorf("target decision %q is not a persisted review match for candidate %q", opts.TargetID, candidate.ID)
			}
		}
		rejected, current, err := s.Store.Decisions.LinkCandidateToCurrent(candidate.ID, opts.TargetID, s.now())
		if err != nil {
			return nil, err
		}
		return &Result{
			Status:     ResultResolved,
			Resolution: opts.Resolution,
			Decision:   rejected,
			Current:    current,
			ChangedIDs: []string{rejected.ID, current.ID},
		}, nil

	case ResolutionRejectNew:
		rejected, err := s.Store.Decisions.RejectCandidate(candidate.ID, s.now())
		if err != nil {
			return nil, err
		}
		return &Result{
			Status:     ResultResolved,
			Resolution: opts.Resolution,
			Decision:   rejected,
			ChangedIDs: []string{rejected.ID},
		}, nil

	case ResolutionCreateDraft:
		if candidate.Status != models.DecisionStatusDraft {
			return nil, fmt.Errorf("decision %q is not a draft candidate", candidate.ID)
		}
		return &Result{
			Status:              ResultResolved,
			Resolution:          opts.Resolution,
			Decision:            candidate,
			ChangedIDs:          []string{candidate.ID},
			PendingVerification: true,
		}, nil
	default:
		return nil, fmt.Errorf("unsupported decision review resolution: %s", opts.Resolution)
	}
}

func candidateHasReviewMatch(candidate *models.DecisionEntry, targetID string) bool {
	for _, match := range candidate.ReviewMatches {
		if match.ID == targetID {
			return true
		}
	}
	return false
}

func decisionHasTag(entry *models.DecisionEntry, tag string) bool {
	if entry == nil {
		return false
	}
	for _, value := range entry.Tags {
		if value == tag {
			return true
		}
	}
	return false
}

func (s *Service) supersedeExisting(candidate *models.DecisionEntry, opts ResolveOptions) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if opts.TargetID == "" {
		return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
	}
	if _, err := s.Store.Decisions.Get(opts.TargetID); err != nil {
		return nil, err
	}

	newID := opts.ReplacementID
	if newID == "" {
		input := cloneDecision(candidate)
		if input == nil {
			input = &models.DecisionEntry{}
		}
		if input.ID == opts.TargetID {
			input.ID = ""
		}
		input.Status = models.DecisionStatusDraft
		entry, err := s.normalizeCandidate(input, models.DecisionStatusDraft)
		if err != nil {
			return nil, err
		}
		created, err := s.create(entry, ResultResolved, opts.Resolution)
		if err != nil {
			return nil, err
		}
		created.Current, _ = s.Store.Decisions.Get(opts.TargetID)
		created.PendingVerification = true
		return created, nil
	} else if _, err := s.Store.Decisions.Get(newID); err != nil {
		return nil, err
	}

	oldDecision, newDecision, err := s.Store.Decisions.Supersede(opts.TargetID, newID)
	if err != nil {
		return nil, err
	}
	return &Result{
		Status:     ResultResolved,
		Resolution: opts.Resolution,
		Decision:   newDecision,
		Superseded: oldDecision,
		Current:    newDecision,
		ChangedIDs: []string{oldDecision.ID, newDecision.ID},
	}, nil
}

func (s *Service) verificationEvidence(entry *models.DecisionEntry) ([]string, error) {
	if entry == nil {
		return nil, fmt.Errorf("decision is required")
	}
	if len(entry.Sources) == 0 {
		return nil, fmt.Errorf("decision %q needs at least one source before acceptance", entry.ID)
	}
	evidence := make([]string, 0, len(entry.Sources)+len(entry.RelatedTasks))
	for _, source := range entry.Sources {
		source = strings.TrimSpace(source)
		if source == "" {
			continue
		}
		if err := s.verifySource(source); err != nil {
			return nil, err
		}
		evidence = append(evidence, "source:"+source)
	}

	taskIDs := normalizeRelatedTaskIDs(entry.RelatedTasks)
	for _, relatedDoc := range entry.RelatedDocs {
		path := normalizeRelatedDocPath(relatedDoc)
		if path == "" {
			continue
		}
		if _, err := s.Store.Docs.Get(path); err != nil {
			return nil, fmt.Errorf("related doc %q is not readable: %w", path, err)
		}
		if strings.HasPrefix(path, "specs/") {
			tasks, err := s.Store.Tasks.ListAll()
			if err != nil {
				return nil, fmt.Errorf("list tasks linked to spec %q: %w", path, err)
			}
			for _, task := range tasks {
				if task.Spec == path {
					taskIDs = appendUnique(taskIDs, task.ID)
				}
			}
		}
	}
	if len(taskIDs) == 0 {
		return nil, fmt.Errorf("decision %q needs at least one linked task or a spec with linked tasks before acceptance", entry.ID)
	}
	for _, taskID := range taskIDs {
		task, err := s.Store.Tasks.Get(taskID)
		if err != nil {
			return nil, fmt.Errorf("linked task %q is not readable: %w", taskID, err)
		}
		if task.Status != "done" {
			return nil, fmt.Errorf("linked task %q is %q; all linked tasks must be done before accepting decision %q", taskID, task.Status, entry.ID)
		}
		for _, criterion := range task.AcceptanceCriteria {
			if !criterion.Completed {
				return nil, fmt.Errorf("linked task %q has unchecked acceptance criteria", taskID)
			}
		}
		evidence = append(evidence, "task:@task-"+taskID+":done")
	}
	return appendUnique(nil, evidence...), nil
}

func (s *Service) verifySource(source string) error {
	switch {
	case strings.HasPrefix(source, "@doc/"):
		path := normalizeRelatedDocPath(source)
		if _, err := s.Store.Docs.Get(path); err != nil {
			return fmt.Errorf("source %q is not readable: %w", source, err)
		}
	case strings.HasPrefix(source, "@task-"):
		id := strings.TrimPrefix(source, "@task-")
		if _, err := s.Store.Tasks.Get(id); err != nil {
			return fmt.Errorf("source %q is not readable: %w", source, err)
		}
	case strings.HasPrefix(source, "@task/"):
		id := strings.TrimPrefix(source, "@task/")
		if _, err := s.Store.Tasks.Get(id); err != nil {
			return fmt.Errorf("source %q is not readable: %w", source, err)
		}
	case strings.HasPrefix(source, "@decision/"):
		id := strings.TrimPrefix(source, "@decision/")
		if _, err := s.Store.Decisions.Get(id); err != nil {
			return fmt.Errorf("source %q is not readable: %w", source, err)
		}
	}
	return nil
}

func normalizeRelatedTaskIDs(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		value = strings.TrimPrefix(value, "@task-")
		value = strings.TrimPrefix(value, "@task/")
		value = strings.TrimPrefix(value, "task-")
		if value != "" {
			result = appendUnique(result, value)
		}
	}
	return result
}

func normalizeRelatedDocPath(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "@doc/")
	value = strings.TrimSuffix(value, ".md")
	return strings.TrimPrefix(value, "/")
}

func (s *Service) linkAsRelated(candidate *models.DecisionEntry, opts ResolveOptions) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if opts.TargetID == "" {
		return nil, fmt.Errorf("targetId is required for %s", opts.Resolution)
	}
	if _, err := s.Store.Decisions.Get(opts.TargetID); err != nil {
		return nil, err
	}
	input := cloneDecision(candidate)
	if input == nil {
		input = &models.DecisionEntry{}
	}
	if input.ID == opts.TargetID {
		input.ID = ""
	}
	input.Status = models.DecisionStatusDraft
	input.Sources = appendUnique(input.Sources, models.DecisionRef(opts.TargetID))
	entry, err := s.normalizeCandidate(input, models.DecisionStatusDraft)
	if err != nil {
		return nil, err
	}
	return s.create(entry, ResultResolved, opts.Resolution)
}

func (s *Service) create(entry *models.DecisionEntry, status, resolution string) (*Result, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	if err := s.Store.Decisions.Create(entry, storage.DecisionCreateOptions{Now: s.now()}); err != nil {
		return nil, err
	}
	result := &Result{Status: status, Decision: entry, ChangedIDs: []string{entry.ID}}
	if resolution != "" {
		result.Resolution = resolution
	}
	return result, nil
}

func (s *Service) normalizeCandidate(candidate *models.DecisionEntry, defaultStatus string) (*models.DecisionEntry, error) {
	if err := s.ensureStore(); err != nil {
		return nil, err
	}
	entry := cloneDecision(candidate)
	if entry == nil {
		entry = &models.DecisionEntry{}
	}
	entry.ID = strings.TrimSpace(entry.ID)
	entry.Title = strings.TrimSpace(entry.Title)
	entry.Status = firstNonEmpty(entry.Status, defaultStatus)
	entry.Content = strings.TrimSpace(entry.Content)
	entry.Context = strings.TrimSpace(entry.Context)
	entry.Decision = strings.TrimSpace(entry.Decision)
	entry.AlternativesConsidered = strings.TrimSpace(entry.AlternativesConsidered)
	entry.Consequences = strings.TrimSpace(entry.Consequences)
	entry.Tags = normalizeStringSlice(entry.Tags)
	entry.Sources = normalizeStringSlice(entry.Sources)
	entry.RelatedDocs = normalizeStringSlice(entry.RelatedDocs)
	entry.RelatedTasks = normalizeStringSlice(entry.RelatedTasks)
	if entry.Title == "" {
		return nil, fmt.Errorf("decision title is required")
	}
	entry.ApplyDecisionDefaults()
	if !models.ValidDecisionStatus(entry.Status) {
		return nil, fmt.Errorf("invalid decision status: %q", entry.Status)
	}
	if entry.ID != "" && !models.ValidDecisionID(entry.ID) {
		return nil, fmt.Errorf("invalid decision ID: %q", entry.ID)
	}
	return entry, nil
}

func (s *Service) ensureStore() error {
	if s == nil || s.Store == nil || s.Store.Decisions == nil {
		return fmt.Errorf("decision store unavailable")
	}
	return nil
}

func (s *Service) semanticMatches(candidate *models.DecisionEntry) ([]Match, error) {
	if s.SemanticSearch != nil {
		return s.SemanticSearch(candidate, s.limit())
	}
	response, err := search.SearchWithRuntime(s.Store, search.SearchOptions{
		Query: candidateSearchText(candidate),
		Type:  "decision",
		Mode:  string(search.ModeSemantic),
		Limit: s.limit(),
	})
	if err != nil {
		return nil, err
	}
	matches := make([]Match, 0, len(response.Results))
	for _, result := range response.Results {
		if result.ID == "" || result.ID == candidate.ID || result.Type != "decision" || result.Score < s.threshold() {
			continue
		}
		entry, err := s.Store.Decisions.Get(result.ID)
		if err != nil || !entry.CurrentForDefaultRetrieval() {
			continue
		}
		matches = append(matches, matchFromEntry(entry, result.Score, MatchDuplicate, append([]string(nil), result.MatchedBy...), result.Snippet))
	}
	return matches, nil
}

func (s *Service) lexicalMatches(candidate *models.DecisionEntry) []Match {
	entries, err := s.Store.Decisions.List()
	if err != nil {
		return nil
	}
	matches := make([]Match, 0)
	for _, entry := range entries {
		if entry.ID == candidate.ID || !entry.CurrentForDefaultRetrieval() {
			continue
		}
		score, kind, reasons := lexicalScore(candidate, entry)
		if score < s.threshold() {
			continue
		}
		matches = append(matches, matchFromEntry(entry, score, kind, reasons, candidateSnippet(entry)))
	}
	sortMatches(matches)
	return matches
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
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

func lexicalScore(candidate, existing *models.DecisionEntry) (float64, string, []string) {
	candidateTitle := normalizedText(candidate.Title)
	existingTitle := normalizedText(existing.Title)
	candidateDecision := normalizedText(decisionBodyText(candidate))
	existingDecision := normalizedText(decisionBodyText(existing))
	candidateAll := normalizedText(candidateSearchText(candidate))
	existingAll := normalizedText(candidateSearchText(existing))

	best := 0.0
	kind := ""
	var reasons []string
	if candidateTitle != "" && candidateTitle == existingTitle {
		best = math.Max(best, 0.98)
		kind = MatchDuplicate
		reasons = append(reasons, "lexical:title")
	}
	if candidateDecision != "" && candidateDecision == existingDecision {
		best = math.Max(best, 1.0)
		kind = MatchDuplicate
		reasons = append(reasons, "lexical:decision")
	}
	for label, score := range map[string]float64{
		"lexical:title_tokens":    tokenSimilarity(candidateTitle, existingTitle),
		"lexical:decision_tokens": tokenSimilarity(candidateDecision, existingDecision),
		"lexical:combined":        tokenSimilarity(candidateAll, existingAll),
	} {
		if score > best {
			best = score
		}
		if score >= defaultReviewThreshold {
			if kind == "" {
				kind = MatchDuplicate
			}
			reasons = append(reasons, label)
		}
	}

	if overlap, ok := conflictTopicOverlap(candidateTitle, existingTitle); ok {
		best = math.Max(best, 0.82+math.Min(float64(overlap-2)*0.03, 0.09))
		if kind == "" {
			kind = MatchConflict
		}
		reasons = append(reasons, "lexical:conflict_topic")
	}
	if kind == "" && best >= defaultReviewThreshold {
		kind = MatchDuplicate
		reasons = append(reasons, "lexical")
	}
	return best, kind, reasons
}

func conflictTopicOverlap(a, b string) (int, bool) {
	left := significantTokenSet(a)
	right := significantTokenSet(b)
	if len(left) == 0 || len(right) == 0 {
		return 0, false
	}
	overlap := 0
	for token := range left {
		if right[token] {
			overlap++
		}
	}
	return overlap, overlap >= 2 && strings.TrimSpace(a) != strings.TrimSpace(b)
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

func significantTokenSet(text string) map[string]bool {
	tokens := tokenSet(text)
	for _, stop := range []string{"and", "are", "but", "for", "from", "new", "old", "our", "the", "this", "that", "use", "uses", "using", "with"} {
		delete(tokens, stop)
	}
	return tokens
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

func matchFromEntry(entry *models.DecisionEntry, score float64, kind string, matchedBy []string, snippet string) Match {
	return Match{
		ID:        entry.ID,
		Title:     entry.Title,
		Status:    entry.Status,
		Score:     score,
		Kind:      kind,
		MatchedBy: matchedBy,
		Snippet:   truncate(strings.TrimSpace(snippet), 220),
		Tags:      append([]string(nil), entry.Tags...),
		Hash:      storage.CanonicalDecisionHash(entry),
	}
}

func cloneDecision(entry *models.DecisionEntry) *models.DecisionEntry {
	if entry == nil {
		return nil
	}
	clone := *entry
	clone.Supersedes = append([]string(nil), entry.Supersedes...)
	clone.SupersededBy = append([]string(nil), entry.SupersededBy...)
	clone.Tags = append([]string(nil), entry.Tags...)
	clone.Sources = append([]string(nil), entry.Sources...)
	clone.RelatedDocs = append([]string(nil), entry.RelatedDocs...)
	clone.RelatedTasks = append([]string(nil), entry.RelatedTasks...)
	clone.Verification = append([]string(nil), entry.Verification...)
	clone.ReviewBlockers = append([]string(nil), entry.ReviewBlockers...)
	clone.ReviewAllowedResolutions = append([]string(nil), entry.ReviewAllowedResolutions...)
	clone.ReviewMatches = make([]models.DecisionReviewMatch, len(entry.ReviewMatches))
	for i, match := range entry.ReviewMatches {
		clone.ReviewMatches[i] = match
		clone.ReviewMatches[i].MatchedBy = append([]string(nil), match.MatchedBy...)
		clone.ReviewMatches[i].Tags = append([]string(nil), match.Tags...)
	}
	return &clone
}

func candidateSearchText(entry *models.DecisionEntry) string {
	if entry == nil {
		return ""
	}
	return strings.TrimSpace(strings.Join([]string{
		entry.Title,
		strings.Join(entry.Tags, " "),
		strings.Join(entry.Sources, " "),
		strings.Join(entry.RelatedDocs, " "),
		strings.Join(entry.RelatedTasks, " "),
		decisionBodyText(entry),
	}, "\n"))
}

func decisionBodyText(entry *models.DecisionEntry) string {
	if entry == nil {
		return ""
	}
	return strings.TrimSpace(strings.Join([]string{
		entry.Decision,
		entry.Context,
		entry.AlternativesConsidered,
		entry.Consequences,
		entry.Content,
	}, "\n"))
}

func candidateSnippet(entry *models.DecisionEntry) string {
	text := decisionBodyText(entry)
	if text != "" {
		return text
	}
	return entry.Title
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

func normalizeStringSlice(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func appendUnique(existing []string, values ...string) []string {
	seen := make(map[string]bool, len(existing)+len(values))
	out := make([]string, 0, len(existing)+len(values))
	for _, value := range existing {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
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
	if maxLen <= 3 {
		return text[:maxLen]
	}
	return text[:maxLen-3] + "..."
}
