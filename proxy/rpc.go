package main

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// reqInfo is what the proxy remembers about a request that has not been answered yet.
type reqInfo struct {
	rawID     string // the id exactly as the agent wrote it, for an error response
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

// readMethods are the JSON-RPC methods that cannot change anything, so they may be sent twice.
// Every other method, including one the proxy has never heard of, counts as a write.
var readMethods = map[string]bool{
	"initialize": true, "ping": true, "tools/list": true,
	"resources/list": true, "resources/read": true, "resources/templates/list": true,
	"prompts/list": true, "prompts/get": true, "completion/complete": true,
}

// readActions lists, per tool, the actions that only read. The lists are per tool on purpose:
// `resolve` reads under `search` but writes under `memory` and `decision`. A tool or action that
// is not listed is a write.
var readActions = map[string]map[string]bool{
	"tasks":     set("get", "list", "history", "board"),
	"docs":      set("get", "list", "history", "diff"),
	"memory":    set("get", "list"),
	"decision":  set("get", "list", "review_inbox", "migration_preview"),
	"templates": set("get", "list"),
	"time":      set("report"),
	"code": set("search", "symbols", "deps", "graph", "find", "definition", "references",
		"implementations", "diagnostics"),
	// a project selection is replayed on every switch anyway, so resending it is harmless
	"project": set("detect", "current", "status", "set"),
}

// readTools are tools whose every action reads.
var readTools = set("initial", "help", "search")

func set(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

// classify decides whether a request may be sent twice. dup means a top-level key was repeated,
// which the two JSON parsers read differently, so the request counts as a write.
func classify(method string, params []byte, dup bool) (readOnly, isProject bool) {
	if dup {
		return false, false
	}
	if method != "tools/call" {
		return readMethods[method], false
	}
	f, ok, d := scanObject(params, "name", "arguments")
	if !ok || d {
		return false, false
	}
	name := unquote(f["name"])
	args, aok, ad := scanObject(f["arguments"], "action", "fix")
	if f["arguments"] != nil && (!aok || ad) {
		return false, false
	}
	action := unquote(args["action"])
	isProject = name == "project" && (action == "set" || action == "detect")
	switch {
	case readTools[name]:
		return true, false
	case name == "validate":
		return string(args["fix"]) != "true", false
	case readActions[name] != nil:
		if name == "project" && action == "" {
			return true, false
		}
		return readActions[name][action], isProject
	}
	return false, false
}

// idKey is the identity of a JSON-RPC id: strings and numbers by parsed value, so `1`, `1.0` and
// `1e0` match each other but never the string "1".
func idKey(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return "s:" + s
		}
		return "s:" + string(raw)
	}
	if f, err := strconv.ParseFloat(string(raw), 64); err == nil {
		return "n:" + strconv.FormatFloat(f, 'g', -1, 64)
	}
	return "r:" + string(raw)
}
