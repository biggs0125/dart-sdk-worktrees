#!/usr/bin/env bash
# Shared configuration and platform defaults for `nw` and `ds`.

load_dart_worktrees_config() {
  local cfg_file="${XDG_CONFIG_HOME:-$HOME/.config}/dart-worktrees/config.env"

  # Preserve any explicit environment overrides passed by the caller.
  local env_main="${DART_MAIN_CHECKOUT:-}"
  local env_wt="${DART_WORKTREES_DIR:-}"
  local env_link="${DART_LINK:-}"
  local env_mode="${DART_BUILD_MODE:-}"
  local env_arch="${DART_BUILD_ARCH:-}"
  local env_out="${DART_OUT_DIR_NAME:-}"
  local env_sub="${DART_SDK_SUBPATH:-}"
  local env_ws="${DART_VSCODE_WORKSPACE:-}"
  local env_code="${DART_CODE_CMD:-}"

  if [[ -f "$cfg_file" ]]; then
    # shellcheck disable=SC1090
    source "$cfg_file"
  fi

  [[ -n "$env_main" ]] && DART_MAIN_CHECKOUT="$env_main"
  [[ -n "$env_wt" ]] && DART_WORKTREES_DIR="$env_wt"
  [[ -n "$env_link" ]] && DART_LINK="$env_link"
  [[ -n "$env_mode" ]] && DART_BUILD_MODE="$env_mode"
  [[ -n "$env_arch" ]] && DART_BUILD_ARCH="$env_arch"
  [[ -n "$env_out" ]] && DART_OUT_DIR_NAME="$env_out"
  [[ -n "$env_sub" ]] && DART_SDK_SUBPATH="$env_sub"
  [[ -n "$env_ws" ]] && DART_VSCODE_WORKSPACE="$env_ws"
  [[ -n "$env_code" ]] && DART_CODE_CMD="$env_code"

  : "${DART_MAIN_CHECKOUT:=$HOME/dart-sdk/sdk}"
  : "${DART_WORKTREES_DIR:=$HOME/dart-sdk-worktrees}"
  : "${DART_LINK:=$HOME/.dart-current}"
  : "${DART_BUILD_MODE:=release}"
  : "${DART_CODE_CMD:=code}"

  if [[ -z "${DART_BUILD_ARCH:-}" ]]; then
    case "$(uname -m)" in
      arm64|aarch64) DART_BUILD_ARCH="arm64" ;;
      *)             DART_BUILD_ARCH="x64" ;;
    esac
  fi

  if [[ -z "${DART_OUT_DIR_NAME:-}" ]]; then
    case "$(uname -s)" in
      Darwin) DART_OUT_DIR_NAME="xcodebuild" ;;
      *)      DART_OUT_DIR_NAME="out" ;;
    esac
  fi

  local mode_cap arch_cap
  case "$DART_BUILD_MODE" in
    debug)   mode_cap="Debug" ;;
    product) mode_cap="Product" ;;
    *)       mode_cap="Release" ;;
  esac
  case "$DART_BUILD_ARCH" in
    arm64)   arch_cap="ARM64" ;;
    ia32)    arch_cap="IA32" ;;
    riscv64) arch_cap="RISCV64" ;;
    *)       arch_cap="X64" ;;
  esac

  DART_CONFIG_NAME="${mode_cap}${arch_cap}"
  : "${DART_SDK_SUBPATH:=$DART_OUT_DIR_NAME/$DART_CONFIG_NAME/dart-sdk}"
  : "${DART_VSCODE_WORKSPACE:=$(dirname "$DART_MAIN_CHECKOUT")/active.code-workspace}"

  export DART_MAIN_CHECKOUT DART_WORKTREES_DIR DART_LINK DART_BUILD_MODE \
    DART_BUILD_ARCH DART_OUT_DIR_NAME DART_CONFIG_NAME DART_SDK_SUBPATH \
    DART_VSCODE_WORKSPACE DART_CODE_CMD
}

load_dart_worktrees_config
