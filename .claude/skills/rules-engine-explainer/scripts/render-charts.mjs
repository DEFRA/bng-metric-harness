#!/usr/bin/env node
/**
 * Render the rules-engine explainer charts as static SVG.
 *
 * Every plotted value is read from the engine's own reference tables or produced
 * by calling the engine, for the same reason the worked examples are executed
 * rather than written out: a hand-drawn chart is one more place for invented data
 * to hide.
 *
 * Usage:
 *   node render-charts.mjs [--out <dir>] [--png]
 *
 * --png additionally rasterises each chart via Playwright, for renderers that
 * will not take SVG. It is optional and degrades gracefully when no browser is
 * installed — SVG is always the primary artefact.
 *
 * Env:
 *   BNG_ENGINE_DIR  Explicit path to the engine package, overriding discovery.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  bar,
  card,
  circle,
  esc,
  legend,
  line,
  linearScale,
  MARK,
  PALETTE,
  plotTopFor,
  polyline,
  round,
  text
} from './svg-kit.mjs'

const HARNESS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const WORKSPACE_ROOT = path.resolve(HARNESS_ROOT, '..')
const PACKAGE_NAME = 'bng-metric-engine'

const CANDIDATE_DIRS = [
  process.env.BNG_ENGINE_DIR,
  path.join(WORKSPACE_ROOT, 'bng-metric-backend', PACKAGE_NAME),
  path.join(WORKSPACE_ROOT, 'bng-library', 'packages', PACKAGE_NAME),
  path.join(WORKSPACE_ROOT, 'bng-library', PACKAGE_NAME),
  path.join(WORKSPACE_ROOT, PACKAGE_NAME),
  path.join(HARNESS_ROOT, 'packages', PACKAGE_NAME)
].filter(Boolean)

/** The habitat the advance/delay charts are built around. */
const DEMO_HABITAT = 'Coastal saltmarsh - Saltmarshes and saline reedbeds'
const DEMO_CONDITION = 'Good'
const DEMO_SIZE_HECTARES = 1
const MAX_ADVANCE_PLOTTED = 15

/** The enhancement chart's scenario. */
const ENHANCE_HABITAT = 'Grassland - Modified grassland'
const ENHANCE_FROM = 'Moderate'
const ENHANCE_TO = 'Good'
const ENHANCE_DELAY_YEARS = 10

const CHART_WIDTH = 720
const CHART_HEIGHT = 420

/**
 * Vertical bands below the plot, as offsets from the bottom of the card. Each
 * element gets its own band so tick labels, the axis title, the legend and the
 * footnote cannot overlap. Charts without a legend use the `NO_LEGEND` layout.
 */
const WITH_LEGEND = { axisLine: 100, tickLabel: 84, axisTitle: 60, legend: 34, footnote: 12 }
const NO_LEGEND = { axisLine: 100, tickLabel: 84, axisTitle: 56, footnote: 12 }

const PLOT = { left: 62, right: 20 }

/** Habitat keys read "Group - Specific type"; the specific part is the readable half. */
function shortHabitatName(habitat) {
  const [, specific] = habitat.split(' - ')
  return (specific ?? habitat).toLowerCase()
}

function locateEngine() {
  const found = CANDIDATE_DIRS.find((dir) => {
    const manifest = path.join(dir, 'package.json')
    if (!existsSync(manifest)) {
      return false
    }
    try {
      return JSON.parse(readFileSync(manifest, 'utf8')).name === PACKAGE_NAME
    } catch {
      return false
    }
  })
  if (!found) {
    console.error(`Could not find the ${PACKAGE_NAME} package. Set BNG_ENGINE_DIR.`)
    process.exit(1)
  }
  return found
}

// ---------------------------------------------------------------------------
// Chart 1 — how the time multiplier decays with each year of waiting
// ---------------------------------------------------------------------------

