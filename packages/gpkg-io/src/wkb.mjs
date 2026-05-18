/**
 * WKB (Well-Known Binary) encoders and GeoPackage Binary wrapper. Pure —
 * no I/O, no database, no SRS knowledge beyond the srsId int the caller
 * passes in.
 *
 * Envelopes are stored as [minX, maxX, minY, maxY] (the GeoPackage Binary
 * layout, *not* OGC envelope ordering).
 */

// WKB geometry type tags (OGC Simple Features).
const WKB_TYPE_POINT = 1;
const WKB_TYPE_LINESTRING = 2;
const WKB_TYPE_POLYGON = 3;

const ENV_MIN_X = 0;
const ENV_MAX_X = 1;
const ENV_MIN_Y = 2;
const ENV_MAX_Y = 3;

function writeDouble(buf, offset, val) {
  buf.writeDoubleLE(val, offset);
  return offset + 8;
}

function writeUInt32(buf, offset, val) {
  buf.writeUInt32LE(val, offset);
  return offset + 4;
}

/**
 * Compute the [minX, maxX, minY, maxY] envelope of a coordinate sequence.
 * Accepts a flat array of [x, y] pairs (e.g. a linestring or polygon ring).
 */
export function envelopeFromCoords(coords) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) {
      minX = x;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (y > maxY) {
      maxY = y;
    }
  }
  return [minX, maxX, minY, maxY];
}

/**
 * Mutate `envelope` in place to also cover `env`. Useful for accumulating
 * the bounding box across multiple features as they're inserted.
 */
export function expandEnvelope(envelope, env) {
  if (env[ENV_MIN_X] < envelope[ENV_MIN_X]) {
    envelope[ENV_MIN_X] = env[ENV_MIN_X];
  }
  if (env[ENV_MAX_X] > envelope[ENV_MAX_X]) {
    envelope[ENV_MAX_X] = env[ENV_MAX_X];
  }
  if (env[ENV_MIN_Y] < envelope[ENV_MIN_Y]) {
    envelope[ENV_MIN_Y] = env[ENV_MIN_Y];
  }
  if (env[ENV_MAX_Y] > envelope[ENV_MAX_Y]) {
    envelope[ENV_MAX_Y] = env[ENV_MAX_Y];
  }
}

/**
 * Encode a point as WKB (Well-Known Binary), little-endian.
 *
 * Layout: byteOrder (1) | wkbType (uint32 = 1) | x (float64) | y (float64)
 *
 * @see https://www.ogc.org/standard/sfa/
 */
export function encodeWkbPoint(x, y) {
  const buf = Buffer.alloc(1 + 4 + 16);
  let off = 0;
  buf[off] = 1;
  off += 1;
  off = writeUInt32(buf, off, WKB_TYPE_POINT);
  off = writeDouble(buf, off, x);
  writeDouble(buf, off, y);
  return buf;
}

/**
 * Encode a linestring as WKB (Well-Known Binary), little-endian.
 *
 * Layout: byteOrder (1) | wkbType (uint32 = 2) | numPoints (uint32) | points
 */
export function encodeWkbLineString(coords) {
  const buf = Buffer.alloc(1 + 4 + 4 + coords.length * 16);
  let off = 0;
  buf[off] = 1;
  off += 1;
  off = writeUInt32(buf, off, WKB_TYPE_LINESTRING);
  off = writeUInt32(buf, off, coords.length);
  for (const [x, y] of coords) {
    off = writeDouble(buf, off, x);
    off = writeDouble(buf, off, y);
  }
  return buf;
}

/**
 * Encode a polygon as WKB (Well-Known Binary), little-endian.
 *
 * The first ring is the exterior boundary; any subsequent rings are interior
 * holes.
 */
export function encodeWkbPolygon(rings) {
  let size = 1 + 4 + 4;
  for (const ring of rings) {
    size += 4 + ring.length * 16;
  }
  const buf = Buffer.alloc(size);
  let off = 0;
  buf[off] = 1;
  off += 1;
  off = writeUInt32(buf, off, WKB_TYPE_POLYGON);
  off = writeUInt32(buf, off, rings.length);
  for (const ring of rings) {
    off = writeUInt32(buf, off, ring.length);
    for (const [x, y] of ring) {
      off = writeDouble(buf, off, x);
      off = writeDouble(buf, off, y);
    }
  }
  return buf;
}

/**
 * Wrap a WKB geometry in a GeoPackage Binary header.
 *
 * Layout: magic ("GP") | version (0) | flags | srsId (uint32) | [envelope] | wkb
 *
 * The flags byte encodes byte order (bit 0, always 1 = little-endian) and
 * envelope type (bits 1-3). When an envelope is provided, type 1 stores
 * [minX, maxX, minY, maxY] as four doubles (32 bytes).
 *
 * @see https://www.geopackage.org/spec/#gpb_format
 */
export function encodeGpkgBinary(srsId, wkb, envelope) {
  const envType = envelope ? 1 : 0;
  const flags = 0x01 | (envType << 1);
  const envSize = envelope ? 32 : 0;
  const headerSize = 2 + 1 + 1 + 4 + envSize;
  const buf = Buffer.alloc(headerSize + wkb.length);
  let off = 0;
  buf[off] = 0x47; // 'G'
  off += 1;
  buf[off] = 0x50; // 'P'
  off += 1;
  buf[off] = 0;
  off += 1;
  buf[off] = flags;
  off += 1;
  off = writeUInt32(buf, off, srsId);
  if (envelope) {
    off = writeDouble(buf, off, envelope[ENV_MIN_X]);
    off = writeDouble(buf, off, envelope[ENV_MAX_X]);
    off = writeDouble(buf, off, envelope[ENV_MIN_Y]);
    off = writeDouble(buf, off, envelope[ENV_MAX_Y]);
  }
  wkb.copy(buf, off);
  return buf;
}

export function gpkgPolygon(srsId, ring) {
  return encodeGpkgBinary(srsId, encodeWkbPolygon([ring]), envelopeFromCoords(ring));
}

export function gpkgLineString(srsId, coords) {
  return encodeGpkgBinary(srsId, encodeWkbLineString(coords), envelopeFromCoords(coords));
}

export function gpkgPoint(srsId, x, y) {
  return encodeGpkgBinary(srsId, encodeWkbPoint(x, y), [x, x, y, y]);
}
