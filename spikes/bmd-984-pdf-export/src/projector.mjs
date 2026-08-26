/**
 * The world → page transform. This is the whole point of the spike.
 *
 * Two different things get drawn into a map frame: raster basemap tiles, and
 * vector habitat geometry. They line up because they are positioned by the
 * *same* function, not because two separate calculations were tuned until they
 * agreed.
 *
 * The enabling fact is that a map tile is not an arbitrary picture — it covers
 * an exact, known rectangle of ground. So a tile corner and a habitat vertex
 * are the same kind of thing: a coordinate in EPSG:27700. Both go through
 * `toPage`. Nothing on a map may be positioned any other way.
 *
 * Note pdfkit's user space: the origin is the page's TOP-LEFT and y increases
 * downward (see its docs on `rotate`, which default to "the origin (top left
 * corner) of the page"). Raw PDF user space is y-up; pdfkit is not. Northing
 * increases upward, so the y term inverts it once, via (maxY - N).
 */

/**
 * Force an envelope to the frame's aspect ratio by growing its short axis
 * about its centre.
 *
 * This is the single most common cause of a basemap that looks *nearly* right.
 * If the land extent and the frame are different shapes, x and y end up with
 * different scales, and every habitat is subtly stretched relative to the
 * tiles underneath. Growing (never cropping) keeps everything that was inside
 * the envelope inside it.
 *
 * @param {{minX,minY,maxX,maxY}} envelope in CRS units
 * @param {{width:number,height:number}} frame in PDF points
 */
export function fitEnvelopeToFrame(envelope, frame) {
  const width = envelope.maxX - envelope.minX
  const height = envelope.maxY - envelope.minY
  if (!(width > 0) || !(height > 0)) {
    throw new Error(
      'Cannot fit a degenerate envelope to a frame — pad it first (see padEnvelope)'
    )
  }

  const frameAspect = frame.width / frame.height
  const centreX = (envelope.minX + envelope.maxX) / 2
  const centreY = (envelope.minY + envelope.maxY) / 2

  if (width / height > frameAspect) {
    const targetHeight = width / frameAspect
    return {
      minX: envelope.minX,
      maxX: envelope.maxX,
      minY: centreY - targetHeight / 2,
      maxY: centreY + targetHeight / 2
    }
  }

  const targetWidth = height * frameAspect
  return {
    minX: centreX - targetWidth / 2,
    maxX: centreX + targetWidth / 2,
    minY: envelope.minY,
    maxY: envelope.maxY
  }
}

/**
 * Build the projector for one map frame.
 *
 * `extent` must already match the frame's aspect ratio — pass it through
 * `fitEnvelopeToFrame` first. That is asserted rather than silently corrected,
 * because a mismatch here is exactly the bug this module exists to prevent.
 *
 * @param {{minX,minY,maxX,maxY}} extent  the land visible in the frame
 * @param {{x,y,width,height}} frame      the frame on the page, in points
 */
const ASPECT_TOLERANCE = 1e-9

export function makeProjector(extent, frame) {
  const worldWidth = extent.maxX - extent.minX
  const worldHeight = extent.maxY - extent.minY

  const scaleX = frame.width / worldWidth
  const scaleY = frame.height / worldHeight
  if (Math.abs(scaleX - scaleY) > ASPECT_TOLERANCE * Math.max(scaleX, scaleY)) {
    throw new Error(
      `Extent aspect ${(worldWidth / worldHeight).toFixed(6)} does not match frame ` +
        `aspect ${(frame.width / frame.height).toFixed(6)} — call fitEnvelopeToFrame first. ` +
        'Unequal x/y scales are what make geometry drift against the basemap.'
    )
  }

  // PDF points per metre. One number for both axes, by construction.
  const scale = scaleX

  return {
    extent,
    frame,
    scale,

    /** Metres → points, for lengths (stroke widths, scale bars). */
    metresToPoints: (metres) => metres * scale,

    /** Points → metres, for choosing a zoom level from a frame size. */
    pointsToMetres: (points) => points / scale,

    /**
     * An EPSG:27700 easting/northing → a point on the page.
     * Every single thing drawn into this frame goes through here.
     */
    toPage: (easting, northing) => [
      frame.x + (easting - extent.minX) * scale,
      frame.y + (extent.maxY - northing) * scale
    ]
  }
}

/**
 * Convenience: pad an envelope, square it to the frame, and build the
 * projector — the sequence every caller wants.
 */
export function projectorFor(envelope, frame, { pad } = {}) {
  const padded =
    pad === undefined ? envelope : padEnvelopeInline(envelope, pad)
  return makeProjector(fitEnvelopeToFrame(padded, frame), frame)
}

// Kept inline (rather than importing geometry.mjs) so this module has no
// dependencies at all — it is the piece most worth reading in isolation.
function padEnvelopeInline(envelope, fraction) {
  const padX = (envelope.maxX - envelope.minX) * fraction
  const padY = (envelope.maxY - envelope.minY) * fraction
  return {
    minX: envelope.minX - padX,
    minY: envelope.minY - padY,
    maxX: envelope.maxX + padX,
    maxY: envelope.maxY + padY
  }
}