function renderTimeDecay(engine, tables) {
  const multipliers = tables.TIME_TO_TARGET_MULTIPLIER
  const years = Object.keys(multipliers)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b)

  const maxYear = years.at(-1)
  const first = multipliers['0']
  const last = multipliers[String(maxYear)]
  const decayPercent = ((1 - multipliers['1'] / first) * 100).toFixed(1)
  const subtitle =
    `Each extra year removes ${decayPercent}% of what is left, so the discount compounds — ` +
    `${first.toFixed(2)} at year 0 down to ${last.toFixed(2)} at year ${maxYear}.`
  const plotTop = plotTopFor(subtitle, CHART_WIDTH)

  const x = linearScale([0, maxYear], [PLOT.left, CHART_WIDTH - PLOT.right])
  const band = NO_LEGEND
  const axisLineY = CHART_HEIGHT - band.axisLine
  const y = linearScale([0, 1], [axisLineY, plotTop])

  const parts = []
  const Y_TICKS = [0, 0.25, 0.5, 0.75, 1]
  for (const tick of Y_TICKS) {
    parts.push(line(PLOT.left, y(tick), CHART_WIDTH - PLOT.right, y(tick), PALETTE.grid))
    parts.push(
      text(tick.toFixed(2), PLOT.left - 10, y(tick) + 4, {
        anchor: 'end',
        fill: PALETTE.textMuted
      })
    )
  }

  const X_TICKS = [0, 5, 10, 15, 20, 25, 30]
  for (const tick of X_TICKS) {
    parts.push(
      text(tick, x(tick), CHART_HEIGHT - band.tickLabel, {
        anchor: 'middle',
        fill: PALETTE.textMuted
      })
    )
  }
  parts.push(
    line(PLOT.left, axisLineY, CHART_WIDTH - PLOT.right, axisLineY, PALETTE.axis)
  )

  const points = years.map((yr) => [x(yr), y(multipliers[String(yr)])])
  parts.push(polyline(points, PALETTE.series1))

  // Direct-label a few anchor years rather than every point. The first and last
  // labels are nudged inward so they cannot run off the plot edges.
  const LABEL_OFFSET = 13
  for (const yr of [0, 10, 20, 30]) {
    const value = multipliers[String(yr)]
    const isFirst = yr === 0
    const isLast = yr === maxYear
    let anchor = 'middle'
    if (isFirst) {
      anchor = 'start'
    } else if (isLast) {
      anchor = 'end'
    }
    parts.push(circle(x(yr), y(value), MARK.markerRadius, PALETTE.series1))
    parts.push(
      text(value.toFixed(2), x(yr), y(value) - LABEL_OFFSET, {
        anchor,
        fill: PALETTE.textPrimary,
        weight: 600
      })
    )
  }

  parts.push(
    text(
      'Years of waiting before the habitat reaches its target condition',
      (PLOT.left + CHART_WIDTH - PLOT.right) / 2,
      CHART_HEIGHT - band.axisTitle,
      { anchor: 'middle', fill: PALETTE.textSecondary }
    )
  )

  return card({
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    title: 'Waiting longer is worth less: the time multiplier',
    subtitle,
    body: parts.join('\n  '),
    footnote: 'Source: time-to-target multiplier table, statutory biodiversity metric.'
  })
}

// ---------------------------------------------------------------------------
// Chart 2 — what advance years do to the units awarded
// ---------------------------------------------------------------------------

/** Which rule the engine applied, used to colour each bar. */
function classifyDifficulty(result, creationMultiplier, enhancementMultiplier) {
  if (result.difficultyMultiplier === creationMultiplier) {
    return 'creation'
  }
  if (result.difficultyMultiplier === enhancementMultiplier) {
    return 'enhancement'
  }
  return 'waived'
}

const DIFFICULTY_STYLE = {
  creation: { color: PALETTE.series2, label: 'Creation difficulty applies' },
  enhancement: { color: PALETTE.series1, label: 'Scored as enhancement' },
  waived: { color: PALETTE.series3, label: 'Difficulty no longer applies' }
}

