// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const {
  MAIN_NAME,
  STATE_DIR,
  WINDOW_LOCK_FILE,
  WORKSPACE_ANCHOR_NAME,
  loadConfig,
  parseSdkPath,
  listCheckouts,
  describeCheckoutGit,
  resolveMappedFolder,
  formatFolderName,
  resolveBuiltDartSdkPath,
  computeWorkspaceSettings,
  ensureWorkspaceAnchor,
  readState,
  writeState,
  isManagedWorkspaceWindowAlive,
  syncWorkspaceFileOnDisk,
} = require('./worktreeCore');

const POLL_MS = 1500;
const PENDING_RESTORE_KEY = 'nwWorktrees.pendingRestore';
const PENDING_RESTORE_TTL_MS = 30_000;

/**
 * Clamp a saved `[line, char]` tuple to valid bounds in `doc`.
 *
 * @param {vscode.TextDocument} doc
 * @param {[number, number]} pos
 * @returns {vscode.Position}
 */
function clampPosition(doc, pos) {
  const maxLine = Math.max(0, doc.lineCount - 1);
  const line = Math.min(Math.max(0, pos[0] || 0), maxLine);
  const maxChar = doc.lineAt(line).text.length;
  const ch = Math.min(Math.max(0, pos[1] || 0), maxChar);
  return new vscode.Position(line, ch);
}

/**
 * Restores cursor selections and vertical scroll position on `editor`.
 *
 * @param {vscode.TextEditor} editor
 * @param {{selections: Array<{anchor: [number, number], active: [number, number]}>, topLine: number} | null} state
 */
function restoreEditorViewport(editor, state) {
  if (!state) return;
  const doc = editor.document;
  if (Array.isArray(state.selections) && state.selections.length > 0) {
    editor.selections = state.selections.map(
      (s) => new vscode.Selection(clampPosition(doc, s.anchor), clampPosition(doc, s.active))
    );
  }
  if (typeof state.topLine === 'number' && state.topLine > 0) {
    const topPos = clampPosition(doc, [state.topLine, 0]);
    editor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
  }
}

class WorktreeController {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.cfg = loadConfig();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.statusBar.command = 'nwWorktrees.switchWorktree';
    this.switching = false;
    this.remappingTabs = false;
    this.resyncRequested = false;
    this.lastStateTimestamp = 0;
    this.lastDartLinkTarget = this.readDartLinkTarget();
    /** @type {fs.FSWatcher | null} */
    this.dirWatcher = null;
    /** @type {NodeJS.Timeout | null} */
    this.debounceTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.pollTimer = null;

