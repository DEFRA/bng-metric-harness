"""Make `1. Copy baseline to post-intervention` fast and interruptible.

    python3 tools/speed_up_copy_action.py "<project>.qgz"

Already applied to templates/bng-service. Kept so it can be applied to a
working copy of the template that predates the change, including the live
master outside this repository. It expects the old body and stops without
writing if it does not find it, so running it twice is safe.


Measured on the 11 554 parcel test site, the action took 1 min 28 s with QGIS
frozen throughout. The same work headless takes 3.1 seconds, so the time was
never the data: it was 11 554 separate `addFeature` calls on an edit buffer,
each one telling a 55-layer project that a feature had arrived.

Three changes, in order of how much they matter:

  * write through the data provider in batches rather than one feature at a
    time through the edit buffer, so the project is told once per batch;
  * stop the canvas redrawing while the batch is written, and redraw once at
    the end;
  * show a modal progress dialog with a Cancel button, so the operation is
    visibly working and can be stopped.

Cancelling is safe. Batches already written stay written, and the action
skips anything already copied, so running it again carries on where it left
off.

A provider write has one cost, and the second half of this script pays it.
An open attribute table is built on a cache that only listens to the layer's
own `featureAdded` signal, which a provider write does not emit, so the table
shows nothing until it is closed and reopened. Nothing else refreshes it:
`reload`, `dataChanged`, `triggerRepaint`, `updateFields`, an empty edit
session, invalidating the cache and resetting the subset string were all
measured and all left the table empty. Emitting `featureAdded` for the rows
just written is what puts it back in step. It costs 4.7 s for 11 554 rows
when a table is open and 0.02 s when none is, because a signal with no
receivers is free.

The body is edited as text rather than regenerated, so the per-type lines in
each of the five copies (Baseline Length for the linear types, Category for
trees) survive untouched.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qgz_actions import read_project, replace_bodies, write_project

ACTION = "1. Copy baseline to post-intervention"

OLD_IMPORTS = """from qgis.core import QgsProject, QgsFeature, QgsGeometry
from qgis.utils import iface
import hashlib, json
"""
NEW_IMPORTS = """from qgis.core import (QgsProject, QgsFeature, QgsFeatureRequest,
                       QgsGeometry)
from qgis.PyQt.QtWidgets import QApplication, QProgressDialog
from qgis.utils import iface
import hashlib, json

# Features written per transaction. Large enough that the per-batch cost
# disappears, small enough that the progress bar moves and Cancel answers.
CHUNK = 1000
# parent_geom records the shape the row was cut from. The checksum beside it
# rounds to three decimals, so full precision doubles the text for nothing:
# 11.6 MB against 5.3 MB across this site.
WKT_DECIMALS = 3
"""

OLD_SCAN = """done_uuids = set()
done_refs = set()
for f in pi.getFeatures():
"""
NEW_SCAN = """done_uuids = set()
done_refs = set()
# Two columns, no geometry. Fetching everything would drag every parent_geom
# in the layer through Python for a membership test.
_scan = QgsFeatureRequest().setSubsetOfAttributes(
    ["parent_uuid", "Parent Ref"], pi.fields())
try:
    _scan.setFlags(QgsFeatureRequest.NoGeometry)
except AttributeError:
    pass
for f in pi.getFeatures(_scan):
"""

OLD_WKT = '            feat["parent_geom"] = src.geometry().asWkt()'
NEW_WKT = '            feat["parent_geom"] = src.geometry().asWkt(WKT_DECIMALS)'

OLD_OPEN = """    pi.startEditing()
    n = 0
    for src in todo:
        feat = QgsFeature(pi.fields())
"""
NEW_OPEN = """    def build_row(src):
        feat = QgsFeature(pi.fields())
