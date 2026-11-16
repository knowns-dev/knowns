package main

import "bytes"

// reqInfo is what the proxy remembers about a request that has not been answered yet.
type reqInfo struct {
	line      []byte // the original line, including the trailing newline
	method    string
	params    []byte
	readOnly  bool // safe to send twice
	isProject bool // a project tool call that selects a project
}

func unquote(raw []byte) string {
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' && bytes.IndexByte(raw, '\\') < 0 {
		return string(raw[1 : len(raw)-1])
	}
	return string(raw)
}

var readActions = map[string]bool{
	"get": true, "list": true, "history": true, "board": true, "diff": true,
	"review_inbox": true, "migration_preview": true, "report": true,
	// code
	"search": true, "symbols": true, "deps": true, "graph": true, "find": true,
	"definition": true, "references": true, "implementations": true, "diagnostics": true,
	// project (a selection is replayed on every switch anyway)
	"detect": true, "current": true, "status": true, "set": true,
	// search tool
	"retrieve": true, "resolve": true,
}

// classify decides whether a request may be sent twice. Anything it does not know may write.
func classify(method string, params []byte) (readOnly, isProject bool) {
	if method != "tools/call" {
		return true, false
	}
	f, ok := topLevel(params, "name", "arguments")
	if !ok {
		return false, false
	}
	name := unquote(f["name"])
	args, _ := topLevel(f["arguments"], "action", "fix")
	action := unquote(args["action"])
	switch name {
	case "initial", "help", "search":
		return true, false
	case "project":
		return readActions[action] || action == "", action == "set" || action == "detect"
	case "validate":
		return string(args["fix"]) != "true", false
	case "tasks", "docs", "memory", "decision", "templates", "time", "code":
		return readActions[action], false
	}
	return false, false
}
