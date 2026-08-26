/**
 * The PDF itself: a tagged, PDF/UA-targeted site summary.
 *
 * Structure of the output:
 *   Page 1  site heading, key figures (pdfkit's built-in tagged table),
 *           baseline and post-intervention site maps side by side, legend
 *   Page 2+ one row per habitat parcel: mini-map, ref, type, condition, area
 *
 * Every map is a `Figure` with a bbox and alt text, and every map is followed
 * by the same information as real table rows — a map conveys nothing to a
 * screen reader, so the table is what actually carries the content.
 */

import PDFDocument from 'pdfkit'

import {
  drawBasemap, drawGeometry, drawGraticule, drawScaleBar, fetchTiles,
  withFrameClip, HABITAT_STYLES
} from './map.mjs'
import { envelopeOf, envelopeOfAll, polygonAreaSqm, lineLengthMetres } from './geometry.mjs'
import { pickZoom, effectiveDpi } from './grid.mjs'
import { fitEnvelopeToFrame, makeProjector, projectorFor } from './projector.mjs'

const A4_PORTRAIT = [595.28, 841.89]
const MARGIN = 40
const CONTENT_WIDTH = A4_PORTRAIT[0] - MARGIN * 2

// GOV.UK palette (govuk-frontend colour names).
const INK = '#0b0c0c'
const MUTED = '#505a5f'
const BORDER = '#b1b4b6'

const SITE_MAP_HEIGHT = 210
const MINI_MAP_SIZE = 52
const HABITAT_ROW_HEIGHT = 62
const MAP_PAD = 0.08

/**
 * Build the PDF.
 *
 * @param {object} options
 * @param {object} options.baseline    site read by readSite()
 * @param {object|null} options.postIntervention
 * @param {object} options.grid        tile matrix set
 * @param {Function} options.tileSource
 * @param {boolean} options.graticule  draw the registration proof overlay
 * @param {boolean} options.habitatBasemap  basemap behind each parcel thumbnail
 * @returns {Promise<{ doc: PDFDocument, stats: object }>}
 */
export async function buildSummaryPdf({
  baseline,
  postIntervention = null,
  grid,
  tileSource,
  graticule = false,
  habitatBasemap = false
}) {
  const siteName = baseline.siteName ?? 'BNG site'
  const title = `Biodiversity net gain summary — ${siteName}`

  const doc = new PDFDocument({
    size: A4_PORTRAIT,
    margin: MARGIN,
    // PDF/UA checklist, from pdfkit's accessibility docs.
    pdfVersion: '1.5',
    subset: 'PDF/UA',
    tagged: true,
    displayTitle: true,
    lang: 'en-GB',
    info: {
      Title: title,
      Author: 'Defra — Biodiversity Net Gain service',
      Subject: 'Site summary with baseline and post-intervention habitat mapping'
    }
  })

  const stats = { maps: 0, tiles: 0, habitats: 0, zooms: [] }
  const root = doc.struct('Document', { title })
  doc.addStructure(root)

  await addSummaryPage({ doc, root, baseline, postIntervention, grid, tileSource, graticule, stats, siteName })
  await addHabitatPages({
    doc, root, baseline, postIntervention, grid, tileSource,
    withBasemap: habitatBasemap, stats
  })

  root.end()
  return { doc, stats }
}

/* ------------------------------------------------------------------ page 1 */

