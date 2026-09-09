/**
 * Page 2 onwards, card layout: one card per habitat parcel.
 *
 * The alternative to the table in `document.mjs`, selected with `--cards`
 * (the default) and turned off with `--table`. Same data source, same
 * mini-map, different shape — and the difference is not cosmetic.
 *
 * A table has to fit every attribute into a column, so the number of
 * attributes it can carry is bounded by the width of the page. Five columns
 * already leaves "Artificial unvegetated, unsealed surface" wrapping in a
 * 150-point cell, which is why the table showed four of the twenty-four
 * attributes the GeoPackage actually holds. A card turns that ninety degrees:
 * each attribute gets a line of its own, so the report can show what the file
 * records — broad habitat, distinctiveness, strategic significance, retention,
 * spatial risk, the baseline the parcel is changing FROM, and the survey
 * provenance — instead of the four that happened to fit.
 *
 * Two consequences worth knowing:
 *
 *   1. **It sidesteps the `/Headers` problem.** The table layout is hand-laid,
 *      because a `doc.table()` cell cannot hold a drawing, and pdfkit only
 *      emits `/Headers` inside `doc.table()`. So its cells carry `/Scope` and
 *      nothing links a value back to the header describing it. A card has no
 *      columns to associate, so the question does not arise: each line is a
 *      paragraph reading "Condition: Poor", which needs no table navigation at
 *      all.
 *   2. **Cards are taller than rows**, so a card layout is longer — roughly
 *      two parcels a page against eleven. That is the trade for the extra
 *      attributes, and it is why this is a choice rather than a replacement.
 *
 * Cards are sized from their content. A parcel with no comment and no survey
 * details has those lines omitted rather than printed as blanks — an empty row
 * invites the reader to wonder what is missing, whereas a shorter card simply
 * says less.
 *
 * Ported from `bng-metric-backend/src/services/report/pdf/habitat-cards.js`,
 * which reads the same parcels out of PostGIS and the project document rather
 * than out of the file. The layout is deliberately identical; only the source
 * of the values differs.
 */

import { HABITAT_STYLES } from './map.mjs'
import { drawMiniMap, prepareThumbnails } from './thumbnail.mjs'
import { polygonAreaSqm } from './geometry.mjs'
import { BODY, BOLD, labelAsArtifact } from './page-furniture.mjs'
import {
  A4_PORTRAIT_HEIGHT, BORDER, CARD_GAP, CARD_GUTTER, CARD_HEADING_HEIGHT,
  CARD_LABEL_WIDTH, CARD_LINE_HEIGHT, CARD_MAP_SIZE, CARD_PADDING, CARD_TOP_GAP,
  CONTENT_WIDTH, FONT_SIZE, INK, MARGIN, MUTED, PARCEL_HECTARE_DECIMALS,
  SQ_M_PER_HECTARE
} from './layout.mjs'

/** Clear space between the end of the longest label and the value column. */
const CARD_LABEL_GAP = 8

/** Per-document, because the width depends on the fonts registered on it. */
const LABEL_WIDTHS = new WeakMap()

/**
 * The attributes a card can show, in reading order.
 *
 * Order is deliberate: what the parcel WILL BE, then what it is changing from,
 * then how it is judged and how big it is, then who recorded it. A reader
 * comparing two cards finds the same fact in the same place on both, which is
 * also why the two free-text fields sit at the end — an unbounded field in the
 * middle would push the fixed ones around from card to card.
 */
const CARD_FIELDS = Object.freeze([
  { key: 'broadType', label: 'Broad habitat' },
  { key: 'condition', label: 'Condition' },
  { key: 'distinctiveness', label: 'Distinctiveness' },
  { key: 'strategicSignificance', label: 'Strategic significance' },
  // The baseline the parcel is changing from. Absent on a baseline-only file,
  // where these columns are the ones already shown above and repeating them
  // would say the same thing twice.
  { key: 'baselineType', label: 'Baseline habitat' },
  { key: 'baselineBroadType', label: 'Baseline broad habitat' },
  { key: 'baselineCondition', label: 'Baseline condition' },
  { key: 'baselineDistinctiveness', label: 'Baseline distinctiveness' },
  { key: 'baselineStrategicSignificance', label: 'Baseline significance' },
  { key: 'retentionCategory', label: 'Retention' },
  { key: 'spatialRiskCategory', label: 'Spatial risk', wraps: true },
  { key: 'location', label: 'Location' },
  { key: 'area', label: 'Size' },
  { key: 'advanceOrDelay', label: 'Advance or delay' },
  { key: 'surveyDate', label: 'Surveyed' },
  { key: 'mappedBy', label: 'Mapped by' },
  { key: 'company', label: 'Company' },
  { key: 'baseMap', label: 'Base map' },
  // Free text, so these wrap. Last, for the reason given above.
  { key: 'surveyDetails', label: 'Survey details', wraps: true },
  { key: 'comment', label: 'Comment', wraps: true }
])

