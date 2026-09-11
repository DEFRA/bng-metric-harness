#!/usr/bin/env python3
"""
Convert a pair of legacy Natural England GeoPackages into a single BNG Service
(staged) GeoPackage for the new template.

    old template   2 files, one table per habitat type, uploaded separately
                     |
                     v
    new template   1 file,  Baseline + Post-Intervention tables per habitat type

This is the harder direction: the legacy format never recorded which baseline
feature a post-intervention feature came from, so lineage has to be rebuilt.
The script stamps only what it can prove — a post-intervention row whose
reference matches a baseline row — and deliberately leaves everything else
unstamped so the service resolves it by area-weighted geometry overlap and
warns, rather than this script guessing with cruder maths and staying silent.

Zero dependencies: Python 3.8+, no GDAL, no QGIS, no network. Input files are
never modified.

Usage:
    python3 old_to_new.py --baseline BASE.gpkg --post-intervention PI.gpkg -o out/
    python3 old_to_new.py --baseline BASE.gpkg --dry-run

See README.md for the full walkthrough and what needs checking afterwards.
"""

import argparse
import os
import re
import sqlite3
import struct
import sys
import uuid
from collections import defaultdict

# Works both as a standalone script and as a module inside the QGIS
# plugin package, where the import has to be relative.
try:
    from .gpkg_common import (
        blob_checksum,
        create_feature_table,
        create_gpkg_system_tables,
        demote_multipolygon_blob_to_polygon,
        feature_table_names,
        line_blob_length_m,
        numeric,
        polygon_blob_area_sqm,
        quote_ident,
        quoted_names,
        read_feature_table,
        read_only_uri,
        read_srs_rows,
        register_spatial_functions,
        resolve_table_name,
        sq_metres_to_hectares,
        update_layer_extent,
    )
except ImportError:  # pragma: no cover - running as a plain script
    from gpkg_common import (
        blob_checksum,
        create_feature_table,
        create_gpkg_system_tables,
        demote_multipolygon_blob_to_polygon,
        feature_table_names,
        line_blob_length_m,
        numeric,
        polygon_blob_area_sqm,
        quote_ident,
        quoted_names,
        read_feature_table,
        read_only_uri,
        read_srs_rows,
        register_spatial_functions,
        resolve_table_name,
        sq_metres_to_hectares,
        update_layer_extent,
    )

# ---------------------------------------------------------------------------
# New-template schema — mirrors Layers/BNG Service Layers.gpkg exactly, so the
# output can replace that file inside a copy of the template project.
# ---------------------------------------------------------------------------

BASELINE_TAIL = [("Comment", "TEXT"), ("feature_uuid", "TEXT")]
PI_TAIL = [("parent_uuid", "TEXT"), ("parent_checksum", "TEXT")]
AREA_BASELINE_HEAD = [
    ("Parcel Ref", "TEXT"),
    ("Baseline Broad Habitat Type", "TEXT"),
    ("Baseline Habitat Type", "TEXT"),
    ("Baseline Distinctiveness", "TEXT"),
    ("Baseline Condition", "TEXT"),
    ("Baseline Strategic Significance", "TEXT"),
    ("Irreplaceable Habitat", "TEXT"),
    ("Area", "REAL"),
]
AREA_PI_HEAD = [
    ("PI Ref", "TEXT"),
    ("Parent Ref", "TEXT"),
    ("Baseline Broad Habitat Type", "TEXT"),
    ("Baseline Habitat Type", "TEXT"),
    ("Baseline Distinctiveness", "TEXT"),
    ("Baseline Condition", "TEXT"),
    ("Baseline Strategic Significance", "TEXT"),
    ("Irreplaceable Habitat", "TEXT"),
    ("Retention Category", "TEXT"),
    ("Proposed Broad Habitat Type", "TEXT"),
    ("Proposed Habitat Type", "TEXT"),
    ("Proposed Distinctiveness", "TEXT"),
    ("Proposed Condition", "TEXT"),
    ("Proposed Strategic Significance", "TEXT"),
    ("Habitat created in advance/years", "TEXT"),
    ("Delay in starting habitat creation/years", "TEXT"),
    ("Spatial risk category", "TEXT"),
    ("Area", "REAL"),
]

