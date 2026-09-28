#!/bin/sh
# Knowns CLI installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/knowns-dev/knowns/main/install/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/knowns-dev/knowns/main/install/install.sh | sh
#
# Options (via env vars):
#   KNOWNS_INSTALL_DIR  - install directory (default: ~/.knowns/bin)
#   KNOWNS_VERSION      - specific version (default: latest)
#   KNOWNS_NO_SYMLINK   - set to 1 to skip creating 'kn' symlink
#   KNOWNS_LINK_DIR     - directory on PATH to link knowns and kn into
#                         (default: ~/.local/bin, when it is already on PATH)
#   KNOWNS_NO_LINK      - set to 1 to skip linking into a PATH directory

set -e

REPO="knowns-dev/knowns"
BINARY="knowns"
DEFAULT_INSTALL_DIR="${HOME}/.knowns/bin"
INSTALL_DIR="${KNOWNS_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
KNOWN_DIR="${HOME}/.knowns"

# ─── Colors ───────────────────────────────────────────────────────────

if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    DIM='\033[0;90m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    RESET='\033[0m'
else
    RED='' GREEN='' DIM='' CYAN='' BOLD='' RESET=''
fi

info()    { printf "\033[K  ${DIM}%s${RESET}\n" "$1"; }
# \033[K clears what the "⠋ ...\r" progress line left behind.
success() { printf "\033[K  ${GREEN}✓${RESET} %s\n" "$1"; }
error()   { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

# ─── Platform detection ───────────────────────────────────────────────

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$OS" in
        darwin)  OS="darwin" ;;
        linux)   OS="linux" ;;
        mingw*|msys*|cygwin*) OS="win" ;;
        *)       error "Unsupported OS: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)             error "Unsupported architecture: $ARCH" ;;
    esac

    PLATFORM="${OS}-${ARCH}"
}

# ─── Version resolution ──────────────────────────────────────────────

resolve_version() {
    if [ -n "$KNOWNS_VERSION" ]; then
        VERSION="$KNOWNS_VERSION"
        # Ensure 'v' prefix
        case "$VERSION" in
            v*) ;;
            *)  VERSION="v${VERSION}" ;;
        esac
        return
    fi

    # Fetch latest release tag
    if command -v curl >/dev/null 2>&1; then
        VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
            | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
    elif command -v wget >/dev/null 2>&1; then
        VERSION=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" \
            | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
    else
        error "curl or wget is required"
    fi

    if [ -z "$VERSION" ]; then
        error "Failed to determine latest version"
    fi
}

# ─── Download helpers ─────────────────────────────────────────────────

download() {
    url="$1"
    dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$dest" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$dest" "$url"
    else
        error "curl or wget is required"
    fi
}

