#!/usr/bin/env bash
# Removes symlinks, shell rc block, and the installed VS Code extension created
# by dart-worktrees/install.sh. Does NOT delete any git worktrees or checkouts.

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER_BEGIN="# >>> dart-worktrees >>>"
MARKER_END="# <<< dart-worktrees <<<"

log() { echo "==> $*"; }

remove_symlinks_in() {
  local dir="$1" tool link target
  [[ -d "$dir" ]] || return 0
  for tool in nw ds; do
    link="$dir/$tool"
    [[ -L "$link" ]] || continue
    target="$(readlink "$link" 2>/dev/null || true)"
    if [[ "$target" == "$REPO_ROOT/bin/$tool" ]]; then
      rm -f "$link"
      log "Removed symlink $link"
    fi
  done
}

strip_rc_block() {
  local rc_file="$1"
  [[ -f "$rc_file" ]] || return 0
  python3 - "$rc_file" "$MARKER_BEGIN" "$MARKER_END" <<'PY'
import sys

rc_path, begin, end = sys.argv[1:]
with open(rc_path, "r", encoding="utf-8") as f:
  content = f.read()

if begin not in content or end not in content:
  sys.exit(0)

pre, rest = content.split(begin, 1)
_, post = rest.split(end, 1)
updated = pre.rstrip("\n")
post = post.lstrip("\n")
if updated and post:
  updated = updated + "\n\n" + post
elif post:
  updated = post
elif updated:
  updated = updated + "\n"

with open(rc_path, "w", encoding="utf-8") as f:
  f.write(updated)
print(f"==> Removed shell integration block from {rc_path}")
PY
}

uninstall_vscode_extension() {
  python3 - <<'PY'
import glob
import json
import os
import shutil

ext_id = "natebiggs.nw-worktrees"
ext_dirs = [
    "~/.vscode/extensions",
    "~/.vscode-server/extensions",
    "~/.cursor/extensions",
    "~/.jetski/extensions",
]

for raw_root in ext_dirs:
  root = os.path.expanduser(raw_root)
  if not os.path.isdir(root):
    continue
  removed = False
  for match in glob.glob(os.path.join(root, f"{ext_id}-*")):
    if os.path.islink(match) or os.path.isfile(match):
      os.unlink(match)
    elif os.path.isdir(match):
      shutil.rmtree(match)
    removed = True

  ext_json = os.path.join(root, "extensions.json")
  if os.path.isfile(ext_json):
    try:
      with open(ext_json, "r", encoding="utf-8") as fp:
        entries = json.load(fp)
      filtered = [
          e
          for e in entries
          if e.get("identifier", {}).get("id", "").lower() != ext_id.lower()
      ]
      if len(filtered) != len(entries):
        with open(ext_json, "w", encoding="utf-8") as fp:
          json.dump(filtered, fp)
        removed = True
    except (OSError, ValueError):
      pass

  if removed:
    print(f"==> Removed {ext_id} from {root}")
PY
}

main() {
  remove_symlinks_in "$HOME/bin"
  remove_symlinks_in "$HOME/.local/bin"
  strip_rc_block "$HOME/.bashrc"
  strip_rc_block "$HOME/.zshrc"
  uninstall_vscode_extension
  log "Uninstalled dart-worktrees (your git worktrees and ~/.config/dart-worktrees were preserved)."
}

main "$@"