STAGED_LAYERS = {
    "Red Line Boundary": {
        "geom_column": "geom",
        "geom_type": "POLYGON",
        "columns": [
            ("Site Name", "TEXT"),
            ("Location", "TEXT"),
            ("Survey Date", "DATE"),
            ("Survey Details", "TEXT"),
            ("Mapped by", "TEXT"),
            ("Company", "TEXT"),
            ("Base Map", "TEXT"),
        ],
    },
    "Habitats Baseline": {
        "geom_column": "geom",
        "geom_type": "POLYGON",
        "columns": AREA_BASELINE_HEAD + BASELINE_TAIL,
    },
    "Habitats Post-Intervention": {
        "geom_column": "geom",
        "geom_type": "POLYGON",
        "columns": AREA_PI_HEAD + PI_TAIL,
    },
    "Vertical Area Habitats Baseline": {
        "geom_column": "geom",
        "geom_type": "LINESTRING",
        "columns": AREA_BASELINE_HEAD + BASELINE_TAIL,
    },
    "Vertical Area Habitats Post-Intervention": {
        "geom_column": "geom",
        "geom_type": "LINESTRING",
        "columns": AREA_PI_HEAD + PI_TAIL,
    },
    "Hedgerows Baseline": {
        "geom_column": "geom",
        "geom_type": "LINESTRING",
        "columns": [
            ("Parcel Ref", "TEXT"),
            ("Baseline Hedge Type", "TEXT"),
            ("Baseline Distinctiveness", "TEXT"),
            ("Baseline Condition", "TEXT"),
            ("Baseline Strategic Significance", "TEXT"),
            ("Length", "REAL"),
        ]
        + BASELINE_TAIL,
    },
    "Hedgerows Post-Intervention": {
        "geom_column": "geom",
        "geom_type": "LINESTRING",
        "columns": [
            ("PI Ref", "TEXT"),
            ("Parent Ref", "TEXT"),
            ("Baseline Hedge Type", "TEXT"),
            ("Baseline Distinctiveness", "TEXT"),
            ("Baseline Condition", "TEXT"),
            ("Baseline Strategic Significance", "TEXT"),
            ("Baseline Length", "REAL"),
            ("Retention Category", "TEXT"),
            ("Proposed Hedge Type", "TEXT"),
            ("Proposed Distinctiveness", "TEXT"),
            ("Proposed Condition", "TEXT"),
            ("Proposed Strategic Significance", "TEXT"),
            ("Habitat created in advance/years", "TEXT"),
            ("Delay in starting habitat creation/years", "TEXT"),
            ("Spatial risk category", "TEXT"),
            ("Length", "REAL"),
        ]
        + PI_TAIL,
    },
    "Watercourses Baseline": {
        "geom_column": "geom",
        "geom_type": "LINESTRING",
        "columns": [
            ("Parcel Ref", "TEXT"),
            ("Baseline River Type", "TEXT"),
            ("Baseline Distinctiveness", "TEXT"),
            ("Baseline Condition", "TEXT"),
            ("Baseline Strategic Significance", "TEXT"),
            ("Baseline Encroachment into Watercourse", "TEXT"),
            ("Baseline Encroachment into riparian zone", "TEXT"),
            ("Length", "REAL"),
        ]
        + BASELINE_TAIL,
    },
    "Watercourses Post-Intervention": {
        "geom_column": "geom",
        "geom_type": "LINESTRING",
        "columns": [
            ("PI Ref", "TEXT"),
            ("Parent Ref", "TEXT"),
            ("Baseline River Type", "TEXT"),
            ("Baseline Distinctiveness", "TEXT"),
            ("Baseline Condition", "TEXT"),
            ("Baseline Strategic Significance", "TEXT"),
            ("Baseline Encroachment into Watercourse", "TEXT"),
            ("Baseline Encroachment into riparian zone", "TEXT"),
            ("Baseline Length", "REAL"),
            ("Retention Category", "TEXT"),
            ("Proposed River Type", "TEXT"),
            ("Proposed Distinctiveness", "TEXT"),
            ("Proposed Condition", "TEXT"),
            ("Proposed Strategic Significance", "TEXT"),
            ("Proposed Encroachment into Watercourse", "TEXT"),
            ("Proposed Encroachment into riparian zone", "TEXT"),
            ("Enhancement Type", "TEXT"),
            ("Habitat created in advance/years", "TEXT"),
            ("Delay in starting habitat creation/years", "TEXT"),
            ("Spatial risk category", "TEXT"),
            ("Length", "REAL"),
        ]
        + PI_TAIL,
    },
    "Trees Baseline": {
        "geom_column": "geom",
        "geom_type": "POINT",
        "columns": [
            ("Tree Ref", "TEXT"),
            ("Baseline Tree Size", "TEXT"),
            ("Baseline Tree Type", "TEXT"),
            ("Baseline Rural or Urban Tree", "TEXT"),
            ("Baseline Condition", "TEXT"),
            ("Baseline Strategic Significance", "TEXT"),
            ("Count", "MEDIUMINT"),
        ]
        + BASELINE_TAIL,
    },
    "Trees Post-Intervention": {
        "geom_column": "geom",
        "geom_type": "POINT",
        "columns": [
            ("PI Ref", "TEXT"),
            ("Parent Ref", "TEXT"),
            ("Baseline Tree Size", "TEXT"),
            ("Baseline Tree Type", "TEXT"),
            ("Baseline Rural or Urban Tree", "TEXT"),
            ("Baseline Condition", "TEXT"),
            ("Baseline Strategic Significance", "TEXT"),
            ("Retention Category", "TEXT"),
            ("Proposed Tree Size", "TEXT"),
            ("Proposed Tree Type", "TEXT"),
            ("Proposed Rural or Urban Tree", "TEXT"),
            ("Proposed Condition", "TEXT"),
            ("Proposed Strategic Significance", "TEXT"),
            ("Category", "TEXT"),
            ("Habitat Created/Enhanced in advance/years", "TEXT"),
            ("Delay in starting habitat creation/enhancement in years", "TEXT"),
            ("Spatial risk category", "TEXT"),
            ("Count", "MEDIUMINT"),
        ]
        + PI_TAIL,
    },
}

# Two staged layers are being renamed in the QGIS template — "Habitats *" to
# "Area Habitats *" and "Trees *" to "Individual Trees *". The keys above stay
# the OLD names because that is what the shipped template still ships, and what
# a fresh conversion must keep producing; these are the other spellings a
# template being filled with --into may carry instead. Newest name first, and
# matched by EXACT name (see resolve_table_name), so "Habitats Baseline" can
# never resolve to the table it is a substring of, "Vertical Area Habitats
# Baseline".
STAGED_TABLE_ALIASES = {
    "Habitats Baseline": ("Area Habitats Baseline",),
    "Habitats Post-Intervention": ("Area Habitats Post-Intervention",),
    "Trees Baseline": ("Individual Trees Baseline",),
    "Trees Post-Intervention": ("Individual Trees Post-Intervention",),
}

