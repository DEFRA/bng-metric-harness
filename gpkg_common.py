"""
Shared GeoPackage primitives for the BNG template converters.

A GeoPackage is a SQLite database, so everything here works with the standard
library alone: geometry is read straight out of the stored blobs and, wherever
a feature is copied between files, the blob's bytes are reused untouched.
"""

import hashlib
import math
import struct

# ---------------------------------------------------------------------------
# GeoPackage / WKB constants
# ---------------------------------------------------------------------------

GPKG_APPLICATION_ID = 0x47504B47  # 'GPKG'
GPKG_USER_VERSION = 10200  # GeoPackage 1.2
BNG_SRS_ID = 27700  # British National Grid

GPKG_BLOB_MAGIC = b"GP"
GPKG_HEADER_FLAG_BYTE = 3
GPKG_HEADER_FIXED_BYTES = 8  # magic(2) + version(1) + flags(1) + srs_id(4)
ENVELOPE_DOUBLE_COUNTS = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}
BYTES_PER_DOUBLE = 8
ENVELOPE_INDICATOR_SHIFT = 1
ENVELOPE_INDICATOR_MASK = 0x07
LITTLE_ENDIAN_FLAG_MASK = 0x01

WKB_BYTE_ORDER_BYTES = 1
WKB_TYPE_BYTES = 4
WKB_LITTLE_ENDIAN = 1

WKB_POINT = 1
WKB_LINE_STRING = 2
WKB_POLYGON = 3
WKB_MULTI_POINT = 4
WKB_MULTI_LINE_STRING = 5
WKB_MULTI_POLYGON = 6

WKB_TYPE_NAMES = {
    WKB_POINT: "Point",
    WKB_LINE_STRING: "LineString",
    WKB_POLYGON: "Polygon",
    WKB_MULTI_POINT: "MultiPoint",
    WKB_MULTI_LINE_STRING: "MultiLineString",
    WKB_MULTI_POLYGON: "MultiPolygon",
}

SINGLE_PART_COUNT = 1
MIN_LINE_VERTICES = 2
MIN_RING_VERTICES = 3


def quote_ident(name):
    """Quote a SQLite identifier — layer and column names contain spaces."""
    escaped = name.replace('"', '""')
    return f'"{escaped}"'


def numeric(value):
    """Coerce a stored value to float, treating blanks and junk as missing."""
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(number) else number


# The new template records area habitat areas in HECTARES (the unit the
# Statutory Metric works in, and what the QGIS project's area setting produces).
# The legacy template's Area column is whole SQUARE METRES. Every conversion
# across that boundary has to go through these two.
SQ_METRES_PER_HECTARE = 10000


def hectares_to_sq_metres(value):
    """Hectares as stored by the new template -> square metres for legacy."""
    number = numeric(value)
    return None if number is None else number * SQ_METRES_PER_HECTARE


def sq_metres_to_hectares(value):
    """Square metres as stored by legacy -> hectares for the new template."""
    number = numeric(value)
    return None if number is None else number / SQ_METRES_PER_HECTARE


# ---------------------------------------------------------------------------
# Blob header / WKB plumbing
# ---------------------------------------------------------------------------


def split_gpkg_blob(blob):
    """Split a GeoPackage geometry blob into (header, wkb)."""
    if not blob or len(blob) < GPKG_HEADER_FIXED_BYTES:
        raise ValueError("geometry blob too short to be a GeoPackage geometry")
    if blob[:2] != GPKG_BLOB_MAGIC:
        raise ValueError("geometry blob is not in GeoPackage format")

    flags = blob[GPKG_HEADER_FLAG_BYTE]
    indicator = (flags >> ENVELOPE_INDICATOR_SHIFT) & ENVELOPE_INDICATOR_MASK
    if indicator not in ENVELOPE_DOUBLE_COUNTS:
        raise ValueError(f"unsupported envelope indicator {indicator}")

    header_length = (
        GPKG_HEADER_FIXED_BYTES
        + ENVELOPE_DOUBLE_COUNTS[indicator] * BYTES_PER_DOUBLE
    )
    return blob[:header_length], blob[header_length:]


def wkb_geometry_type(wkb):
    """Read the OGC geometry type code and byte order from a WKB buffer."""
    if len(wkb) < WKB_BYTE_ORDER_BYTES + WKB_TYPE_BYTES:
        raise ValueError("WKB too short to carry a geometry type")
    endian = "<" if wkb[0] == WKB_LITTLE_ENDIAN else ">"
    (type_code,) = struct.unpack_from(f"{endian}I", wkb, WKB_BYTE_ORDER_BYTES)
    return type_code, endian


