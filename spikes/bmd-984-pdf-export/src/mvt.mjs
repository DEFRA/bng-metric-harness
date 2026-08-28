/**
 * A minimal Mapbox Vector Tile (MVT) reader and writer.
 *
 * Hand-rolled for the same reason png.mjs is: the spike's headline claim is
 * that the whole pipeline needs no dependency beyond pdfkit, and MVT is small
 * enough to honour that. The format is protobuf, but only four wire types and
 * a dozen field numbers of it — see the MVT 2.1 spec and vector_tile.proto.
 *
 * The reader is what the PDF builder uses on real Ordnance Survey tiles. The
 * writer exists for the stub upstream and the tests, so decode can be proven
 * by round-trip against encode rather than trusted by eye.
 *
 * Coordinates are TILE-LOCAL integers in [0, extent) (plus a buffer margin
 * outside it — real tiles include geometry slightly beyond their edge so
 * neighbours can draw seamlessly; the drawing side must clip). Converting them
 * to ground coordinates is the caller's job, because only the caller knows
 * which (z, col, row) square of Britain the tile covers.
 */

/* ------------------------------------------------------- protobuf wire */

const WIRE_VARINT = 0
const WIRE_64BIT = 1
const WIRE_LENGTH = 2
const WIRE_32BIT = 5

// Field numbers from vector_tile.proto.
const TILE_LAYER = 3
const LAYER_NAME = 1
const LAYER_FEATURE = 2
const LAYER_KEY = 3
const LAYER_VALUE = 4
const LAYER_EXTENT = 5
const LAYER_VERSION = 15
const FEATURE_TAGS = 2
const FEATURE_TYPE = 3
const FEATURE_GEOMETRY = 4
const VALUE_STRING = 1
const VALUE_FLOAT = 2
const VALUE_DOUBLE = 3
const VALUE_INT = 4
const VALUE_UINT = 5
const VALUE_SINT = 6
const VALUE_BOOL = 7

// Geometry command integers: id in the low 3 bits, repeat count above them.
const CMD_MOVE_TO = 1
const CMD_LINE_TO = 2
const CMD_CLOSE_PATH = 7
const CMD_ID_BITS = 3
const CMD_ID_MASK = 0x7

export const GEOMETRY_POINT = 1
export const GEOMETRY_LINE = 2
export const GEOMETRY_POLYGON = 3
export const DEFAULT_EXTENT = 4096

const VARINT_CONTINUE = 0x80
const VARINT_DATA_MASK = 0x7f
const VARINT_DATA_BITS = 7

/* ------------------------------------------------------------- reading */

function readVarint(buffer, state) {
  let value = 0
  let multiplier = 1
  for (;;) {
    const byte = buffer[state.pos++]
    value += (byte & VARINT_DATA_MASK) * multiplier
    if ((byte & VARINT_CONTINUE) === 0) {
      return value
    }
    multiplier *= 128
  }
}

function zigzagDecode(value) {
  return value % 2 === 1 ? -(value + 1) / 2 : value / 2
}

function skipField(buffer, state, wireType) {
  if (wireType === WIRE_VARINT) {
    readVarint(buffer, state)
  } else if (wireType === WIRE_64BIT) {
    state.pos += 8
  } else if (wireType === WIRE_LENGTH) {
    state.pos += readVarint(buffer, state)
  } else if (wireType === WIRE_32BIT) {
    state.pos += 4
  } else {
    throw new Error(`Unsupported protobuf wire type ${wireType}`)
  }
}

/**
 * Walk one length-delimited message, calling onField(fieldNumber, wireType,
 * state) for each field. The callback must consume exactly its own bytes.
 */
function readMessage(buffer, state, end, onField) {
  while (state.pos < end) {
    const tag = readVarint(buffer, state)
    onField(tag >> CMD_ID_BITS, tag & CMD_ID_MASK, state)
  }
}

function readValue(buffer, state) {
  const length = readVarint(buffer, state)
  const end = state.pos + length
  let value = null
  readMessage(buffer, state, end, (field, wireType) => {
    if (field === VALUE_STRING) {
      const length = readVarint(buffer, state)
      value = buffer.toString('utf8', state.pos, state.pos + length)
      state.pos += length
    } else if (field === VALUE_DOUBLE) {
      value = buffer.readDoubleLE(state.pos)
      state.pos += 8
    } else if (field === VALUE_FLOAT) {
      value = buffer.readFloatLE(state.pos)
      state.pos += 4
    } else if (field === VALUE_INT || field === VALUE_UINT) {
      value = readVarint(buffer, state)
    } else if (field === VALUE_SINT) {
      value = zigzagDecode(readVarint(buffer, state))
    } else if (field === VALUE_BOOL) {
      value = readVarint(buffer, state) !== 0
    } else {
      skipField(buffer, state, wireType)
    }
  })
  return value
}