# The layers holding area habitats. Named explicitly rather than matched on the
# word "Habitats", which is also a substring of "Vertical Area Habitats *".
AREA_HABITAT_LAYERS = ("Habitats Baseline", "Habitats Post-Intervention")


def staged_table_candidates(layer):
    """Every accepted spelling of a staged table, most-preferred first."""
    return STAGED_TABLE_ALIASES.get(layer, ()) + (layer,)


LEGACY_REDLINE = "Red Line Boundary"
LEGACY_MEANDERS = "Water course enhancement through meanders"

# Retention categories, legacy -> new.
#
# The new template dropped "Lost": removal is recorded by simply leaving the
# feature out. Area habitats are the exception — every square metre inside the
# red line has to be accounted for, and the Statutory Metric treats built-over
# ground as *creating* the new surface, so a lost parcel becomes "Created".
RETENTION_CREATED = "Created"
RETENTION_LOST = "Lost"
CONTINUING_CATEGORIES = ("Retained", "Enhanced")
MEANDER_ENHANCEMENT_TYPE = "Meanders"
TREE_CATEGORY_EXISTING = "Existing"

SITE_DETAIL_FIELDS = [
    "Site Name",
    "Location",
    "Survey Date",
    "Survey Details",
    "Mapped by",
    "Company",
    "Base Map",
]

ALPHABET_SIZE = 26


class Report:
    def __init__(self):
        self.lines = []
        self.warnings = []
        self.counts = {}

    def note(self, message):
        self.lines.append(message)

    def warn(self, message):
        self.warnings.append(message)

    def count(self, key, value):
        self.counts[key] = value


# ---------------------------------------------------------------------------
# Baseline index — the lineage the legacy format never recorded
# ---------------------------------------------------------------------------


class BaselineIndex:
    """Baseline features keyed by reference, with the stamps a child needs."""

    def __init__(self):
        self._by_ref = {}

    def add(self, ref, feature_uuid, checksum, size):
        if ref is None or ref == "":
            return
        # A duplicated baseline ref is ambiguous; the first wins and the
        # caller reports it, because guessing between them would be worse.
        self._by_ref.setdefault(
            ref, {"uuid": feature_uuid, "checksum": checksum, "size": size}
        )

    def get(self, ref):
        return self._by_ref.get(ref)

    def refs(self):
        return set(self._by_ref)


def new_uuid():
    """Match the template's uuid('WithoutBraces') default."""
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Reading the legacy pair
# ---------------------------------------------------------------------------


def read_legacy(path):
    """Read every layer of a legacy GeoPackage we know how to carry over."""
    conn = sqlite3.connect(read_only_uri(path), uri=True)
    try:
        return {
            "redline": read_feature_table(conn, LEGACY_REDLINE),
            "areas": read_feature_table(conn, "Habitats"),
            "hedgerows": read_feature_table(conn, "Hedgerows"),
            "watercourses": read_feature_table(conn, "Rivers"),
            "trees": read_feature_table(conn, "Urban Trees"),
            "meanders": read_feature_table(conn, LEGACY_MEANDERS),
            "srs": read_srs_rows(conn),
        }
    finally:
        conn.close()


def site_details(legacy):
    """Collapse the site details legacy repeats on every row into one record.

    Takes the first non-empty value seen for each field, so a partly-filled
    layer does not blank out a field another layer has.
    """
    details = {field: None for field in SITE_DETAIL_FIELDS}
    sources = ["redline", "areas", "hedgerows", "watercourses", "trees"]
    for key in sources:
        for row in legacy.get(key, []):
            for field in SITE_DETAIL_FIELDS:
                if details[field] in (None, "") and row.get(field) not in (None, ""):
                    details[field] = row.get(field)
    return details


# ---------------------------------------------------------------------------
# Reference handling
# ---------------------------------------------------------------------------


BREADCRUMB_PARENT = re.compile(r"\[parent=([^\];]+)\]")
BREADCRUMB_PI = re.compile(r"\[pi=([^\];]+)\]")


def read_breadcrumbs(rows):
    """Recover lineage from the breadcrumbs new_to_old.py --carry-lineage left.

    Converting to the legacy format has to discard the parent link; that flag
    parks it in the Comment column, which the legacy service ignores. Reading it
    back turns a round trip into an exact restoration rather than a re-guess.
    """
    found = 0
    for row in rows:
        comment = row.get("Comment") or row.get("Comments") or ""
        parent = BREADCRUMB_PARENT.search(str(comment))
        own = BREADCRUMB_PI.search(str(comment))
        if parent:
            row["_parent_ref"] = parent.group(1).strip()
            found += 1
        if own:
            row["_pi_ref"] = own.group(1).strip()
            found += 1
    return found


def drop_lost_rows(rows, ref_key, label, report):
    """Remove legacy 'Lost' rows — the new template records removal by absence.

    Done before references are made unique so a feature that merely outlived a
    sibling is not renamed for nothing.
    """
    kept = [row for row in rows if row.get("Retention Category") != RETENTION_LOST]
    dropped = [
        row.get(ref_key)
        for row in rows
        if row.get("Retention Category") == RETENTION_LOST
    ]
    if dropped:
        listed = ", ".join(str(ref) for ref in dropped)
        report.note(
            f"{label}: dropped {len(dropped)} 'Lost' row(s) ({listed}) — the new "
            "template records removal by leaving the feature out"
        )
    return kept


