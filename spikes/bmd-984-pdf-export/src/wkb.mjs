/**
 * GeoPackage Binary + WKB decoder — dependency-free.
 *
 * The production path (`bng-library/gpkg-io`) uses better-sqlite3 + wkx for
 * this. Neither is installed in the spike, and Node 24 ships `node:sqlite`,
 * so the only missing piece was the geometry decode. The layout below matches
 * `bng-library/src/gpkg-io/src/wkb.mjs`, which is the reference.
 *
 * Nothing here is spike-specific: it is the OGC format. If this graduates,
 * delete it and call `wkbToGeoJSON` from the library instead.
 */

// GeoPackage Binary header: magic(2) + version(1) + flags(1) + srsId(4)
const GPB_MAGIC_G = 0x47
const GPB_MAGIC_P = 0x50
const GPB_SRS_OFFSET = 4
const GPB_ENVELOPE_OFFSET = 8
const GPB_FLAG_ENVELOPE_SHIFT = 1
const GPB_FLAG_ENVELOPE_MASK = 0x07
// Envelope byte size indexed by envelope type (flags bits 1-3).
const GPB_ENVELOPE_BYTES = [0, 32, 48, 48, 64]

// WKB geometry type tags (OGC Simple Features).
const WKB_POINT = 1
const WKB_LINESTRING = 2
const WKB_POLYGON = 3
const WKB_MULTIPOINT = 4
const WKB_MULTILINESTRING = 5
const WKB_MULTIPOLYGON = 6
const WKB_GEOMETRYCOLLECTION = 7

// WKB type tags carry dimensionality in the high digits: 1000 = Z, 2000 = M,
// 3000 = ZM. The base tag is the remainder, and the extra ordinates are read
// and discarded — this spike is strictly 2D.
const WKB_DIMENSION_DIVISOR = 1000
const ORDINATES_BY_DIMENSION = [2, 3, 3, 4]

/**
 * Split a GeoPackage Binary blob into its srsId and the WKB that follows the
 * (variable-length, optional) envelope.
 *
 * @param {Buffer|Uint8Array} blob
 * @returns {{ srsId: number, wkb: Buffer }}
 */
export function decodeGpkgBinary(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (buf[0] !== GPB_MAGIC_G || buf[1] !== GPB_MAGIC_P) {
    throw new Error('Not a GeoPackage Binary blob (bad magic)')
  }

  const flags = buf[3]
  const littleEndian = (flags & 0x01) === 1
  const srsId = littleEndian
    ? buf.readInt32LE(GPB_SRS_OFFSET)
    : buf.readInt32BE(GPB_SRS_OFFSET)

  const envelopeType = (flags >> GPB_FLAG_ENVELOPE_SHIFT) & GPB_FLAG_ENVELOPE_MASK
  const envelopeBytes = GPB_ENVELOPE_BYTES[envelopeType]
  if (envelopeBytes === undefined) {
    throw new Error(`Unknown GeoPackage envelope type ${envelopeType}`)
  }

  return { srsId, wkb: buf.subarray(GPB_ENVELOPE_OFFSET + envelopeBytes) }
}

/**
 * A cursor over a WKB buffer. Each geometry in a multi-part WKB carries its
 * own byte-order flag, so endianness is re-read per geometry rather than
 * fixed for the whole buffer.
 */
class WkbReader {
  constructor(buf) {
    this.buf = buf
    this.offset = 0
    this.littleEndian = true
  }

  readByteOrder() {
    this.littleEndian = this.buf.readUInt8(this.offset) === 1
    this.offset += 1
  }

  readUInt32() {
    const value = this.littleEndian
      ? this.buf.readUInt32LE(this.offset)
      : this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return value
  }

  readDouble() {
    const value = this.littleEndian
      ? this.buf.readDoubleLE(this.offset)
      : this.buf.readDoubleBE(this.offset)
    this.offset += 8
    return value
  }

  /** Read one [x, y], skipping any Z/M ordinates the type declares. */
  readPoint(ordinates) {
    const x = this.readDouble()
    const y = this.readDouble()
    for (let i = 2; i < ordinates; i++) {
      this.readDouble()
    }
    return [x, y]
  }

  readRing(ordinates) {
    const count = this.readUInt32()
    const ring = new Array(count)
    for (let i = 0; i < count; i++) {
      ring[i] = this.readPoint(ordinates)
    }
    return ring
  }

  readPolygon(ordinates) {
    const ringCount = this.readUInt32()
    const rings = new Array(ringCount)
    for (let i = 0; i < ringCount; i++) {
      rings[i] = this.readRing(ordinates)
    }
    return rings
  }
}

function readGeometry(reader) {
  reader.readByteOrder()
  const rawType = reader.readUInt32()
  const dimension = Math.floor(rawType / WKB_DIMENSION_DIVISOR)
  const ordinates = ORDINATES_BY_DIMENSION[dimension] ?? 2
  const type = rawType % WKB_DIMENSION_DIVISOR

  if (type === WKB_POINT) {
    return { type: 'Point', coordinates: reader.readPoint(ordinates) }
  }
  if (type === WKB_LINESTRING) {
    return { type: 'LineString', coordinates: reader.readRing(ordinates) }
  }
  if (type === WKB_POLYGON) {
    return { type: 'Polygon', coordinates: reader.readPolygon(ordinates) }
  }
  if (
    type === WKB_MULTIPOINT ||
    type === WKB_MULTILINESTRING ||
    type === WKB_MULTIPOLYGON ||
    type === WKB_GEOMETRYCOLLECTION
  ) {
    return readMultiGeometry(reader, type)
  }
  throw new Error(`Unsupported WKB geometry type ${rawType}`)
}

// Multi-part geometries are a count followed by complete, self-describing
// child WKB geometries — so each child re-reads its own byte order and type.
function readMultiGeometry(reader, type) {
  const count = reader.readUInt32()
  const parts = new Array(count)
  for (let i = 0; i < count; i++) {
    parts[i] = readGeometry(reader)
  }

  if (type === WKB_GEOMETRYCOLLECTION) {
    return { type: 'GeometryCollection', geometries: parts }
  }
  const names = {
    [WKB_MULTIPOINT]: 'MultiPoint',
    [WKB_MULTILINESTRING]: 'MultiLineString',
    [WKB_MULTIPOLYGON]: 'MultiPolygon'
  }
  return {
    type: names[type],
    coordinates: parts.map((part) => part.coordinates)
  }
}

/**
 * Decode a GeoPackage geometry blob to a GeoJSON geometry object.
 *
 * Coordinates are returned in the file's own SRS — no reprojection happens
 * here or anywhere in this spike.
 *
 * @param {Buffer|Uint8Array} blob
 * @returns {{ srsId: number, geometry: object }}
 */
export function gpkgBlobToGeometry(blob) {
  const { srsId, wkb } = decodeGpkgBinary(blob)
  return { srsId, geometry: readGeometry(new WkbReader(wkb)) }
}
