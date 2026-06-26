package cli

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var docCmd = &cobra.Command{
	Use:   "doc",
	Short: "Manage documentation",
	Long:  "Create, view, and edit project documentation.",
	// Allow 'knowns doc <path>' as a shorthand for 'knowns doc view <path>'
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 {
			return cmd.Help()
		}
		// Treat first arg as doc path → delegate to view
		return runDocView(cmd, args[0])
	},
}

// --- doc list ---

var docListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all documentation files",
	RunE:  runDocList,
}

func runDocList(cmd *cobra.Command, args []string) error {
	store := getStore()
	tagFilter, _ := cmd.Flags().GetString("tag")

	docs, err := store.Docs.List()
	if err != nil {
		return fmt.Errorf("list docs: %w", err)
	}

	// Apply tag filter
	if tagFilter != "" {
		filtered := docs[:0]
		for _, d := range docs {
			if containsTag(d.Tags, tagFilter) {
				filtered = append(filtered, d)
			}
		}
		docs = filtered
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		printJSON(docs)
		return nil
	}

	if len(docs) == 0 {
		fmt.Println(StyleDim.Render("No documentation found."))
		return nil
	}

	if plain {
		page, _ := getPageOpts(cmd)
		total := len(docs)
		limit := defaultPlainItemLimit
		if page <= 0 {
			page = 1
		}
		start := (page - 1) * limit
		end := start + limit
		if start >= total {
			totalPages := (total + limit - 1) / limit
			fmt.Printf("PAGE: %d/%d (no more items)\n", page, totalPages)
			return nil
		}
		if end > total {
			end = total
		}
		pageDocs := docs[start:end]
		var pb strings.Builder
		for _, d := range pageDocs {
			fmt.Fprintf(&pb, "DOC: %s\n", d.Path)
			fmt.Fprintf(&pb, "  TITLE: %s\n", d.Title)
			if d.Description != "" {
				fmt.Fprintf(&pb, "  DESCRIPTION: %s\n", d.Description)
			}
			if len(d.Tags) > 0 {
				fmt.Fprintf(&pb, "  TAGS: %s\n", strings.Join(d.Tags, ", "))
			}
			if d.IsImported {
				fmt.Fprintf(&pb, "  IMPORTED FROM: %s\n", d.ImportSource)
			}
			fmt.Fprintln(&pb)
		}
		fmt.Print(pb.String())
		if total > limit {
			totalPages := (total + limit - 1) / limit
			fmt.Printf("PAGE: %d/%d (items %d-%d of %d)\n", page, totalPages, start+1, end, total)
			if page < totalPages {
				fmt.Printf("Use --page %d to see more results.\n", page+1)
			}
		}
	} else {
		if !isTTY() || isPagerDisabled(cmd) {
			content := renderDocList(docs)
			fmt.Print(content)
			return nil
		}
		items := buildDocListItems(store, docs)
		if err := RunListView("Documents", items); err != nil {
			content := renderDocList(docs)
			fmt.Print(content)
		}
	}
	return nil
}

// --- doc view ---

var docViewCmd = &cobra.Command{
	Use:   "view <path>",
	Short: "View a documentation file",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runDocView(cmd, args[0])
	},
}