def _read_point(wkb, offset, endian):
    x, y = struct.unpack_from(f"{endian}dd", wkb, offset)
    return [x, y], offset + BYTES_PER_DOUBLE * 2


def _read_point_list(wkb, offset, endian):
    (count,) = struct.unpack_from(f"{endian}I", wkb, offset)
    offset += WKB_TYPE_BYTES
    points = []
    for _ in range(count):
        point, offset = _read_point(wkb, offset, endian)
        points.append(point)
    return points, offset


def _read_polygon_body(wkb, offset, endian):
    (ring_count,) = struct.unpack_from(f"{endian}I", wkb, offset)
    offset += WKB_TYPE_BYTES
    rings = []
    for _ in range(ring_count):
        ring, offset = _read_point_list(wkb, offset, endian)
        rings.append(ring)
    return rings, offset


def _read_geometry_body(wkb, offset, endian, type_code):
    """Read one geometry body, returning (coordinates, offset) in GeoJSON shape."""
    if type_code == WKB_POINT:
        return _read_point(wkb, offset, endian)
    if type_code == WKB_LINE_STRING:
        return _read_point_list(wkb, offset, endian)
    if type_code == WKB_POLYGON:
        return _read_polygon_body(wkb, offset, endian)
    if type_code in (WKB_MULTI_POINT, WKB_MULTI_LINE_STRING, WKB_MULTI_POLYGON):
        (part_count,) = struct.unpack_from(f"{endian}I", wkb, offset)
        offset += WKB_TYPE_BYTES
        parts = []
        for _ in range(part_count):
            part_type, part_endian = wkb_geometry_type(wkb[offset:])
            offset += WKB_BYTE_ORDER_BYTES + WKB_TYPE_BYTES
            part, offset = _read_geometry_body(wkb, offset, part_endian, part_type)
            parts.append(part)
        return parts, offset
    raise ValueError(f"unsupported WKB geometry type {type_code}")


def blob_geometry(blob):
    """Decode a geometry blob into (type_name, coordinates), GeoJSON-shaped."""
    _, wkb = split_gpkg_blob(blob)
    type_code, endian = wkb_geometry_type(wkb)
    if type_code not in WKB_TYPE_NAMES:
        raise ValueError(f"unsupported WKB geometry type {type_code}")
    coordinates, _ = _read_geometry_body(
        wkb, WKB_BYTE_ORDER_BYTES + WKB_TYPE_BYTES, endian, type_code
    )
    return WKB_TYPE_NAMES[type_code], coordinates


def blob_envelope(blob):
    """Bounding box (min_x, min_y, max_x, max_y), or None when unreadable."""
    try:
        header, _ = split_gpkg_blob(blob)
        flags = header[GPKG_HEADER_FLAG_BYTE]
        indicator = (flags >> ENVELOPE_INDICATOR_SHIFT) & ENVELOPE_INDICATOR_MASK
        endian = "<" if flags & LITTLE_ENDIAN_FLAG_MASK else ">"
        if indicator:
            min_x, max_x, min_y, max_y = struct.unpack_from(
                f"{endian}dddd", header, GPKG_HEADER_FIXED_BYTES
            )
            return min_x, min_y, max_x, max_y
        points = _flatten_points(blob_geometry(blob)[1])
        if not points:
            return None
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        return min(xs), min(ys), max(xs), max(ys)
    except (ValueError, struct.error):
        return None


def _flatten_points(coordinates):
    """Every [x, y] anywhere in a nested coordinate structure."""
    if not coordinates:
        return []
    if not isinstance(coordinates[0], (list, tuple)):
        return [coordinates]
    points = []
    for part in coordinates:
        points.extend(_flatten_points(part))
    return points


# ---------------------------------------------------------------------------
# Polygon <-> MultiPolygon
# ---------------------------------------------------------------------------


def promote_polygon_blob_to_multipolygon(blob):
    """Wrap a Polygon blob as a single-part MultiPolygon; coordinates untouched."""
    header, wkb = split_gpkg_blob(blob)
    type_code, endian = wkb_geometry_type(wkb)
    if type_code != WKB_POLYGON:
        return blob
    order_byte = WKB_LITTLE_ENDIAN if endian == "<" else 0
    wrapper = struct.pack(
        f"{endian}BII", order_byte, WKB_MULTI_POLYGON, SINGLE_PART_COUNT
    )
    return header + wrapper + wkb