async function addSummaryPage({
  doc, root, baseline, postIntervention, grid, tileSource, graticule, stats, siteName
}) {
  const section = doc.struct('Sect', { title: 'Site summary' })
  root.add(section)

  section.add(
    doc.struct('H1', () => {
      doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
      doc.text(`${siteName} `, MARGIN, MARGIN, { width: CONTENT_WIDTH })
    })
  )

  section.add(
    doc.struct('P', () => {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      doc.text(
        'Baseline and post-intervention habitat summary. All areas are measured from the ' +
          'supplied geometry on the British National Grid (EPSG:27700). ',
        { width: CONTENT_WIDTH }
      )
    })
  )

  doc.moveDown(0.8)
  addKeyFiguresTable(doc, section, baseline, postIntervention)

  doc.moveDown(1)
  section.add(
    doc.struct('H2', () => {
      doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
      doc.text('Site maps ', { width: CONTENT_WIDTH })
    })
  )

  const mapsTop = doc.y + 6
  const gutter = 16
  const mapWidth = (CONTENT_WIDTH - gutter) / 2

  // A single shared extent for both maps, so they are directly comparable —
  // the same ground at the same scale on both sides.
  const sharedEnvelope = envelopeOfAll(
    [baseline, postIntervention]
      .filter(Boolean)
      .map((site) => site.redLine?.geometry)
      .filter(Boolean)
  )

  const panels = [
    { label: 'Baseline', site: baseline, style: HABITAT_STYLES.baseline },
    postIntervention && {
      label: 'Post-intervention',
      site: postIntervention,
      style: HABITAT_STYLES.postIntervention
    }
  ].filter(Boolean)

  for (const [index, panel] of panels.entries()) {
    const frame = {
      x: MARGIN + index * (mapWidth + gutter),
      y: mapsTop + 14,
      width: mapWidth,
      height: SITE_MAP_HEIGHT
    }

    labelAsArtifact(doc, () => {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
      doc.text(`${panel.label} `, frame.x, mapsTop, { width: frame.width })
    })

    // All tile I/O happens before any drawing — see fetchTiles in map.mjs.
    const projector = projectorFor(sharedEnvelope, frame, { pad: MAP_PAD })
    const z = pickZoom(grid, projector.extent, frame.width)
    const { tiles, interval } = await fetchTiles(grid, z, projector.extent, tileSource)

    const drawn = drawSiteMap({
      doc, frame, site: panel.site, style: panel.style, grid, z, tiles, interval,
      graticule, projector
    })
    stats.maps += 1
    stats.tiles += drawn.tileCount
    stats.zooms.push(drawn.z)

    section.add(
      doc.struct('Figure', {
        alt: siteMapAltText(panel.label, panel.site, drawn),
        bbox: [frame.x, frame.y, frame.x + frame.width, frame.y + frame.height]
      }, [drawn.content])
    )
  }

  doc.y = mapsTop + 14 + SITE_MAP_HEIGHT + 26
  section.add(buildLegend(doc, panels))
  section.end()
}

/**
 * Draw one site map: basemap, then habitat layers, then furniture.
 *
 * Synchronous by design. Tiles are already in hand, so nothing can interleave
 * between the marked-content start and its end — which keeps both the visual
 * layering and the tagged reading order intact.
 *
 * Returns the marked structure content so the caller can wrap it in a Figure.
 */
function drawSiteMap({
  doc, frame, site, style, grid, z, tiles, interval, graticule, projector
}) {
  const content = doc.markStructureContent('Figure')

  let tileCount = 0
  withFrameClip(doc, frame, () => {
    tileCount = drawBasemap(doc, { grid, z, projector, tiles }).tileCount

    for (const habitat of site.layers.habitats?.features ?? []) {
      drawGeometry(doc, habitat.geometry, projector, style)
    }
    for (const hedgerow of site.layers.hedgerows?.features ?? []) {
      drawGeometry(doc, hedgerow.geometry, projector, HABITAT_STYLES.hedgerow)
    }
    for (const watercourse of site.layers.watercourses?.features ?? []) {
      drawGeometry(doc, watercourse.geometry, projector, HABITAT_STYLES.watercourse)
    }
    for (const tree of site.layers.trees?.features ?? []) {
      drawGeometry(doc, tree.geometry, projector, HABITAT_STYLES.tree)
    }
    if (site.redLine) {
      drawGeometry(doc, site.redLine.geometry, projector, HABITAT_STYLES.redLine)
    }
    if (graticule && interval) {
      drawGraticule(doc, projector, interval)
    }
  })

  doc.endMarkedContent()

  // Frame edge and scale bar are decoration, not content.
  labelAsArtifact(doc, () => {
    doc.save().lineWidth(0.6).strokeColor(BORDER)
    doc.rect(frame.x, frame.y, frame.width, frame.height).stroke()
    doc.restore()
    drawScaleBar(doc, projector, {
      x: frame.x + 6,
      y: frame.y + frame.height - 14,
      maxWidth: frame.width / 3
    })
  })

  return {
    content,
    tileCount,
    z,
    dpi: effectiveDpi(grid, z, projector.extent, frame.width),
    projector
  }
}