def unique_pi_refs(rows, ref_key, report, label):
    """Give post-intervention rows distinct PI Refs, the way the template does.

    Legacy allows several post-intervention rows to share one reference (its
    only way of saying "part of this feature became X and part became Y"). The
    new template gives each its own PI Ref and records the shared origin in
    Parent Ref instead.
    """
    occurrences = defaultdict(list)
    for row in rows:
        if row.get("_pi_ref"):
            continue  # already recovered from a breadcrumb
        occurrences[row.get(ref_key)].append(row)

    taken = {ref for ref, items in occurrences.items() if len(items) == 1}
    renamed_groups = []
    for ref, items in occurrences.items():
        if ref in (None, "") or len(items) == 1:
            continue
        names = []
        for index, row in enumerate(items):
            candidate = _next_free_ref(ref, index, taken)
            taken.add(candidate)
            row["_pi_ref"] = candidate
            names.append(candidate)
        renamed_groups.append((ref, names))

    for row in rows:
        row.setdefault("_pi_ref", row.get(ref_key))

    for ref, names in renamed_groups:
        report.note(
            f"{label}: '{ref}' appeared {len(names)} times — post-intervention "
            f"refs set to {', '.join(names)}, all with Parent Ref '{ref}'"
        )


def _next_free_ref(ref, index, taken):
    attempt = index
    while True:
        suffix = chr(ord("a") + attempt % ALPHABET_SIZE)
        cycle = attempt // ALPHABET_SIZE
        candidate = f"{ref}{suffix}" if cycle == 0 else f"{ref}{suffix}{cycle}"
        if candidate not in taken:
            return candidate
        attempt += 1


def stamp_parent(values, parent_ref, index, report_unmatched):
    """Attach the lineage stamps for a resolved parent, if there is one.

    Returns True when the row was stamped. An unmatched continuing row is left
    entirely unstamped on purpose: the service then resolves it by area-weighted
    overlap and raises a "parent inferred" warning the user can see and check.
    """
    parent = index.get(parent_ref) if parent_ref else None
    if parent is None:
        if parent_ref:
            report_unmatched.append(parent_ref)
        return False
    values["Parent Ref"] = parent_ref
    values["parent_uuid"] = parent["uuid"]
    values["parent_checksum"] = parent["checksum"]
    return True


# ---------------------------------------------------------------------------
# Row mapping — baseline
# ---------------------------------------------------------------------------


def build_area_baseline(rows, report):
    """Baseline area habitats, with a fresh uuid and geometry checksum each."""
    index = BaselineIndex()
    out = []
    multipart = 0
    duplicate_refs = _duplicate_refs(rows, "Parcel Ref")
    for row in rows:
        blob = row.get("_geom")
        if blob is not None:
            blob, was_multipart = demote_multipolygon_blob_to_polygon(blob)
            multipart += 1 if was_multipart else 0
        feature_uuid = new_uuid()
        # legacy stores square metres; the new template's column is hectares
        area = sq_metres_to_hectares(row.get("Area"))
        if area is None and blob is not None:
            area = sq_metres_to_hectares(polygon_blob_area_sqm(blob))
        index.add(row.get("Parcel Ref"), feature_uuid, blob_checksum(blob), area)
        out.append(
            (
                blob,
                {
                    "Parcel Ref": row.get("Parcel Ref"),
                    "Baseline Broad Habitat Type": row.get(
                        "Baseline Broad Habitat Type"
                    ),
                    "Baseline Habitat Type": row.get("Baseline Habitat Type"),
                    "Baseline Distinctiveness": row.get("Baseline Distinctiveness"),
                    "Baseline Condition": row.get("Baseline Condition"),
                    "Baseline Strategic Significance": row.get(
                        "Baseline Strategic Significance"
                    ),
                    "Area": area,
                    "Comment": row.get("Comment"),
                    "feature_uuid": feature_uuid,
                },
            )
        )
    if multipart:
        report.warn(
            f"{multipart} baseline area habitat(s) are multi-part polygons. The new "
            "template expects one polygon per feature — split them in QGIS "
            "(Edit > Multipart to singleparts) before uploading."
        )
    _report_duplicate_baseline_refs(duplicate_refs, "Habitats", report)
    return out, index


def build_linear_baseline(rows, spec, report, label):
    """Baseline hedgerows or watercourses."""
    index = BaselineIndex()
    out = []
    _report_duplicate_baseline_refs(
        _duplicate_refs(rows, "Parcel Ref"), label, report
    )
    for row in rows:
        blob = row.get("_geom")
        feature_uuid = new_uuid()
        length = numeric(row.get("Length"))
        if length is None and blob is not None:
            length = line_blob_length_m(blob)
        index.add(row.get("Parcel Ref"), feature_uuid, blob_checksum(blob), length)
        values = {
            "Parcel Ref": row.get("Parcel Ref"),
            "Baseline Condition": row.get("Baseline Condition"),
            "Baseline Distinctiveness": row.get("Baseline Distinctiveness"),
            "Baseline Strategic Significance": row.get(
                "Baseline Strategic Significance"
            ),
            "Length": length,
            "Comment": row.get("Comments") or row.get("Comment"),
            "feature_uuid": feature_uuid,
        }
        for target, source in spec.items():
            values[target] = row.get(source)
        out.append((blob, values))
    return out, index