func runDocView(cmd *cobra.Command, path string) error {
	store := getStore()

	doc, err := store.Docs.Get(path)
	if err != nil {
		return fmt.Errorf("doc %q not found", path)
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)
	tocOnly, _ := cmd.Flags().GetBool("toc")
	infoOnly, _ := cmd.Flags().GetBool("info")
	section, _ := cmd.Flags().GetString("section")
	lineParam, _ := cmd.Flags().GetString("line")
	smart, _ := cmd.Flags().GetBool("smart")

	if jsonOut {
		printJSON(doc)
		return nil
	}

	if infoOnly {
		if plain {
			fmt.Printf("PATH: %s\n", doc.Path)
			fmt.Printf("TITLE: %s\n", doc.Title)
			if doc.Description != "" {
				fmt.Printf("DESCRIPTION: %s\n", doc.Description)
			}
			fmt.Printf("SIZE: %d bytes\n", len(doc.Content))
			fmt.Printf("TAGS: %s\n", strings.Join(doc.Tags, ", "))
			fmt.Printf("UPDATED: %s\n", doc.UpdatedAt.Format("2006-01-02"))
		} else {
			content := renderDocInfo(doc)
			renderOrPage(cmd, fmt.Sprintf("Doc Info: %s", doc.Title), content)
		}
		return nil
	}

	if tocOnly {
		headings := extractHeadings(doc.Content)
		if plain {
			fmt.Printf("TOC: %s\n\n", doc.Title)
			for _, h := range headings {
				fmt.Printf("%s%s\n", strings.Repeat("  ", h.level-1), h.text)
			}
		} else {
			content := renderDocTOC(doc.Title, headings)
			renderOrPage(cmd, fmt.Sprintf("TOC: %s", doc.Title), content)
		}
		return nil
	}

	if section != "" {
		content := extractDocSection(doc.Content, section)
		if content == "" {
			return fmt.Errorf("section %q not found in %s", section, doc.Path)
		}
		fmt.Println(content)
		return nil
	}

	if lineParam != "" {
		lineContent, lineLabel, err := extractDocLines(doc.Content, lineParam)
		if err != nil {
			return err
		}
		if plain {
			fmt.Printf("PATH: %s\nLINES: %s\n\n%s\n", doc.Path, lineLabel, lineContent)
		} else {
			fmt.Printf("Lines %s of %s:\n\n%s\n", lineLabel, doc.Title, lineContent)
		}
		return nil
	}

	// Smart mode: return full content if small, stats+toc if large
	if smart {
		const tokenLimit = 2000
		approxTokens := approximateDocTokens(doc.Content)
		if approxTokens > tokenLimit {
			// Print stats + TOC
			if plain {
				fmt.Print(renderSmartDocSummary(doc))
			} else {
				fmt.Println(RenderWarning(fmt.Sprintf("Document too large for smart mode (size: %s chars, ~%s tokens).", formatWithCommas(utf8.RuneCountInString(doc.Content)), formatWithCommas(approxTokens))))
				fmt.Println(RenderHint("Use " + RenderCmd("--toc") + " to view the table of contents, or " + RenderCmd("--section") + " to view a specific section."))
			}
			return nil
		}
	}

	// Full content
	if plain {
		var pb strings.Builder
		fmt.Fprintf(&pb, "PATH: %s\n", doc.Path)
		fmt.Fprintf(&pb, "TITLE: %s\n", doc.Title)
		if doc.Description != "" {
			fmt.Fprintf(&pb, "DESCRIPTION: %s\n", doc.Description)
		}
		if len(doc.Tags) > 0 {
			fmt.Fprintf(&pb, "TAGS: %s\n", strings.Join(doc.Tags, ", "))
		}
		if doc.IsImported {
			fmt.Fprintf(&pb, "IMPORTED FROM: %s\n", doc.ImportSource)
		}
		fmt.Fprintf(&pb, "UPDATED: %s\n\n", doc.UpdatedAt.Format("2006-01-02"))
		fmt.Fprintln(&pb, doc.Content)
		printPaged(cmd, pb.String())
	} else {
		content := renderDocView(doc)
		renderOrPage(cmd, doc.Title, content)
	}

	return nil
}

// --- doc create ---

var docCreateCmd = &cobra.Command{
	Use:   "create <title>",
	Short: "Create a new documentation file",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runDocCreate,
}

