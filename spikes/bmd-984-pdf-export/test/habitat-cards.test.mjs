/**
 * The card layout, at the two points where it can be wrong without looking it.
 *
 *   1. **What each line says.** The values come from the GeoPackage's own
 *      column names, spaces and all, and a mistyped one yields a card that is
 *      simply missing a line — no error, and nothing in the PDF to notice.
 *   2. **How tall the card is.** Height is measured before the card is drawn;
 *      if the measurement is short, the last lines are drawn outside the card's
 *      own border, and every test still passes because the text is there.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import PDFDocument from 'pdfkit'

import { CARD_FIELDS, cardHeight, cardValues, labelWidth } from '../src/habitat-cards.mjs'
import { registerFonts } from '../src/page-furniture.mjs'
import {
  CARD_GUTTER, CARD_MAP_SIZE, CARD_PADDING, CONTENT_WIDTH
} from '../src/layout.mjs'

/** A 100 m square: one hectare, so the formatted size is checkable by hand. */
const SQUARE = {
  type: 'Polygon',
  coordinates: [[
    [412000, 287000], [412100, 287000], [412100, 287100], [412000, 287100],
    [412000, 287000]
  ]]
}

function parcel(properties) {
  return { geometry: SQUARE, properties }
}

const POST_INTERVENTION = parcel({
  'Parcel Ref': 'H001',
  'Baseline Habitat Type': 'Ponds (non-priority habitat)',
  'Baseline Broad Habitat Type': 'Lakes',
  'Baseline Condition': 'Moderate',
  'Baseline Distinctiveness': 'Medium',
  'Baseline Strategic Significance': 'Formally identified in local strategy',
  'Proposed Habitat Type': 'Bramble scrub',
  'Proposed Broad Habitat Type': 'Heathland and shrub',
  'Proposed Condition': 'Condition Assessment N/A',
  'Proposed Distinctiveness': 'Low',
  'Retention Category': '1. Retained',
  'Habitat created in advance/years': '0',
  'Delay in starting habitat creation/years': '0'
})

test('the active side is the proposed one where the parcel has it', () => {
  const values = cardValues(POST_INTERVENTION)

  assert.equal(values.type, 'Bramble scrub')
  assert.equal(values.broadType, 'Heathland and shrub')
  assert.equal(values.condition, 'Condition Assessment N/A')
  assert.equal(values.distinctiveness, 'Low')
})

test('a post-intervention parcel also shows the baseline it changes from', () => {
  const values = cardValues(POST_INTERVENTION)

  assert.equal(values.baselineType, 'Ponds (non-priority habitat)')
  assert.equal(values.baselineCondition, 'Moderate')
  assert.equal(values.baselineDistinctiveness, 'Medium')
})

test('a baseline-only parcel does not print every value twice', () => {
  const values = cardValues(parcel({
    'Parcel Ref': 'H001',
    'Baseline Habitat Type': 'Tall forbs',
    'Baseline Condition': 'Poor'
  }))

  assert.equal(values.type, 'Tall forbs', 'the heading still names the habitat')
  assert.equal(values.condition, 'Poor', 'and the baseline values still show')
  assert.equal(values.baselineType, null, 'but not a second time as a baseline line')
  assert.equal(values.baselineCondition, null)
})

test('the retention category loses the dropdown numbering', () => {
  assert.equal(cardValues(POST_INTERVENTION).retentionCategory, 'Retained')
  assert.equal(
    cardValues(parcel({ 'Retention Category': 'Lost' })).retentionCategory,
    'Lost'
  )
})

test('a blank column is as absent as a missing one', () => {
  const values = cardValues(parcel({ 'Parcel Ref': 'H002', Comment: '   ' }))

  assert.equal(values.comment, null)
  assert.equal(values.surveyDate, null)
  assert.equal(values.ref, 'H002')
})

test('the size is measured from the geometry, not read from a column', () => {
  // The `Area` column says something else on purpose: the report measures.
  const values = cardValues(parcel({ Area: 999_999 }))

  assert.equal(values.area, '1.000 ha')
})

test('a creation timing of zero is a line not worth printing', () => {
  assert.equal(cardValues(POST_INTERVENTION).advanceOrDelay, null)
})

test('advance and delay are worded, and singular where they should be', () => {
  const advance = cardValues(parcel({ 'Habitat created in advance/years': '1' }))
  assert.equal(advance.advanceOrDelay, 'Created 1 year in advance')

  const delay = cardValues(parcel({ 'Delay in starting habitat creation/years': '3' }))
  assert.equal(delay.advanceOrDelay, 'Creation delayed by 3 years')
})

test('a file setting both is reported as both, not resolved here', () => {
  // Not a state the metric should be in (BMD-883), but a state a file can be
  // in. The report says what the file says.
  const values = cardValues(parcel({
    'Habitat created in advance/years': '2',
    'Delay in starting habitat creation/years': '1'
  }))

  assert.equal(values.advanceOrDelay, 'Created 2 years in advance; creation delayed by 1 year')
})

test('an unidentified parcel still gets a heading', () => {
  const values = cardValues(parcel({}))

  assert.equal(values.ref, '—')
  assert.equal(values.type, '—')
})

/* ------------------------------------------------------------- measurement */

function measuringDocument() {
  const doc = new PDFDocument({ autoFirstPage: false })
  registerFonts(doc)
  return doc
}

test('a card is never shorter than the map it has to hold', () => {
  const doc = measuringDocument()
  const bare = cardValues(parcel({ 'Parcel Ref': 'H001' }))

  assert.ok(
    cardHeight(doc, bare) >= CARD_MAP_SIZE + CARD_PADDING * 2,
    'a parcel with almost no attributes still needs room for its thumbnail'
  )
})

test('more attributes make a taller card', () => {
  const doc = measuringDocument()

  assert.ok(
    cardHeight(doc, cardValues(POST_INTERVENTION)) >
      cardHeight(doc, cardValues(parcel({ 'Parcel Ref': 'H001' })))
  )
})

test('free text is measured, not assumed to be one line', () => {
  const doc = measuringDocument()
  const short = cardValues(parcel({ Comment: 'Fine.' }))
  const long = cardValues(parcel({ Comment: 'A comment long enough to wrap. '.repeat(12) }))

  assert.ok(
    cardHeight(doc, long) > cardHeight(doc, short),
    'a wrapping comment must lengthen the card, or it overruns its own border'
  )
})

test('the label column fits the longest label, and leaves the value room', () => {
  const doc = measuringDocument()
  const width = labelWidth(doc)
  const textWidth = CONTENT_WIDTH - CARD_PADDING * 2 - CARD_MAP_SIZE - CARD_GUTTER

  doc.font('Body').fontSize(9)
  const widest = Math.max(...CARD_FIELDS.map(({ label }) => doc.widthOfString(`${label}: `)))

  assert.ok(width >= widest, 'a label that wraps is drawn through the line below it')
  assert.ok(width < textWidth / 2, 'and the value column must stay the wider of the two')
})