function renderAdvanceSensitivity(engine) {
  const rows = []
  for (let advance = 0; advance <= MAX_ADVANCE_PLOTTED; advance += 1) {
    rows.push({
      advance,
      result: engine.calculateCreatedAreaHabitatPostIntervention(
        DEMO_SIZE_HECTARES,
        DEMO_HABITAT,
        DEMO_CONDITION,
        advance,
        0
      )
    })
  }

  const creationMultiplier = rows[0].result.difficultyMultiplier
  const waivedRow = rows.find((r) => r.result.difficultyMultiplier === 1)
  const enhancementMultiplier = rows
    .map((r) => r.result.difficultyMultiplier)
    .find((m) => m !== creationMultiplier && m !== 1)

  const subtitle =
    `Units for ${DEMO_SIZE_HECTARES} ha of ${shortHabitatName(DEMO_HABITAT)} reaching ` +
    `${DEMO_CONDITION.toLowerCase()} condition. Colour shows which difficulty rule the engine applied.`
  const plotTop = plotTopFor(subtitle, CHART_WIDTH)

  const band = WITH_LEGEND
  const axisLineY = CHART_HEIGHT - band.axisLine
  const maxUnits = Math.max(...rows.map((r) => r.result.units))
  const Y_HEADROOM = 1.15
  const x = linearScale([0, rows.length], [PLOT.left, CHART_WIDTH - PLOT.right])
  const y = linearScale([0, maxUnits * Y_HEADROOM], [axisLineY, plotTop])
  const slot = (CHART_WIDTH - PLOT.right - PLOT.left) / rows.length
  const BAR_INSET = 5

  const parts = []
  parts.push(
    line(PLOT.left, axisLineY, CHART_WIDTH - PLOT.right, axisLineY, PALETTE.axis)
  )

  const usedKinds = new Set()
  for (const [index, row] of rows.entries()) {
    const kind = classifyDifficulty(row.result, creationMultiplier, enhancementMultiplier)
    usedKinds.add(kind)
    const barX = x(index) + BAR_INSET
    const barW = slot - BAR_INSET * 2
    const barY = y(row.result.units)
    parts.push(
      bar(barX, barY, barW, axisLineY - barY, DIFFICULTY_STYLE[kind].color)
    )
    parts.push(
      text(row.result.units.toFixed(1), barX + barW / 2, barY - 7, {
        anchor: 'middle',
        fill: PALETTE.textPrimary,
        size: 10
      })
    )
    parts.push(
      text(row.advance, barX + barW / 2, CHART_HEIGHT - band.tickLabel, {
        anchor: 'middle',
        fill: PALETTE.textMuted,
        size: 10
      })
    )
  }

  if (waivedRow) {
    const cliffX = x(waivedRow.advance)
    parts.push(
      `<line x1="${round(cliffX)}" y1="${plotTop - 4}" x2="${round(cliffX)}" ` +
        `y2="${axisLineY}" stroke="${PALETTE.textMuted}" ` +
        `stroke-width="1" stroke-dasharray="4 3" />`
    )
    parts.push(
      text(`step change at ${waivedRow.advance} years`, cliffX + 6, plotTop + 6, {
        fill: PALETTE.textSecondary,
        size: 10
      })
    )
  }

  parts.push(
    text(
      'Years of advance creation (habitat established before it is needed)',
      (PLOT.left + CHART_WIDTH - PLOT.right) / 2,
      CHART_HEIGHT - band.axisTitle,
      { anchor: 'middle', fill: PALETTE.textSecondary }
    )
  )
  parts.push(
    legend(
      [...usedKinds].map((kind) => DIFFICULTY_STYLE[kind]),
      PLOT.left,
      CHART_HEIGHT - band.legend
    )
  )

  return card({
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    title: 'Advance creation does not pay off smoothly',
    subtitle,
    body: parts.join('\n  '),
    footnote: `Units shown for ${DEMO_SIZE_HECTARES} hectare with no delay; the same pattern holds at any size.`
  })
}

// ---------------------------------------------------------------------------
// Chart 3 — enhancement discounts only the uplift
// ---------------------------------------------------------------------------