/**
 * Decode a packed geometry field into paths.
 *
 * A path is an array of [x, y] tile-local vertices: one ring of a polygon, one
 * line of a (multi)linestring, or a single point. ClosePath does NOT repeat
 * the first vertex — the drawing side closes the shape itself.
 */
export function decodeGeometry(commands) {
  const paths = []
  let x = 0
  let y = 0
  let path = null

  for (let i = 0; i < commands.length; ) {
    const command = commands[i++]
    const id = command & CMD_ID_MASK
    let count = command >> CMD_ID_BITS

    if (id === CMD_CLOSE_PATH) {
      path = null
      continue
    }
    while (count-- > 0) {
      x += zigzagDecode(commands[i++])
      y += zigzagDecode(commands[i++])
      if (id === CMD_MOVE_TO) {
        path = [[x, y]]
        paths.push(path)
      } else if (id === CMD_LINE_TO) {
        path.push([x, y])
      } else {
        throw new Error(`Unknown geometry command ${id}`)
      }
    }
  }
  return paths
}

function readPackedVarints(buffer, state) {
  const length = readVarint(buffer, state)
  const end = state.pos + length
  const values = []
  while (state.pos < end) {
    values.push(readVarint(buffer, state))
  }
  return values
}

function readFeature(buffer, start, end, layer) {
  const state = { pos: start }
  const feature = { type: 0, properties: {}, paths: [] }
  let tags = []

  readMessage(buffer, state, end, (field, wireType) => {
    if (field === FEATURE_TYPE) {
      feature.type = readVarint(buffer, state)
    } else if (field === FEATURE_TAGS) {
      tags = readPackedVarints(buffer, state)
    } else if (field === FEATURE_GEOMETRY) {
      feature.paths = decodeGeometry(readPackedVarints(buffer, state))
    } else {
      skipField(buffer, state, wireType)
    }
  })

  // Tags come as key-index/value-index pairs into the layer's shared pools.
  for (let i = 0; i + 1 < tags.length; i += 2) {
    feature.properties[layer.keys[tags[i]]] = layer.values[tags[i + 1]]
  }
  return feature
}

function readLayer(buffer, state) {
  const length = readVarint(buffer, state)
  const end = state.pos + length
  const layer = { name: '', extent: DEFAULT_EXTENT, keys: [], values: [], features: [] }
  const featureSpans = []

  readMessage(buffer, state, end, (field, wireType) => {
    if (field === LAYER_NAME) {
      const length = readVarint(buffer, state)
      layer.name = buffer.toString('utf8', state.pos, state.pos + length)
      state.pos += length
    } else if (field === LAYER_KEY) {
      const length = readVarint(buffer, state)
      layer.keys.push(buffer.toString('utf8', state.pos, state.pos + length))
      state.pos += length
    } else if (field === LAYER_VALUE) {
      layer.values.push(readValue(buffer, state))
    } else if (field === LAYER_EXTENT) {
      layer.extent = readVarint(buffer, state)
    } else if (field === LAYER_FEATURE) {
      // Features reference the key/value pools, which may arrive AFTER them in
      // the byte stream — remember the span, decode once the pools are known.
      const length = readVarint(buffer, state)
      featureSpans.push([state.pos, length])
      state.pos += length
    } else {
      skipField(buffer, state, wireType)
    }
  })

  for (const [start, length] of featureSpans) {
    layer.features.push(readFeature(buffer, start, start + length, layer))
  }
  return layer
}

/**
 * Decode a whole tile.
 *
 * @param {Buffer} buffer
 * @returns {{ layers: Record<string, object> }} layers by name, each
 *   { name, extent, features: [{ type, properties, paths }] }
 */
export function decodeVectorTile(buffer) {
  const state = { pos: 0 }
  const layers = {}

  readMessage(buffer, state, buffer.length, (field, wireType) => {
    if (field === TILE_LAYER) {
      const layer = readLayer(buffer, state)
      layers[layer.name] = layer
    } else {
      skipField(buffer, state, wireType)
    }
  })
  return { layers }
}

/* ------------------------------------------------------------- writing */

function zigzagEncode(value) {
  return value < 0 ? -value * 2 - 1 : value * 2
}

class Writer {
  constructor() {
    this.bytes = []
  }

