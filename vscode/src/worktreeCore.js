// @ts-check
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const MAIN_NAME = 'main';

const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'),
  'dart-worktrees',
  'config.env'
);

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'),
  'nw'
);
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WINDOW_LOCK_FILE = path.join(STATE_DIR, 'active-window.json');

/** Exclusions from sdk.code-workspace when the checkout root itself is opened. */
const ROOT_ANALYSIS_EXCLUDES = [
  '.dart_tool',
  'tests',
  'runtime/tests',
  'third_party',
  'runtime/third_party',
  'runtime/tools/heapsnapshot',
  'sdk/lib',
  'xcodebuild',
  'out',
  'pkg/compiler/test/codesize/swarm',
];

/** Minimal exclusions when scoped to a subpackage/subfolder (e.g. pkg/foo or tests/web). */
const SUBPATH_ANALYSIS_EXCLUDES = [
  '.dart_tool',
  'out',
  'xcodebuild',
  'third_party',
];

/**
 * Expands leading `~/` and `$HOME` in a config value.
 *
 * @param {string} val
 * @param {string} [homeDir]
 * @returns {string}
 */
function expandHomeVars(val, homeDir = HOME) {
  let out = val.replace(/\$\{HOME\}|\$HOME/g, homeDir);
  if (out === '~') return homeDir;
  if (out.startsWith('~/')) return path.join(homeDir, out.slice(2));
  return out;
}

/**
 * Parses simple `KEY="value"` / `KEY=value` lines from `config.env`.
 *
 * @param {string} text
 * @param {string} [homeDir]
 * @returns {Record<string, string>}
 */
function parseConfigEnv(text, homeDir = HOME) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = cleaned.indexOf('=');
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let val = cleaned.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = expandHomeVars(val, homeDir);
  }
  return vars;
}

/**
 * Resolves effective configuration from `config.env`, `env`, and host platform.
 *
 * @param {{configFile?: string, env?: NodeJS.ProcessEnv, platform?: string, arch?: string, homeDir?: string}} [opts]
 */
function loadConfig(opts = {}) {
  const homeDir = opts.homeDir || HOME;
  const cfgPath = opts.configFile !== undefined ? opts.configFile : CONFIG_FILE;
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;

  /** @type {Record<string, string>} */
  let fileVars = {};
  if (cfgPath && fs.existsSync(cfgPath)) {
    try {
      fileVars = parseConfigEnv(fs.readFileSync(cfgPath, 'utf8'), homeDir);
    } catch (_) {
      fileVars = {};
    }
  }

  /** @param {string} key */
  const pick = (key) => {
    const fromEnv = env[key];
    if (fromEnv) return expandHomeVars(fromEnv, homeDir);
    return fileVars[key] || '';
  };

  const mainCheckout = path.resolve(
    pick('DART_MAIN_CHECKOUT') || path.join(homeDir, 'dart-sdk', 'sdk')
  );
  const worktreesDir = path.resolve(
    pick('DART_WORKTREES_DIR') || path.join(homeDir, 'dart-sdk-worktrees')
  );
  const dartLink = path.resolve(
    pick('DART_LINK') || path.join(homeDir, '.dart-current')
  );
  const buildMode = (pick('DART_BUILD_MODE') || 'release').toLowerCase();
  const buildArch = (
    pick('DART_BUILD_ARCH') || (arch === 'arm64' ? 'arm64' : 'x64')
  ).toLowerCase();
  const outDirName =
    pick('DART_OUT_DIR_NAME') || (platform === 'darwin' ? 'xcodebuild' : 'out');

  const modeCap =
    buildMode === 'debug' ? 'Debug' : buildMode === 'product' ? 'Product' : 'Release';
  const archCap =
    buildArch === 'arm64'
      ? 'ARM64'
      : buildArch === 'ia32'
        ? 'IA32'
        : buildArch === 'riscv64'
          ? 'RISCV64'
          : 'X64';

  const sdkSubpath =
    pick('DART_SDK_SUBPATH') || path.join(outDirName, `${modeCap}${archCap}`, 'dart-sdk');
  const activeWorkspacePath = path.resolve(
    pick('DART_VSCODE_WORKSPACE') ||
      path.join(path.dirname(mainCheckout), 'active.code-workspace')
  );
  const codeCmd = pick('DART_CODE_CMD') || 'code';

  return {
    mainCheckout,
    worktreesDir,
    dartLink,
    sdkSubpath,
    activeWorkspacePath,
    codeCmd,
  };
}