export async function addHabitatCards({
  doc, root, baseline, postIntervention, grid, tileSource, withBasemap, stats
}) {
  const site = postIntervention ?? baseline
  const label = postIntervention ? 'Post-intervention' : 'Baseline'
  const style = postIntervention
    ? HABITAT_STYLES.postIntervention
    : HABITAT_STYLES.baseline
  const features = site.layers.habitats?.features ?? []
  if (features.length === 0) {
    return
  }

  const section = doc.struct('Sect', { title: 'Habitat parcels' })
  root.add(section)

  doc.addPage()
  addIntroduction(doc, section, label)

  const thumbnails = await prepareThumbnails({
    features, grid, tileSource, withBasemap, size: CARD_MAP_SIZE
  })

  addCards({ doc, section, features, thumbnails, site, style, grid, stats })
  section.end()
}

function addIntroduction(doc, section, label) {
  section.add(
    doc.struct('H2', () => {
      doc.font(BOLD).fontSize(FONT_SIZE.sectionHeading).fillColor(INK)
      doc.text(`${label} habitat parcels `, MARGIN, MARGIN, { width: CONTENT_WIDTH })
    })
  )
  section.add(
    doc.struct('P', () => {
      doc.font(BODY).fontSize(FONT_SIZE.bodySmall).fillColor(MUTED)
      doc.text(
        'Each parcel is shown as a card: its shape and position among the neighbouring ' +
          'parcels, and every attribute recorded for it, each on its own line. Every value ' +
          'shown on a mini-map is also given as text on the same card, so no information ' +
          'depends on seeing the picture. ',
        { width: CONTENT_WIDTH }
      )
    })
  )
}

function addCards({ doc, section, features, thumbnails, site, style, grid, stats }) {
  let y = doc.y + CARD_TOP_GAP

  for (const feature of features) {
    const values = cardValues(feature)
    const height = cardHeight(doc, values)

    if (y + height > A4_PORTRAIT_HEIGHT - MARGIN) {
      doc.addPage()
      y = MARGIN
    }

    section.add(
      buildCard({
        doc, feature, values, y, height, style, site, grid,
        thumbnail: thumbnails.get(feature), stats
      })
    )
    y += height + CARD_GAP
    stats.habitats += 1
  }
}

/**
 * A card is as tall as its content, with a floor of the map it contains.
 *
 * The map is the tallest fixed thing on the card, so a parcel with only two
 * recorded attributes still gets a card big enough to draw it in.
 *
 * Measured rather than counted, because three of the fields are free text and
 * wrap. `heightOfString` asks pdfkit the same question the renderer will answer
 * when it draws, at the same width and font — the alternative is guessing at a
 * line count and finding out it was wrong by overrunning the card's own frame.
 */
export function cardHeight(doc, values) {
  const textHeight = CARD_HEADING_HEIGHT + fieldsHeight(doc, values) + CARD_PADDING * 2
  return Math.max(textHeight, CARD_MAP_SIZE + CARD_PADDING * 2)
}

/** The stacked height of every line this card will draw. */
function fieldsHeight(doc, values) {
  return presentFields(values).reduce(
    (total, field) => total + fieldHeight(doc, values, field),
    0
  )
}

function fieldHeight(doc, values, { key, wraps }) {
  if (!wraps) {
    return CARD_LINE_HEIGHT
  }
  // BOLD, not BODY: the value is drawn bold, and bold is the wider of the two.
  // Measuring in the lighter face reports fewer lines than the renderer will
  // draw, and the overflow lands outside the card's own border.
  doc.font(BOLD).fontSize(FONT_SIZE.bodySmall)
  const measured = doc.heightOfString(`${values[key]} `, { width: valueWidth(doc) })
  return Math.max(CARD_LINE_HEIGHT, measured)
}

/** Text column geometry, in one place so measuring and drawing cannot disagree. */
function textWidth() {
  return CONTENT_WIDTH - CARD_PADDING * 2 - CARD_MAP_SIZE - CARD_GUTTER
}