function siteMapAltText(label, site, drawn) {
  const habitats = site.layers.habitats?.features?.length ?? 0
  const hedgerows = site.layers.hedgerows?.features?.length ?? 0
  const watercourses = site.layers.watercourses?.features?.length ?? 0
  const area = site.redLine ? polygonAreaSqm(site.redLine.geometry) : 0
  const width = drawn.projector.extent.maxX - drawn.projector.extent.minX

  // Alt text says what the map shows, not that a map exists. The parcel-level
  // detail is in the table that follows, which is where a screen-reader user
  // gets the actual data.
  return (
    `${label} site map. Red line boundary enclosing ${(area / 10_000).toFixed(2)} hectares, ` +
    `containing ${habitats} habitat parcels, ${hedgerows} hedgerows and ${watercourses} watercourses. ` +
    `The map covers approximately ${Math.round(width)} metres across. ` +
    'Each parcel is listed with its area and condition in the habitat table that follows. '
  )
}

/* --------------------------------------------------------- key figures */

function addKeyFiguresTable(doc, section, baseline, postIntervention) {
  const rows = [
    ['Measure', 'Baseline', 'Post-intervention'],
    ...['habitats', 'hedgerows', 'watercourses', 'trees'].map((role) => [
      LAYER_LABELS[role],
      describeLayer(baseline, role),
      postIntervention ? describeLayer(postIntervention, role) : 'Not supplied'
    ])
  ]

  // pdfkit's built-in table generation (added in 0.17.0).
  //
  // `structParent` is what makes it accessible, and it is easy to get wrong:
  // pdfkit's table builds its OWN Table/TR/TH/TD structure and attaches it to
  // the element given here. Wrapping the call in `doc.struct('Table', () => …)`
  // instead looks right and renders identically, but emits a Table element
  // containing no rows at all — the cells become one undifferentiated marked
  // content sequence. Verified by counting /S /TD in the output.
  doc.font('Helvetica').fontSize(9.5).fillColor(INK)
  doc.table({
      structParent: section,
      columnStyles: ['*', 110, 110],
      rowStyles: (index) =>
        index === 0
          ? { border: [0, 0, 1.5, 0], borderColor: INK, font: 'Helvetica-Bold' }
          : { border: [0, 0, 0.5, 0], borderColor: BORDER },
      // `type` and `scope` are pdfkit's accessibility hooks for tables. Scope
      // is undocumented but supported ('Row' | 'Column' | 'Both'), and setting
      // it also makes pdfkit emit a /Headers array linking each data cell to
      // the headers that describe it — which is what a screen reader announces.
      data: rows.map((row, rowIndex) =>
        row.map((cell, columnIndex) => ({
          text: `${cell} `,
          ...headerRole(rowIndex, columnIndex)
        }))
      )
  })
}

/** Column headers scope down their column; the stub column scopes its row. */
function headerRole(rowIndex, columnIndex) {
  if (rowIndex === 0) {
    return { type: 'TH', scope: 'Column' }
  }
  if (columnIndex === 0) {
    return { type: 'TH', scope: 'Row' }
  }
  return { type: 'TD' }
}