/**
 * Parses an absolute path if it belongs to `main` or any worktree under
 * `worktreesDir/<name>` (even if that worktree directory was deleted).
 *
 * @param {string} fsPath
 * @param {{mainCheckout?: string, worktreesDir?: string}} [roots]
 * @returns {{checkoutName: string, checkoutRoot: string, relPath: string} | null}
 */
function parseSdkPath(fsPath, roots) {
  const cfg = roots && (roots.mainCheckout || roots.worktreesDir) ? null : loadConfig();
  const mainCheckout = path.resolve(
    (roots && roots.mainCheckout) || (cfg ? cfg.mainCheckout : path.join(HOME, 'dart-sdk', 'sdk'))
  );
  const worktreesDir = path.resolve(
    (roots && roots.worktreesDir) ||
      (cfg ? cfg.worktreesDir : path.join(HOME, 'dart-sdk-worktrees'))
  );
  const resolved = path.resolve(fsPath);

  if (resolved === mainCheckout || resolved.startsWith(mainCheckout + path.sep)) {
    const relPath = path.relative(mainCheckout, resolved).split(path.sep).join('/');
    return { checkoutName: MAIN_NAME, checkoutRoot: mainCheckout, relPath };
  }

  if (resolved.startsWith(worktreesDir + path.sep)) {
    const afterRoot = resolved.slice(worktreesDir.length + 1);
    const parts = afterRoot.split(path.sep);
    const checkoutName = parts[0];
    if (!checkoutName || checkoutName.startsWith('.')) return null;
    const checkoutRoot = path.join(worktreesDir, checkoutName);
    const relPath = parts.slice(1).join('/');
    return { checkoutName, checkoutRoot, relPath };
  }

  return null;
}

/**
 * Lists `main` plus all valid git worktrees in `worktreesDir`.
 *
 * @param {{mainCheckout?: string, worktreesDir?: string}} [roots]
 * @returns {Array<{name: string, checkoutRoot: string}>}
 */
function listCheckouts(roots) {
  const cfg = roots && (roots.mainCheckout || roots.worktreesDir) ? null : loadConfig();
  const mainCheckout = path.resolve(
    (roots && roots.mainCheckout) || (cfg ? cfg.mainCheckout : path.join(HOME, 'dart-sdk', 'sdk'))
  );
  const worktreesDir = path.resolve(
    (roots && roots.worktreesDir) ||
      (cfg ? cfg.worktreesDir : path.join(HOME, 'dart-sdk-worktrees'))
  );
  /** @type {Array<{name: string, checkoutRoot: string}>} */
  const result = [];
  if (fs.existsSync(mainCheckout)) {
    result.push({ name: MAIN_NAME, checkoutRoot: mainCheckout });
  }
  if (fs.existsSync(worktreesDir)) {
    const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const checkoutRoot = path.join(worktreesDir, entry.name);
      if (fs.existsSync(path.join(checkoutRoot, '.git'))) {
        result.push({ name: entry.name, checkoutRoot });
      }
    }
  }
  return result;
}

/**
 * Short git branch & subject description for QuickPick UI.
 *
 * @param {string} checkoutRoot
 * @returns {string}
 */