def build_tree_baseline(rows, report):
    index = BaselineIndex()
    out = []
    _report_duplicate_baseline_refs(
        _duplicate_refs(rows, "Tree Ref"), "Urban Trees", report
    )
    for row in rows:
        blob = row.get("_geom")
        feature_uuid = new_uuid()
        count = numeric(row.get("Count"))
        index.add(row.get("Tree Ref"), feature_uuid, blob_checksum(blob), count)
        out.append(
            (
                blob,
                {
                    "Tree Ref": row.get("Tree Ref"),
                    "Baseline Tree Size": row.get("Baseline Tree Size"),
                    "Baseline Tree Type": row.get("Baseline Tree Type"),
                    "Baseline Rural or Urban Tree": row.get(
                        "Baseline Rural or Urban Tree"
                    ),
                    "Baseline Condition": row.get("Baseline Condition"),
                    "Baseline Strategic Significance": row.get(
                        "Baseline Strategic Significance"
                    ),
                    "Count": int(count) if count is not None else None,
                    "Comment": row.get("Comment"),
                    "feature_uuid": feature_uuid,
                },
            )
        )
    return out, index


def _duplicate_refs(rows, ref_key):
    seen = defaultdict(int)
    for row in rows:
        ref = row.get(ref_key)
        if ref not in (None, ""):
            seen[ref] += 1
    return {ref for ref, count in seen.items() if count > 1}


def _report_duplicate_baseline_refs(duplicates, label, report):
    if duplicates:
        report.warn(
            f"{label} baseline has duplicate references ({', '.join(sorted(duplicates))}). "
            "Post-intervention features matching them are linked to the first "
            "occurrence — check those links in QGIS."
        )


# ---------------------------------------------------------------------------
# Row mapping — post-intervention
# ---------------------------------------------------------------------------


def build_area_pi(rows, index, report):
    """Post-intervention area habitats.

    Legacy "Lost" becomes "Created": the parcel's baseline habitat goes and
    something else takes its place, which is how the Statutory Metric records
    development. The row stays, because area habitats must account for every
    square metre inside the red line.
    """
    out = []
    unmatched = []
    lost_converted = 0
    multipart = 0
    for row in rows:
        blob = row.get("_geom")
        if blob is not None:
            blob, was_multipart = demote_multipolygon_blob_to_polygon(blob)
            multipart += 1 if was_multipart else 0
        retention = row.get("Retention Category")
        if retention == RETENTION_LOST:
            retention = RETENTION_CREATED
            lost_converted += 1
        # legacy stores square metres; the new template's column is hectares
        area = sq_metres_to_hectares(row.get("Area"))
        if area is None and blob is not None:
            area = sq_metres_to_hectares(polygon_blob_area_sqm(blob))
        values = {
            "PI Ref": row.get("_pi_ref"),
            "Baseline Broad Habitat Type": row.get("Baseline Broad Habitat Type"),
            "Baseline Habitat Type": row.get("Baseline Habitat Type"),
            "Baseline Distinctiveness": row.get("Baseline Distinctiveness"),
            "Baseline Condition": row.get("Baseline Condition"),
            "Baseline Strategic Significance": row.get(
                "Baseline Strategic Significance"
            ),
            "Retention Category": retention,
            "Proposed Broad Habitat Type": row.get("Proposed Broad Habitat Type"),
            "Proposed Habitat Type": row.get("Proposed Habitat Type"),
            "Proposed Distinctiveness": row.get("Proposed Distinctiveness"),
            "Proposed Condition": row.get("Proposed Condition"),
            "Proposed Strategic Significance": row.get(
                "Proposed Strategic Significance"
            ),
            "Habitat created in advance/years": row.get(
                "Habitat created in advance/years"
            ),
            "Delay in starting habitat creation/years": row.get(
                "Delay in starting habitat creation/years"
            ),
            "Spatial risk category": row.get("Spatial risk category"),
            "Area": area,
        }
        stamp_parent(
            values, row.get("_parent_ref") or row.get("Parcel Ref"), index, unmatched
        )
        out.append((blob, values))

    if lost_converted:
        report.note(
            f"Habitats: {lost_converted} 'Lost' row(s) recorded as 'Created' — the "
            "new template records built-over ground as creating the new surface"
        )
    if multipart:
        report.warn(
            f"{multipart} post-intervention area habitat(s) are multi-part polygons; "
            "split them in QGIS (Edit > Multipart to singleparts)."
        )
    _report_unmatched(unmatched, "Habitats", report)
    return out


def build_linear_pi(rows, index, spec, report, label, is_watercourse=False):
    """Post-intervention hedgerows or watercourses.

    Legacy "Lost" rows are dropped: the new template records removal by leaving
    the feature out, and the service works out what went missing by comparing
    the baseline against what carried forward.
    """
    out = []
    unmatched = []
    for row in rows:
        blob = row.get("_geom")
        length = numeric(row.get("Length"))
        if length is None and blob is not None:
            length = line_blob_length_m(blob)
        values = {
            "PI Ref": row.get("_pi_ref"),
            "Baseline Condition": row.get("Baseline Condition"),
            "Baseline Distinctiveness": row.get("Baseline Distinctiveness"),
            "Baseline Strategic Significance": row.get(
                "Baseline Strategic Significance"
            ),
            "Retention Category": row.get("Retention Category"),
            "Proposed Distinctiveness": row.get("Proposed Distinctiveness"),
            "Proposed Condition": row.get("Proposed Condition"),
            "Proposed Strategic Significance": row.get(
                "Proposed Strategic Significance"
            ),
            "Habitat created in advance/years": row.get(
                "Habitat created in advance/years"
            ),
            "Delay in starting habitat creation/years": row.get(
                "Delay in starting habitat creation/years"
            ),
            "Spatial risk category": row.get("Spatial risk category"),
            "Length": length,
        }
        for target, source in spec.items():
            values[target] = row.get(source)
        if is_watercourse:
            values["Enhancement Type"] = row.get("Enhancement Type")

        parent_ref = row.get("_parent_ref") or row.get("Parcel Ref")
        if stamp_parent(values, parent_ref, index, unmatched):
            values["Baseline Length"] = index.get(parent_ref)["size"]
        out.append((blob, values))

    _report_unmatched(unmatched, label, report)
    return out