const LAYER_LABELS = {
  habitats: 'Area habitats',
  hedgerows: 'Hedgerows',
  watercourses: 'Watercourses',
  trees: 'Individual trees'
}

function describeLayer(site, role) {
  const features = site.layers[role]?.features ?? []
  if (features.length === 0) {
    return 'None'
  }
  if (role === 'habitats') {
    const area = features.reduce((sum, f) => sum + polygonAreaSqm(f.geometry), 0)
    return `${features.length} parcels, ${(area / 10_000).toFixed(2)} ha`
  }
  if (role === 'trees') {
    return `${features.length} trees`
  }
  const length = features.reduce((sum, f) => sum + lineLengthMetres(f.geometry), 0)
  const noun = features.length === 1 ? 'feature' : 'features'
  return `${features.length} ${noun} (${Math.round(length)} m)`
}

/* ------------------------------------------------------------- legend */

function buildLegend(doc, panels) {
  const entries = [
    ['Red line boundary', HABITAT_STYLES.redLine.stroke],
    ...panels.map((panel) => [`${panel.label} parcel`, panel.style.fill]),
    ['Hedgerow', HABITAT_STYLES.hedgerow.stroke],
    ['Watercourse', HABITAT_STYLES.watercourse.stroke]
  ]

  // Share the content width evenly so labels never collide, whatever the
  // number of entries (a post-intervention file adds one).
  const columnWidth = CONTENT_WIDTH / entries.length
  const swatch = 8
  const top = doc.y

  labelAsArtifact(doc, () => {
    entries.forEach(([, colour], index) => {
      doc.save()
      doc
        .rect(MARGIN + index * columnWidth, top + 1, swatch, swatch)
        .fillColor(colour)
        .fillOpacity(0.75)
        .fill()
      doc.restore()
    })
  })

  // The legend's meaning is carried by text, not only by the swatch colours —
  // colour alone must never be the sole carrier of information.
  return doc.struct('P', () => {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    entries.forEach(([label], index) => {
      doc.text(`${label} `, MARGIN + swatch + 4 + index * columnWidth, top + 1, {
        width: columnWidth - swatch - 8,
        lineGap: -1
      })
    })
    doc.y = top + 20
  })
}

/* ------------------------------------------------------- habitat pages */

async function addHabitatPages({
  doc, root, baseline, postIntervention, grid, tileSource, withBasemap, stats
}) {
  const site = postIntervention ?? baseline
  const label = postIntervention ? 'Post-intervention' : 'Baseline'
  const style = postIntervention ? HABITAT_STYLES.postIntervention : HABITAT_STYLES.baseline
  const features = site.layers.habitats?.features ?? []
  if (features.length === 0) {
    return
  }

  const section = doc.struct('Sect', { title: 'Habitat parcels' })
  root.add(section)

  doc.addPage()
  section.add(
    doc.struct('H2', () => {
      doc.font('Helvetica-Bold').fontSize(15).fillColor(INK)
      doc.text(`${label} habitat parcels `, MARGIN, MARGIN, { width: CONTENT_WIDTH })
    })
  )
  section.add(
    doc.struct('P', () => {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      doc.text(
        'Each row shows one parcel: its shape and position among the neighbouring parcels, ' +
          'and its recorded attributes. Every value shown on a mini-map is also given as text ' +
          'in the same row, so no information depends on seeing the picture. ',
        { width: CONTENT_WIDTH }
      )
    })
  )

  const table = doc.struct('Table')
  section.add(table)

  // Prefetch every thumbnail's tiles before drawing starts. A mini-map frame
  // is always the same size, so its extent — and therefore its tile set — does
  // not depend on where the row lands on the page.
  const thumbnails = await prepareThumbnails({
    features, grid, tileSource, withBasemap
  })

  const columns = habitatColumns()
  let y = doc.y + 10
  table.add(buildHeaderRow(doc, columns, y))
  y += 20

  for (const feature of features) {
    if (y + HABITAT_ROW_HEIGHT > A4_PORTRAIT[1] - MARGIN) {
      doc.addPage()
      y = MARGIN
      table.add(buildHeaderRow(doc, columns, y))
      y += 20
    }

    table.add(buildHabitatRow({
      doc, feature, columns, y, style, site, grid,
      thumbnail: thumbnails.get(feature), stats
    }))
    y += HABITAT_ROW_HEIGHT
    stats.habitats += 1
  }

  table.end()
  section.end()
}

