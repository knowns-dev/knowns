#!/usr/bin/env bash
# Runs the Go e2e suite (tests/) with a throwaway HOME.
#
# The suite runs the knowns binary with the caller's environment, so without this wrapper every
# run registers its TestCLI_* / TestMCP_* temp projects in the real ~/.knowns/runtime/projects.json
# (and can touch the rest of ~/.knowns). tests/ is frozen Go code (spec D2), so the isolation lives
# here instead.
#
# Usage: [TEST_BINARY=path/to/knowns] scripts/go-e2e.sh [go test flags...]
#   scripts/go-e2e.sh -v -timeout 90m
#   TEST_BINARY=cli/dist/linux-x64/knowns scripts/go-e2e.sh -v -run TestCLI
# Without TEST_BINARY the suite uses bin/knowns (building it if missing). Exit code is go test's.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# go test runs in tests/, so a relative TEST_BINARY would resolve there. Pin it to the caller's cwd.
if [[ -n "${TEST_BINARY:-}" && "${TEST_BINARY}" != /* ]]; then
  TEST_BINARY="$(pwd)/${TEST_BINARY}"
fi
if [[ -n "${TEST_BINARY:-}" ]]; then
  if [[ ! -x "${TEST_BINARY}" ]]; then
    echo "go-e2e: TEST_BINARY is not an executable file: ${TEST_BINARY}" >&2
    exit 2
  fi
  export TEST_BINARY
fi

# Pin Go's caches and its env file to their real locations BEFORE moving HOME; otherwise go would
# rebuild everything into the temp home and lose `go env -w` settings.
GOPATH="$(go env GOPATH)"
GOMODCACHE="$(go env GOMODCACHE)"
GOCACHE="$(go env GOCACHE)"
GOENV="$(go env GOENV)"
export GOPATH GOMODCACHE GOCACHE GOENV

tmp_home="$(mktemp -d "${TMPDIR:-/tmp}/knowns-go-e2e-home.XXXXXX")"
cleanup() { rm -rf "${tmp_home}"; }
trap cleanup EXIT

export HOME="${tmp_home}"
# A test spawns a detached LSP daemon whose unix socket lives in TMPDIR and is keyed by project
# root. With the caller's TMPDIR it shares (and can take over) the socket of the real daemon for
# this repository and outlives the run. A private TMPDIR keeps its socket apart; the orphan then
# idles out on its own. (Windows uses named pipes, which this does not isolate.)
mkdir -p "${tmp_home}/tmp"
export TMPDIR="${tmp_home}/tmp"
# XDG dirs and Knowns overrides could still point at real locations; let them default under HOME.
unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
unset KNOWNS_RUNTIME_INLINE KNOWNS_RUNTIME_ROOT KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT KNOWNS_PROJECT
export NO_UPDATE_CHECK="${NO_UPDATE_CHECK:-1}"

cd "${repo_root}"
set +e
go test ./tests/ -count=1 "$@"
status=$?
set -e
exit "${status}"
