#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * CLI helper invoked by `nw` to record active worktree state and optionally
 * open/focus `active.code-workspace` in VS Code.
 */

const cp = require('child_process');
const fs = require('fs');
const {
  MAIN_NAME,
  loadConfig,
  readState,
  writeState,
  isManagedWorkspaceWindowAlive,
  syncWorkspaceFileOnDisk,
} = require('./worktreeCore');

function main() {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  let name = '';
  let checkout = '';
  let ifActive = '';
  /** @type {string[] | undefined} */
  let subpaths;
  let openCode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') name = argv[++i] || '';
    else if (arg === '--checkout') checkout = argv[++i] || '';
    else if (arg === '--if-active') ifActive = argv[++i] || '';
    else if (arg === '--subpath') {
      const sub = (argv[++i] ?? '').replace(/^\/+|\/+$/g, '');
      subpaths = subpaths || [];
      subpaths.push(sub);
    } else if (arg === '--open') {
      openCode = true;
    }
  }

  const current = readState();

  if (ifActive) {
    const currentMissing = !current || !current.checkout || !fs.existsSync(current.checkout);
    const matchesDeleted = Boolean(current && current.checkout === ifActive);
    if (!currentMissing && !matchesDeleted) {
      return;
    }
  }

  if (!name || !checkout) {
    if (current && current.checkout && fs.existsSync(current.checkout)) {
      name = current.name;
      checkout = current.checkout;
    } else {
      name = MAIN_NAME;
      checkout = cfg.mainCheckout;
    }
  }

  writeState({ name, checkout, subpaths });

  const liveWindow = isManagedWorkspaceWindowAlive();
  if (!liveWindow || !fs.existsSync(cfg.activeWorkspacePath)) {
    syncWorkspaceFileOnDisk(checkout, name, subpaths || null);
  }

  if (openCode) {
    cp.spawnSync(cfg.codeCmd, [cfg.activeWorkspacePath], { stdio: 'ignore' });
  }
}

main();
