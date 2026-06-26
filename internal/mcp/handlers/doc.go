package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// RegisterDocTool registers the consolidated documentation MCP tool.
func RegisterDocTool(s *server.MCPServer, getStore func() *storage.Store) {
	s.AddTool(
		mcp.NewTool("docs",
			mcp.WithDescription("Documentation operations. Use 'action' to specify: create, get, update, delete, list, history, diff, restore."),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("create", "get", "update", "delete", "list", "history", "diff", "restore"),
			),
			mcp.WithString("path",
				mcp.Description("Document path (required for get, update, delete, history, diff, restore)"),
			),
			mcp.WithString("title",
				mcp.Description("Document title (required for create, optional for update)"),
			),
			mcp.WithString("description",
				mcp.Description("Document description (create, update)"),
			),
			mcp.WithString("content",
				mcp.Description("Markdown content (create, update)"),
			),
			mcp.WithArray("tags",
				mcp.Description("Document tags (create, update)"),
				mcp.WithStringItems(),
			),
			mcp.WithString("folder",
				mcp.Description("Folder path (create)"),
			),
			mcp.WithBoolean("smart",
				mcp.Description("Smart mode: auto-return full content if small, else stats+TOC (get)"),
			),
			mcp.WithBoolean("includeHistory",
				mcp.Description("Include structured revision history metadata with get responses"),
			),
			mcp.WithBoolean("info",
				mcp.Description("Return document stats without content (get)"),
			),
			mcp.WithBoolean("toc",
				mcp.Description("Return table of contents only (get)"),
			),
			mcp.WithString("section",
				mcp.Description("Section by heading title or number (get, update)"),
			),
			mcp.WithString("line",
				mcp.Description("Specific lines e.g. '42' or '10-20' (get)"),
			),
			mcp.WithString("appendContent",
				mcp.Description("Append to existing content (update)"),
			),
			mcp.WithString("newPath",
				mcp.Description("Rename document to new path (update)"),
			),
			mcp.WithString("revision",
				mcp.Description("Revision ID or number for diff/restore (defaults to latest for diff)"),
			),
			mcp.WithString("revisionId",
				mcp.Description("Alias for revision ID used by API clients"),
			),
			mcp.WithString("mode",
				mcp.Description("Restore mode: document (default) or section"),
			),
			mcp.WithArray("clear",
				mcp.Description("Clear string fields like title, description, or content (update)"),
				mcp.WithStringItems(),
			),
			mcp.WithString("tag",
				mcp.Description("Filter by tag (list)"),
			),
			mcp.WithBoolean("dryRun",
				mcp.Description("Preview only without deleting (default: true) (delete)"),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "create":
				return handleDocCreate(getStore, req)
			case "get":
				return handleDocGet(getStore, req)
			case "update":
				return handleDocUpdate(getStore, req)
			case "delete":
				return handleDocDelete(getStore, req)
			case "list":
				return handleDocList(getStore, req)
			case "history":
				return handleDocHistory(getStore, req)
			case "diff":
				return handleDocDiff(getStore, req)
			case "restore":
				return handleDocRestore(getStore, req)
			default:
				return errResultf("unknown docs action: %s", action)
			}
		},
	)
}