write_install_metadata() {
    mkdir -p "$KNOWN_DIR"
    links_json=""
    for l in $LINKED_PATHS; do
        links_json="${links_json:+${links_json}, }\"${l}\""
    done
    cat > "${KNOWN_DIR}/install.json" <<EOF
{
  "method": "script",
  "managedBy": "knowns-script",
  "updateStrategy": "self-update",
  "channel": "stable",
  "platform": "${OS}",
  "arch": "${ARCH}",
  "binaryPath": "${INSTALL_DIR}/${BINARY}",
  "linkPaths": [${links_json}],
  "version": "${VERSION#v}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

# ─── PATH linking ─────────────────────────────────────────────────────
#
# `curl | sh` runs in a child process, so it can never change the PATH of
# the shell that launched it. Instead of editing rc files, link the binary
# into a directory that is already on PATH.

on_path() {
    case ":$PATH:" in
        *":$1:"*) return 0 ;;
    esac
    return 1
}

# Links $2 -> $1, refusing to replace anything that is not a symlink, so a
# knowns from Homebrew or npm is never clobbered.
link_one() {
    target="$1"
    link="$2"
    if [ -e "$link" ] && [ ! -L "$link" ]; then
        info "Skipped ${link}: a file that is not a symlink already exists"
        return 1
    fi
    ln -sf "$target" "$link" 2>/dev/null || return 1
    LINKED_PATHS="${LINKED_PATHS:+${LINKED_PATHS} }${link}"
}

link_into_path() {
    LINKED_PATHS=""
    [ "${KNOWNS_NO_LINK:-0}" = "1" ] && return 0
    # Link even when INSTALL_DIR is on this shell's PATH. That entry usually
    # comes from an rc line only interactive shells read, so an editor, an
    # agent started from an older tab, launchd and hooks still cannot find
    # knowns without the link.
    if [ -n "$KNOWNS_LINK_DIR" ]; then
        link_dir="$KNOWNS_LINK_DIR"
    elif on_path "${HOME}/.local/bin"; then
        link_dir="${HOME}/.local/bin"
    else
        return 0
    fi
    # Installed straight into the link dir: the binary is already there.
    [ "${link_dir%/}" = "${INSTALL_DIR%/}" ] && return 0

    mkdir -p "$link_dir" 2>/dev/null || true
    if [ ! -w "$link_dir" ]; then
        info "Skipped linking: ${link_dir} is not writable"
        return 0
    fi

    link_one "${INSTALL_DIR}/${BINARY}" "${link_dir}/${BINARY}" || return 0
    if [ "${KNOWNS_NO_SYMLINK:-0}" != "1" ]; then
        link_one "${INSTALL_DIR}/${BINARY}" "${link_dir}/kn" || true
    fi
    success "Linked into ${link_dir}"
    on_path "$link_dir" || info "${link_dir} is not on PATH yet"
}

print_path_hint() {
    printf "\n  ${DIM}Add ${INSTALL_DIR} to your PATH:${RESET}\n"
    printf "  ${DIM}  export PATH=\"${INSTALL_DIR}:\$PATH\"${RESET}\n"
    if [ "$OS" = "darwin" ]; then
        printf "\n  ${DIM}Or, for every shell without editing rc files:${RESET}\n"
        printf "  ${DIM}  echo \"${INSTALL_DIR}\" | sudo tee /etc/paths.d/knowns${RESET}\n"
    fi
    printf "\n  ${DIM}Or reinstall with a directory that is on PATH:${RESET}\n"
    printf "  ${DIM}  curl -fsSL https://knowns.sh/script/install | KNOWNS_LINK_DIR=<dir> sh${RESET}\n"
}

# ─── Checksum verification ───────────────────────────────────────────

verify_checksum() {
    archive="$1"
    checksum_file="$2"

    expected=$(cat "$checksum_file" | awk '{print $1}')

    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$archive" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$archive" | awk '{print $1}')
    else
        info "sha256sum not found, skipping checksum verification"
        return 0
    fi

    if [ "$expected" != "$actual" ]; then
        error "Checksum mismatch!\n  Expected: ${expected}\n  Got:      ${actual}"
    fi
}

# ─── Main ─────────────────────────────────────────────────────────────

