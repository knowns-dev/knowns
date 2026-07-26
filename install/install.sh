#!/bin/sh
# Knowns CLI installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/knowns-dev/knowns/main/install/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/knowns-dev/knowns/main/install/install.sh | sh
#
# Options (via env vars):
#   KNOWNS_INSTALL_DIR  — install directory (default: ~/.knowns/bin)
#   KNOWNS_VERSION      — specific version (default: latest)
#   KNOWNS_NO_SYMLINK   — set to 1 to skip creating 'kn' symlink

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

info()    { printf "  ${DIM}%s${RESET}\n" "$1"; }
success() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
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
    cat > "${KNOWN_DIR}/install.json" <<EOF
{
  "method": "script",
  "managedBy": "knowns-script",
  "updateStrategy": "self-update",
  "channel": "stable",
  "platform": "${OS}",
  "arch": "${ARCH}",
  "binaryPath": "${INSTALL_DIR}/${BINARY}",
  "version": "${VERSION#v}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
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
    download "$CHECKSUM_URL" "${TMP_DIR}/${ARCHIVE}.sha256" 2>/dev/null
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

    write_install_metadata
    success "Recorded install metadata in ${KNOWN_DIR}/install.json"

    # Verify installation
    printf "\n"
    if command -v knowns >/dev/null 2>&1; then
        INSTALLED_VERSION=$(knowns --version 2>/dev/null || echo "unknown")
        printf "  ${GREEN}${BOLD}Knowns CLI ${INSTALLED_VERSION} installed successfully!${RESET}\n"
    else
        printf "  ${GREEN}${BOLD}Knowns CLI installed successfully!${RESET}\n"
        # Check if install dir is in PATH
        case ":$PATH:" in
            *":${INSTALL_DIR}:"*) ;;
            *)
                printf "\n  ${DIM}Add to your PATH:${RESET}\n"
                printf "  ${DIM}  export PATH=\"${INSTALL_DIR}:\$PATH\"${RESET}\n"
                ;;
        esac
    fi

    printf "\n  ${DIM}Get started:${RESET}\n"
    printf "  ${DIM}  knowns init${RESET}\n"
    printf "  ${DIM}  knowns task create \"My first task\"${RESET}\n\n"

    printf "  ${DIM}Uninstall:${RESET}\n"
    printf "  ${DIM}  curl -fsSL https://github.com/${REPO}/releases/download/${VERSION}/uninstall.sh | sh${RESET}\n\n"
}

if [ "${KNOWNS_INSTALLER_TEST:-0}" != "1" ]; then
    main
fi