def demote_multipolygon_blob_to_polygon(blob):
    """Unwrap a single-part MultiPolygon back to a Polygon.

    Returns (blob, was_multipart). A genuinely multi-part geometry is returned
    unchanged, with the flag set, because dropping parts would lose ground.
    """
    header, wkb = split_gpkg_blob(blob)
    type_code, endian = wkb_geometry_type(wkb)
    if type_code != WKB_MULTI_POLYGON:
        return blob, False

    offset = WKB_BYTE_ORDER_BYTES + WKB_TYPE_BYTES
    (part_count,) = struct.unpack_from(f"{endian}I", wkb, offset)
    if part_count != SINGLE_PART_COUNT:
        return blob, True
    return header + wkb[offset + WKB_TYPE_BYTES:], False


def _ring_area(ring):
    """Shoelace area of a closed ring."""
    total = 0.0
    for index in range(1, len(ring)):
        x1, y1 = ring[index - 1]
        x2, y2 = ring[index]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def polygon_blob_area_sqm(blob):
    """Planar area of a Polygon/MultiPolygon blob, or None if not measurable."""
    try:
        type_name, coordinates = blob_geometry(blob)
    except (ValueError, struct.error):
        return None
    if type_name == "Polygon":
        rings = [coordinates]
    elif type_name == "MultiPolygon":
        rings = coordinates
    else:
        return None

    total = 0.0
    for polygon in rings:
        for index, ring in enumerate(polygon):
            area = _ring_area(ring)
            total += area if index == 0 else -area
    return total


def line_blob_length_m(blob):
    """Planar length of a LineString/MultiLineString blob, or None."""
    try:
        type_name, coordinates = blob_geometry(blob)
    except (ValueError, struct.error):
        return None
    if type_name == "LineString":
        parts = [coordinates]
    elif type_name == "MultiLineString":
        parts = coordinates
    else:
        return None

    total = 0.0
    for part in parts:
        for index in range(1, len(part)):
            x1, y1 = part[index - 1]
            x2, y2 = part[index]
            total += math.hypot(x2 - x1, y2 - y1)
    return total


# ---------------------------------------------------------------------------
# Canonical geometry checksum
#
# Must stay byte-identical to the backend's geometry-checksum.js and to the
# Python embedded in the QGIS template's copy actions: the three are one
# cross-language contract. Duplicate and collinear vertices are removed before
# serialising, so QGIS topological editing (which inserts a vertex into every
# coincident geometry when a parcel is sliced) cannot look like a real reshape.
# Canonicalisation is the identity on geometry that has neither, so checksums
# stamped from clean shapes keep matching.
# ---------------------------------------------------------------------------

VERTEX_TOLERANCE = 0.001  # metres; below the serialiser's 3-decimal rounding
COORD_DECIMALS = 3
CHECKSUM_HEX_LENGTH = 16


