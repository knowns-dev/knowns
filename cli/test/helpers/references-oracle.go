//go:build ignore

// references-oracle drives the real Go internal/references package for differential tests.
// One JSON request per stdin line, one JSON response per line:
//
//	{"op":"extract","content":"..."}                      -> {"refs":[...]}
//	{"op":"parse","raw":"..."}                            -> {"ok":true,"ref":{...}}
//	{"op":"rewrite","content":"...","old":"a","new":"b"}  -> {"out":"..."}
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
)

type request struct {
	Op      string `json:"op"`
	Content string `json:"content"`
	Raw     string `json:"raw"`
	Old     string `json:"old"`
	New     string `json:"new"`
}

type response struct {
	Refs []models.SemanticReference `json:"refs,omitempty"`
	OK   bool                       `json:"ok,omitempty"`
	Ref  *models.SemanticReference  `json:"ref,omitempty"`
	Out  string                     `json:"out,omitempty"`
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<28)
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	for sc.Scan() {
		var req request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			fmt.Fprintln(os.Stderr, "bad request:", err)
			os.Exit(2)
		}
		var resp response
		switch req.Op {
		case "extract":
			resp.Refs = references.Extract(req.Content)
		case "parse":
			ref, ok := references.Parse(req.Raw)
			resp.OK = ok
			if ok {
				resp.Ref = &ref
			}
		case "rewrite":
			resp.Out = references.RewriteDocPath(req.Content, req.Old, req.New)
		}
		if err := enc.Encode(resp); err != nil {
			os.Exit(2)
		}
	}
}
