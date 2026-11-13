//go:build ignore

// codegen-oracle drives the real Go internal/codegen engine for differential tests.
// Input: one JSON request per stdin line. Output: one JSON response per line.
//
//	{"op":"render","tpl":"...","vars":{"a":"b"}}            -> {"out":"...","err":""}
//	{"op":"validate","tpl":"..."}                            -> {"out":"<go template>","err":""}
//	{"op":"run","root":"/p","tmpl":{...},"vars":{},"dryRun":false}
//	                                                         -> {"created":[],"modified":[],"skipped":[],"err":""}
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/models"
)

type request struct {
	Op     string            `json:"op"`
	Tpl    string            `json:"tpl"`
	Vars   map[string]string `json:"vars"`
	Root   string            `json:"root"`
	Tmpl   *models.Template  `json:"tmpl"`
	DryRun bool              `json:"dryRun"`
}

type response struct {
	Out      string   `json:"out"`
	Err      string   `json:"err"`
	Created  []string `json:"created"`
	Modified []string `json:"modified"`
	Skipped  []string `json:"skipped"`
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	for sc.Scan() {
		var req request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			fmt.Fprintln(os.Stderr, "bad request:", err)
			os.Exit(2)
		}
		var res response
		switch req.Op {
		case "render":
			out, err := codegen.NewEngine(req.Root).RenderString(req.Tpl, req.Vars)
			res.Out = out
			if err != nil {
				res.Err = err.Error()
			}
		case "validate":
			out, err := codegen.NewEngine(req.Root).ValidateTemplate(req.Tpl)
			res.Out = out
			if err != nil {
				res.Err = err.Error()
			}
		case "run":
			r, err := codegen.NewEngine(req.Root).Run(req.Tmpl, req.Vars, req.DryRun)
			if r != nil {
				res.Created, res.Modified, res.Skipped = r.Created, r.Modified, r.Skipped
			}
			if err != nil {
				res.Err = err.Error()
			}
		}
		if err := enc.Encode(res); err != nil {
			os.Exit(2)
		}
	}
}