func runDocCreate(cmd *cobra.Command, args []string) error {
	title := strings.Join(args, " ")
	store := getStore()

	description, _ := cmd.Flags().GetString("description")
	tags, _ := cmd.Flags().GetStringArray("tag")
	folder, _ := cmd.Flags().GetString("folder")
	content, _ := cmd.Flags().GetString("content")
	content = unescapeText(content)
	// Build path from folder + sanitized title
	slug := slugifyTitle(title)
	var docPath string
	if folder != "" {
		docPath = folder + "/" + slug
	} else {
		docPath = slug
	}

	now := time.Now()
	doc := &models.Doc{
		Path:        docPath,
		Title:       title,
		Description: description,
		Tags:        tags,
		Content:     content,
		Folder:      folder,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if doc.Tags == nil {
		doc.Tags = []string{}
	}

	if err := store.Docs.Create(doc); err != nil {
		return fmt.Errorf("create doc: %w", err)
	}

	search.BestEffortIndexDoc(store, doc.Path)

	if err := store.Versions.SaveDocRevisionWithOptions(nil, doc, storage.DocRevisionOptions{
		Actor:  "cli",
		Source: "cli",
	}); err != nil {
		return fmt.Errorf("save doc history: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Created doc: %s", docPath)))
	return nil
}

// --- doc edit ---

var docEditCmd = &cobra.Command{
	Use:   "edit <path>",
	Short: "Edit a documentation file",
	Args:  cobra.ExactArgs(1),
	RunE:  runDocEdit,
}

func runDocEdit(cmd *cobra.Command, args []string) error {
	path := args[0]
	store := getStore()

	doc, err := store.Docs.Get(path)
	if err != nil {
		return fmt.Errorf("doc %q not found", path)
	}

	oldDoc := *doc // snapshot before changes

	if cmd.Flags().Changed("title") {
		v, _ := cmd.Flags().GetString("title")
		doc.Title = v
	}
	if cmd.Flags().Changed("description") {
		v, _ := cmd.Flags().GetString("description")
		doc.Description = v
	}
	if cmd.Flags().Changed("tags") {
		v, _ := cmd.Flags().GetString("tags")
		doc.Tags = splitCSV(v)
	}
	oldPath := path
	if cmd.Flags().Changed("path") {
		v, _ := cmd.Flags().GetString("path")
		doc.Path = strings.Trim(strings.TrimSuffix(v, ".md"), "/")
	}

	targetSection, _ := cmd.Flags().GetString("section")

	if cmd.Flags().Changed("content") {
		v, _ := cmd.Flags().GetString("content")
		v = unescapeText(v)
		if targetSection != "" {
			doc.Content = replaceDocSection(doc.Content, targetSection, v)
		} else {
			doc.Content = v
		}
	}
	if cmd.Flags().Changed("append") {
		v, _ := cmd.Flags().GetString("append")
		v = unescapeText(v)
		if doc.Content == "" {
			doc.Content = v
		} else {
			if !strings.HasSuffix(doc.Content, "\n") {
				doc.Content += "\n"
			}
			doc.Content += v
		}
	}

	doc.UpdatedAt = time.Now()

	if oldPath != doc.Path {
		if err := store.Docs.Rename(oldPath, doc); err != nil {
			return fmt.Errorf("rename doc: %w", err)
		}
		if err := store.Docs.RewriteDocReferences(oldPath, doc.Path, store.Tasks, store.Memory); err != nil {
			return fmt.Errorf("rewrite doc refs: %w", err)
		}
		search.BestEffortRemoveDoc(store, oldPath)
	} else if err := store.Docs.Update(doc); err != nil {
		return fmt.Errorf("update doc: %w", err)
	}

	search.BestEffortIndexDoc(store, doc.Path)

	if err := store.Versions.SaveDocRevisionWithOptions(&oldDoc, doc, storage.DocRevisionOptions{
		Section: targetSection,
		Actor:   "cli",
		Source:  "cli",
	}); err != nil {
		return fmt.Errorf("save doc history: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Updated doc: %s", doc.Path)))
	return nil
}

// --- doc delete ---

