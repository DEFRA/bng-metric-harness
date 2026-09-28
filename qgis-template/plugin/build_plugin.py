#!/usr/bin/env python3
"""
Package the QGIS plugin into an installable .zip.

Everything the plugin needs lives in the package folder beside this script,
so building is a straight zip of that folder. The four conversion modules in
it are plain Python with no QGIS imports, which is why they also run from a
command line without the plugin being installed.

    python3 build_plugin.py            ->  dist/bng_template_convert.zip
"""

import os
import sys
import zipfile

PACKAGE = "bng_template_convert"
DIST_DIR = "dist"
DOCS = ("README.md",)
PLUGIN_FILES = (
    "__init__.py",
    "metadata.txt",
    "plugin.py",
    "provider.py",
    "algorithms.py",
    "icon.svg",
    "gpkg_common.py",
    "new_to_old.py",
    "old_to_new.py",
    "to_metric.py",
)


def build(root):
    package_dir = os.path.join(root, PACKAGE)
    dist = os.path.join(root, DIST_DIR)
    os.makedirs(dist, exist_ok=True)
    archive = os.path.join(dist, f"{PACKAGE}.zip")
    if os.path.exists(archive):
        os.remove(archive)

    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in PLUGIN_FILES:
            source = os.path.join(package_dir, name)
            if not os.path.exists(source):
                raise SystemExit(f"missing plugin file: {source}")
            bundle.write(source, os.path.join(PACKAGE, name))
        # The instructions travel with the plugin, so a copy passed on by
        # itself still says what it needs and how to install it.
        for name in DOCS:
            source = os.path.join(root, name)
            if os.path.exists(source):
                bundle.write(source, os.path.join(PACKAGE, name))

    size_kb = os.path.getsize(archive) / 1024
    print(f"built {archive} ({size_kb:.0f} KB)")
    print(
        "install in QGIS: Plugins > Manage and Install Plugins… > Install from ZIP"
    )
    return archive


if __name__ == "__main__":
    sys.exit(0 if build(os.path.dirname(os.path.abspath(__file__))) else 1)
