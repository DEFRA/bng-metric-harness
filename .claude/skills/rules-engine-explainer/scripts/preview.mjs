#!/usr/bin/env node
/**
 * Build a single self-contained HTML page from the generated document, for
 * reading locally before publishing.
 *
 * The published MkDocs site rewrites image paths to raw.githubusercontent.com
 * URLs on the default branch, so images 404 until the work is merged — which
 * makes the real site useless as a local preview. This inlines the charts as
 * data URIs instead, so the page renders correctly straight from disk.
 *
 * Markdown and Mermaid are rendered in the browser from a CDN, so the first
 * load needs a network connection. The charts do not — they are embedded.
 *
 * Usage:
 *   node preview.mjs [<document.md>] [--out <preview.html>] [--open]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const HARNESS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const DEFAULT_DOC = path.join(HARNESS_ROOT, 'docs', 'rules-engine-explained.md')
const DEFAULT_OUT = path.join(
  HARNESS_ROOT,
  '.rules-engine-explainer',
  'preview.html'
)

const flags = process.argv.slice(2)
const positional = flags.filter((a) => !a.startsWith('--'))
const flagValue = (name) =>
  flags.includes(name) ? flags[flags.indexOf(name) + 1] : null

const docPath = positional[0] ? path.resolve(positional[0]) : DEFAULT_DOC
const outPath = flagValue('--out') ? path.resolve(flagValue('--out')) : DEFAULT_OUT

if (!existsSync(docPath)) {
  console.error(
    `No document at ${docPath}.\nRun the rules-engine-explainer skill in generate mode first.`
  )
  process.exit(1)
}

const docDir = path.dirname(docPath)
let markdown = readFileSync(docPath, 'utf8')

/**
 * Replace relative image references with data URIs so the page is standalone.
 * Anything already absolute (http/data) is left alone.
 */
let inlined = 0
let missing = 0
markdown = markdown.replace(
  /!\[([^\]]*)\]\(([^)]+)\)/g,
  (whole, alt, src) => {
    if (/^(https?:|data:)/.test(src)) {
      return whole
    }
    const assetPath = path.resolve(docDir, src)
    if (!existsSync(assetPath)) {
      console.warn(`  WARNING: image not found, left as-is: ${src}`)
      missing += 1
      return whole
    }
    const ext = path.extname(assetPath).toLowerCase()
    const mime =
      { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' }[ext] ??
      'application/octet-stream'
    const encoded = readFileSync(assetPath).toString('base64')
    inlined += 1
    return `![${alt}](data:${mime};base64,${encoded})`
  }
)

const title = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? 'Document preview').trim()

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto; padding: 3rem 1.5rem 6rem; max-width: 46rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a18; background: #fdfdfc;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e7e2; background: #16161a; }
    blockquote { background: #1f1f24 !important; border-left-color: #4a4a52 !important; }
    th { background: #1f1f24 !important; }
    td, th { border-color: #33333a !important; }
    code { background: #24242a !important; }
    a { color: #7fb3f5 !important; }
  }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 1.5rem; }
  h2 { font-size: 1.4rem; margin: 2.75rem 0 0.9rem; padding-top: 1.25rem; border-top: 1px solid rgba(128,128,128,.22); }
  h3 { font-size: 1.1rem; margin: 2rem 0 0.6rem; }
  p, li { max-width: 42rem; }
  img { max-width: 100%; height: auto; display: block; margin: 1.75rem 0; }
  table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: 0.92rem; }
  th, td { border: 1px solid #ddd; padding: 0.5rem 0.7rem; text-align: left; vertical-align: top; }
  th { background: #f4f4f1; font-weight: 600; }
  code { background: #f0f0ec; padding: 0.12em 0.35em; border-radius: 3px; font-size: 0.88em; }
  pre { overflow-x: auto; }
  pre code { display: block; padding: 0.9rem; background: none; }
  blockquote {
    margin: 1.5rem 0; padding: 0.9rem 1.1rem; background: #f7f7f4;
    border-left: 4px solid #c9c9c0; border-radius: 0 4px 4px 0;
  }
  blockquote p { margin: 0.4rem 0; }
  .table-scroll { overflow-x: auto; }
  .mermaid { margin: 1.75rem 0; text-align: center; }
  .preview-banner {
    max-width: 46rem; margin: 0 auto 2rem; padding: 0.6rem 0.9rem;
    background: #fff8e1; border: 1px solid #f0d98c; border-radius: 4px;
    font-size: 0.85rem; color: #5c4a00;
  }
  @media (prefers-color-scheme: dark) {
    .preview-banner { background: #2e2a14; border-color: #5c5124; color: #e0cf8a; }
  }
</style>
</head>
<body>
<div class="preview-banner">
  Local preview — charts are embedded in this file. Generated from
  <code>${path.relative(HARNESS_ROOT, docPath)}</code>.
</div>
<article id="content">Rendering…</article>

<script type="application/json" id="source">${JSON.stringify(markdown)}</script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'

  const source = JSON.parse(document.getElementById('source').textContent)

  // Pull mermaid fences out before markdown rendering so they are not escaped.
  const diagrams = []
  const withPlaceholders = source.replace(
    /\`\`\`mermaid\\n([\\s\\S]*?)\`\`\`/g,
    (_, body) => {
      diagrams.push(body)
      return \`\\n<div class="mermaid-slot" data-index="\${diagrams.length - 1}"></div>\\n\`
    }
  )

  const article = document.getElementById('content')
  article.innerHTML = marked.parse(withPlaceholders)

  for (const slot of article.querySelectorAll('.mermaid-slot')) {
    const pre = document.createElement('pre')
    pre.className = 'mermaid'
    pre.textContent = diagrams[Number(slot.dataset.index)]
    slot.replaceWith(pre)
  }

  // Wide tables scroll inside their own container rather than the page.
  for (const table of article.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-scroll'
    table.parentNode.insertBefore(wrap, table)
    wrap.appendChild(table)
  }

  mermaid.initialize({
    startOnLoad: true,
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default'
  })
  await mermaid.run({ querySelector: '.mermaid' })
</script>
</body>
</html>
`

writeFileSync(outPath, html)
console.log(`Preview written to: ${outPath}`)
console.log(`  ${inlined} image(s) inlined${missing > 0 ? `, ${missing} missing` : ''}`)

if (flags.includes('--open')) {
  const opener =
    { darwin: 'open', win32: 'start' }[process.platform] ?? 'xdg-open'
  execFileSync(opener, [outPath])
}
