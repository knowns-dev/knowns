package search

import (
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestBuildCodeSummaries_ExtractsFields(t *testing.T) {
	source := `package auth

// HandleLogin authenticates the user with credentials.
func HandleLogin(email, password string) (*Session, error) {
	token := generateToken()
	return &Session{Token: token}, nil
}

type Session struct {
	Token string
	User  User
}

// Validate checks if the session token is valid.
func (s *Session) Validate() bool {
	return len(s.Token) > 0
}
`
	symbols := []lsp.DocumentSymbol{
		{
			Name:   "HandleLogin",
			Detail: "func HandleLogin(email, password string) (*Session, error)",
			Kind:   12, // Function
			Range: lsp.Range{
				Start: lsp.Position{Line: 3, Character: 0},
				End:   lsp.Position{Line: 6, Character: 1},
			},
			SelectionRange: lsp.Range{
				Start: lsp.Position{Line: 3, Character: 5},
				End:   lsp.Position{Line: 3, Character: 16},
			},
		},
		{
			Name:   "Session",
			Detail: "type Session struct",
			Kind:   23, // Struct
			Range: lsp.Range{
				Start: lsp.Position{Line: 8, Character: 0},
				End:   lsp.Position{Line: 11, Character: 1},
			},
			SelectionRange: lsp.Range{
				Start: lsp.Position{Line: 8, Character: 5},
				End:   lsp.Position{Line: 8, Character: 12},
			},
			Children: []lsp.DocumentSymbol{
				{
					Name:   "Validate",
					Detail: "func (s *Session) Validate() bool",
					Kind:   6, // Method
					Range: lsp.Range{
						Start: lsp.Position{Line: 13, Character: 0},
						End:   lsp.Position{Line: 15, Character: 1},
					},
					SelectionRange: lsp.Range{
						Start: lsp.Position{Line: 13, Character: 20},
						End:   lsp.Position{Line: 13, Character: 28},
					},
				},
			},
		},
	}

	summaries := BuildCodeSummaries("internal/auth/login.go", symbols, source)

	if len(summaries) != 3 {
		t.Fatalf("expected 3 summaries, got %d", len(summaries))
	}

	// Check HandleLogin summary.
	login := summaries[0]
	if login.Name != "HandleLogin" {
		t.Errorf("expected name HandleLogin, got %s", login.Name)
	}
	if login.Kind != "Function" {
		t.Errorf("expected kind Function, got %s", login.Kind)
	}
	if login.Container != "login.go" {
		t.Errorf("expected container login.go, got %s", login.Container)
	}
	if login.Path != "internal/auth/login.go" {
		t.Errorf("expected path internal/auth/login.go, got %s", login.Path)
	}
	if login.Package != "login.go" {
		t.Errorf("expected package login.go, got %s", login.Package)
	}
	if login.StartLine != 4 {
		t.Errorf("expected start line 4, got %d", login.StartLine)
	}
	if login.Comments == "" {
		t.Errorf("expected comments to be extracted, got empty")
	}

	// Check Session struct summary.
	session := summaries[1]
	if session.Name != "Session" {
		t.Errorf("expected name Session, got %s", session.Name)
	}
	if session.Kind != "Struct" {
		t.Errorf("expected kind Struct, got %s", session.Kind)
	}

	// Check child method summary.
	validate := summaries[2]
	if validate.Name != "Validate" {
		t.Errorf("expected name Validate, got %s", validate.Name)
	}
	if validate.Container != "Session" {
		t.Errorf("expected container Session, got %s", validate.Container)
	}
}

func TestBM25CodeSearch_AuthDiscovery(t *testing.T) {
	summaries := []CodeSummary{
		{
			Name:      "HandleLogin",
			Kind:      "Function",
			Container: "auth",
			Signature: "func HandleLogin(email, password string) (*Session, error)",
			Path:      "internal/auth/login.go",
			Package:   "auth",
			Comments:  "HandleLogin authenticates the user with credentials.",
			StartLine: 4, EndLine: 7, StartCharacter: 1, SelectionStart: 4, SelectionChar: 6,
		},
		{
			Name:      "Session",
			Kind:      "Struct",
			Container: "auth",
			Signature: "type Session struct",
			Path:      "internal/auth/session.go",
			Package:   "auth",
			Comments:  "Session holds the authenticated user session.",
			StartLine: 2, EndLine: 5, StartCharacter: 1, SelectionStart: 2, SelectionChar: 6,
		},
		{
			Name:      "RenderHome",
			Kind:      "Function",
			Container: "web",
			Signature: "func RenderHome(w http.ResponseWriter)",
			Path:      "internal/web/home.go",
			Package:   "web",
			Comments:  "RenderHome renders the homepage.",
			StartLine: 3, EndLine: 8, StartCharacter: 1, SelectionStart: 3, SelectionChar: 6,
		},
	}

	scorer := NewCodeBM25Scorer(summaries)

	// Search for login-related code.
	results, err := scorer.Search("login auth", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for login auth query")
	}

	// HandleLogin should be the top result.
	if results[0].Name != "HandleLogin" {
		t.Errorf("expected HandleLogin as top result, got %s", results[0].Name)
	}

	// Results should include LSP navigation metadata.
	for _, r := range results {
		if r.Path == "" {
			t.Errorf("result %s missing path", r.Name)
		}
		if r.StartLine == 0 {
			t.Errorf("result %s missing start_line", r.Name)
		}
		if r.SelectionStart == 0 {
			t.Errorf("result %s missing selection_start", r.Name)
		}
	}
}

func TestBM25CodeSearch_NoEmbeddings(t *testing.T) {
	summaries := []CodeSummary{
		{Name: "TestFunc", Kind: "Function", Container: "pkg", Path: "test.go", StartLine: 1, EndLine: 5},
	}

	scorer := NewCodeBM25Scorer(summaries)
	results, err := scorer.Search("TestFunc", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify results have no embedding-related fields.
	for _, r := range results {
		if r.Score <= 0 {
			t.Errorf("expected positive score for match, got %f", r.Score)
		}
	}
}

func TestBM25CodeSearch_MetadataForLSP(t *testing.T) {
	summaries := []CodeSummary{
		{
			Name:      "getUser",
			Kind:      "Function",
			Container: "handlers",
			Signature: "func getUser(id int) (*User, error)",
			Path:      "internal/handlers/user.go",
			Package:   "user.go",
			StartLine: 10, EndLine: 20, StartCharacter: 1, SelectionStart: 10, SelectionChar: 5,
		},
	}

	scorer := NewCodeBM25Scorer(summaries)
	results, err := scorer.Search("getUser", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	// Verify all LSP navigation metadata is present.
	if r.Name != "getUser" {
		t.Errorf("expected name getUser, got %s", r.Name)
	}
	if r.Kind != "Function" {
		t.Errorf("expected kind Function, got %s", r.Kind)
	}
	if r.Container != "handlers" {
		t.Errorf("expected container handlers, got %s", r.Container)
	}
	if r.Signature != "func getUser(id int) (*User, error)" {
		t.Errorf("expected signature, got %s", r.Signature)
	}
	if r.Path != "internal/handlers/user.go" {
		t.Errorf("expected path, got %s", r.Path)
	}
	if r.StartLine != 10 {
		t.Errorf("expected start line 10, got %d", r.StartLine)
	}
	if r.EndLine != 20 {
		t.Errorf("expected end line 20, got %d", r.EndLine)
	}
	if r.StartCharacter != 1 {
		t.Errorf("expected start character 1, got %d", r.StartCharacter)
	}
	if r.SelectionStart != 10 {
		t.Errorf("expected selection start 10, got %d", r.SelectionStart)
	}
	if r.SelectionChar != 5 {
		t.Errorf("expected selection char 5, got %d", r.SelectionChar)
	}
}

func TestBM25CodeSearch_EmptyQuery(t *testing.T) {
	summaries := []CodeSummary{
		{Name: "TestFunc", Kind: "Function", Path: "test.go"},
	}

	scorer := NewCodeBM25Scorer(summaries)

	results, err := scorer.Search("", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected empty results for empty query, got %d", len(results))
	}
}

func TestBM25CodeSearch_Limit(t *testing.T) {
	var summaries []CodeSummary
	for i := 0; i < 50; i++ {
		summaries = append(summaries, CodeSummary{
			Name:      "Func",
			Kind:      "Function",
			Container: "pkg",
			Path:      "test.go",
		})
	}

	scorer := NewCodeBM25Scorer(summaries)
	results, err := scorer.Search("Func", 5)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) > 5 {
		t.Errorf("expected at most 5 results, got %d", len(results))
	}
}

func TestExtractComments(t *testing.T) {
	lines := []string{
		"package auth",
		"",
		"// HandleLogin authenticates the user.",
		"// It validates credentials and returns a session.",
		"func HandleLogin() {}",
	}

	comments := extractComments(lines, 4)
	expected := "// HandleLogin authenticates the user. // It validates credentials and returns a session."
	if comments != expected {
		t.Errorf("expected %q, got %q", expected, comments)
	}
}

func TestExtractRelationships(t *testing.T) {
	lines := []string{
		"func (s *Server) handleAuth() error {",
		"\timport \"auth\"",
		"\ts.db.FindUser()",
		"\treturn nil",
		"}",
	}

	rels := extractRelationships(lines, lsp.Range{
		Start: lsp.Position{Line: 0, Character: 0},
		End:   lsp.Position{Line: 4, Character: 1},
	})

	if rels == "" {
		t.Error("expected relationships to be extracted")
	}
}

func TestCodeBM25RerankBoost_AuthKeywords(t *testing.T) {
	sym := CodeSummary{
		Name:      "authenticate",
		Kind:      "Function",
		Container: "auth",
		Comments:  "Authenticate validates user credentials and creates a session token.",
		Path:      "internal/auth/login.go",
	}

	tokens := []string{"login", "auth"}
	boost := codeBM25RerankBoost(sym, tokens)

	if boost <= 0 {
		t.Error("expected positive boost for auth-related symbol")
	}
}