var docDeleteCmd = &cobra.Command{
	Use:   "delete <path>",
	Short: "Delete a document permanently",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := getStore()
		dryRun, _ := cmd.Flags().GetBool("dry-run")
		force, _ := cmd.Flags().GetBool("force")

		doc, err := store.Docs.Get(args[0])
		if err != nil {
			return fmt.Errorf("delete doc: %w", err)
		}

		if dryRun {
			fmt.Println(RenderDim(fmt.Sprintf("Would delete doc: %s (%s)", doc.Path, doc.Title)))
			return nil
		}

		if !force {
			fmt.Printf("%s %s (%s)? %s: ", StyleWarning.Render("Delete doc"), StyleBold.Render(doc.Path), doc.Title, StyleDim.Render("This cannot be undone. (y/n)"))
			var answer string
			fmt.Scanln(&answer)
			if answer != "y" && answer != "yes" {
				fmt.Println(StyleDim.Render("Aborted."))
				return nil
			}
		}

		if err := store.Docs.Delete(args[0]); err != nil {
			return fmt.Errorf("delete doc: %w", err)
		}
		search.BestEffortRemoveDoc(store, args[0])
		fmt.Println(RenderSuccess(fmt.Sprintf("Deleted doc: %s", doc.Path)))
		return nil
	},
}

// --- doc history ---

var docHistoryCmd = &cobra.Command{
	Use:   "history <path>",
	Short: "Show version history of a document",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := getStore()
		history, err := store.Versions.GetDocHistory(args[0])
		if err != nil {
			return fmt.Errorf("get doc history: %w", err)
		}

		plain := isPlain(cmd)
		jsonOut := isJSON(cmd)

		if jsonOut {
			printJSON(history)
			return nil
		}

		if len(history.Versions) == 0 {
			fmt.Println(StyleDim.Render(fmt.Sprintf("No version history for doc %s", args[0])))
			return nil
		}

		if plain {
			printPaged(cmd, renderPlainDocHistory(args[0], history))
		} else {
			content := renderDocHistory(args[0], history)
			renderOrPage(cmd, "Doc History", content)
		}
		return nil
	},
}

func renderPlainDocHistory(docPath string, history *models.DocVersionHistory) string {
	var hb strings.Builder
	path := history.DocPath
	if path == "" {
		path = docPath
	}
	fmt.Fprintf(&hb, "DOC: %s\n", path)
	if history.DocID != "" {
		fmt.Fprintf(&hb, "DOC_ID: %s\n", history.DocID)
	}
	if history.CurrentPath != "" && history.CurrentPath != history.DocPath {
		fmt.Fprintf(&hb, "CURRENT_PATH: %s\n", history.CurrentPath)
	}
	fmt.Fprintf(&hb, "VERSIONS: %d\n\n", history.CurrentVersion)
	for _, gap := range history.RetentionGaps {
		fmt.Fprintf(&hb, "RETENTION_GAP: type=%s reason=%s count=%d before=%s after=%s applied=%s\n",
			gap.Type, gap.Reason, gap.Count, gap.BeforeVersion, gap.AfterVersion, gap.AppliedAt.Format(time.RFC3339))
	}
	if len(history.RetentionGaps) > 0 {
		fmt.Fprintln(&hb)
	}
	for _, v := range history.Versions {
		fmt.Fprintf(&hb, "VERSION: %s\n", v.ID)
		fmt.Fprintf(&hb, "TIMESTAMP: %s\n", v.Timestamp.Format(time.RFC3339))
		fmt.Fprintf(&hb, "CHECKPOINT: %t\n", v.Checkpoint)
		if v.Actor != "" {
			fmt.Fprintf(&hb, "ACTOR: %s\n", v.Actor)
		} else if v.Author != "" {
			fmt.Fprintf(&hb, "AUTHOR: %s\n", v.Author)
		}
		if v.Source != "" {
			fmt.Fprintf(&hb, "SOURCE: %s\n", v.Source)
		}
		if v.AuditEventID != "" {
			fmt.Fprintf(&hb, "AUDIT_EVENT_ID: %s\n", v.AuditEventID)
		}
		if v.SessionID != "" {
			fmt.Fprintf(&hb, "SESSION_ID: %s\n", v.SessionID)
		}
		if v.BaseHash != "" {
			fmt.Fprintf(&hb, "BASE_HASH: %s\n", v.BaseHash)
		}
		if v.NewHash != "" {
			fmt.Fprintf(&hb, "NEW_HASH: %s\n", v.NewHash)
		}
		for _, scope := range v.ChangedScopes {
			fmt.Fprintf(&hb, "  SCOPE: %s\n", formatDocHistoryScope(scope))
		}
		for _, ch := range v.Changes {
			fmt.Fprintf(&hb, "  CHANGE: %s: %v -> %v\n", ch.Field, ch.OldValue, ch.NewValue)
		}
		fmt.Fprintln(&hb)
	}
	return hb.String()
}