main() {
    printf "\n  ${BOLD}${CYAN}Knowns CLI Installer${RESET}\n\n"

    detect_platform
    resolve_version

    ARCHIVE="${BINARY}-${PLATFORM}.tar.gz"
    URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARCHIVE}"
    CHECKSUM_URL="${URL}.sha256"

    info "Version:  ${VERSION}"
    info "Platform: ${PLATFORM}"
    info "Install:  ${INSTALL_DIR}"
    printf "\n"

    # Create temp dir
    TMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TMP_DIR"' EXIT

    # Download archive
    printf "  ${DIM}⠋${RESET} Downloading ${ARCHIVE}...\r"
    download "$URL" "${TMP_DIR}/${ARCHIVE}" || error "Download failed: ${URL}"
    success "Downloaded ${ARCHIVE}"

    # Download & verify checksum
    printf "  ${DIM}⠋${RESET} Verifying checksum...\r"
    download "$CHECKSUM_URL" "${TMP_DIR}/${ARCHIVE}.sha256" 2>/dev/null || rm -f "${TMP_DIR}/${ARCHIVE}.sha256"
    if [ -f "${TMP_DIR}/${ARCHIVE}.sha256" ]; then
        verify_checksum "${TMP_DIR}/${ARCHIVE}" "${TMP_DIR}/${ARCHIVE}.sha256"
        success "Checksum verified"
    else
        info "Checksum file not available, skipped verification"
    fi

    # Extract
    printf "  ${DIM}⠋${RESET} Extracting...\r"
    tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "$TMP_DIR"
    success "Extracted"

    # Find the main binary in extracted files
    EXTRACTED_BIN=""
    if [ -f "${TMP_DIR}/${BINARY}" ]; then
        EXTRACTED_BIN="${TMP_DIR}/${BINARY}"
    elif [ -f "${TMP_DIR}/${BINARY}-${PLATFORM}" ]; then
        EXTRACTED_BIN="${TMP_DIR}/${BINARY}-${PLATFORM}"
    else
        EXTRACTED_BIN=$(find "$TMP_DIR" -name "${BINARY}" -o -name "${BINARY}-${PLATFORM}" | head -1)
    fi

    if [ -z "$EXTRACTED_BIN" ] || [ ! -f "$EXTRACTED_BIN" ]; then
        error "Binary not found in archive"
    fi

    EXTRACT_ROOT=$(dirname "$EXTRACTED_BIN")

    # Install bundle (main binary + native libs)
    printf "  ${DIM}⠋${RESET} Installing to ${INSTALL_DIR}...\r"
    mkdir -p "$INSTALL_DIR" 2>/dev/null || true

    cp "$EXTRACTED_BIN" "${INSTALL_DIR}/${BINARY}"
    chmod +x "${INSTALL_DIR}/${BINARY}"

    # Install colocated ONNX Runtime native libs (dylib/so/dll)
    for f in "${EXTRACT_ROOT}"/libonnxruntime* \
             "${EXTRACT_ROOT}"/onnxruntime.dll; do
        [ -e "$f" ] || continue
        cp "$f" "${INSTALL_DIR}/"
    done

    success "Installed to ${INSTALL_DIR}/${BINARY}"

    # Create 'kn' symlink
    if [ "${KNOWNS_NO_SYMLINK:-0}" != "1" ]; then
        ln -sf "${INSTALL_DIR}/${BINARY}" "${INSTALL_DIR}/kn" 2>/dev/null || true
        if [ -L "${INSTALL_DIR}/kn" ]; then
            success "Created symlink: kn → knowns"
        fi
    fi

    link_into_path

    write_install_metadata
    success "Recorded install metadata in ${KNOWN_DIR}/install.json"

    # Verify installation. Only a link into a directory that was already on
    # PATH makes knowns resolvable from the user's current shell.
    printf "\n"
    reachable=0
    on_path "$INSTALL_DIR" && reachable=1
    for l in $LINKED_PATHS; do
        on_path "$(dirname "$l")" && reachable=1
    done
    if [ "$reachable" = "1" ]; then
        printf "  ${GREEN}${BOLD}Knowns CLI ${VERSION} installed successfully!${RESET}\n"
        printf "  ${DIM}Run 'hash -r' (or open a new terminal) if your shell still cannot find knowns.${RESET}\n"
    else
        printf "  ${GREEN}${BOLD}Knowns CLI installed successfully!${RESET}\n"
        print_path_hint
    fi

    printf "\n  ${DIM}Get started:${RESET}\n"
    printf "  ${DIM}  knowns init${RESET}\n"
    printf "  ${DIM}  knowns task create \"My first task\"${RESET}\n\n"

    printf "  ${DIM}Uninstall:${RESET}\n"
    printf "  ${DIM}  curl -fsSL https://knowns.sh/script/uninstall | sh${RESET}\n\n"
}

if [ "${KNOWNS_INSTALLER_TEST:-0}" != "1" ]; then
    main
fi
