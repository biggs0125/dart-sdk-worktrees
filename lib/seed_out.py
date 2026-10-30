#!/usr/bin/env python3
"""Seeds a Dart SDK worktree's <out>/<config> directory from an existing build.

Handles both Siso (.siso_fs_state) and plain Ninja (.ninja_deps / .ninja_log)
build directories:
  - Uses copy-on-write reflinks automatically where supported (macOS APFS
    clonefile(2), Linux Btrfs/XFS FICLONE ioctl), falling back to parallel
    kernel sendfile copies on ext4.
  - For Siso builds, copies only live files tracked by .siso_fs_state plus GN /
    Ninja / depfile metadata (skipping gigabytes of stale build artifacts), and
    rewrites checkout root paths inside .siso_fs_state via `siso fs export` /
    `siso fs import`.
  - Aligns timestamps of unchanged checkout files, hooks, and dependency
    symlinks in the destination worktree to match the seed checkout while
    ensuring any differing files are newer than seeded build outputs, so clean
    builds are a 0-step no-op and modified files trigger minimal incremental
    rebuilds.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from typing import Iterable


# Linux ioctl constant for filesystem CoW file cloning (<linux/fs.h>).
_FICLONE = 0x40049409

_TOP_METADATA_FILES = (
    "args.gn",
    "build.ninja",
    "build.ninja.d",
    "build.ninja.stamp",
    "toolchain.ninja",
    "project.json",
    ".siso_config",
    ".siso_deps",
    ".siso_filegroups",
)

_SKIP_NAMES = frozenset({
    ".ninja_lock",
    ".siso_lock",
    ".reproxy_tmp",
    "depscan.sock",
    "reproxy.sock",
    "siso_output",
    "siso_explain",
    ".siso_explain",
    "generated_compilations",
    "generated_tests",
    "logs",
})

_HOOK_PATHS = (
    ".dart_tool",
    "pubspec_overrides.yaml",
    "pubspec.lock",
    "sdk/version",
    "runtime/tests/vm/dart/generated",
)


class _FileCloner:
    """Clones files using CoW reflinks when supported, else fast kernel copy."""

    def __init__(self) -> None:
        self.used_cow = False
        self._darwin_clonefile = self._load_darwin_clonefile()
        self._try_linux_ficlone = sys.platform.startswith("linux")

    @staticmethod
    def _load_darwin_clonefile():
        if sys.platform != "darwin":
            return None
        try:
            libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            fn = libc.clonefile
            fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
            fn.restype = ctypes.c_int
            return fn
        except OSError:
            return None

    def copy_file(self, src: str, dst: str, mode: int, mtime_ns: int) -> None:
        cloned = False
        if self._darwin_clonefile is not None:
            rc = self._darwin_clonefile(os.fsencode(src), os.fsencode(dst), 0)
            if rc != 0 and ctypes.get_errno() == errno.EEXIST:
                os.unlink(dst)
                rc = self._darwin_clonefile(
                    os.fsencode(src), os.fsencode(dst), 0
                )
            if rc == 0:
                cloned = True
                self.used_cow = True
            else:
                err = ctypes.get_errno()
                if err in (errno.ENOTSUP, errno.EXDEV):
                    self._darwin_clonefile = None
        elif self._try_linux_ficlone:
            src_fd = os.open(src, os.O_RDONLY)
            try:
                dst_fd = os.open(
                    dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode
                )
                try:
                    fcntl.ioctl(dst_fd, _FICLONE, src_fd)
                    cloned = True
                    self.used_cow = True
                except OSError as exc:
                    if exc.errno in (
                        errno.EOPNOTSUPP,
                        errno.EXDEV,
                        errno.EINVAL,
                        errno.ENOSYS,
                    ):
                        self._try_linux_ficlone = False
                finally:
                    os.close(dst_fd)
            finally:
                os.close(src_fd)

        if not cloned:
            shutil.copyfile(src, dst)

        os.chmod(dst, mode)
        os.utime(dst, ns=(mtime_ns, mtime_ns))


def _git_null_lines(cwd: str, *args: str) -> list[str]:
    out = subprocess.check_output(
        ["git", "-C", cwd, *args], stderr=subprocess.DEVNULL
    )
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def _sha256_file(path: str) -> bytes:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.digest()


def _same_regular_file(p1: str, p2: str) -> bool:
    st1 = os.lstat(p1)
    st2 = os.lstat(p2)
    if st1.st_size != st2.st_size:
        return False
    return _sha256_file(p1) == _sha256_file(p2)


def _compute_diff_paths(src_root: str, dst_root: str) -> set[str]:
    dst_head = subprocess.check_output(
        ["git", "-C", dst_root, "rev-parse", "HEAD"], text=True
    ).strip()
    diff = set(_git_null_lines(src_root, "diff", "--name-only", "-z", dst_head))
    diff.update(_git_null_lines(dst_root, "diff", "--name-only", "-z", "HEAD"))
    diff.update(_git_null_lines(dst_root, "diff", "--cached", "--name-only", "-z"))
    diff.update(
        _git_null_lines(src_root, "ls-files", "--others", "--exclude-standard", "-z")
    )
    diff.update(
        _git_null_lines(dst_root, "ls-files", "--others", "--exclude-standard", "-z")
    )
    return diff


def _align_checkout_timestamps(
    src_root: str,
    dst_root: str,
    diff_paths: set[str],
    max_out_mtime_ns: int,
    override_mtimes: dict[str, int] | None = None,
) -> None:
    """Aligns unchanged checkout input mtimes to src_root; bumps changed ones."""
    src_prefix = src_root + "/"
    dst_prefix = dst_root + "/"
    dirty_dirs: set[str] = set()
    dirs_to_sync: set[str] = set()

    def mark_dirty_parents(rel_path: str) -> None:
        d = os.path.dirname(rel_path)
        while d and d not in dirty_dirs:
            dirty_dirs.add(d)
            d = os.path.dirname(d)

    def record_parent_dirs(rel_path: str) -> None:
        d = os.path.dirname(rel_path)
        while d and d not in dirs_to_sync:
            dirs_to_sync.add(d)
            d = os.path.dirname(d)

    now_ns = max(time.time_ns(), max_out_mtime_ns + 1_000_000)
    for rel in diff_paths:
        mark_dirty_parents(rel)
        dp = dst_prefix + rel
        if os.path.lexists(dp):
            st_d = os.lstat(dp)
            if st_d.st_mtime_ns <= max_out_mtime_ns:
                os.utime(dp, ns=(now_ns, now_ns), follow_symlinks=False)

    for rel in _git_null_lines(dst_root, "ls-files", "-z"):
        record_parent_dirs(rel)
        if rel in diff_paths:
            continue
        dp = dst_prefix + rel
        try:
            if override_mtimes and rel in override_mtimes:
                mt = override_mtimes[rel]
                os.utime(dp, ns=(mt, mt), follow_symlinks=False)
            else:
                st_s = os.lstat(src_prefix + rel)
                os.utime(
                    dp,
                    ns=(st_s.st_atime_ns, st_s.st_mtime_ns),
                    follow_symlinks=False,
                )
        except OSError:
            pass

    for hook_rel in _HOOK_PATHS:
        sp = src_prefix + hook_rel
        dp = dst_prefix + hook_rel
        if os.path.isdir(dp) and not os.path.islink(dp) and os.path.isdir(sp):
            for root, _, files in os.walk(dp):
                rel_dir = root[len(dst_prefix) :]
                dirs_to_sync.add(rel_dir)
                for fn in files:
                    rel_f = f"{rel_dir}/{fn}"
                    sf = src_prefix + rel_f
                    df = dst_prefix + rel_f
                    if os.path.isfile(sf) and _same_regular_file(sf, df):
                        st_s = os.lstat(sf)
                        os.utime(df, ns=(st_s.st_atime_ns, st_s.st_mtime_ns))
                    else:
                        mark_dirty_parents(rel_f)
                        if os.path.lexists(df):
                            os.utime(
                                df, ns=(now_ns, now_ns), follow_symlinks=False
                            )
        elif os.path.isfile(dp) and os.path.isfile(sp):
            record_parent_dirs(hook_rel)
            if _same_regular_file(sp, dp):
                st_s = os.lstat(sp)
                os.utime(dp, ns=(st_s.st_atime_ns, st_s.st_mtime_ns))
            else:
                mark_dirty_parents(hook_rel)
                os.utime(dp, ns=(now_ns, now_ns), follow_symlinks=False)

    skip_top = {".git", "out", "xcodebuild"}
    for root, dirs, files in os.walk(dst_root):
        rel_dir = "" if root == dst_root else root[len(dst_prefix) :]
        if rel_dir in skip_top or rel_dir.startswith(("out/", "xcodebuild/")):
            dirs[:] = []
            continue
        kept_dirs: list[str] = []
        for d in dirs:
            if d in skip_top:
                continue
            p = os.path.join(root, d)
            rel_p = p[len(dst_prefix) :]
            if os.path.islink(p):
                sp = src_prefix + rel_p
                if os.path.lexists(sp):
                    st_s = os.lstat(sp)
                    os.utime(
                        p,
                        ns=(st_s.st_atime_ns, st_s.st_mtime_ns),
                        follow_symlinks=False,
                    )
            else:
                dirs_to_sync.add(rel_p)
                kept_dirs.append(d)
        dirs[:] = kept_dirs
        for fn in files:
            p = os.path.join(root, fn)
            if os.path.islink(p):
                rel_p = p[len(dst_prefix) :]
                sp = src_prefix + rel_p
                if os.path.lexists(sp):
                    st_s = os.lstat(sp)
                    os.utime(
                        p,
                        ns=(st_s.st_atime_ns, st_s.st_mtime_ns),
                        follow_symlinks=False,
                    )

    _sync_clean_dir_mtimes(src_root, dst_root, dirs_to_sync, dirty_dirs)


def _sync_clean_dir_mtimes(
    src_root: str,
    dst_root: str,
    dirs_to_sync: Iterable[str],
    dirty_dirs: set[str],
) -> None:
    src_prefix = src_root + "/"
    dst_prefix = dst_root + "/"
    clean_dirs = sorted(
        (d for d in dirs_to_sync if d and d not in dirty_dirs),
        key=len,
        reverse=True,
    )
    for rel_d in clean_dirs:
        sp = src_prefix + rel_d
        dp = dst_prefix + rel_d
        if os.path.isdir(sp) and os.path.isdir(dp) and not os.path.islink(dp):
            try:
                st_s = os.lstat(sp)
                os.utime(dp, ns=(st_s.st_atime_ns, st_s.st_mtime_ns))
            except OSError:
                pass
    if not dirty_dirs:
        try:
            st_s = os.lstat(src_root)
            os.utime(dst_root, ns=(st_s.st_atime_ns, st_s.st_mtime_ns))
        except OSError:
            pass


def _find_siso_binary(src_root: str, dst_root: str) -> str | None:
    exe = "siso.exe" if os.name == "nt" else "siso"
    for root in (src_root, dst_root):
        cand = os.path.join(root, "third_party", "siso", exe)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return shutil.which(exe)


def _format_bytes(num_bytes: int) -> str:
    val = float(num_bytes)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if val < 1024.0 or unit == "GiB":
            return f"{val:.1f} {unit}" if unit != "B" else f"{int(val)} B"
        val /= 1024.0
    return f"{val:.1f} GiB"


def _copy_or_rewrite_file(
    cloner: _FileCloner,
    src: str,
    dst: str,
    mode: int,
    mtime_ns: int,
    src_prefix_b: bytes,
    dst_prefix_b: bytes,
) -> tuple[str, int] | None:
    """Copies src -> dst, rewriting absolute checkout paths in .d/.deps files."""
    if dst.endswith((".d", ".deps")):
        with open(src, "rb") as f:
            raw = f.read()
        if src_prefix_b in raw:
            updated = raw.replace(src_prefix_b, dst_prefix_b)
            with open(dst, "wb") as out_f:
                out_f.write(updated)
            os.chmod(dst, mode)
            os.utime(dst, ns=(mtime_ns, mtime_ns))
            return hashlib.sha256(updated).hexdigest(), len(updated)
    cloner.copy_file(src, dst, mode, mtime_ns)
    return None


def _seed_with_siso(
    siso_bin: str,
    src_root: str,
    dst_root: str,
    rel_config: str,
    diff_paths: set[str],
    cloner: _FileCloner,
) -> tuple[int, int]:
    src_prefix = src_root + "/"
    dst_prefix = dst_root + "/"
    src_prefix_b = os.fsencode(src_prefix)
    dst_prefix_b = os.fsencode(dst_prefix)
    src_out_dir = os.path.join(src_root, rel_config)
    dst_out_dir = os.path.join(dst_root, rel_config)
    src_out = src_out_dir + "/"
    dst_out = dst_out_dir + "/"

    os.makedirs(dst_out_dir, exist_ok=True)

    exported = subprocess.check_output(
        [siso_bin, "fs", "export", "-C", rel_config], cwd=src_root
    )
    data = json.loads(exported)
    entries = data.get("entries", [])

    max_out_mtime_ns = 0
    siso_diff_entries: dict[str, dict] = {}
    for entry in entries:
        ename = entry.get("name", "")
        if ename.startswith(src_out):
            ns = entry.get("id", {}).get("mod_time", 0)
            if ns > max_out_mtime_ns:
                max_out_mtime_ns = ns
        elif diff_paths and ename.startswith(src_prefix):
            rel_e = ename[len(src_prefix) :]
            if rel_e in diff_paths:
                siso_diff_entries[rel_e] = entry

    effective_diff = set(diff_paths)
    override_mtimes: dict[str, int] = {}
    for rel_e, entry in siso_diff_entries.items():
        dig = entry.get("digest")
        mod_ns = entry.get("id", {}).get("mod_time")
        dp = dst_prefix + rel_e
        if (
            dig
            and mod_ns is not None
            and os.path.isfile(dp)
            and not os.path.islink(dp)
        ):
            st_d = os.lstat(dp)
            if (
                st_d.st_size == dig.get("size_bytes")
                and _sha256_file(dp).hex() == dig.get("hash")
            ):
                effective_diff.discard(rel_e)
                override_mtimes[rel_e] = mod_ns

    _align_checkout_timestamps(
        src_root, dst_root, effective_diff, max_out_mtime_ns, override_mtimes
    )

    made_dirs: set[str] = {dst_out_dir}

    def ensure_dir(path: str) -> None:
        if path not in made_dirs:
            os.makedirs(path, exist_ok=True)
            made_dirs.add(path)

    copy_jobs: list[tuple[str, str, int, int, int]] = []
    planned_dst: set[str] = set()
    kept: list[dict] = []
    out_entry_by_dst: dict[str, dict] = {}

    for meta in _TOP_METADATA_FILES:
        sp = os.path.join(src_out_dir, meta)
        dp = os.path.join(dst_out_dir, meta)
        if os.path.isfile(sp) and not os.path.islink(sp):
            st = os.lstat(sp)
            copy_jobs.append(
                (sp, dp, stat.S_IMODE(st.st_mode), st.st_mtime_ns, st.st_size)
            )
            planned_dst.add(dp)

    for entry in entries:
        name = entry.get("name", "")
        if not name.startswith(src_prefix):
            kept.append(entry)
            continue
        rel = name[len(src_prefix) :]
        new_name = dst_prefix + rel
        entry["name"] = new_name
        if "target" in entry and entry["target"].startswith(src_prefix):
            entry["target"] = dst_prefix + entry["target"][len(src_prefix) :]

        if name.startswith(src_out):
            base = os.path.basename(name)
            if base in _SKIP_NAMES:
                continue
            try:
                st = os.lstat(name)
            except FileNotFoundError:
                continue
            rec_ns = entry.get("id", {}).get("mod_time", st.st_mtime_ns)
            if stat.S_ISLNK(st.st_mode):
                ensure_dir(os.path.dirname(new_name))
                target = os.readlink(name)
                if target.startswith(src_prefix):
                    target = dst_prefix + target[len(src_prefix) :]
                if os.path.lexists(new_name):
                    os.unlink(new_name)
                os.symlink(target, new_name)
                os.utime(new_name, ns=(rec_ns, rec_ns), follow_symlinks=False)
                planned_dst.add(new_name)
            elif stat.S_ISREG(st.st_mode):
                if new_name not in planned_dst:
                    ensure_dir(os.path.dirname(new_name))
                    copy_jobs.append((
                        name,
                        new_name,
                        stat.S_IMODE(st.st_mode),
                        rec_ns,
                        st.st_size,
                    ))
                    planned_dst.add(new_name)
                out_entry_by_dst[new_name] = entry
            elif stat.S_ISDIR(st.st_mode):
                ensure_dir(new_name)
            else:
                continue
            kept.append(entry)
        else:
            if rel in effective_diff or not os.path.lexists(new_name):
                continue
            st_d = os.lstat(new_name)
            rec_ns = entry.get("id", {}).get("mod_time", st_d.st_mtime_ns)
            if st_d.st_mtime_ns == rec_ns:
                kept.append(entry)

    for dirpath, dirnames, filenames in os.walk(src_out_dir):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_NAMES]
        rel_sub = (
            "" if dirpath == src_out_dir else dirpath[len(src_out) :]
        )
        in_gen = (
            rel_sub == "gen"
            or rel_sub.startswith("gen/")
            or "/gen/" in f"/{rel_sub}/"
        )
        for fn in filenames:
            if fn in _SKIP_NAMES:
                continue
            if in_gen or fn.endswith(
                (".ninja", ".runtime_deps", ".d", ".deps", ".stamp")
            ):
                sp = os.path.join(dirpath, fn)
                dp = dst_out + sp[len(src_out) :]
                if dp in planned_dst or os.path.lexists(dp):
                    continue
                st = os.lstat(sp)
                if stat.S_ISREG(st.st_mode):
                    ensure_dir(os.path.dirname(dp))
                    copy_jobs.append((
                        sp,
                        dp,
                        stat.S_IMODE(st.st_mode),
                        st.st_mtime_ns,
                        st.st_size,
                    ))
                    planned_dst.add(dp)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(
                lambda j: (
                    j[1],
                    _copy_or_rewrite_file(
                        cloner,
                        j[0],
                        j[1],
                        j[2],
                        j[3],
                        src_prefix_b,
                        dst_prefix_b,
                    ),
                ),
                copy_jobs,
                chunksize=64,
            )
        )

    for dst_path, new_dig in results:
        if new_dig is not None:
            entry = out_entry_by_dst.get(dst_path)
            if entry is not None and "digest" in entry:
                entry["digest"] = {
                    "hash": new_dig[0],
                    "size_bytes": new_dig[1],
                }

    data["entries"] = kept
    payload = json.dumps(data).encode("utf-8")
    subprocess.run(
        [siso_bin, "fs", "import", "-C", rel_config],
        cwd=dst_root,
        input=payload,
        check=True,
    )

    for meta in (
        "args.gn",
        "build.ninja",
        "build.ninja.d",
        "build.ninja.stamp",
        "toolchain.ninja",
        "project.json",
    ):
        sp = os.path.join(src_out_dir, meta)
        dp = os.path.join(dst_out_dir, meta)
        if os.path.lexists(sp) and os.path.lexists(dp):
            st = os.lstat(sp)
            os.utime(
                dp, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False
            )

    total_bytes = sum(j[4] for j in copy_jobs)
    return len(copy_jobs), total_bytes


def _seed_with_ninja(
    src_root: str,
    dst_root: str,
    rel_config: str,
    diff_paths: set[str],
    cloner: _FileCloner,
) -> tuple[int, int]:
    src_prefix = src_root + "/"
    dst_prefix = dst_root + "/"
    src_prefix_b = os.fsencode(src_prefix)
    dst_prefix_b = os.fsencode(dst_prefix)
    src_out_dir = os.path.join(src_root, rel_config)
    dst_out_dir = os.path.join(dst_root, rel_config)
    src_out = src_out_dir + "/"
    dst_out = dst_out_dir + "/"

    os.makedirs(dst_out_dir, exist_ok=True)
    made_dirs: set[str] = {dst_out_dir}

    def ensure_dir(path: str) -> None:
        if path not in made_dirs:
            os.makedirs(path, exist_ok=True)
            made_dirs.add(path)

    copy_jobs: list[tuple[str, str, int, int, int]] = []
    max_out_mtime_ns = 0

    for dirpath, dirnames, filenames in os.walk(src_out_dir):
        dirnames[:] = [
            d for d in dirnames if d not in _SKIP_NAMES and not d.startswith(".siso")
        ]
        if dirpath != src_out_dir:
            ensure_dir(dst_out + dirpath[len(src_out) :])
        for fn in filenames:
            if fn in _SKIP_NAMES or fn.startswith(".siso"):
                continue
            sp = os.path.join(dirpath, fn)
            dp = dst_out + sp[len(src_out) :]
            try:
                st = os.lstat(sp)
            except FileNotFoundError:
                continue
            if st.st_mtime_ns > max_out_mtime_ns:
                max_out_mtime_ns = st.st_mtime_ns
            if stat.S_ISLNK(st.st_mode):
                ensure_dir(os.path.dirname(dp))
                target = os.readlink(sp)
                if target.startswith(src_prefix):
                    target = dst_prefix + target[len(src_prefix) :]
                if os.path.lexists(dp):
                    os.unlink(dp)
                os.symlink(target, dp)
                os.utime(
                    dp,
                    ns=(st.st_atime_ns, st.st_mtime_ns),
                    follow_symlinks=False,
                )
            elif stat.S_ISREG(st.st_mode):
                ensure_dir(os.path.dirname(dp))
                copy_jobs.append((
                    sp,
                    dp,
                    stat.S_IMODE(st.st_mode),
                    st.st_mtime_ns,
                    st.st_size,
                ))

    _align_checkout_timestamps(
        src_root, dst_root, diff_paths, max_out_mtime_ns
    )

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(
            pool.map(
                lambda j: _copy_or_rewrite_file(
                    cloner,
                    j[0],
                    j[1],
                    j[2],
                    j[3],
                    src_prefix_b,
                    dst_prefix_b,
                ),
                copy_jobs,
                chunksize=64,
            )
        )

    for meta in (
        "args.gn",
        "build.ninja",
        "build.ninja.d",
        "build.ninja.stamp",
        "toolchain.ninja",
        "project.json",
    ):
        sp = os.path.join(src_out_dir, meta)
        dp = os.path.join(dst_out_dir, meta)
        if os.path.lexists(sp) and os.path.lexists(dp):
            st = os.lstat(sp)
            os.utime(
                dp, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False
            )

    total_bytes = sum(j[4] for j in copy_jobs)
    return len(copy_jobs), total_bytes


def _run_hooks_preserving_unchanged_mtimes(
    dst_root: str, hooks: list[str]
) -> int:
    """Runs per-checkout hooks, preserving mtimes of byte-identical outputs."""
    dst_prefix = dst_root + "/"
    before_files: dict[str, tuple[bytes, int, int]] = {}
    before_dirs: dict[str, tuple[int, int]] = {}
    root_st = os.lstat(dst_root)

    for hook_rel in _HOOK_PATHS:
        dp = dst_prefix + hook_rel
        if os.path.isdir(dp) and not os.path.islink(dp):
            for root, _, files in os.walk(dp):
                rel_dir = root[len(dst_prefix) :]
                st_dir = os.lstat(root)
                before_dirs[rel_dir] = (st_dir.st_atime_ns, st_dir.st_mtime_ns)
                for fn in files:
                    rel_f = f"{rel_dir}/{fn}"
                    df = dst_prefix + rel_f
                    if os.path.isfile(df) and not os.path.islink(df):
                        st_f = os.lstat(df)
                        before_files[rel_f] = (
                            _sha256_file(df),
                            st_f.st_atime_ns,
                            st_f.st_mtime_ns,
                        )
        elif os.path.isfile(dp) and not os.path.islink(dp):
            st_f = os.lstat(dp)
            before_files[hook_rel] = (
                _sha256_file(dp),
                st_f.st_atime_ns,
                st_f.st_mtime_ns,
            )
            parent = os.path.dirname(hook_rel)
            if parent and os.path.isdir(dst_prefix + parent):
                st_p = os.lstat(dst_prefix + parent)
                before_dirs[parent] = (st_p.st_atime_ns, st_p.st_mtime_ns)

    for hook in hooks:
        hook_path = os.path.join(dst_root, hook)
        if not os.path.isfile(hook_path):
            continue
        print(f"==> Running {hook}", flush=True)
        subprocess.run([sys.executable, hook], cwd=dst_root, check=True)

    if not before_files:
        return 0

    dirty_dirs: set[str] = set()
    seen_after: set[str] = set()
    changed_any = False

    def mark_dirty(rel_path: str) -> None:
        d = os.path.dirname(rel_path)
        while d:
            dirty_dirs.add(d)
            d = os.path.dirname(d)

    for hook_rel in _HOOK_PATHS:
        dp = dst_prefix + hook_rel
        if os.path.isdir(dp) and not os.path.islink(dp):
            for root, _, files in os.walk(dp):
                rel_dir = root[len(dst_prefix) :]
                for fn in files:
                    rel_f = f"{rel_dir}/{fn}"
                    df = dst_prefix + rel_f
                    if not os.path.isfile(df) or os.path.islink(df):
                        continue
                    seen_after.add(rel_f)
                    prev = before_files.get(rel_f)
                    if prev is not None and _sha256_file(df) == prev[0]:
                        os.utime(df, ns=(prev[1], prev[2]))
                    else:
                        changed_any = True
                        mark_dirty(rel_f)
        elif os.path.isfile(dp) and not os.path.islink(dp):
            seen_after.add(hook_rel)
            prev = before_files.get(hook_rel)
            if prev is not None and _sha256_file(dp) == prev[0]:
                os.utime(dp, ns=(prev[1], prev[2]))
            else:
                changed_any = True
                mark_dirty(hook_rel)

    for rel_f in set(before_files) - seen_after:
        changed_any = True
        mark_dirty(rel_f)

    for rel_d in sorted(before_dirs, key=len, reverse=True):
        if rel_d not in dirty_dirs and os.path.isdir(dst_prefix + rel_d):
            at_ns, mt_ns = before_dirs[rel_d]
            try:
                os.utime(dst_prefix + rel_d, ns=(at_ns, mt_ns))
            except OSError:
                pass

    if not changed_any:
        try:
            os.utime(dst_root, ns=(root_st.st_atime_ns, root_st.st_mtime_ns))
        except OSError:
            pass
    return 0


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == "--run-hooks":
        return _run_hooks_preserving_unchanged_mtimes(
            os.path.realpath(sys.argv[2]), sys.argv[3:]
        )

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", required=True, help="Source SDK checkout root")
    parser.add_argument("--dst", required=True, help="Target worktree root")
    parser.add_argument(
        "--out-dir-name", required=True, help="e.g. 'out' or 'xcodebuild'"
    )
    parser.add_argument(
        "--config-name", required=True, help="e.g. 'ReleaseX64' or 'ReleaseARM64'"
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace an existing <out>/<config> directory in --dst",
    )
    args = parser.parse_args()

    src_root = os.path.realpath(args.src)
    dst_root = os.path.realpath(args.dst)
    if src_root == dst_root:
        print("seed_out: source and destination checkouts are identical", file=sys.stderr)
        return 1

    rel_config = os.path.join(args.out_dir_name, args.config_name)
    src_out_dir = os.path.join(src_root, rel_config)
    dst_out_parent = os.path.join(dst_root, args.out_dir_name)
    dst_out_dir = os.path.join(dst_root, rel_config)

    if os.path.islink(dst_out_parent) or os.path.islink(dst_out_dir):
        print(
            f"seed_out: refusing to write into symlinked {dst_out_dir}",
            file=sys.stderr,
        )
        return 1

    if not os.path.isfile(os.path.join(src_out_dir, "build.ninja")):
        return 2

    if os.path.isfile(os.path.join(dst_out_dir, "build.ninja")):
        if not args.replace:
            return 0
        shutil.rmtree(dst_out_dir)
    elif os.path.exists(dst_out_dir) and args.replace:
        shutil.rmtree(dst_out_dir)

    t0 = time.monotonic()
    diff_paths = _compute_diff_paths(src_root, dst_root)
    cloner = _FileCloner()

    siso_state = os.path.join(src_out_dir, ".siso_fs_state")
    siso_bin = _find_siso_binary(src_root, dst_root) if os.path.isfile(siso_state) else None

    if siso_bin is not None:
        num_files, total_bytes = _seed_with_siso(
            siso_bin, src_root, dst_root, rel_config, diff_paths, cloner
        )
        mode_label = "Siso"
    else:
        num_files, total_bytes = _seed_with_ninja(
            src_root, dst_root, rel_config, diff_paths, cloner
        )
        mode_label = "Ninja"

    elapsed = time.monotonic() - t0
    method = "CoW clone" if cloner.used_cow else "copy"
    print(
        f"    seeded {num_files:,} files ({_format_bytes(total_bytes)}, "
        f"{mode_label} {method}) in {elapsed:.1f}s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
