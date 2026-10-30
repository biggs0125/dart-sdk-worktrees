# Interactive shell integration for `nw` and `ds` (compatible with bash & zsh).
# Sourced from ~/.bashrc or ~/.zshrc; installed by dart-worktrees/install.sh.

_dw_init_env() {
  local src="" repo_bin=""
  if [ -n "${BASH_SOURCE[0]:-}" ]; then
    src="${BASH_SOURCE[0]}"
  elif [ -n "${ZSH_VERSION:-}" ]; then
    eval 'src="${(%):-%x}"'
  fi
  if [ -n "$src" ]; then
    repo_bin="$(cd "$(dirname "$src")/../bin" 2>/dev/null && pwd)"
    if [ -n "$repo_bin" ] && ! command -v nw >/dev/null 2>&1; then
      export PATH="$repo_bin:$PATH"
    fi
  fi

  local cfg_file="${XDG_CONFIG_HOME:-$HOME/.config}/dart-worktrees/config.env"
  if [ -f "$cfg_file" ]; then
    # shellcheck disable=SC1090
    . "$cfg_file"
  fi

  : "${DART_MAIN_CHECKOUT:=$HOME/dart-sdk/sdk}"
  : "${DART_WORKTREES_DIR:=$HOME/dart-sdk-worktrees}"
  : "${DART_LINK:=$HOME/.dart-current}"
  : "${DART_BUILD_MODE:=release}"

  if [ -z "${DART_BUILD_ARCH:-}" ]; then
    case "$(uname -m)" in
      arm64|aarch64) DART_BUILD_ARCH="arm64" ;;
      *)             DART_BUILD_ARCH="x64" ;;
    esac
  fi

  if [ -z "${DART_OUT_DIR_NAME:-}" ]; then
    case "$(uname -s)" in
      Darwin) DART_OUT_DIR_NAME="xcodebuild" ;;
      *)      DART_OUT_DIR_NAME="out" ;;
    esac
  fi

  local mode_cap="Release" arch_cap="X64"
  case "$DART_BUILD_MODE" in
    debug)   mode_cap="Debug" ;;
    product) mode_cap="Product" ;;
  esac
  case "$DART_BUILD_ARCH" in
    arm64)   arch_cap="ARM64" ;;
    ia32)    arch_cap="IA32" ;;
    riscv64) arch_cap="RISCV64" ;;
  esac

  : "${DART_SDK_SUBPATH:=$DART_OUT_DIR_NAME/${mode_cap}${arch_cap}/dart-sdk}"

  if [ -z "${DS_LOCAL_CHECKOUT:-}" ]; then
    export DART_SDK="$DART_LINK"
    local sdk_bin="$DART_LINK/$DART_SDK_SUBPATH/bin"
    case ":$PATH:" in
      *":$sdk_bin:"*) ;;
      *) export PATH="$PATH:$sdk_bin" ;;
    esac
    if [ -z "${RBE_cfg:-}" ] && [ -f "$DART_MAIN_CHECKOUT/build/rbe/unix.cfg" ]; then
      export RBE_cfg="$DART_SDK/build/rbe/unix.cfg"
    fi
  fi
}
_dw_init_env
unset -f _dw_init_env

# `ds -l` changes only this shell's Dart env, so it must run in-process:
# the `ds` script prints the exports and this function evals them.
ds() {
  case "${1:-}" in
    -l|--local)
      local env_out
      env_out="$(command ds --print-local-env "${2:-}")" && eval "$env_out" ;;
    *) command ds "$@" ;;
  esac
}

# `nw <name>` switches to (or creates) a worktree; the script writes the dir
# to $NW_CD_FILE and this function cds there. `nw -d` may delete the worktree
# this shell is in; afterwards, cd back to the main checkout and drop a
# `ds -l` override that points at a deleted dir.
nw() {
  local cd_file target="" status_code=0
  cd_file="$(mktemp "${TMPDIR:-/tmp}/nw-cd.XXXXXX")"
  NW_CD_FILE="$cd_file" command nw "$@" || status_code=$?
  [ -f "$cd_file" ] && target="$(cat "$cd_file")"
  rm -f "$cd_file"
  [ "$status_code" -eq 0 ] || return "$status_code"
  if [ -n "$target" ]; then
    cd "$target" && echo "==> Now in $PWD"
  elif [ ! -d "$PWD" ]; then
    cd "${DART_MAIN_CHECKOUT:-$HOME/dart-sdk/sdk}" && echo "==> Now in $PWD"
  fi
  if [ -n "${DS_LOCAL_CHECKOUT:-}" ] && [ ! -d "$DS_LOCAL_CHECKOUT" ]; then
    ds -l clear
  fi
}