func renderDocHistory(docPath string, history *models.DocVersionHistory) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s\n\n",
		StyleID.Render(docPath),
		StyleDim.Render(fmt.Sprintf("— %d version(s)", history.CurrentVersion)))
	for _, gap := range history.RetentionGaps {
		fmt.Fprintf(&b, "%s %s\n",
			StyleDim.Render("retention gap"),
			fmt.Sprintf("%s removed %d version(s) before %s", gap.Reason, gap.Count, gap.AfterVersion))
	}
	if len(history.RetentionGaps) > 0 {
		fmt.Fprintln(&b)
	}
	for _, v := range history.Versions {
		header := StyleDim.Render("["+v.ID+"]") + " " + v.Timestamp.Format("2006-01-02 15:04:05")
		if v.Actor != "" {
			header += StyleDim.Render(" by ") + v.Actor
		} else if v.Author != "" {
			header += StyleDim.Render(" by ") + v.Author
		}
		if v.Source != "" {
			header += StyleDim.Render(" via ") + v.Source
		}
		if v.Checkpoint {
			header += StyleDim.Render(" checkpoint")
		}
		fmt.Fprintln(&b, header)
		if v.AuditEventID != "" || v.SessionID != "" || v.BaseHash != "" || v.NewHash != "" {
			fmt.Fprintf(&b, "  %s %s\n", StyleDim.Render("meta"), formatDocHistoryMeta(v))
		}
		for _, scope := range v.ChangedScopes {
			fmt.Fprintf(&b, "  %s %s\n", StyleDim.Render("scope"), formatDocHistoryScope(scope))
		}
		for _, ch := range v.Changes {
			fmt.Fprintf(&b, "  %s %s: %v → %v\n",
				StyleDim.Render("•"),
				StyleBold.Render(fmt.Sprintf("%v", ch.Field)),
				ch.OldValue, ch.NewValue)
		}
		fmt.Fprintln(&b)
	}
	return b.String()
}

func formatDocHistoryMeta(v models.DocVersion) string {
	var parts []string
	if v.AuditEventID != "" {
		parts = append(parts, "audit="+v.AuditEventID)
	}
	if v.SessionID != "" {
		parts = append(parts, "session="+v.SessionID)
	}
	if v.BaseHash != "" {
		parts = append(parts, "base="+shortDocHistoryHash(v.BaseHash))
	}
	if v.NewHash != "" {
		parts = append(parts, "new="+shortDocHistoryHash(v.NewHash))
	}
	return strings.Join(parts, " ")
}

func formatDocHistoryScope(scope models.DocChangeScope) string {
	var parts []string
	kind := scope.Type
	if scope.Field != "" {
		kind += ":" + scope.Field
	}
	if scope.Section != "" {
		kind += ":" + strconv.Quote(scope.Section)
	}
	parts = append(parts, kind)
	if scope.Summary != "" {
		parts = append(parts, "summary="+strconv.Quote(scope.Summary))
	}
	if scope.OldBytes != 0 || scope.NewBytes != 0 || scope.DeltaBytes != 0 {
		parts = append(parts, fmt.Sprintf("bytes=%d->%d (%+d)", scope.OldBytes, scope.NewBytes, scope.DeltaBytes))
	}
	return strings.Join(parts, " ")
}

func shortDocHistoryHash(hash string) string {
	if len(hash) <= 12 {
		return hash
	}
	return hash[:12]
}

// ---- list view helpers ----

func buildDocListItems(store *storage.Store, docs []*models.Doc) []listItem {
	items := make([]listItem, len(docs))
	for i, d := range docs {
		desc := d.Description
		if len(d.Tags) > 0 {
			if desc != "" {
				desc += "  "
			}
			desc += RenderTags(d.Tags)
		}
		if d.IsImported {
			if desc != "" {
				desc += "  "
			}
			desc += StyleDim.Render("[imported]")
		}
		// Load full content for detail view
		detail := ""
		full, err := store.Docs.Get(d.Path)
		if err == nil {
			detail = renderDocView(full)
		}
		items[i] = listItem{
			id:          d.Path,
			title:       d.Title,
			description: desc,
			detail:      detail,
		}
	}
	return items
}

