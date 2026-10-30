#!/usr/bin/env bash
# Installs `nw`, `ds`, interactive shell integration (bash/zsh), and the
# `nw-worktrees` VS Code extension from this repository.
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   --sdk <dir>        Path to your main Dart SDK checkout (e.g. ~/dart-sdk/sdk)
#   --worktrees <dir>  Directory where `nw` creates worktrees
#                      (default: ~/dart-sdk-worktrees)
#   --bin-dir <dir>    Directory on PATH for `nw` and `ds` symlinks
#                      (default: ~/bin if present/on PATH, else ~/.local/bin)
#   --no-vscode        Skip packaging & installing the VS Code extension
#   --no-shell-rc      Do not modify ~/.bashrc or ~/.zshrc (print snippet only)
#   -h, --help         Show this help message

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dart-worktrees"
CFG_FILE="$CFG_DIR/config.env"
MARKER_BEGIN="# >>> dart-worktrees >>>"
MARKER_END="# <<< dart-worktrees <<<"

usage() { sed -En '2,/^$/s/^#( |$)//p' "$0"; }
die() { echo "install.sh: $*" >&2; exit 1; }
log() { echo "==> $*"; }

expand_tilde() {
  local p="$1"
  case "$p" in
    "~") echo "$HOME" ;;
    "~/"*) echo "$HOME/${p#~/}" ;;
    *) echo "$p" ;;
  esac
}

is_dart_sdk_checkout() {
  local d="$1"
  [[ -d "$d" && -f "$d/tools/build.py" && -f "$d/DEPS" ]]
}

normalize_sdk_candidate() {
  local raw
  raw="$(expand_tilde "$1")"
  raw="${raw%/}"
  if is_dart_sdk_checkout "$raw"; then
    (cd -P "$raw" && pwd)
    return 0
  fi
  # Accept the gclient root (e.g. ~/dart-sdk instead of ~/dart-sdk/sdk).
  if is_dart_sdk_checkout "$raw/sdk"; then
    (cd -P "$raw/sdk" && pwd)
    return 0
  fi
  return 1
}

detect_sdk_checkout() {
  local arg_sdk="$1" existing_sdk="$2" candidate resolved
  if [[ -n "$arg_sdk" ]]; then
    resolved="$(normalize_sdk_candidate "$arg_sdk")" ||
      die "'$arg_sdk' does not look like a Dart SDK checkout (missing tools/build.py or DEPS)"
    echo "$resolved"
    return 0
  fi

  for candidate in \
    "$existing_sdk" \
    "${DART_MAIN_CHECKOUT:-}" \
    "$HOME/dart-sdk/sdk" \
    "$HOME/sdk/sdk" \
    "$HOME/src/dart-sdk/sdk" \
    "$HOME/src/sdk/sdk" \
    "$HOME/dart/sdk"; do
    [[ -n "$candidate" ]] || continue
    if resolved="$(normalize_sdk_candidate "$candidate")"; then
      echo "$resolved"
      return 0
    fi
  done

  if [[ -t 0 ]]; then
    local reply
    read -r -p "Path to your main Dart SDK checkout (e.g. ~/dart-sdk/sdk): " reply
    [[ -n "$reply" ]] || die "no Dart SDK checkout specified"
    resolved="$(normalize_sdk_candidate "$reply")" ||
      die "'$reply' does not look like a Dart SDK checkout (missing tools/build.py or DEPS)"
    echo "$resolved"
    return 0
  fi

  die "could not auto-detect your main Dart SDK checkout; re-run with: ./install.sh --sdk <path/to/sdk>"
}

default_bin_dir() {
  if [[ -d "$HOME/bin" ]] || [[ ":$PATH:" == *":$HOME/bin:"* ]]; then
    echo "$HOME/bin"
  else
    echo "$HOME/.local/bin"
  fi
}

update_rc_file() {
  local rc_file="$1" snippet="$2"
  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"

  python3 - "$rc_file" "$MARKER_BEGIN" "$MARKER_END" "$snippet" <<'PY'
import sys

rc_path, begin, end, snippet = sys.argv[1:]
with open(rc_path, "r", encoding="utf-8") as f:
  content = f.read()

block = f"{begin}\n{snippet}\n{end}\n"

if begin in content and end in content:
  pre, rest = content.split(begin, 1)
  _, post = rest.split(end, 1)
  post = post.lstrip("\n")
  updated = pre.rstrip("\n")
  if updated:
    updated += "\n\n"
  updated += block
  if post:
    updated += "\n" + post
else:
  updated = content.rstrip("\n")
  if updated:
    updated += "\n\n"
  updated += block

if updated != content:
  with open(rc_path, "w", encoding="utf-8") as f:
    f.write(updated)
PY
  log "Updated shell integration in $rc_file"
}

