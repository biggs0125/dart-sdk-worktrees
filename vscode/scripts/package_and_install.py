#!/usr/bin/env python3
"""Packages nw-worktrees into a .vsix and installs it into VS Code / Remote-SSH /
Cursor / Jetski extension directories without requiring npm or vsce."""

import argparse
import glob
import json
import os
import shutil
import subprocess
import time
import zipfile

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG_JSON_PATH = os.path.join(ROOT_DIR, 'package.json')
EXTENSION_DIRS = [
    '~/.vscode/extensions',
    '~/.vscode-server/extensions',
    '~/.cursor/extensions',
    '~/.jetski/extensions',
]

CONTENT_TYPES_XML = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""

VSIX_MANIFEST_TEMPLATE = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}"/>
    <DisplayName>{displayName}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>Other,SCM Providers</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def runtime_files() -> list[str]:
  """Files the extension needs at runtime (tests and build scripts excluded)."""
  patterns = ['package.json', 'README.md', 'src/**/*.js']
  files = []
  for pattern in patterns:
    files.extend(glob.glob(os.path.join(ROOT_DIR, pattern), recursive=True))
  return sorted(os.path.relpath(f, ROOT_DIR) for f in files if os.path.isfile(f))


def build_vsix(pkg: dict) -> str:
  vsix_path = os.path.join(ROOT_DIR, f"{pkg['name']}-{pkg['version']}.vsix")
  manifest = VSIX_MANIFEST_TEMPLATE.format(
      name=pkg['name'],
      version=pkg['version'],
      publisher=pkg['publisher'],
      displayName=pkg['displayName'],
      description=pkg['description'],
      engine=pkg['engines']['vscode'],
  )
  with zipfile.ZipFile(vsix_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('[Content_Types].xml', CONTENT_TYPES_XML.strip())
    zf.writestr('extension.vsixmanifest', manifest.strip())
    for rel in runtime_files():
      zf.write(os.path.join(ROOT_DIR, rel), f'extension/{rel}')
  return vsix_path


def remove_path(path: str) -> None:
  if os.path.islink(path) or os.path.isfile(path):
    os.unlink(path)
  elif os.path.isdir(path):
    shutil.rmtree(path)


def install_into_extensions_dir(ext_root: str, pkg: dict) -> bool:
  ext_root = os.path.expanduser(ext_root)
  if not os.path.exists(ext_root):
    return False

  ext_id = f"{pkg['publisher']}.{pkg['name']}"
  folder_name = f"{ext_id}-{pkg['version']}"
  target_dir = os.path.join(ext_root, folder_name)

  for old in glob.glob(os.path.join(ext_root, f'{ext_id}-*')):
    remove_path(old)

  for rel in runtime_files():
    dest = os.path.join(target_dir, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(os.path.join(ROOT_DIR, rel), dest)

  ext_json_path = os.path.join(ext_root, 'extensions.json')
  entries = []
  if os.path.exists(ext_json_path):
    try:
      with open(ext_json_path, 'r', encoding='utf-8') as fp:
        entries = json.load(fp)
    except (OSError, ValueError):
      entries = []

  entries = [
      e
      for e in entries
      if e.get('identifier', {}).get('id', '').lower() != ext_id.lower()
  ]
  entries.append({
      'identifier': {'id': ext_id},
      'version': pkg['version'],
      'location': {
          '$mid': 1,
          'fsPath': target_dir,
          'external': f'file://{target_dir}',
          'path': target_dir,
          'scheme': 'file',
      },
      'relativeLocation': folder_name,
      'metadata': {
          'isApplicationScoped': False,
          'isMachineScoped': False,
          'isBuiltin': False,
          'installedTimestamp': int(time.time() * 1000),
          'pinned': False,
          'source': 'vsix',
      },
  })
  with open(ext_json_path, 'w', encoding='utf-8') as fp:
    json.dump(entries, fp)
  print(f'Installed {ext_id} {pkg["version"]} into {target_dir}')
  return True


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
      '--vsix-only',
      action='store_true',
      help='Only build the .vsix file without installing into extension dirs.',
  )
  args = parser.parse_args()

  with open(PKG_JSON_PATH, 'r', encoding='utf-8') as fp:
    pkg = json.load(fp)
  vsix_path = build_vsix(pkg)
  print(f'Packaged VSIX: {vsix_path}')
  if args.vsix_only:
    return

  installed_any = False
  for ext_dir in EXTENSION_DIRS:
    if install_into_extensions_dir(ext_dir, pkg):
      installed_any = True

  if not installed_any:
    code_bin = shutil.which(os.environ.get('DART_CODE_CMD', 'code'))
    if code_bin:
      res = subprocess.run(
          [code_bin, '--install-extension', vsix_path, '--force'],
          capture_output=True,
          text=True,
          check=False,
      )
      if res.returncode == 0:
        print(f'Installed via {code_bin}: {vsix_path}')
        installed_any = True
    if not installed_any:
      print(
          'No VS Code/Cursor/Jetski extension directory found yet; '
          f'install {vsix_path} via "Extensions: Install from VSIX..." when ready.'
      )


if __name__ == '__main__':
  main()
