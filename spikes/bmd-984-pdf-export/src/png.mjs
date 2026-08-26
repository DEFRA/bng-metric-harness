/**
 * Minimal 8-bit RGB PNG encoder built on `node:zlib`.
 *
 * Exists so the offline proof can synthesise its own basemap tiles without
 * sharp, node-canvas or any network access. pdfkit embeds PNG directly, so
 * these behave exactly like real OS tiles from the document's point of view.
 */

import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const BIT_DEPTH_8 = 8
const COLOUR_TYPE_RGB = 2
const CHANNELS = 3
const FILTER_NONE = 0

const CRC_TABLE = buildCrcTable()

function buildCrcTable() {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
}

function crc32(buf) {
  let crc = -1
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * A mutable RGB raster with just enough drawing to build a test basemap.
 */
export class Raster {
  constructor(width, height, fill = [255, 255, 255]) {
    this.width = width
    this.height = height
    this.data = Buffer.alloc(width * height * CHANNELS)
    for (let i = 0; i < width * height; i++) {
      this.data[i * CHANNELS] = fill[0]
      this.data[i * CHANNELS + 1] = fill[1]
      this.data[i * CHANNELS + 2] = fill[2]
    }
  }

  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return
    }
    const i = (y * this.width + x) * CHANNELS
    this.data[i] = r
    this.data[i + 1] = g
    this.data[i + 2] = b
  }

  fillRect(x0, y0, w, h, colour) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        this.set(x, y, colour)
      }
    }
  }

  verticalLine(x, colour, width = 1) {
    this.fillRect(x, 0, width, this.height, colour)
  }

  horizontalLine(y, colour, width = 1) {
    this.fillRect(0, y, this.width, width, colour)
  }

  /** Encode to a PNG buffer. */
  toPng() {
    // Each scanline is prefixed with its filter byte; filter 0 = none.
    const stride = this.width * CHANNELS
    const raw = Buffer.alloc((stride + 1) * this.height)
    for (let y = 0; y < this.height; y++) {
      raw[y * (stride + 1)] = FILTER_NONE
      this.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.width, 0)
    ihdr.writeUInt32BE(this.height, 4)
    ihdr[8] = BIT_DEPTH_8
    ihdr[9] = COLOUR_TYPE_RGB
    ihdr[10] = 0 // compression: deflate
    ihdr[11] = 0 // filter method: adaptive
    ihdr[12] = 0 // interlace: none

    return Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ])
  }
}
