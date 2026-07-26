package main

import (
	"os"

	"github.com/howznguyen/knowns/internal/cli"
)

func main() {
	if err := cli.Execute(); err != nil {
		os.Exit(cli.ExitCode(err))
	}
}