  varint(value) {
    let remaining = value
    while (remaining >= 128) {
      this.bytes.push((remaining % 128) + VARINT_CONTINUE)
      remaining = Math.floor(remaining / 128)
    }
    this.bytes.push(remaining)
  }

  tag(field, wireType) {
    this.varint(field * 8 + wireType)
  }

  lengthDelimited(field, payloadBytes) {
    this.tag(field, WIRE_LENGTH)
    this.varint(payloadBytes.length)
    this.bytes.push(...payloadBytes)
  }

  string(field, text) {
    this.lengthDelimited(field, [...Buffer.from(text, 'utf8')])
  }

  toBuffer() {
    return Buffer.from(this.bytes)
  }
}

function encodeValue(value) {
  const writer = new Writer()
  if (typeof value === 'string') {
    writer.string(VALUE_STRING, value)
  } else if (typeof value === 'boolean') {
    writer.tag(VALUE_BOOL, WIRE_VARINT)
    writer.varint(value ? 1 : 0)
  } else if (Number.isInteger(value)) {
    writer.tag(VALUE_SINT, WIRE_VARINT)
    writer.varint(zigzagEncode(value))
  } else {
    writer.tag(VALUE_DOUBLE, WIRE_64BIT)
    const scratch = Buffer.alloc(8)
    scratch.writeDoubleLE(value)
    writer.bytes.push(...scratch)
  }
  return writer.bytes
}

function commandInteger(id, count) {
  return (count << CMD_ID_BITS) | id
}

function encodeGeometry(type, paths) {
  const commands = []
  let x = 0
  let y = 0

  const push = (vertex) => {
    commands.push(zigzagEncode(vertex[0] - x), zigzagEncode(vertex[1] - y))
    ;[x, y] = vertex
  }

  if (type === GEOMETRY_POINT) {
    commands.push(commandInteger(CMD_MOVE_TO, paths.length))
    for (const path of paths) {
      push(path[0])
    }
    return commands
  }

  for (const path of paths) {
    commands.push(commandInteger(CMD_MOVE_TO, 1))
    push(path[0])
    commands.push(commandInteger(CMD_LINE_TO, path.length - 1))
    for (const vertex of path.slice(1)) {
      push(vertex)
    }
    if (type === GEOMETRY_POLYGON) {
      commands.push(commandInteger(CMD_CLOSE_PATH, 1))
    }
  }
  return commands
}

function encodeFeature(feature, keyPool, valuePool) {
  const writer = new Writer()

  const tags = []
  for (const [key, value] of Object.entries(feature.properties ?? {})) {
    tags.push(poolIndex(keyPool, key), poolIndex(valuePool, JSON.stringify(value)))
  }
  if (tags.length > 0) {
    const packed = new Writer()
    for (const tag of tags) {
      packed.varint(tag)
    }
    writer.lengthDelimited(FEATURE_TAGS, packed.bytes)
  }

  writer.tag(FEATURE_TYPE, WIRE_VARINT)
  writer.varint(feature.type)

  const geometry = new Writer()
  for (const command of encodeGeometry(feature.type, feature.paths)) {
    geometry.varint(command)
  }
  writer.lengthDelimited(FEATURE_GEOMETRY, geometry.bytes)
  return writer.bytes
}

function poolIndex(pool, item) {
  if (!pool.has(item)) {
    pool.set(item, pool.size)
  }
  return pool.get(item)
}

function encodeLayer(layer) {
  const writer = new Writer()
  writer.tag(LAYER_VERSION, WIRE_VARINT)
  writer.varint(2)
  writer.string(LAYER_NAME, layer.name)

  const keyPool = new Map()
  const valuePool = new Map() // JSON-keyed so 1 and '1' stay distinct

  for (const feature of layer.features) {
    writer.lengthDelimited(LAYER_FEATURE, encodeFeature(feature, keyPool, valuePool))
  }
  for (const key of keyPool.keys()) {
    writer.string(LAYER_KEY, key)
  }
  for (const encoded of valuePool.keys()) {
    writer.lengthDelimited(LAYER_VALUE, encodeValue(JSON.parse(encoded)))
  }

  writer.tag(LAYER_EXTENT, WIRE_VARINT)
  writer.varint(layer.extent ?? DEFAULT_EXTENT)
  return writer.bytes
}

/**
 * Encode a tile.
 *
 * @param {Array<{name, extent?, features: [{type, properties?, paths}]}>} layers
 * @returns {Buffer}
 */
export function encodeVectorTile(layers) {
  const writer = new Writer()
  for (const layer of layers) {
    writer.lengthDelimited(TILE_LAYER, encodeLayer(layer))
  }
  return writer.toBuffer()
}