# Prints the names of the worktrees in $DART_WORKTREES_DIR, one per line.
_dw_worktree_names() {
  [ -n "${ZSH_VERSION:-}" ] && setopt local_options null_glob
  local wt_dir="${DART_WORKTREES_DIR:-$HOME/dart-sdk-worktrees}" dir
  [ -d "$wt_dir" ] || return 0
  for dir in "$wt_dir"/*/; do
    [ -f "${dir}.git" ] && basename "$dir"
  done
  return 0
}

if [ -n "${BASH_VERSION:-}" ]; then
  _nw_complete() {
    local cur="${COMP_WORDS[COMP_CWORD]}" positional=0 main_ok=true word i
    if [[ "$cur" == -* ]]; then
      # shellcheck disable=SC2207
      COMPREPLY=($(compgen -W \
        "-b --build -c --code -d --delete -e --existing -f --force -h --help -l --list" \
        -- "$cur"))
      return
    fi
    for (( i = 1; i < COMP_CWORD; i++ )); do
      word="${COMP_WORDS[i]}"
      case "$word" in
        -l|--list|-h|--help) return 0 ;;
        -d|--delete|-e|--existing) main_ok=false ;;
        -*) ;;
        *) positional=$((positional + 1)) ;;
      esac
    done
    (( positional == 0 )) || return 0
    local candidates
    candidates="$(_dw_worktree_names)"
    $main_ok && candidates="$candidates main"
    # shellcheck disable=SC2207
    COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
  }

  _ds_complete() {
    local cur="${COMP_WORDS[COMP_CWORD]}" positional=0 local_mode=false word i
    if [[ "$cur" == -* ]]; then
      # shellcheck disable=SC2207
      COMPREPLY=($(compgen -W "-l --local -h --help" -- "$cur"))
      return
    fi
    for (( i = 1; i < COMP_CWORD; i++ )); do
      word="${COMP_WORDS[i]}"
      case "$word" in
        -l|--local) local_mode=true ;;
        -h|--help|clear|status|list) return 0 ;;
        -*) ;;
        *) positional=$((positional + 1)) ;;
      esac
    done
    (( positional == 0 )) || return 0
    local candidates
    candidates="$(_dw_worktree_names) main clear"
    $local_mode || candidates="$candidates status list"
    # shellcheck disable=SC2207
    COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
  }

  complete -F _nw_complete nw
  complete -F _ds_complete ds
elif [ -n "${ZSH_VERSION:-}" ]; then
  _nw_zsh_complete() {
    local -a opts names
    opts=(-b --build -c --code -d --delete -e --existing -f --force -h --help -l --list)
    if [[ "${words[CURRENT]}" == -* ]]; then
      compadd -- "${opts[@]}"
      return
    fi
    local i word line positional=0 main_ok=1
    for (( i = 2; i < CURRENT; i++ )); do
      word="${words[i]}"
      case "$word" in
        -l|--list|-h|--help) return ;;
        -d|--delete|-e|--existing) main_ok=0 ;;
        -*) ;;
        *) positional=$((positional + 1)) ;;
      esac
    done
    (( positional == 0 )) || return
    names=()
    while IFS= read -r line; do
      [ -n "$line" ] && names+=("$line")
    done <<EOF
$(_dw_worktree_names)
EOF
    (( main_ok )) && names+=(main)
    compadd -- "${names[@]}"
  }

  _ds_zsh_complete() {
    local -a opts names
    opts=(-l --local -h --help)
    if [[ "${words[CURRENT]}" == -* ]]; then
      compadd -- "${opts[@]}"
      return
    fi
    local i word line positional=0 local_mode=0
    for (( i = 2; i < CURRENT; i++ )); do
      word="${words[i]}"
      case "$word" in
        -l|--local) local_mode=1 ;;
        -h|--help|clear|status|list) return ;;
        -*) ;;
        *) positional=$((positional + 1)) ;;
      esac
    done
    (( positional == 0 )) || return
    names=()
    while IFS= read -r line; do
      [ -n "$line" ] && names+=("$line")
    done <<EOF
$(_dw_worktree_names)
EOF
    names+=(main clear)
    (( local_mode )) || names+=(status list)
    compadd -- "${names[@]}"
  }

  if command -v compdef >/dev/null 2>&1; then
    compdef _nw_zsh_complete nw
    compdef _ds_zsh_complete ds
  fi
fi