// ---- render helpers ----

func renderDocList(docs []*models.Doc) string {
	var b strings.Builder
	fmt.Fprintf(&b, "  %s  %s  %s\n",
		StyleBold.Render(fmt.Sprintf("%-40s", "PATH")),
		StyleBold.Render(fmt.Sprintf("%-30s", "TITLE")),
		StyleBold.Render("TAGS"))
	fmt.Fprintln(&b, "  "+RenderSeparator(86))
	for _, d := range docs {
		path := d.Path
		if len(path) > 38 {
			path = path[:35] + "..."
		}
		title := d.Title
		if len(title) > 28 {
			title = title[:25] + "..."
		}
		tags := RenderTags(d.Tags)
		prefix := ""
		if d.IsImported {
			prefix = StyleDim.Render("[imported] ")
		}
		fmt.Fprintf(&b, "  %s  %-30s  %s%s\n",
			StyleID.Render(fmt.Sprintf("%-40s", path)),
			title, prefix, tags)
	}
	return b.String()
}

func renderDocView(doc *models.Doc) string {
	var b strings.Builder
	fmt.Fprintln(&b, StyleTitle.Render("# "+doc.Title))
	if doc.Description != "" {
		fmt.Fprintln(&b, StyleDim.Render(doc.Description))
	}
	if len(doc.Tags) > 0 {
		fmt.Fprintf(&b, "%s %s\n", StyleDim.Render("Tags:"), RenderTags(doc.Tags))
	}
	fmt.Fprintln(&b, RenderSeparator(60))
	fmt.Fprintln(&b, doc.Content)
	return b.String()
}

func renderDocInfo(doc *models.Doc) string {
	var b strings.Builder
	fmt.Fprintln(&b, RenderKeyValue("Path", doc.Path))
	fmt.Fprintln(&b, RenderKeyValue("Title", doc.Title))
	if doc.Description != "" {
		fmt.Fprintln(&b, RenderKeyValue("Desc", doc.Description))
	}
	fmt.Fprintln(&b, RenderKeyValue("Size", fmt.Sprintf("%d bytes", len(doc.Content))))
	fmt.Fprintf(&b, "%s %s\n", StyleDim.Render("Tags:"), RenderTags(doc.Tags))
	fmt.Fprintln(&b, RenderKeyValue("Updated", doc.UpdatedAt.Format("2006-01-02")))
	return b.String()
}

func renderDocTOC(title string, headings []heading) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s\n\n", RenderSectionHeader("Table of Contents:"), StyleInfo.Render(title))
	for _, h := range headings {
		fmt.Fprintf(&b, "%s%s\n", strings.Repeat("  ", h.level-1), h.text)
	}
	return b.String()
}

func renderSmartDocSummary(doc *models.Doc) string {
	headings := extractHeadings(doc.Content)
	contentLen := utf8.RuneCountInString(doc.Content)
	approxTokens := approximateDocTokens(doc.Content)
	baseLevel := 1
	if len(headings) > 0 {
		baseLevel = headings[0].level
		for _, h := range headings[1:] {
			if h.level < baseLevel {
				baseLevel = h.level
			}
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Document: %s\n", doc.Title)
	fmt.Fprintln(&b, strings.Repeat("=", 50))
	fmt.Fprintln(&b)
	fmt.Fprintf(&b, "Size: %s chars (~%s tokens)\n", formatWithCommas(contentLen), formatWithCommas(approxTokens))
	fmt.Fprintf(&b, "Headings: %d\n", len(headings))
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "Table of Contents:")
	fmt.Fprintln(&b, strings.Repeat("-", 50))
	for i, h := range headings {
		indentLevel := h.level - baseLevel + 1
		if indentLevel < 1 {
			indentLevel = 1
		}
		fmt.Fprintf(&b, "%s%d. %s\n", strings.Repeat("  ", indentLevel), i+1, h.text)
	}
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "Document is large. Use --section <number> to read a specific section.")
	return b.String()
}

