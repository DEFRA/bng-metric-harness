"""Fill the Statutory Biodiversity Metric workbook from a staged GeoPackage.

This is the third route out of the BNG Service template, alongside the legacy
GeoPackage pair and the GIS import tool's CSVs. It skips the import tool: the
habitats go straight into a copy of the metric's own .xlsm.

HOW IT WRITES
    An .xlsm is a zip of XML, so no library is needed and none is available
    anyway (openpyxl is absent from QGIS's Python). Every cell this fills
    already exists in the sheet as an empty, styled element, so filling one is
    a replacement in place and nothing else moves. vbaProject.bin and every
    other part are copied through byte for byte, and sheet protection is left
    alone: it guards the user interface, not the file.

    Excel caches a formula dependency chain. That cache is dropped and the
    workbook is marked for a full recalculation on open, so the numbers are
    computed from the values written here rather than from anything stale.

HOW IT MAPS
    The metric splits a site by retention across three sheets per module. Its
    baseline sheet holds an area that is then divided into "retained" and
    "enhanced", with the remainder treated as lost. Its enhancement sheet is
    nearly all formulas that pull the baseline back by lookup, in the order the
    enhanced rows appear in the baseline sheet.

    So each post-intervention parcel becomes one baseline row carrying its
    parent's baseline values and its own size, with that size placed in
    retained, enhanced, or neither. Parcels tile their parent and units are
    linear in size, so splitting a parent across rows gives the same totals and
    makes the correspondence with the enhancement sheet one to one. A baseline
    feature nothing was derived from is wholly lost.

SCOPE
    On-site only. The off-site sheets (D, E and F) carry extra allocation
    columns and a different layout, so they are deliberately not written rather
    than guessed at. Individual trees are not written either: the metric treats
    them as an area habitat with a notional size from a band lookup, which is a
    calculation this does not yet do.
"""

import argparse
import os
import re
import shutil
import sqlite3
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import OrderedDict, defaultdict

try:
    from .gpkg_common import numeric
except ImportError:  # pragma: no cover - running as a plain script
    from gpkg_common import numeric

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

METRES_PER_KM = 1000

RETAINED, ENHANCED, CREATED = "Retained", "Enhanced", "Created"

# Column letters were found by taking, on each sheet's first data row, the
# cells that EXIST but hold nothing. Those are the inputs; everything else is a
# formula and must not be written to. Header text is no guide, because it sits
# across two or three rows per sheet.
#
# The "Ref" column on the baseline and creation sheets (A-1 D, A-2 B, B-1 B,
# C-1 C) is NOT the user's reference. It holds the metric's own line numbers,
# and the enhancement sheets find their baseline through it: A-3!E12 is
# ='A-1'!AL11, which yields a line number, and A-3!F12 then looks that up in
# A-1 column D. Overwrite D and every enhancement row loses its baseline with
# nothing shown on screen. The user's reference goes in "Habitat reference
# number" instead.
LAYOUT = {
    "areas": {
        "baseline": ("A-1 On-Site Habitat Baseline", 11, 258,
                     dict(broad="E", habitat="F", irreplaceable="G", size="H",
                          condition="K", significance="M", retained="S",
                          enhanced="T", comment="Z", ref="AB")),
        "creation": ("A-2 On-Site Habitat Creation", 11, 258,
                     dict(broad="D", habitat="E", size="G", condition="J",
                          significance="L", advance="P", delay="Q",
                          comment="Z", ref="AB")),
        "enhancement": ("A-3 On-Site Habitat Enhancement", 12, 259,
                        dict(habitat="R", condition="Y", significance="AA",
                             advance="AE", delay="AF")),
    },
    "hedgerows": {
        "baseline": ("B-1 On-Site Hedge Baseline", 10, 257,
                     dict(number="C", habitat="D", size="E", condition="H",
                          significance="J", retained="P", enhanced="Q",
                          comment="V", ref="X")),
        "creation": ("B-2 On-Site Hedge Creation", 12, 259,
                     dict(number="C", habitat="D", size="E", condition="H",
                          significance="J", advance="N", delay="O",
                          comment="X", ref="Z")),
        "enhancement": ("B-3 On-Site Hedge Enhancement", 12, 259,
                        dict(habitat="M", condition="S", significance="U",
                             advance="Y", delay="Z")),
    },
    "watercourses": {
        "baseline": ("C-1 On-Site WaterC' Baseline", 10, 257,
                     dict(habitat="D", size="E", condition="H",
                          significance="J", retained="U", enhanced="V",
                          comment="AB", ref="AD")),
        "creation": ("C-2 On-Site WaterC' Creation", 12, 259,
                     dict(habitat="C", size="D", condition="G",
                          significance="I", advance="M", delay="N",
                          comment="AA", ref="AC")),
        "enhancement": ("C-3 On-Site WaterC' Enhancement", 12, 259,
                        dict(habitat="N", condition="T", significance="V",
                             advance="Z", delay="AA")),
    },
}

