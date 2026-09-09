/**
 * Page geometry and palette, in one place.
 *
 * Extracted from `document.mjs` when the card layout arrived: two layouts that
 * disagree about the margin produce two documents that look subtly different
 * for no stated reason, and the disagreement is invisible until someone puts
 * the pages side by side. Shared constants make that impossible rather than
 * unlikely.
 *
 * The names and values match `bng-metric-backend/src/services/report/pdf/layout.js`
 * so the two can be read against each other.
 */

export const A4_PORTRAIT = [595.28, 841.89]
export const A4_PORTRAIT_HEIGHT = A4_PORTRAIT[1]
export const MARGIN = 40
export const CONTENT_WIDTH = A4_PORTRAIT[0] - MARGIN * 2

// GOV.UK palette (govuk-frontend colour names).
export const INK = '#0b0c0c'
export const MUTED = '#505a5f'
export const BORDER = '#b1b4b6'
export const MAP_GROUND = '#f8f8f8'
export const CONTEXT_FILL = '#d8d4d0'
export const CONTEXT_STROKE = '#b1b4b6'

export const FONT_SIZE = Object.freeze({
  title: 22,
  sectionHeading: 15,
  subHeading: 14,
  intro: 10,
  body: 9.5,
  bodySmall: 9,
  tableCell: 8.5,
  legend: 7.5
})

export const SITE_MAP_HEIGHT = 210
export const MAP_PAD = 0.08

/* --------------------------------------------------------- table layout */

export const MINI_MAP_SIZE = 52
export const MINI_MAP_PAD = 0.35
export const HABITAT_ROW_HEIGHT = 62

/* ---------------------------------------------------------- card layout */

/**
 * A card's map is nearly twice the thumbnail in the table, because a card has
 * the height to spend on it — and at 34 mm the parcel outline is legible
 * rather than merely present.
 */
export const CARD_MAP_SIZE = 96
export const CARD_GUTTER = 12
export const CARD_PADDING = 10
export // 20, not the heading's own 14pt: the first attribute line starts exactly this
// far below the top of the card, so anything tighter has "Broad habitat:"
// crowding the descenders of the parcel name above it.
const CARD_HEADING_HEIGHT = 20
export const CARD_LINE_HEIGHT = 12
export const CARD_LABEL_WIDTH = 96
export const CARD_GAP = 10
export const CARD_TOP_GAP = 10

export const SQ_M_PER_HECTARE = 10_000
export const PARCEL_HECTARE_DECIMALS = 3