main() {
  local opt_sdk="" opt_worktrees="" opt_bin_dir=""
  local install_vscode=true update_shell_rc=true

  while (( $# > 0 )); do
    case "$1" in
      --sdk)
        [[ $# -ge 2 ]] || die "--sdk requires an argument"
        opt_sdk="$2"
        shift 2
        ;;
      --sdk=*)
        opt_sdk="${1#*=}"
        shift
        ;;
      --worktrees)
        [[ $# -ge 2 ]] || die "--worktrees requires an argument"
        opt_worktrees="$2"
        shift 2
        ;;
      --worktrees=*)
        opt_worktrees="${1#*=}"
        shift
        ;;
      --bin-dir)
        [[ $# -ge 2 ]] || die "--bin-dir requires an argument"
        opt_bin_dir="$2"
        shift 2
        ;;
      --bin-dir=*)
        opt_bin_dir="${1#*=}"
        shift
        ;;
      --no-vscode)
        install_vscode=false
        shift
        ;;
      --no-shell-rc)
        update_shell_rc=false
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "unknown option '$1' (see ./install.sh --help)"
        ;;
    esac
  done

  command -v git >/dev/null 2>&1 || die "'git' is required"
  command -v python3 >/dev/null 2>&1 || die "'python3' is required"

  # Load any existing config values so re-running ./install.sh preserves them.
  local prev_main="" prev_wt="" prev_link="" prev_mode="" prev_arch=""
  local prev_out="" prev_sub="" prev_ws="" prev_code="" prev_seed=""
  if [[ -f "$CFG_FILE" ]]; then
    # shellcheck disable=SC1090
    eval "$(
      DART_MAIN_CHECKOUT="" DART_WORKTREES_DIR="" DART_LINK="" \
      DART_BUILD_MODE="" DART_BUILD_ARCH="" DART_OUT_DIR_NAME="" \
      DART_SDK_SUBPATH="" DART_VSCODE_WORKSPACE="" DART_CODE_CMD="" \
      DART_SEED_OUT="" \
      bash -c 'source "$1" >/dev/null 2>&1 || true
        printf "prev_main=%q\nprev_wt=%q\nprev_link=%q\nprev_mode=%q\n" \
          "$DART_MAIN_CHECKOUT" "$DART_WORKTREES_DIR" "$DART_LINK" "$DART_BUILD_MODE"
        printf "prev_arch=%q\nprev_out=%q\nprev_sub=%q\nprev_ws=%q\nprev_code=%q\nprev_seed=%q\n" \
          "$DART_BUILD_ARCH" "$DART_OUT_DIR_NAME" "$DART_SDK_SUBPATH" "$DART_VSCODE_WORKSPACE" "$DART_CODE_CMD" "$DART_SEED_OUT"
      ' _ "$CFG_FILE"
    )"
  fi

  local sdk_dir worktrees_dir dart_link bin_dir
  sdk_dir="$(detect_sdk_checkout "$opt_sdk" "$prev_main")"

  if [[ -n "$opt_worktrees" ]]; then
    worktrees_dir="$(expand_tilde "$opt_worktrees")"
    worktrees_dir="${worktrees_dir%/}"
    [[ "$worktrees_dir" == "$REPO_ROOT" ]] &&
      die "--worktrees ($worktrees_dir) cannot be this tool repository's own directory"
  elif [[ -n "$prev_wt" && "$prev_wt" != "$REPO_ROOT" ]]; then
    worktrees_dir="${prev_wt%/}"
  elif [[ "$REPO_ROOT" == "$HOME/dart-sdk-worktrees" ]]; then
    worktrees_dir="$HOME/sdk-worktrees"
    log "Tool checkout is at $REPO_ROOT; storing SDK worktrees in $worktrees_dir"
  else
    worktrees_dir="$HOME/dart-sdk-worktrees"
  fi

  dart_link="${prev_link:-$HOME/.dart-current}"

  if [[ -n "$opt_bin_dir" ]]; then
    bin_dir="$(expand_tilde "$opt_bin_dir")"
  else
    bin_dir="$(default_bin_dir)"
  fi
  bin_dir="${bin_dir%/}"

  chmod +x \
    "$REPO_ROOT/bin/nw" \
    "$REPO_ROOT/bin/ds" \
    "$REPO_ROOT/lib/seed_out.py" \
    "$REPO_ROOT/vscode/src/cliSync.js" \
    "$REPO_ROOT/vscode/scripts/package_and_install.py"
  [[ -f "$REPO_ROOT/uninstall.sh" ]] && chmod +x "$REPO_ROOT/uninstall.sh"

  mkdir -p "$CFG_DIR" "$worktrees_dir" "$bin_dir"
  {
    echo "# Generated by dart-worktrees/install.sh — edit freely or re-run install.sh."
    printf 'DART_MAIN_CHECKOUT=%q\n' "$sdk_dir"
    printf 'DART_WORKTREES_DIR=%q\n' "$worktrees_dir"
    printf 'DART_LINK=%q\n' "$dart_link"
    [[ -n "$prev_mode" ]] && printf 'DART_BUILD_MODE=%q\n' "$prev_mode"
    [[ -n "$prev_arch" ]] && printf 'DART_BUILD_ARCH=%q\n' "$prev_arch"
    [[ -n "$prev_out" ]]  && printf 'DART_OUT_DIR_NAME=%q\n' "$prev_out"
    [[ -n "$prev_sub" ]]  && printf 'DART_SDK_SUBPATH=%q\n' "$prev_sub"
    [[ -n "$prev_ws" ]]   && printf 'DART_VSCODE_WORKSPACE=%q\n' "$prev_ws"
    [[ -n "$prev_code" ]] && printf 'DART_CODE_CMD=%q\n' "$prev_code"
    [[ -n "$prev_seed" ]] && printf 'DART_SEED_OUT=%q\n' "$prev_seed"
  } > "$CFG_FILE"
  log "Wrote configuration to $CFG_FILE"
  echo "    DART_MAIN_CHECKOUT=$sdk_dir"
  echo "    DART_WORKTREES_DIR=$worktrees_dir"

  if [[ ! -L "$dart_link" && ! -e "$dart_link" ]]; then
    ln -sfn "$sdk_dir" "$dart_link"
    log "Initialized $dart_link -> $sdk_dir"
  fi

  local tool target existing
  for tool in nw ds; do
    target="$REPO_ROOT/bin/$tool"
    existing="$bin_dir/$tool"
    if [[ -e "$existing" && ! -L "$existing" ]]; then
      mv "$existing" "${existing}.pre-dart-worktrees.bak"
      log "Backed up existing $existing -> ${existing}.pre-dart-worktrees.bak"
    fi
    ln -sfn "$target" "$existing"
    log "Linked $existing -> $target"
  done

  local snippet="[ -f \"$REPO_ROOT/shell/init.sh\" ] && . \"$REPO_ROOT/shell/init.sh\""
  if $update_shell_rc; then
    local updated_any=false user_shell="${SHELL##*/}"
    if [[ "$user_shell" == "zsh" || -f "$HOME/.zshrc" ]]; then
      update_rc_file "$HOME/.zshrc" "$snippet"
      updated_any=true
    fi
    if [[ "$user_shell" == "bash" || -f "$HOME/.bashrc" ]]; then
      update_rc_file "$HOME/.bashrc" "$snippet"
      updated_any=true
    fi
    if ! $updated_any; then
      update_rc_file "$HOME/.bashrc" "$snippet"
    fi
  else
    log "Add this line to your ~/.bashrc or ~/.zshrc:"
    echo "    $snippet"
  fi

  if $install_vscode; then
    log "Packaging & installing VS Code extension (nw-worktrees)"
    python3 "$REPO_ROOT/vscode/scripts/package_and_install.py"
  fi

  if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
    echo "note: $bin_dir is not currently on PATH in this shell;" \
      "interactive shells sourcing init.sh add $REPO_ROOT/bin automatically."
  fi

  echo ""
  log "Installation complete!"
  echo "    1. Reload your shell:  source ~/.bashrc   (or source ~/.zshrc)"
  echo "    2. List worktrees:     nw -l"
  echo "    3. Open in VS Code:    nw -c"
}

main "$@"