def _distance(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _perpendicular_distance(point, start, end):
    """Distance from `point` to the line through `start`/`end`."""
    span = _distance(start, end)
    if span < VERTEX_TOLERANCE:
        return 0.0
    cross = (end[0] - start[0]) * (point[1] - start[1]) - (
        end[1] - start[1]
    ) * (point[0] - start[0])
    return abs(cross) / span


def _dedupe_runs(points):
    """Drop consecutive points closer together than the tolerance."""
    if not points:
        return []
    kept = [points[0]]
    for point in points[1:]:
        if _distance(point, kept[-1]) >= VERTEX_TOLERANCE:
            kept.append(point)
    return kept


def _dedupe_open_path(points):
    """Dedupe a path, but never lose its final vertex."""
    kept = _dedupe_runs(points)
    last = points[-1]
    if kept[-1] is not last and kept[-1] != last:
        kept[-1] = last
    return kept


def _strip_collinear(points):
    """Stack pass removing any vertex lying on the segment between its
    neighbours; runs of inserted vertices collapse in one traversal."""
    result = []
    for point in points:
        while (
            len(result) >= MIN_LINE_VERTICES
            and _perpendicular_distance(result[-1], result[-2], point)
            < VERTEX_TOLERANCE
        ):
            result.pop()
        result.append(point)
    return result


def _canonicalise_line(points):
    deduped = _dedupe_open_path(points)
    stripped = _strip_collinear(deduped)
    return stripped if len(stripped) >= MIN_LINE_VERTICES else deduped


def _canonicalise_ring(ring):
    """Canonicalise a closed ring, including across its closing vertex."""
    if len(ring) < MIN_LINE_VERTICES:
        return ring
    points = _dedupe_runs(ring[:-1])
    if len(points) > 1 and _distance(points[0], points[-1]) < VERTEX_TOLERANCE:
        points.pop()

    deduped = list(points)
    points = _strip_collinear(points)

    # The strip above leaves the ring's first and last vertices in place; they
    # can still be collinear once the ring is closed, so re-test both ends.
    for _ in range(len(deduped)):
        if len(points) <= MIN_RING_VERTICES:
            break
        if _perpendicular_distance(points[0], points[-1], points[1]) < VERTEX_TOLERANCE:
            points.pop(0)
            continue
        if _perpendicular_distance(points[-1], points[-2], points[0]) < VERTEX_TOLERANCE:
            points.pop()
            continue
        break

    if len(points) < MIN_RING_VERTICES:
        points = deduped
    return points + [list(points[0])]


def canonicalise_coordinates(type_name, coordinates):
    """Canonical form of a geometry's coordinates, for checksumming only."""
    if type_name == "Point":
        return coordinates
    if type_name == "MultiPoint":
        return coordinates
    if type_name == "LineString":
        return _canonicalise_line(coordinates)
    if type_name == "MultiLineString":
        return [_canonicalise_line(part) for part in coordinates]
    if type_name == "Polygon":
        return [_canonicalise_ring(ring) for ring in coordinates]
    if type_name == "MultiPolygon":
        return [
            [_canonicalise_ring(ring) for ring in polygon] for polygon in coordinates
        ]
    return coordinates


def _serialise(coordinates):
    if not coordinates:
        return "()"
    if not isinstance(coordinates[0], (list, tuple)):
        x = f"%.{COORD_DECIMALS}f" % coordinates[0]
        y = f"%.{COORD_DECIMALS}f" % coordinates[1]
        return f"{x},{y}"
    return "(" + ";".join(_serialise(part) for part in coordinates) + ")"


def geometry_checksum(type_name, coordinates):
    """Stable short hash of a geometry's shape."""
    canonical = canonicalise_coordinates(type_name, coordinates)
    payload = f"{type_name.upper()}|{_serialise(canonical)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:CHECKSUM_HEX_LENGTH]


def blob_checksum(blob):
    """Canonical checksum of a stored geometry blob, or None when unreadable."""
    if blob is None:
        return None
    try:
        type_name, coordinates = blob_geometry(blob)
    except (ValueError, struct.error):
        return None
    return geometry_checksum(type_name, coordinates)


# ---------------------------------------------------------------------------
# SQLite helpers
# ---------------------------------------------------------------------------


def register_spatial_functions(conn):
    """Provide the ST_* functions the template's rtree triggers call.

    A GeoPackage written by QGIS carries spatial-index triggers that call
    ST_IsEmpty / ST_MinX / ST_MaxX / ST_MinY / ST_MaxY. Plain SQLite has no
    such functions, so inserting into such a file fails unless they are
    supplied. These are real implementations read from the blob envelope, so
    the spatial index stays correct.
    """

    def is_empty(blob):
        envelope = blob_envelope(blob) if blob else None
        return 1 if envelope is None else 0

    def bound(index):
        def read(blob):
            envelope = blob_envelope(blob) if blob else None
            return None if envelope is None else envelope[index]

        return read

    conn.create_function("ST_IsEmpty", 1, is_empty)
    conn.create_function("ST_MinX", 1, bound(0))
    conn.create_function("ST_MinY", 1, bound(1))
    conn.create_function("ST_MaxX", 1, bound(2))
    conn.create_function("ST_MaxY", 1, bound(3))


def read_srs_rows(conn):
    """Carry a source file's spatial reference definitions across verbatim."""
    rows = conn.execute(
        "SELECT srs_name, srs_id, organization, organization_coordsys_id, "
        "definition, description FROM gpkg_spatial_ref_sys"
    ).fetchall()
    return [tuple(row) for row in rows]


def create_gpkg_system_tables(conn, srs_rows):
    """Create the GeoPackage metadata tables and seed the SRS definitions."""
    conn.execute(f"PRAGMA application_id = {GPKG_APPLICATION_ID}")
    conn.execute(f"PRAGMA user_version = {GPKG_USER_VERSION}")
    conn.execute(
        """
        CREATE TABLE gpkg_spatial_ref_sys (
            srs_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL PRIMARY KEY,
            organization TEXT NOT NULL,
            organization_coordsys_id INTEGER NOT NULL,
            definition TEXT NOT NULL,
            description TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE gpkg_contents (
            table_name TEXT NOT NULL PRIMARY KEY,
            data_type TEXT NOT NULL,
            identifier TEXT UNIQUE,
            description TEXT DEFAULT '',
            last_change DATETIME NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
            srs_id INTEGER,
            CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id)
                REFERENCES gpkg_spatial_ref_sys(srs_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE gpkg_geometry_columns (
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL,
            geometry_type_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL,
            z TINYINT NOT NULL,
            m TINYINT NOT NULL,
            CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
            CONSTRAINT uk_gc_table_name UNIQUE (table_name),
            CONSTRAINT fk_gc_tn FOREIGN KEY (table_name)
                REFERENCES gpkg_contents(table_name),
            CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id)
                REFERENCES gpkg_spatial_ref_sys (srs_id)
        )
        """
    )
    conn.executemany(
        "INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)", srs_rows
    )


def create_feature_table(conn, table, geom_column, geom_type, columns):
    """Create one feature table and register it in the GeoPackage metadata."""
    column_sql = ", ".join(
        f"{quote_ident(name)} {sql_type}" for name, sql_type in columns
    )
    conn.execute(
        f"CREATE TABLE {quote_ident(table)} ("
        f"fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "
        f"{quote_ident(geom_column)} {geom_type}, "
        f"{column_sql})"
    )
    conn.execute(
        "INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id) "
        "VALUES (?,?,?,?)",
        (table, "features", table, BNG_SRS_ID),
    )
    conn.execute(
        "INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)",
        (table, geom_column, geom_type, BNG_SRS_ID, 0, 0),
    )


def update_layer_extent(conn, table, geom_column):
    """Fill gpkg_contents' bounding box, which QGIS uses to zoom to a layer."""
    rows = conn.execute(
        f"SELECT {quote_ident(geom_column)} FROM {quote_ident(table)}"
    ).fetchall()
    boxes = [blob_envelope(blob) for (blob,) in rows if blob is not None]
    boxes = [box for box in boxes if box]
    if not boxes:
        return
    conn.execute(
        "UPDATE gpkg_contents SET min_x=?, min_y=?, max_x=?, max_y=? "
        "WHERE table_name=?",
        (
            min(box[0] for box in boxes),
            min(box[1] for box in boxes),
            max(box[2] for box in boxes),
            max(box[3] for box in boxes),
            table,
        ),
    )


def feature_table_names(conn):
    """Every feature table this GeoPackage registers, as a set of names."""
    rows = conn.execute(
        "SELECT table_name FROM gpkg_contents WHERE data_type = 'features'"
    ).fetchall()
    return {row[0] for row in rows}


def resolve_table_name(candidates, present):
    """First accepted spelling of a table that `present` actually holds.

    `candidates` is ordered most-preferred first. Matching is by EXACT name and
    never by substring, so "Habitats Baseline" can never be resolved to — or
    confused with — "Vertical Area Habitats Baseline". Returns None when the
    file holds none of them, which callers must report rather than quietly
    treat as an empty layer.
    """
    for candidate in candidates:
        if candidate in present:
            return candidate
    return None


def quoted_names(names):
    """Render a list of candidate table names for a message."""
    return ", ".join(f'"{name}"' for name in names)


def read_feature_table(conn, table):
    """Read a feature table as dicts, with geometry under the `_geom` key."""
    exists = conn.execute(
        "SELECT 1 FROM gpkg_contents WHERE table_name = ? AND data_type = 'features'",
        (table,),
    ).fetchone()
    if not exists:
        return []

    geom_row = conn.execute(
        "SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?",
        (table,),
    ).fetchone()
    geom_column = geom_row[0] if geom_row else None

    cursor = conn.execute(f"SELECT * FROM {quote_ident(table)} ORDER BY fid")
    names = [description[0] for description in cursor.description]
    rows = []
    for values in cursor.fetchall():
        record = dict(zip(names, values))
        record["_geom"] = record.pop(geom_column, None) if geom_column else None
        rows.append(record)
    return rows