function describeCheckoutGit(checkoutRoot) {
  try {
    const branch = cp
      .execFileSync('git', ['-C', checkoutRoot, 'branch', '--show-current'], {
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString()
      .trim();
    const subject = cp
      .execFileSync('git', ['-C', checkoutRoot, 'log', '-1', '--format=%h %s'], {
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString()
      .trim();
    return branch ? `${branch} — ${subject}` : subject;
  } catch (_) {
    return checkoutRoot;
  }
}

/**
 * Maps a checkout-relative folder path onto `targetCheckout`. Falls back to
 * `targetCheckout` itself if `relSubpath` does not exist on that branch.
 *
 * @param {string} relSubpath
 * @param {string} targetCheckout
 * @returns {{folderPath: string, effectiveSubpath: string, fellBack: boolean}}
 */
function resolveMappedFolder(relSubpath, targetCheckout) {
  const cleanRel = (relSubpath || '').replace(/^\/+|\/+$/g, '');
  if (!cleanRel) {
    return { folderPath: targetCheckout, effectiveSubpath: '', fellBack: false };
  }
  const candidate = path.join(targetCheckout, ...cleanRel.split('/'));
  try {
    if (fs.statSync(candidate).isDirectory()) {
      return { folderPath: candidate, effectiveSubpath: cleanRel, fellBack: false };
    }
  } catch (_) {
    // Fall back to checkout root.
  }
  return { folderPath: targetCheckout, effectiveSubpath: '', fellBack: true };
}

/**
 * Human-readable workspace folder label showing both subpath and worktree.
 *
 * @param {string} effectiveSubpath
 * @param {string} checkoutName
 * @returns {string}
 */
function formatFolderName(effectiveSubpath, checkoutName) {
  const base = effectiveSubpath || 'sdk';
  return `${base} [${checkoutName}]`;
}

/**
 * Resolves the best built `dart-sdk` directory for the analyzer: prefers the
 * checkout targeted by `~/.dart-current` (`ds`) if built, else `main` if built.
 *
 * @param {{dartLink?: string, mainCheckout?: string, sdkSubpath?: string}} [opts]
 * @returns {string | undefined}
 */
function resolveBuiltDartSdkPath(opts = {}) {
  const cfg = loadConfig();
  const dartLink = opts.dartLink || cfg.dartLink;
  const mainCheckout = opts.mainCheckout || cfg.mainCheckout;
  const sdkSubpath = opts.sdkSubpath || cfg.sdkSubpath;
  /** @type {string[]} */
  const candidates = [];
  try {
    if (fs.lstatSync(dartLink).isSymbolicLink()) {
      candidates.push(fs.realpathSync(dartLink));
    }
  } catch (_) {
    // Ignore missing symlink.
  }
  candidates.push(mainCheckout);

  const binName = process.platform === 'win32' ? 'dart.exe' : 'dart';
  for (const root of candidates) {
    const sdkDir = path.join(root, sdkSubpath);
    const dartBin = path.join(sdkDir, 'bin', binName);
    try {
      fs.accessSync(dartBin, fs.constants.X_OK);
      return sdkDir;
    } catch (_) {
      // Try next candidate.
    }
  }
  return undefined;
}

/**
 * Computes workspace settings (`window.title`, `dart.analysisExcludedFolders`,
 * and optionally `dart.sdkPath`) for a given checkout + subpaths.
 *
 * @param {string} checkoutName
 * @param {string[]} effectiveSubpaths
 * @param {{followDsSdk?: boolean, dartLink?: string, mainCheckout?: string, sdkSubpath?: string}} [opts]
 * @returns {Record<string, any>}
 */
function computeWorkspaceSettings(checkoutName, effectiveSubpaths, opts = {}) {
  const hasRoot = effectiveSubpaths.some((s) => !s);
  const scopeLabel =
    effectiveSubpaths.length === 0 || (effectiveSubpaths.length === 1 && !effectiveSubpaths[0])
      ? 'sdk'
      : effectiveSubpaths.map((s) => s || 'sdk').join(', ');

  /** @type {Record<string, any>} */
  const settings = {
    'window.title': `\${dirty}\${activeEditorShort}\${separator}[${checkoutName}] ${scopeLabel}`,
    'dart.analysisExcludedFolders': hasRoot ? ROOT_ANALYSIS_EXCLUDES : SUBPATH_ANALYSIS_EXCLUDES,
    'dart.analyzeAngularTemplates': false,
    'files.watcherExclude': {
      '**/out/**': true,
      '**/xcodebuild/**': true,
      '**/.dart_tool/**': true,
    },
  };

  if (opts.followDsSdk !== false) {
    const sdkDir = resolveBuiltDartSdkPath(opts);
    if (sdkDir) settings['dart.sdkPath'] = sdkDir;
  }
  return settings;
}

/**
 * Builds the full `.code-workspace` JSON object.
 *
 * @param {string} checkoutRoot
 * @param {string} checkoutName
 * @param {string[]} subpaths
 * @param {{followDsSdk?: boolean, existingSettings?: Record<string, any>, dartLink?: string, mainCheckout?: string, sdkSubpath?: string}} [opts]
 */
function buildWorkspaceConfig(checkoutRoot, checkoutName, subpaths, opts = {}) {
  const normalized = subpaths && subpaths.length > 0 ? subpaths : [''];
  /** @type {Array<{name: string, path: string}>} */
  const folders = [];
  /** @type {string[]} */
  const effectiveSubpaths = [];
  const seen = new Set();

  for (const sub of normalized) {
    const resolved = resolveMappedFolder(sub, checkoutRoot);
    if (seen.has(resolved.folderPath)) continue;
    seen.add(resolved.folderPath);
    effectiveSubpaths.push(resolved.effectiveSubpath);
    folders.push({
      name: formatFolderName(resolved.effectiveSubpath, checkoutName),
      path: resolved.folderPath,
    });
  }

  const computed = computeWorkspaceSettings(checkoutName, effectiveSubpaths, opts);
  const settings = Object.assign({}, opts.existingSettings || {}, computed);

  return { folders, settings };
}

/**
 * Reads `~/.local/state/nw/state.json`, or `null` if missing/corrupt.
 *
 * @param {string} [stateFile]
 * @returns {{name: string, checkout: string, subpaths?: string[], timestamp: number} | null}
 */
function readState(stateFile = STATE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Atomically writes `~/.local/state/nw/state.json`.
 *
 * @param {{name: string, checkout: string, subpaths?: string[], timestamp?: number}} next
 * @param {string} [stateFile]
 */
function writeState(next, stateFile = STATE_FILE) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    name: next.name,
    checkout: next.checkout,
    ...(next.subpaths ? { subpaths: next.subpaths } : {}),
    timestamp: next.timestamp || Date.now(),
  };
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, stateFile);
  return payload;
}

/**
 * Returns `true` if a live VS Code extension host process currently has
 * `active.code-workspace` open.
 *
 * @param {string} [lockFile]
 * @returns {boolean}
 */
function isManagedWorkspaceWindowAlive(lockFile = WINDOW_LOCK_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!data || typeof data.pid !== 'number') return false;
    process.kill(data.pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Updates `active.code-workspace` on disk (used when no live VS Code window has
 * `active.code-workspace` open yet). Preserves existing relative subpaths unless
 * `explicitSubpaths` is provided.
 *
 * @param {string} checkoutRoot
 * @param {string} checkoutName
 * @param {string[] | null} [explicitSubpaths]
 * @param {{workspacePath?: string, mainCheckout?: string, worktreesDir?: string, dartLink?: string, sdkSubpath?: string}} [opts]
 */
function syncWorkspaceFileOnDisk(checkoutRoot, checkoutName, explicitSubpaths = null, opts = {}) {
  const cfg = loadConfig();
  const wsPath = opts.workspacePath || cfg.activeWorkspacePath;
  /** @type {Record<string, any>} */
  let existingSettings = {};
  /** @type {string[]} */
  let existingSubpaths = [];
  /** @type {Array<{name?: string, path: string}>} */
  let nonSdkFolders = [];

  if (fs.existsSync(wsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      if (raw && typeof raw.settings === 'object' && raw.settings) {
        existingSettings = raw.settings;
      }
      if (raw && Array.isArray(raw.folders)) {
        const wsDir = path.dirname(wsPath);
        for (const f of raw.folders) {
          if (!f || typeof f.path !== 'string') continue;
          const abs = path.resolve(wsDir, f.path);
          const parsed = parseSdkPath(abs, opts);
          if (parsed) {
            existingSubpaths.push(parsed.relPath);
          } else {
            nonSdkFolders.push(f);
          }
        }
      }
    } catch (_) {
      // Overwrite malformed workspace file.
    }
  }

  const subpaths =
    explicitSubpaths && explicitSubpaths.length > 0
      ? explicitSubpaths
      : existingSubpaths.length > 0
        ? existingSubpaths
        : [''];

  const config = buildWorkspaceConfig(checkoutRoot, checkoutName, subpaths, {
    existingSettings,
    mainCheckout: opts.mainCheckout,
    dartLink: opts.dartLink,
    sdkSubpath: opts.sdkSubpath,
  });
  config.folders.push(...nonSdkFolders);

  fs.mkdirSync(path.dirname(wsPath), { recursive: true });
  const tmp = `${wsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, wsPath);
  return config;
}

module.exports = {
  HOME,
  MAIN_NAME,
  CONFIG_FILE,
  STATE_DIR,
  STATE_FILE,
  WINDOW_LOCK_FILE,
  ROOT_ANALYSIS_EXCLUDES,
  SUBPATH_ANALYSIS_EXCLUDES,
  parseConfigEnv,
  loadConfig,
  parseSdkPath,
  listCheckouts,
  describeCheckoutGit,
  resolveMappedFolder,
  formatFolderName,
  resolveBuiltDartSdkPath,
  computeWorkspaceSettings,
  buildWorkspaceConfig,
  readState,
  writeState,
  isManagedWorkspaceWindowAlive,
  syncWorkspaceFileOnDisk,
};