/**
 * Work out each thumbnail's extent and fetch its tiles, before any drawing.
 */
async function prepareThumbnails({ features, grid, tileSource, withBasemap }) {
  const square = { x: 0, y: 0, width: MINI_MAP_SIZE, height: MINI_MAP_SIZE }
  const thumbnails = new Map()

  for (const feature of features) {
    const padded = padEnvelopeBy(envelopeOf(feature.geometry), MINI_MAP_PAD)
    const extent = fitEnvelopeToFrame(padded, square)

    if (!withBasemap) {
      thumbnails.set(feature, { extent, z: null, tiles: null })
      continue
    }
    const z = pickZoom(grid, extent, square.width, 150)
    const { tiles } = await fetchTiles(grid, z, extent, tileSource)
    thumbnails.set(feature, { extent, z, tiles })
  }
  return thumbnails
}

function padEnvelopeBy(envelope, fraction) {
  const padX = (envelope.maxX - envelope.minX) * fraction
  const padY = (envelope.maxY - envelope.minY) * fraction
  return {
    minX: envelope.minX - padX,
    minY: envelope.minY - padY,
    maxX: envelope.maxX + padX,
    maxY: envelope.maxY + padY
  }
}

function habitatColumns() {
  const mapWidth = MINI_MAP_SIZE + 10
  const remaining = CONTENT_WIDTH - mapWidth
  return [
    { key: 'map', label: 'Location', width: mapWidth },
    { key: 'ref', label: 'Ref', width: remaining * 0.12 },
    { key: 'type', label: 'Habitat type', width: remaining * 0.4 },
    { key: 'condition', label: 'Condition', width: remaining * 0.26 },
    { key: 'area', label: 'Area (ha)', width: remaining * 0.22 }
  ]
}

function buildHeaderRow(doc, columns, y) {
  const cells = columns.map((column, index) =>
    doc.struct('TH', { title: column.label, scope: 'Column' }, () => {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
      doc.text(`${column.label} `, columnX(columns, index), y, { width: column.width - 6 })
    })
  )

  labelAsArtifact(doc, () => {
    doc.save().lineWidth(1).strokeColor(INK)
    doc.moveTo(MARGIN, y + 14).lineTo(MARGIN + CONTENT_WIDTH, y + 14).stroke()
    doc.restore()
  })

  return doc.struct('TR', cells)
}