function renderEnhancementUplift(engine) {
  const before = engine.calculateAreaHabitatBaseline(
    DEMO_SIZE_HECTARES,
    ENHANCE_HABITAT,
    ENHANCE_FROM
  )
  const ceiling = engine.calculateAreaHabitatBaseline(
    DEMO_SIZE_HECTARES,
    ENHANCE_HABITAT,
    ENHANCE_TO
  )
  const enhanced = engine.calculateEnhancedAreaHabitatPostIntervention(
    DEMO_SIZE_HECTARES,
    ENHANCE_HABITAT,
    ENHANCE_HABITAT,
    ENHANCE_FROM,
    ENHANCE_TO,
    0,
    ENHANCE_DELAY_YEARS
  )

  const protectedValue = before.units
  const upliftIfCertain = ceiling.units - before.units
  const upliftRetained = enhanced.units - before.units
  const upliftLost = upliftIfCertain - upliftRetained

  const subtitle =
    `${DEMO_SIZE_HECTARES} ha of ${shortHabitatName(ENHANCE_HABITAT)} improved from ` +
    `${ENHANCE_FROM.toLowerCase()} to ${ENHANCE_TO.toLowerCase()}, delayed ${ENHANCE_DELAY_YEARS} years.`
  const BAR_HEIGHT = 54
  const BAR_TOP = plotTopFor(subtitle, CHART_WIDTH) + 10
  const RIGHT_LABEL_SPACE = 210
  const x = linearScale(
    [0, ceiling.units],
    [PLOT.left, CHART_WIDTH - PLOT.right - RIGHT_LABEL_SPACE]
  )

  const segments = [
    {
      value: protectedValue,
      from: 0,
      color: PALETTE.series1,
      label: 'Value it already had — never discounted'
    },
    {
      value: upliftRetained,
      from: protectedValue,
      color: PALETTE.series3,
      label: 'Uplift that survives the risk discount'
    },
    {
      value: upliftLost,
      from: protectedValue + upliftRetained,
      color: PALETTE.ghost,
      label: 'Uplift removed for time and difficulty risk'
    }
  ]

  const parts = []
  for (const [index, segment] of segments.entries()) {
    const startX = x(segment.from)
    const endX = x(segment.from + segment.value)
    const width = Math.max(0, endX - startX - (index === 0 ? 0 : MARK.stackGap))
    const offset = index === 0 ? 0 : MARK.stackGap
    parts.push(
      `<rect x="${round(startX + offset)}" y="${BAR_TOP}" width="${round(width)}" ` +
        `height="${BAR_HEIGHT}" fill="${segment.color}" ` +
        `${index === segments.length - 1 ? 'rx="4"' : ''} />`
    )
    parts.push(
      text(segment.value.toFixed(2), startX + offset + width / 2, BAR_TOP + BAR_HEIGHT / 2 + 4, {
        anchor: 'middle',
        fill: index === segments.length - 1 ? PALETTE.textSecondary : '#ffffff',
        weight: 600,
        size: 12
      })
    )
  }

  // A bracket under the awarded portion only. Labelling the total at the far right
  // of the bar would imply the ghost segment counts towards it, which it does not.
  const awardedEnd = x(protectedValue + upliftRetained)
  const BRACKET_Y = BAR_TOP + BAR_HEIGHT + 10
  const BRACKET_DROP = 6
  parts.push(
    `<path d="M${round(x(0))},${BRACKET_Y} L${round(x(0))},${BRACKET_Y + BRACKET_DROP} ` +
      `L${round(awardedEnd)},${BRACKET_Y + BRACKET_DROP} L${round(awardedEnd)},${BRACKET_Y}" ` +
      `fill="none" stroke="${PALETTE.axis}" stroke-width="1" />`
  )
  parts.push(
    text(
      `${enhanced.units.toFixed(2)} units awarded`,
      (x(0) + awardedEnd) / 2,
      BRACKET_Y + BRACKET_DROP + 16,
      { anchor: 'middle', fill: PALETTE.textPrimary, weight: 600, size: 12 }
    )
  )
  parts.push(
    text(
      `${ceiling.units.toFixed(2)} if the improvement were certain`,
      x(ceiling.units) + 12,
      BAR_TOP + BAR_HEIGHT / 2 + 4,
      { fill: PALETTE.textMuted, size: 11 }
    )
  )

  const LEGEND_TOP = BAR_TOP + BAR_HEIGHT + 58
  const LEGEND_ROW = 22
  for (const [index, segment] of segments.entries()) {
    const rowY = LEGEND_TOP + index * LEGEND_ROW
    parts.push(
      `<rect x="${PLOT.left}" y="${rowY - 9}" width="10" height="10" rx="2" fill="${segment.color}" />`
    )
    parts.push(
      text(`${segment.label} — ${segment.value.toFixed(2)}`, PLOT.left + 18, rowY, {
        fill: PALETTE.textSecondary
      })
    )
  }

  const ENHANCE_CHART_HEIGHT = 292
  return card({
    width: CHART_WIDTH,
    height: ENHANCE_CHART_HEIGHT,
    title: 'Enhancement only discounts the improvement',
    subtitle,
    body: parts.join('\n  '),
    footnote:
      'The habitat keeps the value it already had in full; only the uplift carries risk.'
  })
}

// ---------------------------------------------------------------------------

async function rasterise(files, outDir) {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    console.log('  PNG export skipped — Playwright is not installed.')
    return
  }
  let browser
  try {
    browser = await chromium.launch()
  } catch (error) {
    console.log(
      `  PNG export skipped — no browser available (${error.message.split('\n')[0]}).\n` +
        `  Run 'npx playwright install chromium' if PNGs are needed.`
    )
    return
  }
  const page = await browser.newPage({ deviceScaleFactor: 2 })
  for (const file of files) {
    const svg = readFileSync(path.join(outDir, file), 'utf8')
    await page.setContent(
      `<body style="margin:0">${svg}</body>`,
      { waitUntil: 'load' }
    )
    const element = await page.$('svg')
    const pngPath = path.join(outDir, file.replace(/\.svg$/, '.png'))
    await element.screenshot({ path: pngPath })
    console.log(`  ${path.basename(pngPath)}`)
  }
  await browser.close()
}

const flags = process.argv.slice(2)
const outDir = flags.includes('--out')
  ? flags[flags.indexOf('--out') + 1]
  : path.join(process.cwd(), 'charts')
const wantPng = flags.includes('--png')

const engineDir = locateEngine()
const engine = await import(`file://${path.join(engineDir, 'src', 'index.js')}`)
console.log(`Engine located at: ${engineDir}`)

mkdirSync(outDir, { recursive: true })

const charts = {
  'time-multiplier-decay.svg': renderTimeDecay(engine, engine),
  'advance-sensitivity.svg': renderAdvanceSensitivity(engine),
  'enhancement-uplift.svg': renderEnhancementUplift(engine)
}

for (const [name, svg] of Object.entries(charts)) {
  writeFileSync(path.join(outDir, name), svg)
  console.log(`  ${name}`)
}

if (wantPng) {
  await rasterise(Object.keys(charts), outDir)
}

console.log(`\n${Object.keys(charts).length} chart(s) written to ${outDir}`)
