#!/usr/bin/env python3
"""Fill a copy of the BNG Service template with an NSIP-scale synthetic site.

The site is a 56 km subsection of a new rail line between Handsacre in
Staffordshire and Crewe, about 31.8 square kilometres of land take, with more
than eleven thousand baseline habitat parcels plus hedgerows, watercourses and
individual trees, and a post-intervention state for all four.

Run it with no arguments. It writes into
hs2-phase2a-subsection/Layers/BNG Service Layers.gpkg, replacing whatever that
file holds.
"""

import os
import shutil
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# gpkg_common sits at the root of this repository; it owns the canonical
# geometry checksum the template stamps onto every post-intervention row.
sys.path.insert(0, os.path.join(HERE, '..'))

from gpkg_common import (register_spatial_functions,                   # noqa: E402
                         update_layer_extent)
from corridor_mesh import CorridorMesh                                 # noqa: E402
from corridor_writers import (write_area_habitats, write_hedgerows,    # noqa: E402
                              write_redline, write_trees,
                              write_watercourses)

# The template this site is built in, and the working copy of it that the
# site lives in. The working copy is generated, not committed: it is 32 MB of
# data this script rebuilds in seven seconds.
TEMPLATE_DIR = os.path.join(HERE, '..', 'templates', 'bng-service')
WORKING_DIR = os.path.join(HERE, 'hs2-phase2a-subsection')
TARGET = os.path.join(WORKING_DIR, 'Layers', 'BNG Service Layers.gpkg')
# Copying the pristine file over the target each run means it starts with no
# page history, so two runs produce identical bytes.
PRISTINE = os.path.join(TEMPLATE_DIR, 'Layers', 'BNG Service Layers.gpkg')



# Everything in the working copy except the data: refreshed from the template
# on every run, so a change to the QGIS project or the reference lists reaches
# an existing working copy instead of only a newly created one.
TEMPLATE_ASSETS = ('BNG Service Habitat Mapping.qgz', 'CSV References',
                   'HOW TO USE THIS TEMPLATE.md')


def ensure_working_copy():
    """Create or refresh the working copy of the template.

    The whole folder is generated, so there is nothing here worth preserving
    against the template: the data lives in the GeoPackage, which is written
    fresh below.
    """
    if not os.path.isdir(WORKING_DIR):
        print(f'creating the working copy from {TEMPLATE_DIR}')
        shutil.copytree(TEMPLATE_DIR, WORKING_DIR)
        return
    for name in TEMPLATE_ASSETS:
        source = os.path.join(TEMPLATE_DIR, name)
        target = os.path.join(WORKING_DIR, name)
        if not os.path.exists(source):
            continue
        if os.path.isdir(source):
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)


def main():
    ensure_working_copy()
    mesh = CorridorMesh()
    print(f'route {mesh.route_length_m / 1000:.1f} km, '
          f'{mesh.stations} stations x {mesh.lanes} lanes')

    # Build into a scratch file and move it into place at the end. Writing
    # over the target directly destroys it before the first insert, which
    # loses the previous run's file if anything then fails -- and something
    # will: QGIS holds a lock on a project it has open, and the whole point of
    # this file is that someone opens it in QGIS.
    building = TARGET + '.building'
    shutil.copyfile(PRISTINE, building)
    conn = sqlite3.connect(building)
    register_spatial_functions(conn)
    conn.execute('PRAGMA journal_mode = MEMORY')
    conn.execute('PRAGMA synchronous = OFF')

    totals = {}
    totals['areas'] = write_area_habitats(conn, mesh)
    totals['hedgerows'] = write_hedgerows(conn, mesh)
    totals['watercourses'] = write_watercourses(conn, mesh)
    totals['trees'] = write_trees(conn, mesh)
    totals['redline'] = write_redline(conn, mesh)

    for table in ['Habitats Baseline', 'Habitats Post-Intervention',
                  'Hedgerows Baseline', 'Hedgerows Post-Intervention',
                  'Watercourses Baseline', 'Watercourses Post-Intervention',
                  'Trees Baseline', 'Trees Post-Intervention',
                  'Red Line Boundary']:
        update_layer_extent(conn, table, 'geom')
    conn.commit()
    conn.execute('VACUUM')
    conn.close()
    os.replace(building, TARGET)

    print()
    for name, counts in totals.items():
        print(f'{name:14s} {counts}')
    size = os.path.getsize(TARGET) / (1024 * 1024)
    print(f'\nwritten {TARGET}  ({size:.1f} MB)')


if __name__ == '__main__':
    main()
