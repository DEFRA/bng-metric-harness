#!/usr/bin/env python3
"""
Package the QGIS plugin into an installable .zip.

The conversion logic lives in the three modules at the repository root so it can
also be run from a command line. They are copied into the plugin package at
build time, keeping one source of truth rather than two drifting copies.

    python3 build_plugin.py            ->  dist/bng_template_convert.zip
"""

import os
import shutil
import sys
import zipfile

PACKAGE = "bng_template_convert"
DIST_DIR = "dist"
SHARED_MODULES = ("gpkg_common.py", "new_to_old.py", "old_to_new.py",
                  "to_metric.py")
PLUGIN_FILES = (
    "__init__.py",
    "metadata.txt",
    "plugin.py",
    "provider.py",
    "algorithms.py",
    "icon.svg",
)


def build(root):
    package_dir = os.path.join(root, PACKAGE)
    for name in SHARED_MODULES:
        shutil.copy2(os.path.join(root, name), os.path.join(package_dir, name))

    dist = os.path.join(root, DIST_DIR)
    os.makedirs(dist, exist_ok=True)
    archive = os.path.join(dist, f"{PACKAGE}.zip")
    if os.path.exists(archive):
        os.remove(archive)

    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in PLUGIN_FILES + SHARED_MODULES:
            source = os.path.join(package_dir, name)
            if not os.path.exists(source):
                raise SystemExit(f"missing plugin file: {source}")
            bundle.write(source, os.path.join(PACKAGE, name))

    size_kb = os.path.getsize(archive) / 1024
    print(f"built {archive} ({size_kb:.0f} KB)")
    print(
        "install in QGIS: Plugins > Manage and Install Plugins… > Install from ZIP"
    )
    return archive


if __name__ == "__main__":
    sys.exit(0 if build(os.path.dirname(os.path.abspath(__file__))) else 1)
