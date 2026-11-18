// knowns: the launcher. It is the `knowns` command (spec mcp-thin-proxy D10). `knowns mcp --stdio`
// runs here, as the thin MCP stdio proxy: it forwards the agent's JSON-RPC to the per-user Knowns
// daemon and falls back to the engine's in-process `knowns-engine mcp --stdio` when the daemon
// cannot serve. Every other invocation is handed to the TypeScript engine, knowns-engine, which
// is installed next to the launcher.
package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"
)

var isWindows = runtime.GOOS == "windows"

// mcpStdio reports whether args are exactly `mcp --stdio` with at most a --project. Anything else
// (`mcp --help`, other flags) belongs to the engine.
func mcpStdio(args []string) (project string, ok bool) {
	if len(args) == 0 || args[0] != "mcp" {
		return "", false
	}
	stdio := false
	for i := 1; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--stdio":
			stdio = true
		case a == "--project" && i+1 < len(args):
			i++
			project = args[i]
		case strings.HasPrefix(a, "--project="):
			project = strings.TrimPrefix(a, "--project=")
		default:
			return "", false
		}
	}
	return project, stdio
}

func main() {
	args := os.Args[1:]
	disabled := strings.TrimSpace(os.Getenv("KNOWNS_MCP_PROXY")) == "0"
	if project, ok := mcpStdio(args); ok && !disabled {
		cwd, err := os.Getwd()
		if err != nil {
			fmt.Fprintln(os.Stderr, "knowns: cannot read the working directory:", err)
			os.Exit(1)
		}
		if project == "" {
			project = os.Getenv("KNOWNS_PROJECT")
		}
		c := &config{stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, cwd: cwd, project: project}
		os.Exit(newSession(c).run())
	}
	os.Exit(runEngine(args))
}

// runEngine hands the command to the engine and returns the exit code (the Unix handoff returns
// only when the exec failed).
func runEngine(args []string) int {
	engine, err := findEngine()
	if err == nil && engineOverride() == "" {
		// A directory entry that is not there or not a file is a missing engine, said clearly.
		if st, serr := os.Stat(engine); serr != nil || st.IsDir() {
			err = errNoEngine
		}
	}
	if err != nil {
		if len(args) > 0 && (args[0] == "--version" || args[0] == "-v" || args[0] == "version") {
			fmt.Println("knowns version " + version + " (launcher only)")
		}
		return missingEngine("the knowns engine ("+engineName()+") was not found next to "+launcherPath(), 127)
	}
	return handoff(engine, args)
}
