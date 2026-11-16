// knowns-proxy: the thin MCP stdio proxy. It forwards the agent's JSON-RPC to the per-user
// Knowns daemon and falls back to an in-process `knowns mcp --stdio` when the daemon cannot serve.
// See @doc/specs/2026-11-16/mcp-thin-proxy.
package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"
)

var isWindows = runtime.GOOS == "windows"

func main() {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "knowns-proxy: cannot read the working directory:", err)
		os.Exit(1)
	}
	c := &config{stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, cwd: cwd, project: os.Getenv("KNOWNS_PROJECT")}
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--version" || a == "-v" || a == "version":
			fmt.Println("knowns-proxy version " + version)
			return
		case a == "--project" && i+1 < len(args):
			i++
			c.project = args[i]
		case strings.HasPrefix(a, "--project="):
			c.project = strings.TrimPrefix(a, "--project=")
		}
	}
	c.disableProxy = strings.TrimSpace(os.Getenv("KNOWNS_MCP_PROXY")) == "0"
	os.Exit(newSession(c).run())
}