def build_tree_pi(rows, index, report):
    """Post-intervention trees; legacy 'Lost' rows are dropped as above."""
    out = []
    unmatched = []
    for row in rows:
        count = numeric(row.get("Count"))
        values = {
            "PI Ref": row.get("_pi_ref"),
            "Baseline Tree Size": row.get("Baseline Tree Size"),
            "Baseline Tree Type": row.get("Baseline Tree Type"),
            "Baseline Rural or Urban Tree": row.get("Baseline Rural or Urban Tree"),
            "Baseline Condition": row.get("Baseline Condition"),
            "Baseline Strategic Significance": row.get(
                "Baseline Strategic Significance"
            ),
            "Retention Category": row.get("Retention Category"),
            "Proposed Tree Size": row.get("Proposed Tree Size"),
            "Proposed Tree Type": row.get("Proposed Tree Type"),
            "Proposed Rural or Urban Tree": row.get("Proposed Rural or Urban Tree"),
            "Proposed Condition": row.get("Proposed Condition"),
            "Proposed Strategic Significance": row.get(
                "Proposed Strategic Significance"
            ),
            "Category": row.get("Category") or TREE_CATEGORY_EXISTING,
            "Habitat Created/Enhanced in advance/years": row.get(
                "Habitat Created/Enhanced in advance/years"
            ),
            "Delay in starting habitat creation/enhancement in years": row.get(
                "Delay in starting habitat creation/enhancement in years"
            ),
            "Spatial risk category": row.get("Spatial risk category"),
            "Count": int(count) if count is not None else None,
        }
        stamp_parent(
            values, row.get("_parent_ref") or row.get("Tree Ref"), index, unmatched
        )
        out.append((row.get("_geom"), values))

    _report_unmatched(unmatched, "Trees", report)
    return out


def build_meander_rows(rows, index, report):
    """Carry the legacy meanders layer into Watercourses Post-Intervention.

    The new template folds re-meandering into the watercourse itself via the
    Enhancement Type column, so these become enhanced watercourse rows. That is
    an interpretation, not a stated equivalence — hence the warning.
    """
    if not rows:
        return []
    out = []
    unmatched = []
    for row in rows:
        blob = row.get("_geom")
        length = numeric(row.get("Length"))
        if length is None and blob is not None:
            length = line_blob_length_m(blob)
        values = {
            "PI Ref": row.get("Baseline Parcel Ref"),
            "Retention Category": "Enhanced",
            "Enhancement Type": MEANDER_ENHANCEMENT_TYPE,
            "Proposed River Type": row.get("Proposed River Type"),
            "Proposed Condition": row.get("Proposed Condition"),
            "Proposed Distinctiveness": row.get("Proposed Distinctiveness"),
            "Proposed Strategic Significance": row.get(
                "Proposed Strategic Significance"
            ),
            "Proposed Encroachment into Watercourse": row.get(
                "Proposed Encroachment into Watercourse"
            ),
            "Proposed Encroachment into riparian zone": row.get(
                "Proposed Encroachment into riparian zone"
            ),
            "Baseline Distinctiveness": row.get("Baseline Distinctiveness"),
            "Habitat created in advance/years": row.get(
                "Habitat created in advance/years "
            )
            or row.get("Habitat created in advance/years"),
            "Delay in starting habitat creation/years": row.get(
                "Delay in starting habitat creation/years"
            ),
            "Spatial risk category": row.get("Spatial risk category"),
            "Length": length,
        }
        parent_ref = row.get("Baseline Parcel Ref")
        if stamp_parent(values, parent_ref, index, unmatched):
            values["Baseline Length"] = index.get(parent_ref)["size"]
        out.append((blob, values))

    report.warn(
        f"{len(out)} row(s) from the legacy 'Water course enhancement through "
        "meanders' layer were carried into Watercourses Post-Intervention as "
        f"Enhanced, with Enhancement Type '{MEANDER_ENHANCEMENT_TYPE}'. The new "
        "template has no separate meanders layer, so this is an interpretation — "
        "check these rows."
    )
    _report_unmatched(unmatched, "Meanders", report)
    return out


def _report_unmatched(unmatched, label, report):
    if not unmatched:
        return
    distinct = sorted(set(str(ref) for ref in unmatched))
    report.warn(
        f"{label}: {len(unmatched)} post-intervention feature(s) reference "
        f"{len(distinct)} baseline feature(s) that do not exist "
        f"({', '.join(distinct)}). They are left without a recorded parent, so "
        "the service will infer one from the geometry and warn you — review "
        "those before relying on the result."
    )


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def insert_rows(conn, table, rows, target_table=None):
    """Insert rows for the logical layer `table`.

    `target_table` is the name to actually write into, which differs from the
    logical name when filling a template that carries the renamed tables.
    """
    if not rows:
        return 0
    spec = STAGED_LAYERS[table]
    table = target_table or table
    column_names = [name for name, _ in spec["columns"]]
    placeholders = ", ".join(["?"] * (len(column_names) + 1))
    quoted = ", ".join(
        [quote_ident(spec["geom_column"])]
        + [quote_ident(name) for name in column_names]
    )
    payload = [
        [geometry] + [values.get(name) for name in column_names]
        for geometry, values in rows
    ]
    conn.executemany(
        f"INSERT INTO {quote_ident(table)} ({quoted}) VALUES ({placeholders})",
        payload,
    )
    return len(payload)