# module -> staged tables, the size column, the habitat-type column, and the
# factor taking the template's units to the metric's. Areas are hectares on
# both sides; the metric wants linear features in KILOMETRES.
MODULES = (
    ("areas", "Habitats Baseline", "Habitats Post-Intervention",
     "Area", "Habitat Type", 1.0),
    ("hedgerows", "Hedgerows Baseline", "Hedgerows Post-Intervention",
     "Length", "Hedge Type", 1.0 / METRES_PER_KM),
    ("watercourses", "Watercourses Baseline", "Watercourses Post-Intervention",
     "Length", "River Type", 1.0 / METRES_PER_KM),
)

# A cell that proves the workbook already holds a site.
OCCUPIED_PROBE = ("A-1 On-Site Habitat Baseline", "E11")

SIZE_FIELDS = ("size", "retained", "enhanced")


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
# Reading the staged GeoPackage
# ---------------------------------------------------------------------------


def read_table(conn, table, present):
    if table not in present:
        return []
    cursor = conn.execute(f'SELECT * FROM "{table}"')
    names = [d[0] for d in cursor.description]
    return [dict(zip(names, values)) for values in cursor.fetchall()]


def read_staged(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        present = {
            row[0] for row in conn.execute(
                "SELECT table_name FROM gpkg_contents WHERE data_type='features'")
        }
        return {
            kind: {"baseline": read_table(conn, base, present),
                   "pi": read_table(conn, pi, present)}
            for kind, base, pi, _size, _type, _scale in MODULES
        }
    finally:
        conn.close()


def build_lines(tables, size_field, type_field, consolidate):
    """Baseline, creation and enhancement lines for one module."""
    baseline_rows = tables["baseline"]
    pi_rows = tables["pi"]
    by_uuid = {row.get("feature_uuid"): row
               for row in baseline_rows if row.get("feature_uuid")}

    baseline, creation, enhancement = [], [], []
    derived_from = set()

    for row in pi_rows:
        retention = (row.get("Retention Category") or "").strip()
        parent = by_uuid.get(row.get("parent_uuid"))
        size = numeric(row.get(size_field)) or 0.0
        if parent is not None:
            derived_from.add(row.get("parent_uuid"))

        if retention == CREATED or parent is None:
            creation.append({
                "ref": row.get("PI Ref"),
                "broad": row.get("Proposed Broad Habitat Type"),
                "number": row.get("PI Ref"),
                "habitat": row.get(f"Proposed {type_field}"),
                "size": size,
                "condition": row.get("Proposed Condition"),
                "significance": row.get("Proposed Strategic Significance"),
                "advance": row.get("Habitat created in advance/years"),
                "delay": row.get("Delay in starting habitat creation/years"),
            })
            continue

        baseline.append({
            "ref": row.get("PI Ref"),
            "number": row.get("PI Ref"),
            "broad": parent.get("Baseline Broad Habitat Type"),
            "habitat": parent.get(f"Baseline {type_field}"),
            "irreplaceable": row.get("Irreplaceable Habitat"),
            "size": size,
            "condition": parent.get("Baseline Condition"),
            "significance": parent.get("Baseline Strategic Significance"),
            "retained": size if retention == RETAINED else 0,
            "enhanced": size if retention == ENHANCED else 0,
        })
        if retention == ENHANCED:
            enhancement.append({
                "habitat": row.get(f"Proposed {type_field}"),
                "condition": row.get("Proposed Condition"),
                "significance": row.get("Proposed Strategic Significance"),
                "advance": row.get("Habitat created in advance/years"),
                "delay": row.get("Delay in starting habitat creation/years"),
            })

    for row in baseline_rows:
        if row.get("feature_uuid") in derived_from:
            continue
        baseline.append({
            "ref": row.get("Parcel Ref") or row.get("Tree Ref"),
            "number": row.get("Parcel Ref"),
            "broad": row.get("Baseline Broad Habitat Type"),
            "habitat": row.get(f"Baseline {type_field}"),
            # Its own flag, not None: a wholly lost parcel is still
            # irreplaceable habitat, and consolidation groups on this.
            "irreplaceable": row.get("Irreplaceable Habitat"),
            "size": numeric(row.get(size_field)) or 0.0,
            "condition": row.get("Baseline Condition"),
            "significance": row.get("Baseline Strategic Significance"),
            "retained": 0,
            "enhanced": 0,
        })

    if consolidate:
        baseline = consolidate_lines(baseline)
        creation = consolidate_lines(creation)
    return baseline, creation, enhancement


def consolidate_lines(lines):
    """Merge lines agreeing on everything but size, summing the sizes.

    The import tool offers the same thing. It is arithmetically free: units are
    linear in size and merged lines share every multiplier, so the totals do
    not move. What it costs is the per-parcel audit trail.

    IRREPLACEABLE LINES ARE NEVER MERGED WITH REPLACEABLE ONES. The key below
    is built from every field except size and reference, and `irreplaceable`
    is one of those fields, so a flagged parcel can only ever join a group of
    flagged parcels. That is the difference between doing this here and
    pressing Consolidate Data in the import tool, which cannot see the flag
    at all because the legacy CSVs have no column for it.

    ENHANCED LINES ARE NEVER MERGED. The enhancement sheet is positional
    against the baseline sheet: its Nth row belongs to the Nth baseline row
    with an enhanced size. Merging two enhanced parcels that share their
    baseline values but head for different habitats would leave one baseline
    row against two enhancement rows, and every target after it would be
    applied to the wrong parcel, with nothing shown on screen.
    """
    merged = OrderedDict()
    kept = []
    for line in lines:
        if line.get("enhanced"):
            kept.append(line)
            continue
        key = tuple(sorted((k, v) for k, v in line.items()
                           if k not in SIZE_FIELDS and k not in ("ref", "number")))
        if key in merged:
            for field in SIZE_FIELDS:
                if field in line:
                    merged[key][field] = merged[key].get(field, 0) + line[field]
            merged[key]["ref"] = f"{merged[key]['ref']} +"
            merged[key]["number"] = merged[key]["ref"]
        else:
            merged[key] = dict(line)
    # enhanced lines keep their original position relative to each other
    return list(merged.values()) + kept


# ---------------------------------------------------------------------------
# Writing the workbook
# ---------------------------------------------------------------------------


def escape(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def cell_xml(ref, attributes, value):
    """A replacement <c> keeping the original style, now holding a value."""
    keep = re.sub(r'\s+t="[^"]*"', "", attributes)
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"{keep}><v>{value}</v></c>'
    return (f'<c r="{ref}"{keep} t="inlineStr"><is><t xml:space="preserve">'
            f"{escape(value)}</t></is></c>")


def cell_pattern(ref):
    return re.compile(
        r'<c r="%s"((?:\s+[a-zA-Z:]+="[^"]*")*)\s*(?:/>|>.*?</c>)' % ref, re.S)


def set_cells(sheet_xml, values):
    missing = []
    for ref, value in values.items():
        match = cell_pattern(ref).search(sheet_xml)
        if not match:
            missing.append(ref)
            continue
        sheet_xml = (sheet_xml[:match.start()]
                     + cell_xml(ref, match.group(1), value)
                     + sheet_xml[match.end():])
    return sheet_xml, missing


def sheet_paths(archive):
    rels = {rel.get("Id"): rel.get("Target") for rel in
            ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
    paths = {}
    for sheet in ET.fromstring(archive.read("xl/workbook.xml")).iter(f"{NS}sheet"):
        target = rels[sheet.get(f"{REL}id")].lstrip("/")
        paths[sheet.get("name")] = (
            target if target.startswith("xl/") else "xl/" + target)
    return paths


def cell_is_empty(archive, paths, sheet, ref):
    xml = archive.read(paths[sheet]).decode("utf-8")
    match = re.search(
        r'<c r="%s"(?:\s+[a-zA-Z:]+="[^"]*")*\s*(?:/>|>(.*?)</c>)' % ref, xml, re.S)
    return match is None or not (match.group(1) or "").strip()


def drop_incomplete_rows(xml, values):
    """Discard every edit on a row the sheet cannot hold in full.

    Some columns run out of styled cells a row or two before others do. Writing
    the cells that exist and silently skipping the rest would leave a row
    carrying a size with no habitat against it, which the metric would then
    total. A row that cannot be written whole is not written at all.

    Returns (values to write, refs that were dropped).
    """
    present = set(re.findall(r'<c r="([A-Z]+\d+)"', xml))
    by_row = defaultdict(list)
    for ref in values:
        by_row[re.sub(r"^[A-Z]+", "", ref)].append(ref)

    keep, dropped = {}, []
    for refs in by_row.values():
        if all(ref in present for ref in refs):
            keep.update({ref: values[ref] for ref in refs})
        else:
            dropped.extend(sorted(refs))
    return keep, dropped


def write_workbook(template, out_path, edits):
    """Apply edits to a copy of the metric workbook. Everything else is kept."""
    with zipfile.ZipFile(template) as archive:
        names = archive.namelist()
        paths = sheet_paths(archive)
        payload = {name: archive.read(name) for name in names}

    missing = {}
    for sheet, values in edits.items():
        path = paths[sheet]
        xml = payload[path].decode("utf-8")
        values, dropped = drop_incomplete_rows(xml, values)
        if dropped:
            missing[sheet] = dropped
        xml, gone = set_cells(xml, values)
        if gone:
            missing.setdefault(sheet, []).extend(gone)
        payload[path] = xml.encode("utf-8")

    workbook = payload["xl/workbook.xml"].decode("utf-8")
    if "fullCalcOnLoad" in workbook:
        workbook = re.sub(r'fullCalcOnLoad="[^"]*"', 'fullCalcOnLoad="1"', workbook)
    else:
        workbook = workbook.replace("<calcPr ", '<calcPr fullCalcOnLoad="1" ', 1)
    payload["xl/workbook.xml"] = workbook.encode("utf-8")

    # Drop the cached formula dependency chain so it cannot disagree with the
    # values just written; Excel rebuilds it on open.
    content_types = payload["[Content_Types].xml"].decode("utf-8")
    payload["[Content_Types].xml"] = re.sub(
        r'<Override PartName="/xl/calcChain\.xml"[^>]*/>', "",
        content_types).encode("utf-8")
    rels = payload["xl/_rels/workbook.xml.rels"].decode("utf-8")
    payload["xl/_rels/workbook.xml.rels"] = re.sub(
        r'<Relationship[^>]*Target="calcChain\.xml"[^>]*/>', "",
        rels).encode("utf-8")

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as out:
        for name in names:
            if name == "xl/calcChain.xml":
                continue
            out.writestr(name, payload[name])
    return missing


# ---------------------------------------------------------------------------
# Putting it together
# ---------------------------------------------------------------------------


def cells_for(row_number, columns, line, scale):
    out = {}
    for field, column in columns.items():
        if field not in line:
            continue
        value = line[field]
        if value in (None, ""):
            continue
        if field in SIZE_FIELDS:
            value = round(float(value) * scale, 6)
        out[f"{column}{row_number}"] = value
    return out


def build_edits(staged, consolidate, report):
    edits = {}
    for kind, _base, _pi, size_field, type_field, scale in MODULES:
        baseline, creation, enhancement = build_lines(
            staged[kind], size_field, type_field, consolidate)
        report.count(f"{kind} baseline", len(baseline))
        report.count(f"{kind} creation", len(creation))
        report.count(f"{kind} enhancement", len(enhancement))
        for stage, lines in (("baseline", baseline), ("creation", creation),
                             ("enhancement", enhancement)):
            sheet, first, last, columns = LAYOUT[kind][stage]
            capacity = last - first + 1
            if len(lines) > capacity:
                report.warn(
                    f"{sheet} holds {capacity} rows and this site needs "
                    f"{len(lines)}. The extra rows were NOT written. Try "
                    f"consolidating, or split the site.")
                lines = lines[:capacity]
            target = edits.setdefault(sheet, {})
            for offset, line in enumerate(lines):
                target.update(cells_for(first + offset, columns, line, scale))
    return edits


def convert(input_path, template_path, out_path, consolidate=False,
            allow_occupied=False):
    report = Report()
    staged = read_staged(input_path)

    with zipfile.ZipFile(template_path) as archive:
        try:
            paths = sheet_paths(archive)
        except KeyError:
            # .xlsb keeps its sheets as binary parts, and anything else is not
            # a workbook at all.
            raise ValueError(
                f"{os.path.basename(template_path)} is not a readable .xlsm "
                "workbook. The macro-enabled Statutory Metric file is needed "
                "here, not the .xlsb GIS import tool.")
        for sheet in {LAYOUT[k][s][0] for k in LAYOUT for s in LAYOUT[k]}:
            if sheet not in paths:
                raise ValueError(
                    f"{os.path.basename(template_path)} has no '{sheet}' sheet, "
                    "so it does not look like the Statutory Metric workbook.")
        occupied = not cell_is_empty(archive, paths, *OCCUPIED_PROBE)
    if occupied and not allow_occupied:
        raise ValueError(
            f"{os.path.basename(template_path)} already holds habitat data. "
            "Point this at a blank copy of the metric so nothing is "
            "overwritten.")

    edits = build_edits(staged, consolidate, report)
    if not any(edits.values()):
        report.warn("Nothing was written: the GeoPackage holds no habitats.")

    missing = write_workbook(template_path, out_path, edits)
    for sheet, refs in missing.items():
        rows = sorted({re.sub(r"^[A-Z]+", "", ref) for ref in refs}, key=int)
        report.warn(
            f"{sheet}: {len(rows)} row(s) skipped because the sheet runs out "
            f"of cells before the last row of its stated range "
            f"(row(s) {', '.join(rows)}). Nothing partial was written.")

    report.count("cells written", sum(len(v) for v in edits.values()))
    report.note(f"Metric workbook: {out_path}")
    report.note("Open it in Excel and let it recalculate. On-site tabs only.")

    return report


def print_report(report):
    print("\nRows mapped")
    for key, value in report.counts.items():
        print(f"  {key}".ljust(50, ".") + f" {value}")
    if report.lines:
        print("\nNotes:")
        for line in report.lines:
            print(f"  - {line}")
    if report.warnings:
        print("\nWARNINGS — read before relying on the numbers:")
        for line in report.warnings:
            print(f"  ! {line}")
    print(
        "\nNot written: individual trees (the metric derives their size from a "
        "\nband lookup), off-site tabs, and irreplaceable habitats."
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=("Fill a copy of the Statutory Biodiversity Metric "
                     "workbook from a BNG Service staged GeoPackage."))
    parser.add_argument("input", help="the staged .gpkg from the new template")
    parser.add_argument("--metric", required=True,
                        help="a blank copy of the metric .xlsm")
    parser.add_argument("-o", "--out", required=True,
                        help="where to write the filled workbook")
    parser.add_argument("--consolidate", action="store_true",
                        help="merge rows agreeing on everything but size")
    parser.add_argument("--allow-occupied", action="store_true",
                        help="write even if the metric already holds habitats")
    args = parser.parse_args(argv)

    for path in (args.input, args.metric):
        if not os.path.exists(path):
            print(f"error: file not found: {path}", file=sys.stderr)
            return 1
    try:
        report = convert(args.input, args.metric, args.out, args.consolidate,
                         args.allow_occupied)
    except (sqlite3.Error, ValueError, zipfile.BadZipFile, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print_report(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