// ---- helpers ----

func approximateDocTokens(content string) int {
	contentLen := utf8.RuneCountInString(content)
	if contentLen == 0 {
		return 0
	}
	return int(math.Ceil(float64(contentLen) / 3.5))
}

func formatWithCommas(n int) string {
	s := strconv.Itoa(n)
	if len(s) <= 3 {
		return s
	}

	negative := strings.HasPrefix(s, "-")
	if negative {
		s = s[1:]
	}

	rem := len(s) % 3
	if rem == 0 {
		rem = 3
	}

	var b strings.Builder
	if negative {
		b.WriteByte('-')
	}
	b.WriteString(s[:rem])
	for i := rem; i < len(s); i += 3 {
		b.WriteByte(',')
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

func containsTag(tags []string, tag string) bool {
	for _, t := range tags {
		if t == tag {
			return true
		}
	}
	return false
}

func slugifyTitle(title string) string {
	s := strings.ToLower(title)
	var b strings.Builder
	prevHyphen := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevHyphen = false
		} else {
			if !prevHyphen {
				b.WriteRune('-')
				prevHyphen = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

type heading struct {
	level int
	text  string
}

func extractHeadings(content string) []heading {
	var headings []heading
	for _, line := range strings.Split(content, "\n") {
		if !strings.HasPrefix(line, "#") {
			continue
		}
		level := 0
		for _, r := range line {
			if r == '#' {
				level++
			} else {
				break
			}
		}
		text := strings.TrimSpace(line[level:])
		if text != "" {
			headings = append(headings, heading{level: level, text: text})
		}
	}
	return headings
}

func extractDocSection(content, sectionRef string) string {
	lines := strings.Split(content, "\n")
	// Try to match by heading text or number
	var startLine, endLine int
	found := false
	headingCount := 0

	for i, line := range lines {
		if !strings.HasPrefix(line, "#") {
			continue
		}
		headingCount++
		level := 0
		for _, r := range line {
			if r == '#' {
				level++
			} else {
				break
			}
		}
		text := strings.TrimSpace(line[level:])

		// Match by number or text
		matches := fmt.Sprintf("%d", headingCount) == sectionRef ||
			strings.EqualFold(text, sectionRef) ||
			strings.Contains(strings.ToLower(text), strings.ToLower(sectionRef))

		if matches {
			startLine = i
			found = true
			// Find end: next heading of same or higher level
			for j := i + 1; j < len(lines); j++ {
				if strings.HasPrefix(lines[j], "#") {
					nextLevel := 0
					for _, r := range lines[j] {
						if r == '#' {
							nextLevel++
						} else {
							break
						}
					}
					if nextLevel <= level {
						endLine = j
						break
					}
				}
				if j == len(lines)-1 {
					endLine = len(lines)
				}
			}
			if endLine == 0 {
				endLine = len(lines)
			}
			break
		}
	}

	if !found {
		return ""
	}
	return strings.TrimSpace(strings.Join(lines[startLine:endLine], "\n"))
}

// extractDocLines returns specific lines from content.
// lineParam can be "42" (single line) or "10-20" (range).
func extractDocLines(content, lineParam string) (string, string, error) {
	allLines := strings.Split(content, "\n")
	total := len(allLines)

	// Try range: "10-20"
	if parts := strings.SplitN(lineParam, "-", 2); len(parts) == 2 {
		start, err1 := strconv.Atoi(parts[0])
		end, err2 := strconv.Atoi(parts[1])
		if err1 == nil && err2 == nil && start >= 1 && end >= start {
			if start > total {
				return "", "", fmt.Errorf("line %d exceeds document length (%d lines)", start, total)
			}
			if end > total {
				end = total
			}
			return strings.Join(allLines[start-1:end], "\n"), fmt.Sprintf("%d-%d", start, end), nil
		}
	}

	// Single line: "42"
	line, err := strconv.Atoi(lineParam)
	if err != nil {
		return "", "", fmt.Errorf("invalid line parameter: %q (use '42' or '10-20')", lineParam)
	}
	if line < 1 || line > total {
		return "", "", fmt.Errorf("line %d out of range (document has %d lines)", line, total)
	}
	return allLines[line-1], fmt.Sprintf("%d", line), nil
}

func replaceDocSection(content, sectionRef, newContent string) string {
	lines := strings.Split(content, "\n")
	headingCount := 0

	for i, line := range lines {
		if !strings.HasPrefix(line, "#") {
			continue
		}
		headingCount++
		level := 0
		for _, r := range line {
			if r == '#' {
				level++
			} else {
				break
			}
		}
		text := strings.TrimSpace(line[level:])

		matches := fmt.Sprintf("%d", headingCount) == sectionRef ||
			strings.EqualFold(text, sectionRef) ||
			strings.Contains(strings.ToLower(text), strings.ToLower(sectionRef))

		if matches {
			endLine := len(lines)
			for j := i + 1; j < len(lines); j++ {
				if strings.HasPrefix(lines[j], "#") {
					nextLevel := 0
					for _, r := range lines[j] {
						if r == '#' {
							nextLevel++
						} else {
							break
						}
					}
					if nextLevel <= level {
						endLine = j
						break
					}
				}
			}
			before := strings.Join(lines[:i+1], "\n")
			after := strings.Join(lines[endLine:], "\n")
			result := before + "\n\n" + newContent
			if after != "" {
				result += "\n\n" + after
			}
			return result
		}
	}
	return content
}

func init() {
	// doc list flags
	docListCmd.Flags().String("tag", "", "Filter by tag")

	// doc view flags
	docViewCmd.Flags().Bool("toc", false, "Show table of contents only")
	docViewCmd.Flags().Bool("info", false, "Show document stats without content")
	docViewCmd.Flags().String("section", "", "Show specific section by number or title")
	docViewCmd.Flags().String("line", "", "Show specific lines (e.g., '42' or '10-20')")
	docViewCmd.Flags().Bool("smart", false, "Auto-optimize reading for large documents")

	// doc shorthand (the docCmd itself) also needs view flags
	docCmd.Flags().Bool("toc", false, "Show table of contents only")
	docCmd.Flags().Bool("info", false, "Show document stats without content")
	docCmd.Flags().String("section", "", "Show specific section by number or title")
	docCmd.Flags().String("line", "", "Show specific lines (e.g., '42' or '10-20')")
	docCmd.Flags().Bool("smart", false, "Auto-optimize reading for large documents")

	// doc create flags
	docCreateCmd.Flags().StringP("description", "d", "", "Document description")
	docCreateCmd.Flags().StringArrayP("tag", "t", nil, "Document tag (repeatable)")
	docCreateCmd.Flags().StringP("folder", "f", "", "Folder path within docs/")
	docCreateCmd.Flags().StringP("content", "c", "", "Initial content")

	// doc edit flags
	docEditCmd.Flags().StringP("title", "t", "", "New title")
	docEditCmd.Flags().StringP("description", "d", "", "New description")
	docEditCmd.Flags().String("tags", "", "New tags (comma-separated)")
	docEditCmd.Flags().String("path", "", "Rename doc to a new path")
	docEditCmd.Flags().StringP("content", "c", "", "Replace content")
	docEditCmd.Flags().StringP("append", "a", "", "Append to content")
	docEditCmd.Flags().String("section", "", "Target section to replace (used with --content)")

	// doc delete flags
	docDeleteCmd.Flags().Bool("dry-run", false, "Preview what would be deleted without deleting")
	docDeleteCmd.Flags().Bool("force", false, "Skip confirmation prompt")

	docCmd.AddCommand(docListCmd)
	docCmd.AddCommand(docViewCmd)
	docCmd.AddCommand(docCreateCmd)
	docCmd.AddCommand(docEditCmd)
	docCmd.AddCommand(docDeleteCmd)
	docCmd.AddCommand(docHistoryCmd)

	rootCmd.AddCommand(docCmd)
}
