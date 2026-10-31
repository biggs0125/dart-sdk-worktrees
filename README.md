# dart-sdk-worktrees

Fast git-worktree management (`nw`), active-SDK switching (`ds`), and seamless VS Code workspace tracking for the [Dart SDK](https://github.com/dart-lang/sdk) repository.

Works on **Linux** and **macOS** (`x64` and Apple Silicon `arm64`), in **`bash`** and **`zsh`**, and across **local VS Code**, **Remote-SSH (Cloudtop)**, **Cursor**, and **Jetski** — with zero `npm` dependencies.

---

## Why not plain `git worktree add`?

The Dart SDK uses `gclient` to populate hundreds of git-ignored directories (`third_party/*`, `buildtools/*`, toolchains) and runs checkout-level hooks (`generate_package_config.py`, `generate_sdk_version_file.py`, etc.). A plain `git worktree add` has none of those and cannot build or analyze Dart code.

- **`nw` ("new worktree")** creates a lightweight git worktree, symlinks all shared `gclient` dependencies from your main checkout, runs the per-checkout hooks, **pre-seeds `<out>/<config>` from your built `main` checkout** (rewriting Siso `.siso_fs_state` paths, skipping stale untracked build artifacts, and using instant APFS/Btrfs/XFS copy-on-write clones where supported so `dart` works immediately and `tools/build.py` runs incrementally in seconds), and `cd`s your shell right into it.
- **`ds` ("dart switch")** points your active `$DART_SDK` / `dart` binary (`~/.dart-current`) at any worktree globally or in just the current shell (`ds -l`).
- **`nw-worktrees` VS Code extension** keeps a single VS Code window following your interactive `nw` switches **in place** — swapping workspace folders without reloading the window, preserving subpackage scoping (e.g. `pkg/wasm_builder`), remapping open editor tabs (cursor + scroll intact), and syncing `dart.sdkPath` with `ds`.

---

## Quick Start

**Prerequisites:** `git`, `python3`, and a `gclient`-synced Dart SDK checkout (`node` optional, used by VS Code sync).

Clone the tools into `~/dart-worktrees` (keeping `~/dart-sdk-worktrees` free for the worktrees `nw` creates) and run `./install.sh`:

```bash
git clone https://github.com/biggs0125/dart-sdk-worktrees.git ~/dart-worktrees
~/dart-worktrees/install.sh
```

If your main Dart SDK checkout isn't in a standard location (`~/dart-sdk/sdk`, `~/sdk/sdk`, `~/src/dart-sdk/sdk`), pass `--sdk`:

```bash
~/dart-worktrees/install.sh --sdk /path/to/dart-sdk/sdk
```

> **Using Remote-SSH (e.g. Cloudtop)?** Clone and run `./install.sh` **on the remote host** where your Dart SDK lives. The installer automatically detects `~/.vscode-server/extensions` and registers the extension to run in the remote workspace host.

Reload your shell (`source ~/.bashrc` or `source ~/.zshrc`) and reload VS Code once (`Developer: Reload Window`).

---

## Daily Workflow

### 1. Creating, switching, listing, and deleting worktrees (`nw`)

```bash
nw my-feature                  # Switch to ~/dart-sdk-worktrees/my-feature (prompts to create if new)
nw -f my-feature               # Create without prompting (pre-seeds <out>/<config> from main)
nw -f -b my-feature            # Create and incrementally build any delta (`create_sdk`)
nw -f --no-seed-out my-feature # Create with an empty build directory (skip seeding)
nw my-feature origin/main      # Create from a specific base ref
nw main                        # Switch back to your main SDK checkout
nw -l                          # List `main` and all worktrees (`*` marks current cwd)
nw -d                          # Delete the current worktree + its branch (refuses if dirty unless -f)
nw -d my-feature               # Delete a named worktree + its branch
nw -e existing-wt              # Re-link gclient deps, re-run hooks & seed <out>/<config> if unbuilt
nw -e --seed-out existing-wt   # Re-seed <out>/<config> from main, replacing existing build dir
nw -e --seed-from other-wt wt  # Seed <out>/<config> from another built worktree
```

> **How `out/` seeding works:** When `<main>/<out>/<config>/build.ninja` exists (or your active `ds` checkout is built), `nw` seeds only live build artifacts tracked by Siso's `.siso_fs_state` (plus GN/Ninja/depfile metadata), rewrites checkout paths inside `.siso_fs_state` via `siso fs export`/`import`, and aligns unchanged source/hook/symlink timestamps. Clean worktrees have a working `<out>/<config>/dart-sdk/bin/dart` immediately and 0-step `tools/build.py` runs (~1–2s), while modified files trigger fast incremental builds. Uses CoW reflinks automatically on macOS (APFS `clonefile`) and Linux Btrfs/XFS (`FICLONE`), with parallel copies on `ext4`.

> **Note on `DEPS` updates:** Because `third_party/*` and `buildtools/*` are symlinked from your main checkout, run `gclient sync` in your main checkout whenever `DEPS` changes.

### 2. Switching your active `dart` SDK (`ds`)

`shell/init.sh` puts `~/.dart-current/<out>/<config>/dart-sdk/bin` on your `PATH` and sets `DART_SDK=~/.dart-current`.

```bash
ds                        # Globally point `dart` at the worktree you're standing in
ds my-feature             # Globally point `dart` at `my-feature`
ds main                   # Globally switch back to `main` (alias: `ds clear`)
ds -l my-feature          # Override `dart` in THIS shell only
ds -l clear               # Drop this shell's override and follow global again
ds status                 # Show active global (and shell-local) checkout
ds list                   # List `main` and worktrees (`*` = global, `L` = local)
```

### 3. VS Code integration (`nw -c` + status bar)

Open the managed workspace once from any checkout or subpackage directory:

```bash
cd ~/dart-sdk/sdk/pkg/wasm_builder
nw -c
```

- Opening `nw -c` from inside a subpackage (like `pkg/wasm_builder` or `pkg/vm`) scopes the Dart analyzer to just that folder for fast analysis.
- From then on, every interactive `nw <branch>` or `nw main` in your terminal **automatically swaps VS Code to the same subpackage in the target worktree** and remaps your open tabs in place.
- Non-interactive `nw -f ...` invocations (e.g. background AI coding agents creating their own worktrees) **never** hijack your VS Code window.
- The workspace always lists an empty `nw` folder (`~/.local/state/nw/workspace-anchor`) first. VS Code restarts all extensions whenever the first workspace folder changes (prompting if e.g. a Markdown preview editor is open), so keeping it fixed lets switches swap only the SDK folders. New terminals for it start in your first SDK folder.
- **Status bar controls** (bottom-left):
  - `$(git-branch) nw: <branch>` — click to switch worktrees from inside VS Code (`Dart Worktrees: Switch Worktree…`).
  - `$(folder-opened) <scope>` — click to re-scope the workspace to full `sdk` or one/more `pkg/*` folders (`Dart Worktrees: Scope Workspace to Package / Subfolder…`).

#### VS Code settings

| Setting | Default | Description |
| :--- | :---: | :--- |
| `nwWorktrees.followNw` | `true` | Automatically switch workspace folders and remap open tabs when `nw` changes the active worktree. |
| `nwWorktrees.followDsSdk` | `true` | Keep workspace `dart.sdkPath` synced to the checkout selected by `ds` whenever a built SDK exists there. |

---

## Configuration

`install.sh` writes `~/.config/dart-worktrees/config.env`. All values can be edited there or overridden via environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DART_MAIN_CHECKOUT` | `~/dart-sdk/sdk` | Path to your main `gclient` Dart SDK checkout. |
| `DART_WORKTREES_DIR` | `~/dart-sdk-worktrees` | Parent directory where `nw` creates worktrees (keep short on Linux so RBE Unix socket paths stay $\le 106$ chars). |
| `DART_LINK` | `~/.dart-current` | Symlink managed by `ds`. |
| `DART_BUILD_MODE` | `release` | Default build mode (`release`, `debug`, `product`). |
| `DART_BUILD_ARCH` | Auto (`arm64` or `x64`) | Default target architecture. |
| `DART_OUT_DIR_NAME` | `xcodebuild` (macOS) / `out` (Linux) | Build output directory name. |
| `DART_SEED_OUT` | `1` | Pre-seed `<out>/<config>` on new worktrees (`0` to disable by default). |
| `DART_VSCODE_WORKSPACE` | `<sdk-parent>/active.code-workspace` | Managed VS Code `.code-workspace` path. |
| `DART_CODE_CMD` | `code` | Editor CLI binary used by `nw -c` (e.g. `code`, `cursor`). |

---

## Updating & Uninstalling

```bash
# Update to latest CLI + VS Code extension:
cd ~/dart-worktrees && git pull && ./install.sh

# Uninstall symlinks, shell rc block, and VS Code extension (keeps your worktrees):
~/dart-worktrees/uninstall.sh
```