function buildHabitatRow({
  doc, feature, columns, y, style, site, grid, thumbnail, stats
}) {
  const properties = feature.properties
  const areaHectares = polygonAreaSqm(feature.geometry) / 10_000
  const values = {
    ref: properties['Parcel Ref'] ?? '—',
    type:
      properties['Proposed Habitat Type'] ??
      properties['Baseline Habitat Type'] ??
      '—',
    condition:
      properties['Proposed Condition'] ?? properties['Baseline Condition'] ?? '—',
    area: areaHectares.toFixed(3)
  }

  const frame = {
    x: MARGIN + 2,
    y: y + 3,
    width: MINI_MAP_SIZE,
    height: MINI_MAP_SIZE
  }

  stats.tiles += drawMiniMap({
    doc, frame, feature, style, site, grid, thumbnail
  }).tileCount

  const cells = [
    doc.struct('TD', [
      // The alt text repeats no data — the sibling cells carry it — so it
      // describes only what the picture adds: shape and position.
      doc.struct('Figure', {
        alt: `Outline of parcel ${values.ref}, ${values.type}, ${values.area} hectares, ` +
          'shown in place among the neighbouring parcels. ',
        bbox: [frame.x, frame.y, frame.x + frame.width, frame.y + frame.height]
      }, [doc.markStructureContent('Figure')])
    ]),
    ...['ref', 'type', 'condition', 'area'].map((key, index) =>
      doc.struct('TD', () => {
        doc.font('Helvetica').fontSize(8.5).fillColor(INK)
        doc.text(`${values[key]} `, columnX(columns, index + 1), y + 6, {
          width: columns[index + 1].width - 6
        })
      })
    )
  ]

  doc.endMarkedContent()

  labelAsArtifact(doc, () => {
    doc.save().lineWidth(0.4).strokeColor(BORDER)
    doc
      .moveTo(MARGIN, y + HABITAT_ROW_HEIGHT - 4)
      .lineTo(MARGIN + CONTENT_WIDTH, y + HABITAT_ROW_HEIGHT - 4)
      .stroke()
    doc.restore()
  })

  return doc.struct('TR', cells)
}

/**
 * A parcel thumbnail, zoomed to the parcel itself so its shape is legible.
 *
 * Neighbouring parcels and the site boundary are drawn faintly underneath for
 * orientation — without them a lone polygon on a blank square tells you the
 * shape but not where it sits.
 *
 * The basemap is optional and off by default: at 18 mm an OS raster is mostly
 * noise, and it costs a tile fetch per habitat. `--habitat-basemap` turns it on
 * to prove the same pipeline drives both sizes.
 */
const MINI_MAP_PAD = 0.35
const CONTEXT_FILL = '#d8d4d0'
const CONTEXT_STROKE = '#b1b4b6'

function drawMiniMap({ doc, frame, feature, style, site, grid, thumbnail }) {
  // The extent was computed against an identically sized frame, so rebuilding
  // the projector here only moves the origin — the scale is unchanged.
  const projector = makeProjector(thumbnail.extent, frame)

  doc.save()
  doc.rect(frame.x, frame.y, frame.width, frame.height).fillColor('#f8f8f8').fill()
  doc.restore()

  let tileCount = 0
  withFrameClip(doc, frame, () => {
    if (thumbnail.tiles) {
      tileCount = drawBasemap(doc, {
        grid, z: thumbnail.z, projector, tiles: thumbnail.tiles
      }).tileCount
    }

    // Context first, so the subject parcel draws over it.
    for (const other of site.layers.habitats?.features ?? []) {
      if (other !== feature) {
        drawGeometry(doc, other.geometry, projector, {
          fill: CONTEXT_FILL,
          stroke: CONTEXT_STROKE,
          fillOpacity: 0.45,
          lineWidth: 0.3
        })
      }
    }
    if (site.redLine) {
      drawGeometry(doc, site.redLine.geometry, projector, {
        stroke: HABITAT_STYLES.redLine.stroke,
        lineWidth: 0.8
      })
    }
    drawGeometry(doc, feature.geometry, projector, { ...style, lineWidth: 0.8 })
  })

  doc.save().lineWidth(0.5).strokeColor(BORDER)
  doc.rect(frame.x, frame.y, frame.width, frame.height).stroke()
  doc.restore()

  return { tileCount, projector }
}

function columnX(columns, index) {
  return MARGIN + columns.slice(0, index).reduce((sum, column) => sum + column.width, 0)
}

/* ----------------------------------------------------------- utilities */

/**
 * Mark drawing as an artifact — decoration that carries no information and
 * must be skipped by assistive technology. Tagged PDF requires that all
 * non-structure content be marked this way.
 */
function labelAsArtifact(doc, draw) {
  doc.markContent('Artifact', { type: 'Layout' })
  draw()
  doc.endMarkedContent()
}