func handleDocList(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	docs, err := store.Docs.List()
	if err != nil {
		return errFailed("list docs", err)
	}

	args := req.GetArguments()
	tagFilter, _ := stringArg(args, "tag")

	var filtered []*models.Doc
	for _, d := range docs {
		if tagFilter != "" && !containsString(d.Tags, tagFilter) {
			continue
		}
		d.Content = ""
		filtered = append(filtered, d)
	}
	if filtered == nil {
		filtered = []*models.Doc{}
	}

	// If results are empty, include project context for diagnostics.
	if len(filtered) == 0 {
		wrapper := map[string]any{
			"results":      filtered,
			"_projectRoot": store.Root,
			"_hint":        "No docs found. Verify the active project is correct via project({ action: \"current\" }).",
		}
		out, _ := json.MarshalIndent(wrapper, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	out, _ := json.MarshalIndent(filtered, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleDocGet(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	path, err := req.RequireString("path")
	if err != nil {
		return errResult(ErrPathReq)
	}

	doc, err := store.Docs.Get(path)
	if err != nil {
		return errNotFound("Doc", err)
	}

	args := req.GetArguments()
	smart := boolArg(args, "smart")
	info := boolArg(args, "info")
	tocOnly := boolArg(args, "toc")
	includeHistory := boolArg(args, "includeHistory")
	section, hasSection := stringArg(args, "section")
	lineParam, hasLine := stringArg(args, "line")

	contentLen := utf8.RuneCountInString(doc.Content)
	approxTokens := contentLen / 4

	if info {
		headings := extractHeadings(doc.Content)
		result := map[string]any{
			"path":        doc.Path,
			"title":       doc.Title,
			"description": doc.Description,
			"tags":        doc.Tags,
			"size":        contentLen,
			"tokens":      approxTokens,
			"headings":    headings,
			"createdAt":   doc.CreatedAt,
			"updatedAt":   doc.UpdatedAt,
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	if tocOnly {
		headings := extractHeadings(doc.Content)
		result := map[string]any{
			"path":     doc.Path,
			"title":    doc.Title,
			"headings": headings,
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	if hasSection && section != "" {
		sectionContent := extractSection(doc.Content, section)
		result := map[string]any{
			"path":    doc.Path,
			"title":   doc.Title,
			"section": section,
			"content": sectionContent,
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	if hasLine && lineParam != "" {
		lineContent, lineLabel, err := extractLines(doc.Content, lineParam)
		if err != nil {
			return errResult(err.Error())
		}
		result := map[string]any{
			"path":    doc.Path,
			"title":   doc.Title,
			"lines":   lineLabel,
			"content": lineContent,
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	if smart {
		const smartThreshold = 2000
		if approxTokens <= smartThreshold {
			if includeHistory {
				return docWithHistoryResult(store, doc)
			}
			out, _ := json.MarshalIndent(doc, "", "  ")
			return mcp.NewToolResultText(string(out)), nil
		}
		headings := extractHeadings(doc.Content)
		result := map[string]any{
			"path":        doc.Path,
			"title":       doc.Title,
			"description": doc.Description,
			"tags":        doc.Tags,
			"size":        contentLen,
			"tokens":      approxTokens,
			"headings":    headings,
			"note":        "Document is large. Use 'section' parameter to read a specific section, or 'toc: true' to see the table of contents.",
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	if includeHistory {
		return docWithHistoryResult(store, doc)
	}

	out, _ := json.MarshalIndent(doc, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleDocCreate(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	title, err := req.RequireString("title")
	if err != nil {
		return errResult(err.Error())
	}

	args := req.GetArguments()

	slug := slugify(title)
	folder, _ := stringArg(args, "folder")
	var docPath string
	if folder != "" {
		docPath = folder + "/" + slug
	} else {
		docPath = slug
	}

	doc := &models.Doc{
		Path:      docPath,
		Title:     title,
		Tags:      []string{},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}

	if v, ok := textArg(args, "description"); ok {
		doc.Description = v
	}
	if v, ok := textArg(args, "content"); ok {
		doc.Content = v
	}
	if v, ok := stringSliceArg(args, "tags"); ok {
		doc.Tags = v
	}

	if err := store.Docs.Create(doc); err != nil {
		return errFailed("create doc", err)
	}

	search.BestEffortIndexDoc(store, doc.Path)

	if err := store.Versions.SaveDocRevisionWithOptions(nil, doc, storage.DocRevisionOptions{
		Actor:  "mcp",
		Source: "mcp",
	}); err != nil {
		return errFailed("save doc history", err)
	}

	go notifyDocUpdated(store, doc.Path)

	out, _ := json.MarshalIndent(doc, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleDocUpdate(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	path, err := req.RequireString("path")
	if err != nil {
		return errResult(ErrPathReq)
	}

	doc, err := store.Docs.Get(path)
	if err != nil {
		return errNotFound("Doc", err)
	}

	oldDoc := *doc
	args := req.GetArguments()
	clearFields := stringSetArg(args, "clear")
	oldPath := doc.Path

	if clearFields["title"] {
		doc.Title = ""
	} else if v, ok := stringArg(args, "title"); ok && v != "" {
		doc.Title = v
	}
	if clearFields["description"] {
		doc.Description = ""
	} else if v, ok := textArg(args, "description"); ok && v != "" {
		doc.Description = v
	}
	if _, ok := args["tags"]; ok {
		if v, ok := stringSliceArg(args, "tags"); ok {
			doc.Tags = v
		} else {
			doc.Tags = []string{}
		}
	}
	if v, ok := stringArg(args, "newPath"); ok && strings.TrimSpace(v) != "" {
		doc.Path = strings.Trim(strings.TrimSuffix(v, ".md"), "/")
	}

	sectionTarget, hasSection := stringArg(args, "section")
	newContent, hasContent := textArg(args, "content")
	appendContent, hasAppend := textArg(args, "appendContent")

	if clearFields["content"] {
		doc.Content = ""
	} else if hasSection && sectionTarget != "" && hasContent {
		doc.Content = replaceSection(doc.Content, sectionTarget, newContent)
	} else if hasContent && newContent != "" {
		doc.Content = newContent
	}
	if hasAppend && appendContent != "" {
		if doc.Content == "" {
			doc.Content = appendContent
		} else {
			if !strings.HasSuffix(doc.Content, "\n") {
				doc.Content += "\n"
			}
			doc.Content += appendContent
		}
	}

	doc.UpdatedAt = time.Now().UTC()

	if oldPath != doc.Path {
		if err := store.Docs.Rename(oldPath, doc); err != nil {
			return errFailed("rename doc", err)
		}
		if err := store.Docs.RewriteDocReferences(oldPath, doc.Path, store.Tasks, store.Memory); err != nil {
			return errFailed("rewrite doc references", err)
		}
		search.BestEffortRemoveDoc(store, oldPath)
	} else if err := store.Docs.Update(doc); err != nil {
		return errFailed("update doc", err)
	}

	search.BestEffortIndexDoc(store, doc.Path)

	if err := store.Versions.SaveDocRevisionWithOptions(&oldDoc, doc, storage.DocRevisionOptions{
		Section: sectionTarget,
		Actor:   "mcp",
		Source:  "mcp",
	}); err != nil {
		return errFailed("save doc history", err)
	}

	if oldPath != doc.Path {
		go notifyServer(store, "notify/refresh")
	} else {
		go notifyDocUpdated(store, doc.Path)
	}

	out, _ := json.MarshalIndent(doc, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleDocHistory(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	path, err := req.RequireString("path")
	if err != nil {
		return errResult(ErrPathReq)
	}

	history, err := store.Versions.GetDocHistory(path)
	if err != nil {
		return errFailed("get doc history", err)
	}

	out, _ := json.MarshalIndent(history, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleDocDiff(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	path, err := req.RequireString("path")
	if err != nil {
		return errResult(ErrPathReq)
	}

	diff, err := store.Versions.GetDocRevisionDiff(path, docRevisionArg(req.GetArguments()))
	if err != nil {
		return errFailed("get doc revision diff", err)
	}

	out, _ := json.MarshalIndent(diff, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleDocRestore(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	path, err := req.RequireString("path")
	if err != nil {
		return errResult(ErrPathReq)
	}

	args := req.GetArguments()
	revision := docRevisionArg(args)
	if revision == "" {
		return errResult("revision is required")
	}
	section, _ := stringArg(args, "section")
	mode, _ := stringArg(args, "mode")
	mode = strings.ToLower(strings.TrimSpace(mode))

	opts := storage.DocRevisionOptions{Actor: "mcp", Source: "mcp"}
	var restored *models.Doc
	if section != "" || mode == "section" {
		restored, err = store.RestoreDocSection(path, revision, section, opts)
	} else if mode == "" || mode == "document" || mode == "whole_doc" || mode == "whole-doc" {
		restored, err = store.RestoreDoc(path, revision, opts)
	} else {
		return errResultf("unknown restore mode: %s", mode)
	}
	if err != nil {
		return errFailed("restore doc", err)
	}

	search.BestEffortIndexDoc(store, restored.Path)
	go notifyDocUpdated(store, restored.Path)

	history, _ := store.Versions.GetDocHistory(restored.Path)
	out, _ := json.MarshalIndent(map[string]any{
		"restored": true,
		"doc":      restored,
		"history":  history,
	}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func docWithHistoryResult(store *storage.Store, doc *models.Doc) (*mcp.CallToolResult, error) {
	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		return errFailed("get doc history", err)
	}
	out, _ := json.MarshalIndent(map[string]any{
		"doc":     doc,
		"history": history,
	}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func docRevisionArg(args map[string]any) string {
	if revision, ok := stringArg(args, "revision"); ok && strings.TrimSpace(revision) != "" {
		return strings.TrimSpace(revision)
	}
	if revision, ok := stringArg(args, "revisionId"); ok && strings.TrimSpace(revision) != "" {
		return strings.TrimSpace(revision)
	}
	return ""
}

func handleDocDelete(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	args := req.GetArguments()
	path, ok := stringArg(args, "path")
	if !ok || path == "" {
		return errResult(ErrPathReq)
	}

	dryRun := true
	if v, exists := args["dryRun"]; exists {
		if b, ok := v.(bool); ok {
			dryRun = b
		}
	}

	doc, err := store.Docs.Get(path)
	if err != nil {
		return errNotFound("Doc", err)
	}

	if dryRun {
		out, _ := json.MarshalIndent(map[string]any{
			"dryRun":  true,
			"message": fmt.Sprintf(MsgWouldDeleteDoc, doc.Path, doc.Title),
			"doc":     map[string]string{"path": doc.Path, "title": doc.Title, "description": doc.Description},
		}, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	if err := store.Docs.Delete(path); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to delete doc: %s", err.Error())), nil
	}

	search.BestEffortRemoveDoc(store, path)
	go notifyServer(store, "notify/refresh")

	out, _ := json.MarshalIndent(map[string]any{
		"deleted": true,
		"message": fmt.Sprintf(MsgDeletedDoc, doc.Path, doc.Title),
	}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

// extractHeadings returns a list of headings found in the markdown content.
func extractHeadings(content string) []string {
	var headings []string
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "#") {
			headings = append(headings, strings.TrimSpace(line))
		}
	}
	return headings
}

// extractLines returns specific lines from content.
func extractLines(content, lineParam string) (string, string, error) {
	allLines := strings.Split(content, "\n")
	total := len(allLines)

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
			extracted := allLines[start-1 : end]
			label := fmt.Sprintf("%d-%d", start, end)
			return strings.Join(extracted, "\n"), label, nil
		}
	}

	line, err := strconv.Atoi(lineParam)
	if err != nil {
		return "", "", fmt.Errorf("invalid line parameter: %q (use '42' or '10-20')", lineParam)
	}
	if line < 1 || line > total {
		return "", "", fmt.Errorf("line %d out of range (document has %d lines)", line, total)
	}
	return allLines[line-1], fmt.Sprintf("%d", line), nil
}

// extractSection finds the content of a specific heading section.
func extractSection(content, section string) string {
	lines := strings.Split(content, "\n")

	sectionNum := 0
	if n, err := fmt.Sscanf(section, "%d", &sectionNum); n == 1 && err == nil {
		headingCount := 0
		startLine := -1
		headingLevel := 0
		for i, line := range lines {
			if strings.HasPrefix(line, "#") {
				headingCount++
				if headingCount == sectionNum {
					startLine = i
					for _, c := range line {
						if c == '#' {
							headingLevel++
						} else {
							break
						}
					}
					break
				}
			}
		}
		if startLine == -1 {
			return ""
		}
		return extractSectionFromLine(lines, startLine, headingLevel)
	}

	searchTitle := strings.TrimLeft(section, "# ")
	for i, line := range lines {
		if !strings.HasPrefix(line, "#") {
			continue
		}
		lineTitle := strings.TrimLeft(line, "# ")
		if strings.EqualFold(strings.TrimSpace(lineTitle), strings.TrimSpace(searchTitle)) {
			level := 0
			for _, c := range line {
				if c == '#' {
					level++
				} else {
					break
				}
			}
			return extractSectionFromLine(lines, i, level)
		}
	}
	return ""
}

func extractSectionFromLine(lines []string, startLine, level int) string {
	var result []string
	result = append(result, lines[startLine])
	for i := startLine + 1; i < len(lines); i++ {
		line := lines[i]
		if strings.HasPrefix(line, "#") {
			lineLevel := 0
			for _, c := range line {
				if c == '#' {
					lineLevel++
				} else {
					break
				}
			}
			if lineLevel <= level {
				break
			}
		}
		result = append(result, line)
	}
	return strings.TrimSpace(strings.Join(result, "\n"))
}

func replaceSection(content, sectionTarget, newContent string) string {
	lines := strings.Split(content, "\n")

	sectionNum := 0
	startLine := -1
	headingLevel := 0

	if n, err := fmt.Sscanf(sectionTarget, "%d", &sectionNum); n == 1 && err == nil {
		headingCount := 0
		for i, line := range lines {
			if strings.HasPrefix(line, "#") {
				headingCount++
				if headingCount == sectionNum {
					startLine = i
					for _, c := range line {
						if c == '#' {
							headingLevel++
						} else {
							break
						}
					}
					break
				}
			}
		}
	} else {
		searchTitle := strings.TrimLeft(sectionTarget, "# ")
		for i, line := range lines {
			if !strings.HasPrefix(line, "#") {
				continue
			}
			lineTitle := strings.TrimLeft(line, "# ")
			if strings.EqualFold(strings.TrimSpace(lineTitle), strings.TrimSpace(searchTitle)) {
				startLine = i
				for _, c := range line {
					if c == '#' {
						headingLevel++
					} else {
						break
					}
				}
				break
			}
		}
	}

	if startLine == -1 {
		return content
	}

	endLine := len(lines)
	for i := startLine + 1; i < len(lines); i++ {
		line := lines[i]
		if strings.HasPrefix(line, "#") {
			lineLevel := 0
			for _, c := range line {
				if c == '#' {
					lineLevel++
				} else {
					break
				}
			}
			if lineLevel <= headingLevel {
				endLine = i
				break
			}
		}
	}

	var result []string
	result = append(result, lines[:startLine]...)
	replacementLines := strings.Split(newContent, "\n")
	currentSectionLines := lines[startLine:endLine]
	for i := len(currentSectionLines) - 1; i >= 0 && strings.TrimSpace(currentSectionLines[i]) == ""; i-- {
		if len(replacementLines) == 0 || strings.TrimSpace(replacementLines[len(replacementLines)-1]) != "" {
			replacementLines = append(replacementLines, "")
		}
	}
	result = append(result, replacementLines...)
	result = append(result, lines[endLine:]...)
	return strings.Join(result, "\n")
}

func slugify(title string) string {
	title = strings.ToLower(title)
	var b strings.Builder
	prevHyphen := false
	for _, r := range title {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevHyphen = false
		} else if r == '-' || r == ' ' || r == '_' {
			if !prevHyphen {
				b.WriteRune('-')
				prevHyphen = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
