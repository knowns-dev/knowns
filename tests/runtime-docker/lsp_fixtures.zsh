#!/usr/bin/env zsh
emulate -L zsh
set -e
set -u
set -o pipefail

export CI=1
export NO_COLOR=1
export NO_UPDATE_CHECK=1
export KNOWNS_LSP_DAEMON=0
export TEST_LSP_FIXTURES=1
export TEST_BINARY=/opt/knowns/bin/knowns

status_file="$(mktemp)"
trap 'rm -f "$status_file"' EXIT

knowns lsp list --json >"$status_file"

if ! jq -e '
  [.[] | select(.id == "markdown" or .id == "bash" or .id == "json" or .id == "terraform" or .id == "yaml")] as $rows
  | ($rows | length) == 5
    and all($rows[];
      .install_state == "installed"
      and .requested_version == "recommended"
      and (.resolved_version | type == "string" and length > 0)
      and (.source_location | type == "string" and length > 0)
      and (.integrity | type == "string" and length > 0)
      and (.selected_path | type == "string" and length > 0)
      and .verified == true)
' "$status_file" >/dev/null; then
  echo "managed LSP provenance check failed" >&2
  jq '[.[] | select(.id == "markdown" or .id == "bash" or .id == "json" or .id == "terraform" or .id == "yaml")]' "$status_file" >&2
  exit 1
fi

typeset -a server_dirs
while IFS= read -r selected_path; do
  if [[ ! -x "$selected_path" ]]; then
    echo "managed LSP selected path is not executable: $selected_path" >&2
    exit 1
  fi
  server_dirs+=("${selected_path:h}")
done < <(jq -r '.[] | select(.id == "markdown" or .id == "bash" or .id == "json" or .id == "terraform" or .id == "yaml") | .selected_path' "$status_file")

export PATH="${(j/:/)server_dirs}:$PATH"

echo "=== managed LSP fixture provenance ==="
jq '[.[] | select(.id == "markdown" or .id == "bash" or .id == "json" or .id == "terraform" or .id == "yaml") | {id,requested_version,resolved_version,selected_path,verified}]' "$status_file"
terraform version

echo "=== run managed LSP fixture suite ==="
/opt/knowns/bin/lspfixtures.test \
  -test.v \
  -test.timeout=15m \
  -test.run='^TestLSPFixture_(MarkdownMarksman|Bash|JSONLocalSchema|Terraform|YAMLLocalSchema)$'