def create_staged_gpkg(path, srs_rows):
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    create_gpkg_system_tables(conn, srs_rows)
    for table, spec in STAGED_LAYERS.items():
        create_feature_table(
            conn, table, spec["geom_column"], spec["geom_type"], spec["columns"]
        )
    conn.commit()
    return conn


def resolve_template_tables(conn):
    """Map each logical staged layer to the table name this template carries.

    Templates from before and after the "Area Habitats" / "Individual Trees"
    rename are both accepted; the rows are written into whichever the target
    actually has. A layer with no accepted spelling is a hard error naming
    every name that was looked for, rather than the bare SQLite
    "no such table".
    """
    present = feature_table_names(conn)
    resolved = {}
    missing = []
    for layer in STAGED_LAYERS:
        table = resolve_table_name(staged_table_candidates(layer), present)
        if table is None:
            missing.append(layer)
        else:
            resolved[layer] = table
    if missing:
        detail = "; ".join(
            f"{layer} (looked for {quoted_names(staged_table_candidates(layer))})"
            for layer in missing
        )
        raise ValueError(
            "The target GeoPackage is missing feature table(s): "
            f"{detail}. Point --into at a copy of the BNG Service template."
        )
    return resolved


def open_template_gpkg(path, force):
    """Open an existing template GeoPackage to write into.

    Returns the connection and the logical-layer -> actual-table-name map the
    caller must write through.

    Keeps the template's own spatial indexes working by supplying the ST_*
    functions its triggers call.
    """
    conn = sqlite3.connect(path)
    register_spatial_functions(conn)
    try:
        tables = resolve_template_tables(conn)
    except ValueError:
        conn.close()
        raise
    if not force:
        for table in tables.values():
            row = conn.execute(
                f"SELECT COUNT(*) FROM {quote_ident(table)}"
            ).fetchone()
            if row and row[0]:
                conn.close()
                raise ValueError(
                    f'"{table}" in the target already has {row[0]} feature(s). '
                    "Point --into at a fresh copy of the template, or pass "
                    "--force to add to what is there."
                )
    return conn, tables


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------

HEDGEROW_BASELINE_SPEC = {"Baseline Hedge Type": "Baseline Hedge Type"}
HEDGEROW_PI_SPEC = {
    "Baseline Hedge Type": "Baseline Hedge Type",
    "Proposed Hedge Type": "Proposed Hedge Type",
}
WATERCOURSE_BASELINE_SPEC = {
    "Baseline River Type": "Baseline River Type",
    "Baseline Encroachment into Watercourse": "Baseline Encroachment into Watercourse",
    "Baseline Encroachment into riparian zone": (
        "Baseline Encroachment into riparian zone"
    ),
}
WATERCOURSE_PI_SPEC = {
    "Baseline River Type": "Baseline River Type",
    "Baseline Encroachment into Watercourse": "Baseline Encroachment into Watercourse",
    "Baseline Encroachment into riparian zone": (
        "Baseline Encroachment into riparian zone"
    ),
    "Proposed River Type": "Proposed River Type",
    "Proposed Encroachment into Watercourse": "Proposed Encroachment into Watercourse",
    "Proposed Encroachment into riparian zone": (
        "Proposed Encroachment into riparian zone"
    ),
}