/**
 * The label column, measured from the labels rather than assumed.
 *
 * A label that does not fit its column wraps to a second line, and a
 * non-wrapping field advances by exactly one line height — so the wrapped label
 * would be drawn straight through the row beneath it. Sizing the column to the
 * widest label makes that impossible instead of merely unlikely.
 *
 * Measured rather than fixed because the typeface is a licensing decision that
 * has not been taken yet (GDS Transport instead of Noto Sans): a face a shade
 * wider would start overlapping rows on the page only, with every test green.
 */
export function labelWidth(doc) {
  const cached = LABEL_WIDTHS.get(doc)
  if (cached !== undefined) {
    return cached
  }
  doc.font(BODY).fontSize(FONT_SIZE.bodySmall)
  const widest = Math.max(...CARD_FIELDS.map(({ label }) => doc.widthOfString(`${label}: `)))
  const measured = Math.max(CARD_LABEL_WIDTH, Math.ceil(widest) + CARD_LABEL_GAP)
  LABEL_WIDTHS.set(doc, measured)
  return measured
}

function valueWidth(doc) {
  return textWidth() - labelWidth(doc)
}

/** Only the fields this parcel actually has a value for. */
function presentFields(values) {
  return CARD_FIELDS.filter(({ key }) => values[key] !== null)
}

function mapFrame(y) {
  return {
    x: MARGIN + CARD_PADDING,
    y: y + CARD_PADDING,
    width: CARD_MAP_SIZE,
    height: CARD_MAP_SIZE
  }
}

function buildCard({ doc, feature, values, y, height, style, site, grid, thumbnail, stats }) {
  drawCardFrame(doc, y, height)

  const frame = mapFrame(y)

  // Order matters, and getting it wrong is silent: the marked-content sequence
  // must be OPEN before anything is drawn into it. Drawing first and marking
  // afterwards yields a Figure wrapping an empty sequence, with every drawing
  // operation left as untagged, unartifacted content — PDF/UA 7.1-3. That is
  // exactly what the table layout did until veraPDF caught it.
  const figureContent = doc.markStructureContent('Figure')
  stats.tiles += drawMiniMap({ doc, frame, feature, style, site, grid, thumbnail }).tileCount
  doc.endMarkedContent()

  const textX = MARGIN + CARD_PADDING + CARD_MAP_SIZE + CARD_GUTTER

  return doc.struct('Sect', [
    cardHeading(doc, values, textX, y + CARD_PADDING, textWidth()),
    cardFigure(doc, frame, values, figureContent),
    ...cardLines(doc, values, textX, y + CARD_PADDING + CARD_HEADING_HEIGHT)
  ])
}

/**
 * The parcel's identity, as a real heading.
 *
 * H3 because the section's own heading is an H2. A screen reader can then jump
 * card to card by heading, which is the navigation a table would have given
 * through its rows.
 */
function cardHeading(doc, values, x, y, width) {
  return doc.struct('H3', () => {
    doc.font(BOLD).fontSize(FONT_SIZE.subHeading).fillColor(INK)
    doc.text(`${values.ref} — ${values.type} `, x, y, { width })
  })
}

/**
 * One paragraph per attribute, drawn as a label and a value.
 *
 * Visually two columns; semantically one sentence, "Condition: Poor". That is
 * what removes the need for the table `/Headers` the hand-laid layout cannot
 * emit — there is no cell to associate with a header, because there is no cell.
 */
function cardLines(doc, values, x, top) {
  let lineY = top
  return presentFields(values).map((field) => {
    const at = lineY
    lineY += fieldHeight(doc, values, field)
    return doc.struct('P', () => {
      doc.fontSize(FONT_SIZE.bodySmall)
      doc.font(BODY).fillColor(MUTED)
      doc.text(`${field.label}: `, x, at, { width: labelWidth(doc), continued: false })
      doc.font(BOLD).fillColor(INK)
      doc.text(`${values[field.key]} `, x + labelWidth(doc), at, { width: valueWidth(doc) })
    })
  })
}

/**
 * The alt text repeats no data — the card's own lines carry it — so it
 * describes only what the picture adds: shape and position.
 */
function cardFigure(doc, frame, values, figureContent) {
  return doc.struct(
    'Figure',
    {
      alt: `Outline of parcel ${values.ref}, shown in place among the neighbouring parcels. `,
      bbox: [frame.x, frame.y, frame.x + frame.width, frame.y + frame.height]
    },
    [figureContent]
  )
}

function drawCardFrame(doc, y, height) {
  labelAsArtifact(doc, () => {
    doc.save().lineWidth(0.6).strokeColor(BORDER)
    doc.rect(MARGIN, y, CONTENT_WIDTH, height).stroke()
    doc.restore()
  })
}

