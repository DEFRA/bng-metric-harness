/**
 * The two pieces of PDF plumbing every page needs: the fonts, and the way to
 * say "this drawing is decoration".
 *
 * Both were in `document.mjs` until the card layout needed them too. Neither is
 * optional for conformance, and both are the kind of thing that is silently
 * wrong rather than visibly broken — see the comments below.
 */

import path from 'node:path'

/**
 * Embed the body fonts.
 *
 * PDF/UA 7.21.4.1 requires every font PROGRAM to be embedded. pdfkit's
 * defaults — Helvetica and friends — are the PDF base-14: they are referenced
 * by name and resolved by the viewer, never embedded, so a document using them
 * can never pass however well tagged it is. veraPDF caught this; nothing about
 * the rendered page looks different either way.
 *
 * Noto Sans is used because it is SIL OFL 1.1 and therefore safe to commit.
 * A real service should use GDS Transport, which is what GOV.UK sets in the
 * browser; it is licensed for GOV.UK services but is not redistributable here,
 * so swapping it in is a licensing step, not a code change — replace the two
 * files and the paths below. The backend has since built that swap properly:
 * `services/report/fonts.js` reads them from a private bucket.
 */
const FONT_DIR = path.resolve(import.meta.dirname, '..', 'assets', 'fonts')

export const BODY = 'Body'
export const BOLD = 'Bold'

export function registerFonts(doc) {
  doc.registerFont(BODY, path.join(FONT_DIR, 'NotoSans-Regular.ttf'))
  doc.registerFont(BOLD, path.join(FONT_DIR, 'NotoSans-Bold.ttf'))
  // pdfkit starts every document on Helvetica; without this, anything drawn
  // before the first explicit font() call would reintroduce the failure.
  doc.font(BODY)
}

/**
 * Mark drawing as an artifact — decoration that carries no information and
 * must be skipped by assistive technology. Tagged PDF requires that all
 * non-structure content be marked this way.
 */
export function labelAsArtifact(doc, draw) {
  doc.markContent('Artifact', { type: 'Layout' })
  draw()
  doc.endMarkedContent()
}

/**
 * "1 watercourse", not "1 watercourses".
 *
 * Trivial, and worth doing properly: this string is not decoration, it is what
 * a screen-reader user actually hears in place of the map. Automated
 * conformance checking cannot catch it — veraPDF confirms alt text EXISTS, not
 * that it reads well — which is precisely why a human pass is still required.
 */
export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
