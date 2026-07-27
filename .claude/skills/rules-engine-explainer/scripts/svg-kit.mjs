/**
 * Minimal dependency-free SVG primitives for the rules-engine charts.
 *
 * Everything is emitted as inline presentation attributes rather than a <style>
 * block, because the charts must survive three hostile renderers: GitHub strips
 * <style> from SVG, Confluence serves them as uploaded attachments, and MkDocs
 * embeds them as images. Inline attributes are the only styling all three honour.
 *
 * For the same reason the charts commit to a single light surface instead of
 * adapting to the viewer's theme — theme adaptation needs CSS that two of those
 * three renderers discard. On a dark background the chart reads as a light card.
 */

/** Validated palette slots (light surface). See dataviz references/palette.md. */
export const PALETTE = {
  surface: '#fcfcfb',
  border: '#e3e2dd',
  textPrimary: '#0b0b0b',
  textSecondary: '#52514e',
  textMuted: '#77756e',
  grid: '#eceae4',
  axis: '#c9c7c0',
  series1: '#2a78d6',
  series2: '#eb6834',
  series3: '#1baf7a',
  ghost: '#d8d6cf'
}

export const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/** Mark geometry, per the dataviz mark specs. */
export const MARK = {
  lineWidth: 2,
  markerRadius: 4,
  cornerRadius: 4,
  stackGap: 2,
  gridWidth: 1
}

const TITLE_SIZE = 15
const SUBTITLE_SIZE = 12
const LABEL_SIZE = 11
const VALUE_SIZE = 11
const LEGEND_SWATCH = 10
const LEGEND_GAP = 6
const LEGEND_ITEM_GAP = 18

export function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Build a linear scale mapping a numeric domain onto a pixel range.
 * @param {[number, number]} domain
 * @param {[number, number]} range
 */
export function linearScale([d0, d1], [r0, r1]) {
  const span = d1 - d0
  const scale = (value) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0))
  scale.domain = [d0, d1]
  scale.range = [r0, r1]
  return scale
}

export function text(content, x, y, options = {}) {
  const {
    size = LABEL_SIZE,
    fill = PALETTE.textSecondary,
    anchor = 'start',
    weight = 400,
    baseline = 'auto'
  } = options
  return (
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" ` +
    `font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ` +
    `dominant-baseline="${baseline}">${esc(content)}</text>`
  )
}

export function line(x1, y1, x2, y2, stroke, width = MARK.gridWidth) {
  return (
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
    `stroke="${stroke}" stroke-width="${width}" />`
  )
}

export function polyline(points, stroke, width = MARK.lineWidth) {
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x)},${round(y)}`).join(' ')
  return (
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" ` +
    `stroke-linejoin="round" stroke-linecap="round" />`
  )
}

export function circle(cx, cy, r, fill, ringColor = PALETTE.surface) {
  // A 2px surface ring keeps overlapping markers separable, per the mark specs.
  return (
    `<circle cx="${round(cx)}" cy="${round(cy)}" r="${r}" fill="${fill}" ` +
    `stroke="${ringColor}" stroke-width="2" />`
  )
}

/**
 * A bar with rounded corners only on its data end, anchored to the baseline.
 * @param {boolean} roundEnd - false for stacked segments below the top one.
 */
export function bar(x, y, width, height, fill, roundEnd = true) {
  if (height <= 0) {
    return ''
  }
  const r = Math.min(MARK.cornerRadius, height, width / 2)
  if (!roundEnd || r <= 0) {
    return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" fill="${fill}" />`
  }
  const x0 = round(x)
  const y0 = round(y)
  const w = round(width)
  const h = round(height)
  const d =
    `M${x0},${y0 + h} L${x0},${y0 + r} Q${x0},${y0} ${x0 + r},${y0} ` +
    `L${x0 + w - r},${y0} Q${x0 + w},${y0} ${x0 + w},${y0 + r} ` +
    `L${x0 + w},${y0 + h} Z`
  return `<path d="${d}" fill="${fill}" />`
}

export function legend(items, x, y) {
  let offset = x
  const parts = []
  for (const item of items) {
    parts.push(
      `<rect x="${offset}" y="${y - LEGEND_SWATCH + 1}" width="${LEGEND_SWATCH}" ` +
        `height="${LEGEND_SWATCH}" rx="2" fill="${item.color}" />`
    )
    parts.push(
      text(item.label, offset + LEGEND_SWATCH + LEGEND_GAP, y, {
        size: LABEL_SIZE,
        fill: PALETTE.textSecondary
      })
    )
    offset +=
      LEGEND_SWATCH + LEGEND_GAP + estimateTextWidth(item.label, LABEL_SIZE) + LEGEND_ITEM_GAP
  }
  return parts.join('\n  ')
}

/** Rough advance-width estimate; good enough to lay out a legend row. */
export function estimateTextWidth(value, size) {
  const AVERAGE_GLYPH_RATIO = 0.55
  return String(value).length * size * AVERAGE_GLYPH_RATIO
}

export function round(value) {
  const PRECISION = 100
  return Math.round(value * PRECISION) / PRECISION
}

export const CARD_PAD = 16
const TITLE_Y = 26
const SUBTITLE_TOP = 44
const SUBTITLE_LINE_HEIGHT = 16

/**
 * Greedy word wrap to a pixel width. SVG has no automatic text wrapping, so long
 * subtitles must be split into explicit lines or they run past the card edge.
 */
export function wrapText(content, maxWidth, size) {
  const words = String(content).split(/\s+/)
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (current && estimateTextWidth(candidate, size) > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) {
    lines.push(current)
  }
  return lines
}

/** Y coordinate where a chart's plot area can safely begin, given its subtitle. */
export function plotTopFor(subtitle, width) {
  const lines = subtitle
    ? wrapText(subtitle, width - CARD_PAD * 2, SUBTITLE_SIZE).length
    : 0
  const HEADROOM = 22
  return SUBTITLE_TOP + lines * SUBTITLE_LINE_HEIGHT + HEADROOM
}

/**
 * Wrap chart body markup in a titled surface card.
 */
export function card({ width, height, title, subtitle, body, footnote }) {
  const parts = [
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" ` +
      `fill="${PALETTE.surface}" stroke="${PALETTE.border}" stroke-width="1" />`,
    text(title, CARD_PAD, TITLE_Y, {
      size: TITLE_SIZE,
      fill: PALETTE.textPrimary,
      weight: 600
    })
  ]
  if (subtitle) {
    const lines = wrapText(subtitle, width - CARD_PAD * 2, SUBTITLE_SIZE)
    for (const [index, lineText] of lines.entries()) {
      parts.push(
        text(lineText, CARD_PAD, SUBTITLE_TOP + index * SUBTITLE_LINE_HEIGHT, {
          size: SUBTITLE_SIZE,
          fill: PALETTE.textSecondary
        })
      )
    }
  }
  parts.push(body)
  if (footnote) {
    parts.push(
      text(footnote, CARD_PAD, height - 12, {
        size: LABEL_SIZE,
        fill: PALETTE.textMuted
      })
    )
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">\n  ` +
    parts.filter(Boolean).join('\n  ') +
    '\n</svg>\n'
  )
}

export const SIZES = { TITLE_SIZE, SUBTITLE_SIZE, LABEL_SIZE, VALUE_SIZE }