/**
 * Everything a card can show, already formatted, with `null` for anything the
 * file does not record. `ref` and `type` are exempt: they identify the parcel
 * and go in the heading, so they fall back to a dash rather than disappearing.
 *
 * The column names are the BNG GeoPackage template's own, spaces and all. The
 * backend reads the same parcels from the project document, where they have
 * already been named in camelCase — which is the only reason this function and
 * its backend twin are not the same code.
 */
export function cardValues(feature) {
  const properties = feature.properties ?? {}
  const proposedType = text(properties['Proposed Habitat Type'])

  // A post-intervention file carries both sides of the change; a baseline file
  // carries one. Showing the baseline group on a baseline file would print
  // every value twice, so the group is suppressed rather than duplicated.
  const baselineGroup = proposedType !== null

  return {
    ref: text(properties['Parcel Ref']) ?? '—',
    type: proposedType ?? text(properties['Baseline Habitat Type']) ?? '—',
    broadType: activeValue(properties, 'Broad Habitat Type'),
    condition: activeValue(properties, 'Condition'),
    distinctiveness: activeValue(properties, 'Distinctiveness'),
    strategicSignificance: activeValue(properties, 'Strategic Significance'),
    baselineType: baselineGroup ? text(properties['Baseline Habitat Type']) : null,
    baselineBroadType: baselineGroup
      ? text(properties['Baseline Broad Habitat Type'])
      : null,
    baselineCondition: baselineGroup ? text(properties['Baseline Condition']) : null,
    baselineDistinctiveness: baselineGroup
      ? text(properties['Baseline Distinctiveness'])
      : null,
    baselineStrategicSignificance: baselineGroup
      ? text(properties['Baseline Strategic Significance'])
      : null,
    retentionCategory: normaliseRetentionCategory(properties['Retention Category']),
    spatialRiskCategory: text(properties['Spatial risk category']),
    location: text(properties.Location),
    // Measured from the geometry, like every other area in this report, rather
    // than read from the file's own `Area` column. Page 1 says so, and the two
    // agree to under a square metre across the example files — which is what
    // independently validates the hand-rolled WKB decoder.
    area: `${(polygonAreaSqm(feature.geometry) / SQ_M_PER_HECTARE).toFixed(
      PARCEL_HECTARE_DECIMALS
    )} ha`,
    advanceOrDelay: advanceOrDelay(properties),
    surveyDate: text(properties['Survey Date']),
    mappedBy: text(properties['Mapped by']),
    company: text(properties.Company),
    baseMap: text(properties['Base Map']),
    surveyDetails: text(properties['Survey Details']),
    comment: text(properties.Comment)
  }
}

/**
 * The proposed value where the parcel has one, the baseline value otherwise —
 * the same rule the heading and the table both use, so a card cannot describe
 * a different side of the change from the row it replaced.
 */
function activeValue(properties, suffix) {
  return text(properties[`Proposed ${suffix}`]) ?? text(properties[`Baseline ${suffix}`])
}

/** Empty strings are as absent as nulls, and the file contains both. */
function text(value) {
  if (value === null || value === undefined) {
    return null
  }
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/**
 * "1. Retained" -> "Retained".
 *
 * The template's dropdown numbers its options, so the stored value carries the
 * list position. The service strips it on display; the report has to do the
 * same, or the report and the screen it was generated from describe the same
 * parcel differently.
 */
function normaliseRetentionCategory(value) {
  const trimmed = text(value)
  return trimmed === null ? null : trimmed.replace(/^\d+\.\s*/u, '') || null
}

/**
 * The two creation-timing columns, worded as one line.
 *
 * They are stored as numeric STRINGS ("0"), and nearly every parcel has zero
 * for both — printing "Advance or delay: 0" on twenty cards would be twenty
 * lines saying nothing, so the line is omitted unless one of them is set.
 *
 * Both set at once is not a state the metric should be in, but it is a state a
 * file can be in (see BMD-883), so it is reported rather than resolved here.
 */
function advanceOrDelay(properties) {
  const advance = years(properties['Habitat created in advance/years'])
  const delay = years(properties['Delay in starting habitat creation/years'])
  const parts = []
  if (advance > 0) {
    parts.push(`created ${plainYears(advance)} in advance`)
  }
  if (delay > 0) {
    parts.push(`creation delayed by ${plainYears(delay)}`)
  }
  if (parts.length === 0) {
    return null
  }
  const sentence = parts.join('; ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

function years(value) {
  const number = Number(text(value))
  return Number.isFinite(number) ? number : 0
}

function plainYears(count) {
  return `${count} ${count === 1 ? 'year' : 'years'}`
}

export { CARD_FIELDS }