    this.syncWatchersForMode();
  }

  /**
   * `'managed'` when `active.code-workspace` is open;
   * `'single-sdk'` when a single folder inside `main` or `worktreesDir/*` is open;
   * `'other'` for unrelated windows (Google3, webdev, empty, etc.).
   *
   * @returns {'managed' | 'single-sdk' | 'other'}
   */
  windowMode() {
    this.cfg = loadConfig();
    const wsFile = vscode.workspace.workspaceFile;
    if (
      wsFile &&
      wsFile.scheme === 'file' &&
      path.resolve(wsFile.fsPath) === path.resolve(this.cfg.activeWorkspacePath)
    ) {
      return 'managed';
    }
    if (!wsFile) {
      for (const folder of vscode.workspace.workspaceFolders || []) {
        if (folder.uri.scheme === 'file' && parseSdkPath(folder.uri.fsPath, this.cfg)) {
          return 'single-sdk';
        }
      }
    }
    return 'other';
  }

  /**
   * Starts watchers/polling only in SDK windows; keeps non-SDK windows 100% idle.
   */
  syncWatchersForMode() {
    if (this.windowMode() === 'other') {
      this.stopWatchers();
      this.statusBar.hide();
      return;
    }
    this.ensureDirWatcher();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    }
  }

  stopWatchers() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
  }

  /**
   * Parses all SDK workspace folders currently mounted in this window.
   *
   * @returns {Array<{index: number, folder: vscode.WorkspaceFolder, checkoutName: string, checkoutRoot: string, relPath: string}>}
   */
  currentSdkFolders() {
    /** @type {Array<{index: number, folder: vscode.WorkspaceFolder, checkoutName: string, checkoutRoot: string, relPath: string}>} */
    const out = [];
    const folders = vscode.workspace.workspaceFolders || [];
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      if (f.uri.scheme !== 'file') continue;
      const parsed = parseSdkPath(f.uri.fsPath, this.cfg);
      if (parsed) out.push({ index: i, folder: f, ...parsed });
    }
    return out;
  }

  updateWindowLock() {
    if (this.windowMode() !== 'managed') return;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        WINDOW_LOCK_FILE,
        JSON.stringify({ pid: process.pid, updatedAt: Date.now() }) + '\n',
        'utf8'
      );
    } catch (_) {
      // Ignore lock write failures.
    }
  }

  releaseWindowLock() {
    try {
      const raw = JSON.parse(fs.readFileSync(WINDOW_LOCK_FILE, 'utf8'));
      if (raw && raw.pid === process.pid) {
        fs.unlinkSync(WINDOW_LOCK_FILE);
      }
    } catch (_) {
      // Ignore missing lock.
    }
  }

  readDartLinkTarget() {
    try {
      return fs.realpathSync(this.cfg.dartLink);
    } catch (_) {
      return '';
    }
  }

  ensureDirWatcher() {
    if (this.dirWatcher) return;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      this.dirWatcher = fs.watch(STATE_DIR, (_event, filename) => {
        if (filename && !filename.startsWith('state.json')) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.checkStateChange(), 40);
      });
      this.dirWatcher.on('error', () => {
        if (this.dirWatcher) {
          this.dirWatcher.close();
          this.dirWatcher = null;
        }
      });
    } catch (_) {
      // Poll fallback handles environments where fs.watch fails.
    }
  }

  async initialize() {
    this.syncWatchersForMode();
    const mode = this.windowMode();
    if (mode === 'other') return;

    this.updateWindowLock();
    await this.restorePendingTabsIfAny();
    this.refreshStatusBar();

    const state = readState();
    if (state) {
      this.lastStateTimestamp = state.timestamp || 0;
    }

    const sdkFolders = this.currentSdkFolders();
    const missingOnDisk = sdkFolders.some((f) => !fs.existsSync(f.checkoutRoot));

    if (state && fs.existsSync(state.checkout)) {
      const differs = sdkFolders.some((f) => f.checkoutRoot !== state.checkout);
      if (mode === 'managed' && (differs || missingOnDisk)) {
        await this.syncToTarget(state.checkout, state.name, state.subpaths || null);
        return;
      } else if (mode === 'single-sdk' && missingOnDisk && !isManagedWorkspaceWindowAlive()) {
        await this.upgradeSingleFolderWindow(state.checkout, state.name);
        return;
      }
    } else if (missingOnDisk && fs.existsSync(this.cfg.mainCheckout)) {
      if (mode === 'managed') {
        await this.syncToTarget(this.cfg.mainCheckout, MAIN_NAME, null);
        return;
      } else if (mode === 'single-sdk' && !isManagedWorkspaceWindowAlive()) {
        await this.upgradeSingleFolderWindow(this.cfg.mainCheckout, MAIN_NAME);
        return;
      }
    }

    // VS Code restarts the background Extension Host (without reloading the
    // window) AFTER updating `folders` if folder[0] in `active.code-workspace`
    // changed, e.g. when migrating to the stable workspace anchor folder.
    // Finish syncing workspace settings and remapping any open tabs from the
    // previous worktree right here on startup!
    if (mode === 'managed' && sdkFolders.length > 0) {
      const activeCheckout = sdkFolders[0].checkoutRoot;
      const activeName = sdkFolders[0].checkoutName;
      const effectiveSubpaths = sdkFolders.map((f) => f.relPath);
      await this.updateManagedWorkspaceSettings(activeName, effectiveSubpaths);
      await this.remapStaleTabsToCheckout(activeCheckout);
      this.refreshStatusBar();
    }
  }

  poll() {
    if (this.windowMode() === 'other') {
      this.stopWatchers();
      this.statusBar.hide();
      return;
    }
    this.ensureDirWatcher();
    this.checkStateChange();
    this.checkDartLinkChange();
  }

  checkStateChange() {
    if (!this.followNwEnabled()) return;
    const mode = this.windowMode();
    if (mode === 'other') return;

    const state = readState();
    if (!state || !state.checkout) return;
    if ((state.timestamp || 0) <= this.lastStateTimestamp) return;
    this.lastStateTimestamp = state.timestamp || Date.now();

    if (!fs.existsSync(state.checkout)) return;

    if (mode === 'managed') {
      void this.syncToTarget(state.checkout, state.name, state.subpaths || null);
    } else if (mode === 'single-sdk' && !isManagedWorkspaceWindowAlive()) {
      void this.upgradeSingleFolderWindow(state.checkout, state.name, state.subpaths || null);
    }
  }

  checkDartLinkChange() {
    if (this.windowMode() !== 'managed') return;
    const current = this.readDartLinkTarget();
    if (current !== this.lastDartLinkTarget) {
      this.lastDartLinkTarget = current;
      void this.syncDsSdkPathIfNeeded();
    }
  }

  followNwEnabled() {
    return vscode.workspace.getConfiguration('nwWorktrees').get('followNw', true);
  }

  followDsSdkEnabled() {
    return vscode.workspace.getConfiguration('nwWorktrees').get('followDsSdk', true);
  }

  async syncDsSdkPathIfNeeded() {
    if (this.windowMode() !== 'managed' || !this.followDsSdkEnabled()) return;
    const sdkDir = resolveBuiltDartSdkPath(this.cfg);
    if (!sdkDir) return;
    const dartConfig = vscode.workspace.getConfiguration('dart');
    const inspected = dartConfig.inspect('sdkPath');
    if ((inspected && inspected.workspaceValue) !== sdkDir) {
      await dartConfig.update('sdkPath', sdkDir, vscode.ConfigurationTarget.Workspace);
    }
  }

  refreshStatusBar() {
    const mode = this.windowMode();
    if (mode === 'other') {
      this.statusBar.hide();
      return;
    }
    const sdkFolders = this.currentSdkFolders();
    if (sdkFolders.length === 0) {
      this.statusBar.hide();
      return;
    }
    const name = sdkFolders[0].checkoutName;
    const scopes = sdkFolders.map((f) => f.relPath || 'sdk').join(', ');
    const unmanagedHint = mode === 'single-sdk' ? ' (single-folder)' : '';
    this.statusBar.text = `$(git-branch) nw: ${name}`;
    this.statusBar.tooltip =
      `Dart SDK checkout: ${name} (${sdkFolders[0].checkoutRoot})\n` +
      `Scope: ${scopes}${unmanagedHint}\n` +
      `Click to switch worktree`;
    this.statusBar.show();
  }

  /**
   * Captures open SDK tabs (and visible cursor/scroll positions) that do NOT
   * already point at `targetCheckout`.
   *
   * @param {string} targetCheckout
   */
  captureTabsForSwitch(targetCheckout) {
    /** @type {Map<string, {selections: Array<{anchor: [number, number], active: [number, number]}>, topLine: number}>} */
    const viewports = new Map();
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== 'file') continue;
      viewports.set(ed.document.uri.fsPath, {
        selections: ed.selections.map((s) => ({
          anchor: [s.anchor.line, s.anchor.character],
          active: [s.active.line, s.active.character],
        })),
        topLine: ed.visibleRanges[0] ? ed.visibleRanges[0].start.line : 0,
      });
    }

    const activeFsPath =
      vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file'
        ? vscode.window.activeTextEditor.document.uri.fsPath
        : null;

    /** @type {Array<{tab: vscode.Tab, fsPath: string, relPath: string, checkoutRoot: string, viewColumn: vscode.ViewColumn, isActiveInGroup: boolean, isGroupActive: boolean, isPreview: boolean, isPinned: boolean, isDirty: boolean, viewport: any}>} */
    const textTabs = [];
    /** @type {vscode.Tab[]} */
    const staleDiffTabs = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
          const parsed = parseSdkPath(input.uri.fsPath, this.cfg);
          if (parsed && parsed.checkoutRoot !== targetCheckout) {
            textTabs.push({
              tab,
              fsPath: input.uri.fsPath,
              relPath: parsed.relPath,
              checkoutRoot: parsed.checkoutRoot,
              viewColumn: group.viewColumn,
              isActiveInGroup: tab.isActive,
              isGroupActive: group.isActive,
              isPreview: tab.isPreview,
              isPinned: tab.isPinned,
              isDirty: tab.isDirty,
              viewport: viewports.get(input.uri.fsPath) || null,
            });
          }
        } else if (input instanceof vscode.TabInputTextDiff && !tab.isDirty) {
          const orig =
            input.original.scheme === 'file' ? parseSdkPath(input.original.fsPath, this.cfg) : null;
          const mod =
            input.modified.scheme === 'file' ? parseSdkPath(input.modified.fsPath, this.cfg) : null;
          if (
            (orig && orig.checkoutRoot !== targetCheckout) ||
            (mod && mod.checkoutRoot !== targetCheckout)
          ) {
            staleDiffTabs.push(tab);
          }
        }
      }
    }

    return { textTabs, staleDiffTabs, activeFsPath };
  }

  /**
   * Attempts to save any dirty SDK documents before switching checkouts.
   * Returns the set of `fsPath`s that remain dirty and MUST NOT be closed.
   *
   * @param {string} targetCheckout
   * @returns {Promise<Set<string>>}
   */
  async saveDirtySdkDocuments(targetCheckout) {
    /** @type {Set<string>} */
    const stillDirty = new Set();
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || doc.uri.scheme !== 'file') continue;
      const parsed = parseSdkPath(doc.uri.fsPath, this.cfg);
      if (!parsed || parsed.checkoutRoot === targetCheckout) continue;
      if (fs.existsSync(path.dirname(doc.uri.fsPath))) {
        try {
          await doc.save();
        } catch (_) {
          // Handled below via doc.isDirty check.
        }
      }
      if (doc.isDirty) {
        stillDirty.add(doc.uri.fsPath);
      }
    }
    return stillDirty;
  }

  /**
   * Closes any open tabs belonging to another SDK checkout and reopens their
   * counterparts in `targetCheckout` at the same cursor/scroll position.
   *
   * @param {string} targetCheckout
   */
  async remapStaleTabsToCheckout(targetCheckout) {
    if (this.remappingTabs) return;
    this.remappingTabs = true;
    try {
      const stillDirty = await this.saveDirtySdkDocuments(targetCheckout);
      const captured = this.captureTabsForSwitch(targetCheckout);
      if (captured.textTabs.length === 0 && captured.staleDiffTabs.length === 0) {
        return;
      }

      const closableTextTabs = captured.textTabs.filter((item) => !stillDirty.has(item.fsPath));
      const reopenableItems = closableTextTabs.map((item) => ({
        relPath: item.relPath,
        viewColumn: item.viewColumn,
        isActiveInGroup: item.isActiveInGroup,
        isGroupActive: item.isGroupActive,
        isPreview: item.isPreview,
        isPinned: item.isPinned,
        viewport: item.viewport,
      }));
      const tabsToClose = [
        ...closableTextTabs.map((item) => item.tab),
        ...captured.staleDiffTabs,
      ];
      const hadSdkEditorFocus = Boolean(
        captured.activeFsPath && parseSdkPath(captured.activeFsPath, this.cfg)
      );

      if (tabsToClose.length > 0) {
        try {
          await vscode.window.tabGroups.close(tabsToClose, true);
        } catch (_) {
          // Ignore individual tab close errors.
        }
      }

      if (reopenableItems.length > 0) {
        await this.reopenMappedItems(targetCheckout, reopenableItems, hadSdkEditorFocus);
      }

      if (stillDirty.size > 0) {
        vscode.window.showWarningMessage(
          `Dart Worktrees: Kept ${stillDirty.size} unsaved tab(s) open from the previous worktree.`
        );
      }
    } finally {
      this.remappingTabs = false;
    }
  }

  /**
   * Transitions a single-folder SDK window onto `active.code-workspace` once,
   * preserving its relative subpath and open tabs/cursors across the reload.
   *
   * @param {string} targetCheckout
   * @param {string} targetName
   * @param {string[] | null} [explicitSubpaths]
   */
  async upgradeSingleFolderWindow(targetCheckout, targetName, explicitSubpaths = null) {
    if (this.switching) return;
    this.switching = true;
    try {
      const stillDirty = await this.saveDirtySdkDocuments(targetCheckout);
      if (stillDirty.size > 0) {
        vscode.window.showWarningMessage(
          `Dart Worktrees: Save ${stillDirty.size} unsaved file(s) before switching worktrees.`
        );
        return;
      }

      const sdkFolders = this.currentSdkFolders();
      const subpaths =
        explicitSubpaths && explicitSubpaths.length > 0
          ? explicitSubpaths
          : sdkFolders.map((f) => f.relPath);

      const captured = this.captureTabsForSwitch(targetCheckout);
      const sameCheckoutTabs = this.captureTabsForSwitch('__none__').textTabs;
      const serializable = (captured.textTabs.length > 0 ? captured.textTabs : sameCheckoutTabs).map(
        (item) => ({
          relPath: item.relPath,
          viewColumn: item.viewColumn,
          isActiveInGroup: item.isActiveInGroup,
          isGroupActive: item.isGroupActive,
          isPreview: item.isPreview,
          isPinned: item.isPinned,
          viewport: item.viewport,
        })
      );

      await this.context.globalState.update(PENDING_RESTORE_KEY, {
        targetCheckout,
        items: serializable,
        hadEditorFocus: Boolean(captured.activeFsPath),
        createdAt: Date.now(),
      });

      syncWorkspaceFileOnDisk(targetCheckout, targetName, subpaths);
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(this.cfg.activeWorkspacePath),
        { forceNewWindow: false }
      );
    } finally {
      this.switching = false;
    }
  }

  async restorePendingTabsIfAny() {
    /** @type {any} */
    const pending = this.context.globalState.get(PENDING_RESTORE_KEY);
    if (!pending) return;
    await this.context.globalState.update(PENDING_RESTORE_KEY, undefined);
    if (this.windowMode() !== 'managed') return;
    if (Date.now() - (pending.createdAt || 0) > PENDING_RESTORE_TTL_MS) return;
    if (!pending.targetCheckout || !Array.isArray(pending.items)) return;

    await this.reopenMappedItems(pending.targetCheckout, pending.items, pending.hadEditorFocus);
  }

  /**
   * Reopens mapped SDK tabs in `targetCheckout` and restores cursor/scroll state.
   *
   * @param {string} targetCheckout
   * @param {Array<{relPath: string, viewColumn: vscode.ViewColumn, isActiveInGroup: boolean, isGroupActive: boolean, isPreview: boolean, isPinned: boolean, viewport: any}>} items
   * @param {boolean} focusActiveEditor
   */
  async reopenMappedItems(targetCheckout, items, focusActiveEditor) {
    /** @type {Array<{uri: vscode.Uri, item: any}>} */
    const activePerGroup = [];
    /** @type {{uri: vscode.Uri, item: any} | null} */
    let primaryActive = null;

    for (const item of items) {
      const targetFsPath = path.join(targetCheckout, ...item.relPath.split('/'));
      if (!fs.existsSync(targetFsPath)) continue;
      const uri = vscode.Uri.file(targetFsPath);
      try {
        const editor = await vscode.window.showTextDocument(uri, {
          viewColumn: item.viewColumn,
          preview: item.isPreview && !item.isPinned,
          preserveFocus: true,
        });
        restoreEditorViewport(editor, item.viewport);
        if (item.isPinned) {
          await vscode.window.showTextDocument(uri, {
            viewColumn: item.viewColumn,
            preview: false,
            preserveFocus: false,
          });
          await vscode.commands.executeCommand('workbench.action.pinEditor');
        }
        if (item.isActiveInGroup) {
          if (item.isGroupActive) {
            primaryActive = { uri, item };
          } else {
            activePerGroup.push({ uri, item });
          }
        }
      } catch (_) {
        // Ignore files that cannot be opened as text.
      }
    }

    for (const entry of activePerGroup) {
      try {
        const ed = await vscode.window.showTextDocument(entry.uri, {
          viewColumn: entry.item.viewColumn,
          preview: entry.item.isPreview && !entry.item.isPinned,
          preserveFocus: true,
        });
        restoreEditorViewport(ed, entry.item.viewport);
      } catch (_) {
        // Ignore.
      }
    }

    if (primaryActive) {
      try {
        const ed = await vscode.window.showTextDocument(primaryActive.uri, {
          viewColumn: primaryActive.item.viewColumn,
          preview: primaryActive.item.isPreview && !primaryActive.item.isPinned,
          preserveFocus: !focusActiveEditor,
        });
        restoreEditorViewport(ed, primaryActive.item.viewport);
      } catch (_) {
        // Ignore.
      }
    }
  }

  /**
   * Switches `active.code-workspace` to `targetCheckout` in place, updating
   * workspace folders, workspace settings, and open editor tabs.
   *
   * @param {string} targetCheckout
   * @param {string} targetName
   * @param {string[] | null} [explicitSubpaths]
   */
  async syncToTarget(targetCheckout, targetName, explicitSubpaths = null) {
    if (this.switching) {
      this.resyncRequested = true;
      return;
    }
    this.switching = true;
    try {
      await this.saveDirtySdkDocuments(targetCheckout);

      const currentFolders = vscode.workspace.workspaceFolders || [];
      /** @type {Array<{uri: vscode.Uri, name?: string}>} */
      const nextFolders = [];
      /** @type {string[]} */
      const effectiveSubpaths = [];
      /** @type {string[]} */
      const fallbackSubpaths = [];
      const seenPaths = new Set();

      if (explicitSubpaths && explicitSubpaths.length > 0) {
        for (const sub of explicitSubpaths) {
          const resolved = resolveMappedFolder(sub, targetCheckout);
          if (resolved.fellBack && sub) fallbackSubpaths.push(sub);
          if (!seenPaths.has(resolved.folderPath)) {
            seenPaths.add(resolved.folderPath);
            effectiveSubpaths.push(resolved.effectiveSubpath);
            nextFolders.push({
              uri: vscode.Uri.file(resolved.folderPath),
              name: formatFolderName(resolved.effectiveSubpath, targetName),
            });
          }
        }
        for (const f of currentFolders) {
          if (f.uri.scheme !== 'file' || !parseSdkPath(f.uri.fsPath, this.cfg)) {
            nextFolders.push({ uri: f.uri, name: f.name });
          }
        }
      } else {
        let sawSdkFolder = false;
        for (const f of currentFolders) {
          const parsed = f.uri.scheme === 'file' ? parseSdkPath(f.uri.fsPath, this.cfg) : null;
          if (!parsed) {
            nextFolders.push({ uri: f.uri, name: f.name });
            continue;
          }
          sawSdkFolder = true;
          const resolved = resolveMappedFolder(parsed.relPath, targetCheckout);
          if (resolved.fellBack && parsed.relPath) fallbackSubpaths.push(parsed.relPath);
          if (seenPaths.has(resolved.folderPath)) continue;
          seenPaths.add(resolved.folderPath);
          effectiveSubpaths.push(resolved.effectiveSubpath);
          nextFolders.push({
            uri: vscode.Uri.file(resolved.folderPath),
            name: formatFolderName(resolved.effectiveSubpath, targetName),
          });
        }
        if (!sawSdkFolder) {
          effectiveSubpaths.push('');
          nextFolders.unshift({
            uri: vscode.Uri.file(targetCheckout),
            name: formatFolderName('', targetName),
          });
        }
      }
      this.prependWorkspaceAnchor(nextFolders);

      const foldersChanged =
        currentFolders.length !== nextFolders.length ||
        currentFolders.some(
          (f, idx) =>
            f.uri.toString() !== nextFolders[idx].uri.toString() ||
            f.name !== nextFolders[idx].name
        );

      if (foldersChanged) {
        await this.applyWorkspaceFoldersUpdate(currentFolders, nextFolders);
      }

      await this.updateManagedWorkspaceSettings(targetName, effectiveSubpaths);
      await this.remapStaleTabsToCheckout(targetCheckout);

      this.updateWindowLock();
      this.refreshStatusBar();

      if (fallbackSubpaths.length > 0) {
        vscode.window.setStatusBarMessage(
          `Dart Worktrees: ${fallbackSubpaths.join(', ')} not in ${targetName}; mounted sdk root.`,
          5000
        );
      }
    } finally {
      this.switching = false;
      if (this.resyncRequested) {
        this.resyncRequested = false;
        const latest = readState();
        if (latest && fs.existsSync(latest.checkout)) {
          void this.syncToTarget(latest.checkout, latest.name, latest.subpaths || null);
        }
      }
    }
  }

  /**
   * Moves the stable workspace anchor folder to the front of `folders`, so
   * folder[0] stays the same across worktree switches and VS Code doesn't
   * restart the extension host (which prompts if custom editors are open).
   *
   * @param {Array<{uri: vscode.Uri, name?: string}>} folders
   */
  prependWorkspaceAnchor(folders) {
    const firstSdkFolder = folders.find(
      (f) => f.uri.scheme === 'file' && parseSdkPath(f.uri.fsPath, this.cfg)
    );
    const anchorUri = vscode.Uri.file(
      ensureWorkspaceAnchor(firstSdkFolder ? firstSdkFolder.uri.fsPath : this.cfg.mainCheckout)
    );
    const existing = folders.findIndex((f) => f.uri.toString() === anchorUri.toString());
    if (existing >= 0) folders.splice(existing, 1);
    folders.unshift({ uri: anchorUri, name: WORKSPACE_ANCHOR_NAME });
  }

  /**
   * Replaces `currentFolders` with `nextFolders`, leaving their shared leading
   * folders (including the workspace anchor) untouched.
   *
   * @param {readonly vscode.WorkspaceFolder[]} currentFolders
   * @param {Array<{uri: vscode.Uri, name?: string}>} nextFolders
   */
  applyWorkspaceFoldersUpdate(currentFolders, nextFolders) {
    let start = 0;
    while (
      start < currentFolders.length &&
      start < nextFolders.length &&
      currentFolders[start].uri.toString() === nextFolders[start].uri.toString() &&
      currentFolders[start].name === nextFolders[start].name
    ) {
      start++;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        sub.dispose();
        clearTimeout(timer);
        resolve(undefined);
      };
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => finish());
      const timer = setTimeout(finish, 2500);
      const ok = vscode.workspace.updateWorkspaceFolders(
        start,
        currentFolders.length - start,
        ...nextFolders.slice(start)
      );
      if (!ok) finish();
    });
  }

  /**
   * @param {string} checkoutName
   * @param {string[]} effectiveSubpaths
   */
  async updateManagedWorkspaceSettings(checkoutName, effectiveSubpaths) {
    if (this.windowMode() !== 'managed') return;
    const desired = computeWorkspaceSettings(checkoutName, effectiveSubpaths, {
      followDsSdk: this.followDsSdkEnabled(),
      ...this.cfg,
    });
    const wsConfig = vscode.workspace.getConfiguration();
    for (const [key, val] of Object.entries(desired)) {
      const inspected = wsConfig.inspect(key);
      const currentVal = inspected ? inspected.workspaceValue : undefined;
      if (JSON.stringify(currentVal) !== JSON.stringify(val)) {
        await wsConfig.update(key, val, vscode.ConfigurationTarget.Workspace);
      }
    }
  }

  async pickAndSwitchWorktree() {
    const checkouts = listCheckouts(this.cfg);
    if (checkouts.length === 0) {
      vscode.window.showInformationMessage('No Dart SDK checkouts found.');
      return;
    }

    const sdkFolders = this.currentSdkFolders();
    const currentCheckout = sdkFolders[0] ? sdkFolders[0].checkoutRoot : '';

    const items = checkouts.map((c) => {
      const active = c.checkoutRoot === currentCheckout;
      return {
        label: `${active ? '$(check) ' : ''}${c.name}`,
        description: describeCheckoutGit(c.checkoutRoot),
        detail: c.checkoutRoot,
        checkout: c,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Switch Dart SDK worktree (nw)',
      matchOnDescription: true,
    });
    if (!picked) return;

    const written = writeState({
      name: picked.checkout.name,
      checkout: picked.checkout.checkoutRoot,
    });
    this.lastStateTimestamp = written.timestamp;

    const mode = this.windowMode();
    if (mode === 'managed') {
      await this.syncToTarget(picked.checkout.checkoutRoot, picked.checkout.name, null);
    } else if (mode === 'single-sdk') {
      await this.upgradeSingleFolderWindow(picked.checkout.checkoutRoot, picked.checkout.name);
    } else {
      syncWorkspaceFileOnDisk(picked.checkout.checkoutRoot, picked.checkout.name, null);
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(this.cfg.activeWorkspacePath),
        { forceNewWindow: true }
      );
    }
  }

  async pickAndScopeFolders() {
    const sdkFolders = this.currentSdkFolders();
    const state = readState();
    const checkoutRoot =
      (sdkFolders[0] && fs.existsSync(sdkFolders[0].checkoutRoot) && sdkFolders[0].checkoutRoot) ||
      (state && fs.existsSync(state.checkout) && state.checkout) ||
      this.cfg.mainCheckout;
    const checkoutName =
      (sdkFolders[0] && sdkFolders[0].checkoutName) || (state && state.name) || MAIN_NAME;

    const activeRelPaths = new Set(sdkFolders.map((f) => f.relPath));

    /** @type {string[]} */
    const candidates = [''];
    for (const parent of ['pkg', 'sdk/lib', 'sdk/lib/_internal', 'tests', 'runtime']) {
      const absParent = path.join(checkoutRoot, ...parent.split('/'));
      if (!fs.existsSync(absParent)) continue;
      candidates.push(parent);
      try {
        for (const entry of fs.readdirSync(absParent, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            candidates.push(`${parent}/${entry.name}`);
          }
        }
      } catch (_) {
        // Ignore unreadable dirs.
      }
    }
    for (const existing of activeRelPaths) {
      if (!candidates.includes(existing)) candidates.unshift(existing);
    }

    const items = candidates.map((rel) => ({
      label: rel || '. (Full Dart SDK checkout)',
      description: rel ? undefined : 'Applies sdk.code-workspace analyzer exclusions',
      picked: activeRelPaths.has(rel),
      rel,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Select SDK folder(s) to mount in [${checkoutName}]`,
    });
    if (!picked || picked.length === 0) return;

    const chosenSubpaths = picked.map((p) => p.rel);
    const written = writeState({
      name: checkoutName,
      checkout: checkoutRoot,
      subpaths: chosenSubpaths,
    });
    this.lastStateTimestamp = written.timestamp;

    if (this.windowMode() === 'managed') {
      await this.syncToTarget(checkoutRoot, checkoutName, chosenSubpaths);
    } else {
      await this.upgradeSingleFolderWindow(checkoutRoot, checkoutName, chosenSubpaths);
    }
  }

  async syncNow() {
    const state = readState();
    const targetCheckout =
      state && fs.existsSync(state.checkout) ? state.checkout : this.cfg.mainCheckout;
    const targetName = state && fs.existsSync(state.checkout) ? state.name : MAIN_NAME;

    if (this.windowMode() === 'managed') {
      await this.syncToTarget(targetCheckout, targetName, null);
    } else if (this.windowMode() === 'single-sdk') {
      await this.upgradeSingleFolderWindow(targetCheckout, targetName, null);
    } else {
      vscode.window.showInformationMessage(
        `Open ${this.cfg.activeWorkspacePath} (or run \`nw -c\`) to follow Dart SDK worktrees in this window.`
      );
    }
  }

  dispose() {
    this.stopWatchers();
    this.releaseWindowLock();
    this.statusBar.dispose();
  }
}

/** @type {WorktreeController | null} */
let activeController = null;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const controller = new WorktreeController(context);
  activeController = controller;

  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('nwWorktrees.switchWorktree', () =>
      controller.pickAndSwitchWorktree()
    ),
    vscode.commands.registerCommand('nwWorktrees.scopeFolders', () =>
      controller.pickAndScopeFolders()
    ),
    vscode.commands.registerCommand('nwWorktrees.syncNow', () => controller.syncNow()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      controller.syncWatchersForMode();
      controller.updateWindowLock();
      controller.refreshStatusBar();
    }),
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) controller.poll();
    })
  );

  void controller.initialize();
}

function deactivate() {
  if (activeController) {
    activeController.releaseWindowLock();
    activeController = null;
  }
}

module.exports = {
  activate,
  deactivate,
};