"""

OLD_TAIL = """        pi.addFeature(feat)
        n += 1
    pi.commitChanges()
    msg = "Copied %d feature(s) into %s." % (n, PI)
    if skipped:
        msg += " %d already had a row and were left alone." % skipped
    iface.messageBar().pushSuccess("Copy baseline", msg)"""
NEW_TAIL = '''        return feat

    provider = pi.dataProvider()
    canvas = iface.mapCanvas()
    was_rendering = canvas.renderFlag()
    canvas.setRenderFlag(False)

    progress = QProgressDialog(
        "Copying %d feature(s) into %s..." % (len(todo), PI),
        "Cancel", 0, len(todo), iface.mainWindow())
    progress.setWindowTitle("Copy baseline")
    progress.setModal(True)
    progress.setAutoClose(False)
    progress.setAutoReset(False)
    progress.setMinimumDuration(0)
    progress.setValue(0)

    n = 0
    failed = 0
    cancelled = False
    batch = []

    def flush(rows):
        ok, _ = provider.addFeatures(rows)
        return len(rows) if ok else 0

    try:
        for src in todo:
            batch.append(build_row(src))
            if len(batch) >= CHUNK:
                written = flush(batch)
                n += written
                failed += len(batch) - written
                batch = []
                progress.setValue(n + failed)
                QApplication.processEvents()
                if progress.wasCanceled():
                    cancelled = True
                    break
        if batch and not cancelled:
            written = flush(batch)
            n += written
            failed += len(batch) - written
    finally:
        progress.close()
        pi.reload()
        pi.updateExtents()
        canvas.setRenderFlag(was_rendering)
        pi.triggerRepaint()

    msg = "Copied %d feature(s) into %s." % (n, PI)
    if skipped:
        msg += " %d already had a row and were left alone." % skipped
    if cancelled:
        iface.messageBar().pushWarning("Copy baseline", msg
            + " Cancelled. What was copied is saved, and running this again"
              " carries on from there.")
    elif failed:
        iface.messageBar().pushWarning("Copy baseline", msg
            + " %d could not be written." % failed)
    else:
        iface.messageBar().pushSuccess("Copy baseline", msg)'''

OLD_GUARD = """if not todo:
    iface.messageBar().pushSuccess("Copy baseline",
        "Every baseline feature already has a row in %s." % PI)
else:"""
NEW_GUARD = """if pi.isEditable():
    iface.messageBar().pushWarning("Copy baseline",
        "%s has unsaved edits. Save or discard them, then run this again."
        % PI)
elif not todo:
    iface.messageBar().pushSuccess("Copy baseline",
        "Every baseline feature already has a row in %s." % PI)
else:"""

SWAPS = [
    (OLD_IMPORTS, NEW_IMPORTS),
    (OLD_SCAN, NEW_SCAN),
    (OLD_WKT, NEW_WKT),
    (OLD_GUARD, NEW_GUARD),
    (OLD_OPEN, NEW_OPEN),
    (OLD_TAIL, NEW_TAIL),
]

# Keeping an open attribute table in step. Applied on its own to a project
# that already has the batched body, and after SWAPS to one that does not.
OLD_FLUSH = """    def flush(rows):
        ok, _ = provider.addFeatures(rows)
        return len(rows) if ok else 0
"""
NEW_FLUSH = """    # The ids the provider hands back, so an open attribute table can be
    # told which rows arrived.
    added_ids = []

    def flush(rows):
        ok, written = provider.addFeatures(rows)
        if not ok:
            return 0
        added_ids.extend(f.id() for f in written)
        return len(written)
"""

OLD_FINALLY = """    finally:
        progress.close()
        pi.reload()
        pi.updateExtents()
        canvas.setRenderFlag(was_rendering)
        pi.triggerRepaint()
"""
NEW_FINALLY = """    finally:
        # Rows written through the provider do not reach an open attribute
        # table. It is built on a cache that listens to the layer's own
        # featureAdded signal, and a provider write never emits one, so the
        # table stays empty until it is closed and opened again. Emitting the
        # signal here is what keeps it in step; with no table open there are
        # no receivers and the loop costs nothing.
        if added_ids:
            progress.setLabelText("Updating the table view...")
            QApplication.processEvents()
            pi.reload()
            for fid in added_ids:
                pi.featureAdded.emit(fid)
        progress.close()
        pi.updateExtents()
        canvas.setRenderFlag(was_rendering)
        pi.triggerRepaint()
"""

TABLE_SWAPS = [(OLD_FLUSH, NEW_FLUSH), (OLD_FINALLY, NEW_FINALLY)]


def apply_swaps(body, swaps):
    for before, after in swaps:
        if body.count(before) != 1:
            raise SystemExit(
                f"expected exactly one occurrence of:\n{before[:120]}\n"
                f"found {body.count(before)}")
        body = body.replace(before, after)
    return body


def rewrite(old):
    """Bring a body up to date from whichever version it is on."""
    body = old
    if "QProgressDialog" not in body:
        body = apply_swaps(body, SWAPS)
    if "added_ids" not in body:
        body = apply_swaps(body, TABLE_SWAPS)
    if body == old:
        raise SystemExit("already up to date; nothing to do")
    compile(body, "action", "exec")           # syntax, before it reaches QGIS
    return body


def main(path):
    qgs, payload = read_project(path)
    xml = payload[qgs].decode("utf-8")
    xml, count = replace_bodies(xml, ACTION, rewrite)
    if count != 5:
        raise SystemExit(f"expected 5 copy actions, rewrote {count}")
    backup = write_project(path, qgs, payload, xml)
    print(f"rewrote {count} copies of '{ACTION}' in {path}")
    print(f"backup at {backup}")


if __name__ == "__main__":
    main(sys.argv[1])