def convert(baseline_path, pi_path, out_dir, into_path, force, dry_run,
            out_file=None):
    report = Report()
    baseline = read_legacy(baseline_path)
    post = read_legacy(pi_path) if pi_path else None

    if not baseline["redline"]:
        report.warn(
            "The baseline file has no Red Line Boundary feature — the new "
            "template needs one, and it carries the site details."
        )

    site = site_details(post or baseline) if (post or baseline) else {}
    for field in SITE_DETAIL_FIELDS:
        if site.get(field) in (None, ""):
            site[field] = site_details(baseline).get(field)

    # Build the baseline side first: every stamp a child needs comes from here.
    area_baseline, area_index = build_area_baseline(baseline["areas"], report)
    hedge_baseline, hedge_index = build_linear_baseline(
        baseline["hedgerows"], HEDGEROW_BASELINE_SPEC, report, "Hedgerows"
    )
    water_baseline, water_index = build_linear_baseline(
        baseline["watercourses"], WATERCOURSE_BASELINE_SPEC, report, "Watercourses"
    )
    tree_baseline, tree_index = build_tree_baseline(baseline["trees"], report)

    area_pi, hedge_pi, water_pi, tree_pi = [], [], [], []
    if post:
        recovered = 0
        for key in ("areas", "hedgerows", "watercourses", "trees"):
            recovered += read_breadcrumbs(post[key])
        if recovered:
            report.note(
                f"Recovered {recovered} lineage breadcrumb(s) left by "
                "new_to_old.py --carry-lineage"
            )

        post["hedgerows"] = drop_lost_rows(
            post["hedgerows"], "Parcel Ref", "Hedgerows", report
        )
        post["watercourses"] = drop_lost_rows(
            post["watercourses"], "Parcel Ref", "Watercourses", report
        )
        post["trees"] = drop_lost_rows(post["trees"], "Tree Ref", "Trees", report)

        unique_pi_refs(post["areas"], "Parcel Ref", report, "Habitats")
        unique_pi_refs(post["hedgerows"], "Parcel Ref", report, "Hedgerows")
        unique_pi_refs(post["watercourses"], "Parcel Ref", report, "Watercourses")
        unique_pi_refs(post["trees"], "Tree Ref", report, "Trees")

        area_pi = build_area_pi(post["areas"], area_index, report)
        hedge_pi = build_linear_pi(
            post["hedgerows"], hedge_index, HEDGEROW_PI_SPEC, report, "Hedgerows"
        )
        water_pi = build_linear_pi(
            post["watercourses"], water_index, WATERCOURSE_PI_SPEC, report,
            "Watercourses", is_watercourse=True,
        )
        water_pi.extend(build_meander_rows(post["meanders"], water_index, report))
        tree_pi = build_tree_pi(post["trees"], tree_index, report)
    else:
        report.note(
            "No post-intervention file given — only the baseline was converted."
        )

    redline_rows = [
        (row.get("_geom"), {field: site.get(field) for field in SITE_DETAIL_FIELDS})
        for row in baseline["redline"]
    ]

    tables = {
        "Red Line Boundary": redline_rows,
        "Habitats Baseline": area_baseline,
        "Habitats Post-Intervention": area_pi,
        "Hedgerows Baseline": hedge_baseline,
        "Hedgerows Post-Intervention": hedge_pi,
        "Watercourses Baseline": water_baseline,
        "Watercourses Post-Intervention": water_pi,
        "Trees Baseline": tree_baseline,
        "Trees Post-Intervention": tree_pi,
    }
    for table, rows in tables.items():
        report.count(table, len(rows))

    _report_lineage_quality(tables, report)
    _report_manual_steps(tables, report)

    if dry_run:
        return report

    if into_path:
        conn, table_names = open_template_gpkg(into_path, force)
        target = into_path
        renamed = [
            f'"{layer}" -> "{name}"'
            for layer, name in table_names.items()
            if name != layer
        ]
        if renamed:
            report.note(
                "Target template uses renamed table(s); wrote into "
                + ", ".join(renamed)
            )
    else:
        if out_file:
            target = out_file
            parent = os.path.dirname(os.path.abspath(target))
            os.makedirs(parent, exist_ok=True)
        else:
            os.makedirs(out_dir, exist_ok=True)
            stem = os.path.splitext(os.path.basename(baseline_path))[0]
            target = os.path.join(out_dir, f"{stem} - Staged.gpkg")
        conn = create_staged_gpkg(target, baseline["srs"])
        # A file we create ourselves carries the names the shipped template
        # still uses, so every logical layer maps to itself.
        table_names = {layer: layer for layer in STAGED_LAYERS}

    try:
        for table, rows in tables.items():
            insert_rows(conn, table, rows, table_names[table])
        for table, spec in STAGED_LAYERS.items():
            update_layer_extent(conn, table_names[table], spec["geom_column"])
        conn.commit()
    finally:
        conn.close()

    report.note(f"Staged file: {target}")
    return report


def _report_lineage_quality(tables, report):
    """How much of the lineage could actually be proved, rather than guessed."""
    stamped = 0
    total = 0
    for table, rows in tables.items():
        if not table.endswith("Post-Intervention"):
            continue
        for _, values in rows:
            total += 1
            if values.get("parent_uuid"):
                stamped += 1
    if not total:
        return
    inferred = total - stamped
    report.note(
        f"Lineage: {stamped} of {total} post-intervention feature(s) linked to a "
        f"baseline feature by reference"
        + (
            f"; {inferred} left for the service to infer from geometry"
            if inferred
            else ""
        )
    )


def _report_manual_steps(tables, report):
    if any(
        values.get("Irreplaceable Habitat") is None
        for table, rows in tables.items()
        if table in AREA_HABITAT_LAYERS
        for _, values in rows
    ):
        report.warn(
            "Irreplaceable Habitat is blank on every habitat feature — the legacy "
            "template has no such column. Fill it in before uploading."
        )
    report.warn(
        "Vertical area habitats (green walls, intertidal hard structures) are "
        "empty: the legacy template cannot record them. Add any that exist."
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def print_report(report, dry_run):
    print()
    print("=" * 70)
    print("  legacy Natural England GeoPackages  ->  BNG Service GeoPackage")
    print("=" * 70)
    if dry_run:
        print("  DRY RUN — nothing was written")
        print("-" * 70)

    print("\nRows:")
    for key, value in report.counts.items():
        print(f"  {key:.<50} {value}")

    if report.lines:
        print("\nNotes:")
        for line in report.lines:
            print(f"  - {line}")

    if report.warnings:
        print("\nWARNINGS — check these before uploading:")
        for line in report.warnings:
            print(f"  ! {line}")

    print(
        "\nLineage is rebuilt from references, which the legacy format never "
        "guaranteed.\nOpen the result in the new template and check the parent "
        "links before relying\non it.\n"
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Convert a legacy Natural England baseline + post-intervention pair "
            "into a single BNG Service staged GeoPackage."
        )
    )
    parser.add_argument("--baseline", required=True, help="legacy baseline .gpkg")
    parser.add_argument(
        "--post-intervention", help="legacy post-intervention .gpkg (optional)"
    )
    parser.add_argument(
        "-o", "--out-dir", default=".", help="directory for the staged file"
    )
    parser.add_argument(
        "--into",
        help=(
            "write into this existing template GeoPackage (a fresh copy of "
            "Layers/BNG Service Layers.gpkg) instead of creating a new file"
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="allow --into when the target already holds features",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be produced without writing anything",
    )
    args = parser.parse_args(argv)

    for label, path in (
        ("baseline", args.baseline),
        ("post-intervention", args.post_intervention),
        ("target", args.into),
    ):
        if path and not os.path.exists(path):
            print(f"error: {label} file not found: {path}", file=sys.stderr)
            return 1

    try:
        report = convert(
            args.baseline,
            args.post_intervention,
            args.out_dir,
            args.into,
            args.force,
            args.dry_run,
        )
    except (sqlite3.Error, ValueError, struct.error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print_report(report, args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
