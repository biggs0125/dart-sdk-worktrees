// @ts-check
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const core = require('../src/worktreeCore');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nw-core-test-'));
}

test('parseConfigEnv handles comments, quotes, export, and ~ / $HOME expansion', () => {
  const parsed = core.parseConfigEnv(
    [
      '# comment',
      'DART_MAIN_CHECKOUT="~/src/dart-sdk/sdk"',
      "export DART_WORKTREES_DIR='$HOME/custom-wt'",
      'DART_BUILD_MODE=debug',
      'DART_LINK=${HOME}/.my-dart',
    ].join('\n'),
    '/fake/home'
  );

  assert.equal(parsed.DART_MAIN_CHECKOUT, '/fake/home/src/dart-sdk/sdk');
  assert.equal(parsed.DART_WORKTREES_DIR, '/fake/home/custom-wt');
  assert.equal(parsed.DART_BUILD_MODE, 'debug');
  assert.equal(parsed.DART_LINK, '/fake/home/.my-dart');
});

test('loadConfig computes macOS arm64 and Linux x64 SDK paths and respects env overrides', () => {
  const tmp = makeTempDir();
  try {
    const cfgFile = path.join(tmp, 'config.env');
    fs.writeFileSync(
      cfgFile,
      [
        'DART_MAIN_CHECKOUT="~/my-dart/sdk"',
        'DART_WORKTREES_DIR="~/my-worktrees"',
      ].join('\n'),
      'utf8'
    );

    const macCfg = core.loadConfig({
      configFile: cfgFile,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      homeDir: '/Users/alice',
    });
    assert.equal(macCfg.mainCheckout, '/Users/alice/my-dart/sdk');
    assert.equal(macCfg.worktreesDir, '/Users/alice/my-worktrees');
    assert.equal(
      macCfg.sdkSubpath,
      path.join('xcodebuild', 'ReleaseARM64', 'dart-sdk')
    );
    assert.equal(
      macCfg.activeWorkspacePath,
      '/Users/alice/my-dart/active.code-workspace'
    );

    const linuxOverride = core.loadConfig({
      configFile: cfgFile,
      env: {
        DART_MAIN_CHECKOUT: '/work/dart/sdk',
        DART_BUILD_MODE: 'debug',
      },
      platform: 'linux',
      arch: 'x64',
      homeDir: '/home/bob',
    });
    assert.equal(linuxOverride.mainCheckout, '/work/dart/sdk');
    assert.equal(linuxOverride.worktreesDir, '/home/bob/my-worktrees');
    assert.equal(
      linuxOverride.sdkSubpath,
      path.join('out', 'DebugX64', 'dart-sdk')
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseSdkPath parses main, live worktree, deleted worktree, and rejects unrelated paths', () => {
  const roots = {
    mainCheckout: '/h/dart-sdk/sdk',
    worktreesDir: '/h/dart-sdk-worktrees',
  };

  assert.deepEqual(core.parseSdkPath('/h/dart-sdk/sdk', roots), {
    checkoutName: 'main',
    checkoutRoot: '/h/dart-sdk/sdk',
    relPath: '',
  });

  assert.deepEqual(
    core.parseSdkPath('/h/dart-sdk/sdk/pkg/wasm_builder/lib/foo.dart', roots),
    {
      checkoutName: 'main',
      checkoutRoot: '/h/dart-sdk/sdk',
      relPath: 'pkg/wasm_builder/lib/foo.dart',
    }
  );

  assert.deepEqual(
    core.parseSdkPath('/h/dart-sdk-worktrees/deleted-wt/pkg/vm/bar.dart', roots),
    {
      checkoutName: 'deleted-wt',
      checkoutRoot: '/h/dart-sdk-worktrees/deleted-wt',
      relPath: 'pkg/vm/bar.dart',
    }
  );

  assert.equal(core.parseSdkPath('/h/dart-sdk-worktrees/.hidden/foo', roots), null);
  assert.equal(core.parseSdkPath('/h/other-repo/file.dart', roots), null);
});

test('listCheckouts, resolveMappedFolder, and syncWorkspaceFileOnDisk preserve subpaths', () => {
  const tmp = makeTempDir();
  try {
    const mainDir = path.join(tmp, 'dart-sdk', 'sdk');
    const wtRoot = path.join(tmp, 'dart-sdk-worktrees');
    const wtAlpha = path.join(wtRoot, 'alpha');
    const wtBroken = path.join(wtRoot, 'not-a-worktree');
    const wsPath = path.join(tmp, 'dart-sdk', 'active.code-workspace');
    const dartLink = path.join(tmp, '.dart-current');
    const sdkSubpath = path.join('out', 'ReleaseX64', 'dart-sdk');

    fs.mkdirSync(path.join(mainDir, 'pkg', 'wasm_builder'), { recursive: true });
    fs.mkdirSync(path.join(mainDir, sdkSubpath, 'bin'), { recursive: true });
    const dartBin = path.join(mainDir, sdkSubpath, 'bin', 'dart');
    fs.writeFileSync(dartBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    fs.mkdirSync(path.join(wtAlpha, 'pkg', 'wasm_builder'), { recursive: true });
    fs.writeFileSync(path.join(wtAlpha, '.git'), 'gitdir: /fake\n');
    fs.mkdirSync(wtBroken, { recursive: true });
    fs.symlinkSync(mainDir, dartLink);

    const checkouts = core.listCheckouts({
      mainCheckout: mainDir,
      worktreesDir: wtRoot,
    });
    assert.deepEqual(checkouts, [
      { name: 'main', checkoutRoot: mainDir },
      { name: 'alpha', checkoutRoot: wtAlpha },
    ]);

    const mappedOk = core.resolveMappedFolder('pkg/wasm_builder', wtAlpha);
    assert.equal(mappedOk.fellBack, false);
    assert.equal(mappedOk.effectiveSubpath, 'pkg/wasm_builder');
    assert.equal(mappedOk.folderPath, path.join(wtAlpha, 'pkg', 'wasm_builder'));

    const mappedFallback = core.resolveMappedFolder('pkg/new_only_on_branch', wtAlpha);
    assert.equal(mappedFallback.fellBack, true);
    assert.equal(mappedFallback.effectiveSubpath, '');
    assert.equal(mappedFallback.folderPath, wtAlpha);

    // Initial scope to pkg/wasm_builder on main.
    core.syncWorkspaceFileOnDisk(mainDir, 'main', ['pkg/wasm_builder'], {
      workspacePath: wsPath,
      mainCheckout: mainDir,
      worktreesDir: wtRoot,
      dartLink,
      sdkSubpath,
    });

    // Switch to alpha without explicit subpaths: preserves pkg/wasm_builder.
    const nextCfg = core.syncWorkspaceFileOnDisk(wtAlpha, 'alpha', null, {
      workspacePath: wsPath,
      mainCheckout: mainDir,
      worktreesDir: wtRoot,
      dartLink,
      sdkSubpath,
    });

    assert.deepEqual(nextCfg.folders, [
      {
        name: 'pkg/wasm_builder [alpha]',
        path: path.join(wtAlpha, 'pkg', 'wasm_builder'),
      },
    ]);
    assert.equal(nextCfg.settings['dart.sdkPath'], path.join(mainDir, sdkSubpath));
    assert.deepEqual(
      nextCfg.settings['dart.analysisExcludedFolders'],
      core.SUBPATH_ANALYSIS_EXCLUDES
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeState/readState and isManagedWorkspaceWindowAlive work as expected', () => {
  const tmp = makeTempDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const lockFile = path.join(tmp, 'lock.json');

    core.writeState(
      { name: 'alpha', checkout: '/tmp/alpha', subpaths: ['pkg/vm'], timestamp: 1234 },
      stateFile
    );
    assert.deepEqual(core.readState(stateFile), {
      name: 'alpha',
      checkout: '/tmp/alpha',
      subpaths: ['pkg/vm'],
      timestamp: 1234,
    });

    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), 'utf8');
    assert.equal(core.isManagedWorkspaceWindowAlive(lockFile), true);

    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999 }), 'utf8');
    assert.equal(core.isManagedWorkspaceWindowAlive(lockFile), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
