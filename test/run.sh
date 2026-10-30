#!/usr/bin/env bash
# Runs syntax checks, VS Code extension unit tests, and an isolated end-to-end
# install + nw/ds (bash & zsh) + uninstall test suite.

set -euo pipefail

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Checking shell, Python, and JS syntax"
bash -n install.sh uninstall.sh test/run.sh lib/common.sh bin/nw bin/ds shell/init.sh
if command -v zsh >/dev/null 2>&1; then
  zsh -n shell/init.sh
fi
python3 -m py_compile vscode/scripts/package_and_install.py
node --check vscode/src/worktreeCore.js
node --check vscode/src/cliSync.js
node --check vscode/src/extension.js

echo "==> Running VS Code extension unit tests"
node vscode/test/worktreeCore.test.js

echo "==> Running isolated end-to-end installer + nw/ds test"
TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT
export HOME="$TMP_HOME"
export XDG_CONFIG_HOME="$TMP_HOME/.config"
export XDG_STATE_HOME="$TMP_HOME/.local/state"

SDK_DIR="$TMP_HOME/dart-sdk/sdk"
mkdir -p "$SDK_DIR/tools" "$SDK_DIR/third_party/mock_dep" "$TMP_HOME/.vscode/extensions"
printf '#!/usr/bin/env python3\n' > "$SDK_DIR/tools/build.py"
printf 'vars = {}\n' > "$SDK_DIR/DEPS"
printf '/out\n/xcodebuild\n' > "$SDK_DIR/.gitignore"
printf '/*\n!.gitignore\n' > "$SDK_DIR/third_party/.gitignore"
echo "shared-dep" > "$SDK_DIR/third_party/mock_dep/hello.txt"

git -C "$SDK_DIR" init -b main >/dev/null
git -C "$SDK_DIR" config user.email "test@example.com"
git -C "$SDK_DIR" config user.name "Test"
git -C "$SDK_DIR" add tools/build.py DEPS .gitignore third_party/.gitignore
git -C "$SDK_DIR" commit -m "Initial mock SDK" >/dev/null

"$REPO_DIR/install.sh" --help | grep -- "--sdk" >/dev/null
"$REPO_DIR/install.sh" --sdk "$SDK_DIR" >/dev/null
test -f "$TMP_HOME/.vscode/extensions/natebiggs.nw-worktrees-0.1.0/package.json"

bash -c '
  set -euo pipefail
  . "'"$REPO_DIR"'/shell/init.sh"
  nw --help | grep "Usage:" >/dev/null
  ds --help | grep "Usage:" >/dev/null
  nw -f feat-one >/dev/null
  test -L "$PWD/third_party/mock_dep"
  test -f "$PWD/third_party/mock_dep/hello.txt"
  nw -l | grep "\* feat-one" >/dev/null
  ds feat-one >/dev/null 2>&1
  ds -l main >/dev/null 2>&1
  ds status | grep "local:" >/dev/null
  ds -l clear >/dev/null 2>&1
  nw -d feat-one >/dev/null
  nw -l | grep "\* main" >/dev/null
'

if command -v zsh >/dev/null 2>&1; then
  zsh -c '
    set -euo pipefail
    source "'"$REPO_DIR"'/shell/init.sh"
    nw -f feat-zsh >/dev/null
    nw -l | grep "feat-zsh" >/dev/null
    ds status >/dev/null
    nw main >/dev/null
    nw -d feat-zsh >/dev/null
  '
fi

"$REPO_DIR/uninstall.sh" >/dev/null
! test -d "$TMP_HOME/.vscode/extensions/natebiggs.nw-worktrees-0.1.0"

echo "==> All tests passed!"
