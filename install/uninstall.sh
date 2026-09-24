#!/bin/sh
# Knowns CLI uninstaller
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/knowns-dev/knowns/main/install/uninstall.sh | sh
#   wget -qO- https://raw.githubusercontent.com/knowns-dev/knowns/main/install/uninstall.sh | sh
#
# Options (via env vars):
#   KNOWNS_INSTALL_DIR  - install directory (default: ~/.knowns/bin, matching install.sh)

set -e

DEFAULT_INSTALL_DIR="${HOME}/.knowns/bin"
INSTALL_DIR="${KNOWNS_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
KNOWN_DIR="${HOME}/.knowns"
METADATA="${KNOWN_DIR}/install.json"
LEGACY_INSTALL_DIR="/usr/local/bin"

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
warn()    { printf "  ${DIM}-%s${RESET}\n" " $1"; }
error()   { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

remove_path() {
    target="$1"

    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
        return 1
    fi

    if [ -w "$(dirname "$target")" ]; then
        rm -f "$target"
    else
        sudo rm -f "$target"
    fi

    return 0
}

# Prints the linkPaths the installer recorded, one per line, without a jq
# dependency. install.sh writes the array on one line; `knowns update`
# rewrites it one entry per line, so read from the key to the closing ].
recorded_links() {
    [ -f "$METADATA" ] || return 0
    sed -n '/"linkPaths"/,/]/p' "$METADATA" | grep -o '"/[^"]*"' | tr -d '"'
}

# Removes $1 only if it is a symlink to the binary we installed, so a knowns
# from Homebrew or npm sharing the directory is left alone.
remove_link() {
    link="$1"
    [ -L "$link" ] || return 1
    case "$(readlink "$link")" in
        "${INSTALL_DIR}/knowns") ;;
        *) warn "Left ${link}: it does not point at ${INSTALL_DIR}/knowns"; return 1 ;;
    esac
    remove_path "$link"
}

main() {
    printf "\n  ${BOLD}${CYAN}Knowns CLI Uninstaller${RESET}\n\n"
    info "Install:  ${INSTALL_DIR}"
    printf "\n"

    removed=0

    if remove_path "${INSTALL_DIR}/knowns"; then
        success "Removed ${INSTALL_DIR}/knowns"
        removed=1
    fi

    if remove_path "${INSTALL_DIR}/kn"; then
        success "Removed ${INSTALL_DIR}/kn"
        removed=1
    fi

    for link in $(recorded_links); do
        if remove_link "$link"; then
            success "Removed ${link}"
        fi
    done

    if [ "$removed" -eq 0 ]; then
        warn "No Knowns binaries found in ${INSTALL_DIR}"
        if [ -z "$KNOWNS_INSTALL_DIR" ] && [ -e "${LEGACY_INSTALL_DIR}/knowns" ]; then
            info "Found ${LEGACY_INSTALL_DIR}/knowns from an older installer; remove it with:"
            info "  curl -fsSL https://knowns.sh/script/uninstall | KNOWNS_INSTALL_DIR=${LEGACY_INSTALL_DIR} sh"
        fi
    fi

    if [ -f "$METADATA" ] && grep -q '"managedBy": "knowns-script"' "$METADATA"; then
        rm -f "$METADATA"
    fi

    if [ -d "$INSTALL_DIR" ] && [ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
        if [ -w "$(dirname "$INSTALL_DIR")" ]; then
            rmdir "$INSTALL_DIR" 2>/dev/null || true
        else
            sudo rmdir "$INSTALL_DIR" 2>/dev/null || true
        fi
    fi

    printf "\n"
    success "Knowns CLI uninstall complete"
    info "Project folders and .knowns data were left untouched"
    printf "\n"
}

main
