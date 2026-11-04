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
python3 -m py_compile lib/seed_out.py vscode/scripts/package_and_install.py
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
mkdir -p "$SDK_DIR/tools" "$SDK_DIR/third_party/mock_dep" \
  "$SDK_DIR/third_party/siso" "$TMP_HOME/.vscode/extensions"
printf '#!/usr/bin/env python3\n' > "$SDK_DIR/tools/build.py"
printf 'vars = {}\n' > "$SDK_DIR/DEPS"
printf '/out\n/xcodebuild\n' > "$SDK_DIR/.gitignore"
printf '/*\n!.gitignore\n' > "$SDK_DIR/third_party/.gitignore"
echo "shared-dep" > "$SDK_DIR/third_party/mock_dep/hello.txt"

cat > "$SDK_DIR/third_party/siso/siso" <<'SISO_EOF'
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
cfg = args[args.index("-C") + 1]
root = os.getcwd()
if args[:2] == ["fs", "export"]:
    entries = []
    for rel in (
        "DEPS",
        f"{cfg}/obj/foo.o",
        f"{cfg}/dart-sdk/bin/dart",
    ):
        p = os.path.join(root, rel)
        st = os.lstat(p)
        entries.append({"name": p, "id": {"mod_time": st.st_mtime_ns}})
    sys.stdout.write(json.dumps({"entries": entries}))
elif args[:2] == ["fs", "import"]:
    payload = sys.stdin.read()
    with open(os.path.join(root, cfg, ".siso_fs_state"), "w") as f:
        f.write(payload)
SISO_EOF
chmod +x "$SDK_DIR/third_party/siso/siso"

git -C "$SDK_DIR" init -b main >/dev/null
git -C "$SDK_DIR" config user.email "test@example.com"
git -C "$SDK_DIR" config user.name "Test"
git -C "$SDK_DIR" add tools/build.py DEPS .gitignore third_party/.gitignore
git -C "$SDK_DIR" commit -m "Initial mock SDK" >/dev/null

"$REPO_DIR/install.sh" --help | grep -- "--sdk" >/dev/null
"$REPO_DIR/install.sh" --sdk "~/dart-sdk/sdk" --worktrees "~/dart-sdk-worktrees" >/dev/null
grep -F "DART_MAIN_CHECKOUT=$SDK_DIR" "$XDG_CONFIG_HOME/dart-worktrees/config.env" >/dev/null
test -f "$TMP_HOME/.vscode/extensions/natebiggs.nw-worktrees-0.1.0/package.json"

bash -c '
  set -euo pipefail
  . "'"$REPO_DIR"'/shell/init.sh"
  CFG_REL="${DART_SDK_SUBPATH%/dart-sdk}"
  mkdir -p "$DART_MAIN_CHECKOUT/$CFG_REL/obj" \
    "$DART_MAIN_CHECKOUT/$CFG_REL/gen/utils" \
    "$DART_MAIN_CHECKOUT/$DART_SDK_SUBPATH/bin"
  echo "use_rbe = true" > "$DART_MAIN_CHECKOUT/$CFG_REL/args.gn"
  echo "rule phony" > "$DART_MAIN_CHECKOUT/$CFG_REL/build.ninja"
  echo "live-obj" > "$DART_MAIN_CHECKOUT/$CFG_REL/obj/foo.o"
  echo "stale-obj" > "$DART_MAIN_CHECKOUT/$CFG_REL/obj/stale_junk.o"
  echo "git-ver" > "$DART_MAIN_CHECKOUT/$CFG_REL/gen/utils/git_version"
  echo "bootstrap.exe: $DART_MAIN_CHECKOUT/DEPS" \
    > "$DART_MAIN_CHECKOUT/$CFG_REL/bootstrap.exe.d"
  printf "#!/usr/bin/env bash\necho mock-dart\n" \
    > "$DART_MAIN_CHECKOUT/$DART_SDK_SUBPATH/bin/dart"
  chmod +x "$DART_MAIN_CHECKOUT/$DART_SDK_SUBPATH/bin/dart"
  echo "{}" > "$DART_MAIN_CHECKOUT/$CFG_REL/.siso_fs_state"
  # Backdate main build & source timestamps so a naive worktree checkout (mtime=now)
  # would look newer than foo.o unless seed_out.py aligns timestamps.
  touch -d "2025-01-01T00:00:00Z" "$DART_MAIN_CHECKOUT/DEPS" \
    "$DART_MAIN_CHECKOUT/tools/build.py"
  touch -d "2025-01-01T00:01:00Z" \
    "$DART_MAIN_CHECKOUT/$CFG_REL/args.gn" \
    "$DART_MAIN_CHECKOUT/$CFG_REL/build.ninja" \
    "$DART_MAIN_CHECKOUT/$CFG_REL/obj/foo.o" \
    "$DART_MAIN_CHECKOUT/$CFG_REL/gen/utils/git_version" \
    "$DART_MAIN_CHECKOUT/$DART_SDK_SUBPATH/bin/dart"

  nw --help | grep "Usage:" >/dev/null
  ds --help | grep "Usage:" >/dev/null
  nw -f feat-one >/dev/null
  test -L "$PWD/third_party/mock_dep"
  test -f "$PWD/third_party/mock_dep/hello.txt"
  test -x "$PWD/$DART_SDK_SUBPATH/bin/dart"
  test -f "$PWD/$CFG_REL/obj/foo.o"
  test -f "$PWD/$CFG_REL/gen/utils/git_version"
  ! test -e "$PWD/$CFG_REL/obj/stale_junk.o"
  grep -F "$PWD/$CFG_REL/obj/foo.o" "$PWD/$CFG_REL/.siso_fs_state" >/dev/null
  ! grep -F "$DART_MAIN_CHECKOUT" "$PWD/$CFG_REL/.siso_fs_state" >/dev/null
  grep -F "$PWD/DEPS" "$PWD/$CFG_REL/bootstrap.exe.d" >/dev/null
  ! grep -F "$DART_MAIN_CHECKOUT" "$PWD/$CFG_REL/bootstrap.exe.d" >/dev/null
  test "$PWD/$CFG_REL/obj/foo.o" -nt "$PWD/DEPS"

  nw -f --no-seed-out feat-unseeded >/dev/null
  ! test -e "$PWD/$CFG_REL/build.ninja"
  nw -e --seed-from feat-one feat-unseeded >/dev/null
  test -x "$PWD/$DART_SDK_SUBPATH/bin/dart"
  nw -d feat-unseeded >/dev/null

  nw feat-one >/dev/null
  nw -l | grep "\* feat-one" >/dev/null
  ds_err="$(ds feat-one 2>&1 >/dev/null)"
  test -z "$ds_err"
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
