# BMD-984 — five questions about report export, answered

**As at 1 September 2026.** Answers taken from the code on the BMD-984 branches, not
from intent. Companion documents: [`STATUS.md`](STATUS.md) (where the work stands),
[`README.md`](README.md) (the evidence), [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) (the
stakeholder briefing), and `bng-metric-backend/docs/site-report.md` (the shipped
implementation).

## The short answers

| Question | Answer |
| --- | --- |
| **1.** Reports as PDF and/or HTML? | **PDF: yes, built, shipped and downloadable today.** HTML: **not built** — no blocker found, but it is unbuilt work, not a switch |
| **2.** Large site overview maps, baseline → post-intervention? | **Yes.** Two maps side by side on page 1, real Ordnance Survey basemap, habitats drawn in register |
| **3.** Mini-maps per habitat parcel? | **Yes.** One thumbnail per parcel row, zoomed to that parcel, with its own basemap |
| **4.** Accessible reports? | **Machine-verified yes — the PDF passes PDF/UA-1 under veraPDF.** A human screen-reader pass (NVDA, PAC) is still outstanding and remains the go/no-go |
| **5.** GDS styles? | **Layout, palette and tone: yes.** GDS Transport is built and verified (PDF/UA-1 PASS) behind a private-bucket switch; only the licensing consent is outstanding |

Two of the five have an open item attached, and neither is engineering: **font licensing**
(Q5) and **a human accessibility pass** (Q4). One — HTML (Q1) — is genuinely unbuilt.

---

## 1. Can we generate reports as PDF and/or HTML files?

### PDF — yes, and it is already a real route

Not a prototype output. A user can download one today:

- **Backend:** `GET /projects/{projectId}/report.pdf?basemap=vector|raster` — geometry
  read from PostGIS (the copy the user has *since edited*, not the uploaded GeoPackage),
  numbers from the project document, so the report cannot disagree with the screen it was
  generated from. Visibility-checked, 404 with no baseline.
- **Frontend:** a **Reports page** at `/projects/{id}/reports` with the download as its
  primary action, plus a passthrough route that swaps the session token for the API call
  and returns the bytes as `content-disposition: attachment`.
- **Journey tests:** a real browser saves a real PDF of a plausible size.

| | Measured |
| --- | --- |
| 50 parcels, real PostGIS, backend | **~190 ms**, 184 kB |
| 120 parcels / 12 pages, spike | **0.38 s**, 774 kB (4.6 MB with parcel-thumbnail basemaps) |
| Runtime dependencies | **one** — `pdfkit`. No native code, no headless browser |
| Tests | 165 backend / 19 frontend / 72 spike |

Compute is not the constraint and never became one. The cost that matters is *network* —
tile fetches through the CDP egress proxy — which is measured in [`STATUS.md`](STATUS.md)
item 15 as an open operational question, not a code one.

### HTML — no technical obstacle found, but it does not exist

To be plain: **nothing in this spike produces HTML.** The ticket asked for PDF and PDF is
what was built and proven. What can be said with evidence is how much of the existing work
an HTML report would reuse:

| Piece | Reusable for HTML? |
| --- | --- |
| `services/report/site-data.js` — reads PostGIS + document, joins them into a site model | **Yes, unchanged.** It is renderer-agnostic; it returns data, not drawing |
| `pdf/projector.js`, `pdf/grid.js`, `pdf/envelope.js` — the world→page maths | **Yes.** Pure coordinate arithmetic with no pdfkit in it |
| `plugins/os-tiles.js` + `services/os-tiles/` — the tiles proxy | **Yes — this is what it was designed for.** [`PLAN.md`](PLAN.md) specifies one proxy shared by "the browser map and the PDF generator". The browser half has simply never been built |
| `pdf/summary-page.js`, `pdf/habitat-pages.js`, `pdf/map.js` — the drawing | **No.** These issue pdfkit calls and would need an HTML/SVG equivalent |
| The tagged-PDF structure tree, `/Alt`, `/Scope`, XMP | **Not needed.** HTML gets this from ordinary semantic markup |

So the shape of the work is: keep the data layer and the map maths, replace the drawing
layer. Two credible routes for the maps, both using the existing proxy:

1. **Server-rendered inline SVG** — the same projector emitting `<path>` instead of pdfkit
   path calls. Static, printable, no client-side map library.
2. **An interactive browser map** (MapLibre or similar against `/os-tiles`) — richer, but
   the frontend currently has **no map library at all** in its dependencies, so this adds
   one plus its accessibility burden.

Worth putting on the record alongside this: **GOV.UK content guidance prefers HTML over
PDF**, and publishes PDFs only in addition to an HTML version. If reports are ever
published rather than downloaded by their own author, that guidance points at building the
HTML version rather than treating it as optional. It is not a reason to undo the PDF — a
PDF is the artefact that gets attached to a planning submission or emailed to a consultant
— but it is a reason not to leave HTML permanently at "later".

**Verdict:** PDF is answered and delivered. HTML is an open, unstarted piece of work with
no identified blocker and a useful amount of reuse — days of work for a tables-only
report; the maps are the variable.

---

## 2. Can we embed large site overview maps showing baseline → post-intervention?

**Yes.** This is page 1 of the report as it exists.

Two site maps sit **side by side** — baseline on the left, post-intervention on the right —
each 210 pt tall across the content width, each with its own habitat styling, its own scale
bar, and a shared legend beneath. Both are drawn over a real Ordnance Survey basemap, end
to end, through our own tile proxy.

### Two basemap sources, because a key may hold either

| | `?basemap=vector` (**default**) | `?basemap=raster` |
| --- | --- | --- |
| OS product needed | OS NGD API – Tiles | OS Maps API |
| What arrives | Mapbox Vector Tiles, z0–15 | 256 px PNG rasters, z0–13 |
| How it lands in the PDF | drawn as **vector paths** — crisp at any print size | placed as images |
| Plan ceiling observed | **none** — z0–15 all serve | OpenData stops at **z9** (~1.75 m/px) |

Vector is the default: it is the product our key actually holds, it has shown no zoom
ceiling, and it stays sharp when printed. `drawBasemap` dispatches on the tile object
itself (`{ png }` vs `{ layers }`), so the document builder never knows which product the
deployment could afford.

With **no OS key present the proxy is not registered at all**, and the same report renders
correctly on a plain ground. That is the licensing lever as well as the failure mode.

### The alignment claim is proven, not asserted

Basemap tiles and habitat geometry cannot land in different places, because both are
positioned by the same `projector.toPage` call in EPSG:27700. Shown three ways:

1. **Arithmetic** — adjacent tiles abut to within 1e-9 pt; a deliberately too-coarse zoom
   changes nothing about alignment.
2. **Visual** — a graticule drawn at round EPSG:27700 coordinates lands exactly on the
   basemap's own grid lines at 600 dpi, across tile boundaries.
3. **Externally** — the tile we ask OS for is **byte-identical** to the one OS's own
   standards-based WMTS `GetTile` returns for that matrix cell. Nothing is eyeballed.

Ran against a live OS key on 26 August 2026: capabilities parsed, grid matched the spike's
constants to the resolution, 24 real tiles, PDF out.

**The one caveat is commercial, not technical.** Our OpenData key caps *raster* at ~1.75
m/px, which is soft at parcel scale; Premium/PSGA reaches 0.109 m/px. Defra is a PSGA
member, so this is likely joining an existing departmental project rather than buying
anything — but **settle it before anyone judges the output on appearance**. (Vector shows
no such ceiling, which is the strongest argument for keeping it as the default.)

---

## 3. Can we render mini-maps for each habitat parcel?

**Yes — this was the "extra" beyond what the ticket asked for, and it works.**

Page 2 onwards is one row per parcel. Each row leads with a square thumbnail zoomed to that
parcel so its **shape** is legible, followed by the recorded type, condition and area as
text.

| | |
| --- | --- |
| Thumbnail size | 52 pt square (~18 mm), rendered at a 150 dpi target |
| Basemap | on by default, per thumbnail; `--no-habitat-basemap` / config turns it off |
| Source layer | the `habitats` layer only — trees, hedgerows and watercourses are separate layers, appear on the site maps, and get no rows (see open question in [`STATUS.md`](STATUS.md) item 18) |
| Tagging | each thumbnail is a `TD > Figure` with alt text that describes **only what the picture adds** — shape and context — because every value it shows is already in the sibling cells as text |

### The cost is file size, not time

On the 120-parcel example against real OS, thumbnails take the document from 851 kB /
12 tiles to **4.6 MB / 262 tiles**, while wall-clock moves by only ~0.4 s — neighbouring
parcels overlap and the proxy cache absorbs the repeats. So judge it on size.

4.6 MB is fine to download and arguably large to email. **The first lever is halving the
thumbnail target DPI**, which at 18 mm square is invisible, ahead of dropping the thumbnail
basemap entirely.

### One finding worth carrying forward

The first thumbnail implementation rendered **completely blank rows**, and it took a
conformance checker to explain why: all tile I/O must finish before any drawing starts.
pdfkit's drawing is sequential and stateful, so an `await` mid-draw lets other work
interleave and silently corrupts both layout *and* the tagged reading order. Fixed by
splitting the async fetch from the synchronous draw — a constraint the production code
preserves deliberately and comments at the top of `build-site-report.js`.

---

## 4. Can we ensure the reports are accessible?

**Machine-verified: yes. Human-verified: not yet, and that is the honest state.**

### What is proven

The document **passes PDF/UA-1** under **veraPDF** — the reference open-source validator —
on both the 20-parcel and 120-parcel examples, with and without a real OS basemap.
Validation runs on every `npm run osdemo`, so a regression fails the build rather than
being noticed later.

What that PASS covers:

- A real structure tree: `Document / Sect / H1 / H2 / P / Table / TR / TH / TD / Figure`
- `/Alt` on every figure — both site maps and every parcel thumbnail
- `/Scope` on table headers, `/Lang` `en-GB`, document title set
- Heading levels H1 → H2 → H2 with none skipped
- All fonts **embedded** (Noto Sans, subsetted — +17 kB, not the 1.1 MB the files weigh)

### It failed first, and both failures were invisible on screen

| Rule | Count | Cause |
| --- | --- | --- |
| `7.1-3` | **512×** | Content drawn *before* the marked-content sequence opened, so the `Figure` wrapped an empty sequence and every drawing operation landed untagged |
| `7.21.4.1-1` | 2× | pdfkit's default base-14 fonts (Helvetica et al.) are referenced by name and never embedded |

The document rendered identically and reported 22 figures with alt text throughout. **Only
a conformance checker could see either problem.** That is the argument for keeping veraPDF
in the loop permanently rather than treating accessibility as a one-off review.

### What is genuinely outstanding

**A PASS is necessary, not sufficient.** Roughly a third of PDF/UA's failure conditions are
human judgement, and veraPDF was perfectly happy with alt text reading *"1 watercourses"*
— a unit test now prevents that specific embarrassment, but not the general class.

| Outstanding | Why it needs a person |
| --- | --- |
| **NVDA screen-reader pass** | Reading order, table navigation and whether thumbnail descriptions are actually useful |
| **PAC (PDF Accessibility Checker)** | A second, differently-opinionated machine check |
| `/Headers` on the habitat table | Present as `/Scope`, but pdfkit only emits `/Headers` inside `doc.table()`, which cannot hold a drawing in a cell. Revisit **if** the NVDA pass finds the table hard to navigate |
| An `accessibility.test.js` for the new Reports page | `project-summary`, `projects` and `area-baseline` all have one; `project-reports` does not. Standard GOV.UK markup, so this should be a formality — but it is missing |

**These remain the go/no-go.** Nothing else on this list can substitute for them.

Worth noting for completeness: **HTML would make this dramatically easier.** An accessible
HTML report is ordinary semantic markup plus the GOV.UK components the service already
uses; an accessible PDF is a hand-built structure tree that only a validator can check.
That is a genuine argument in favour of Q1's HTML half, not against the PDF.

---

## 5. Can the reports follow GDS styles?

**Substantially yes — with one licensing question.**

| Aspect | State |
| --- | --- |
| **Layout and tone** | Follows GOV.UK — heading hierarchy, generous margins, plain-English labels, no decoration |
| **Palette** | GOV.UK `govuk-frontend` colour names, in one module (`pdf/layout.js`) so a change is made once: ink `#0b0c0c`, muted `#505a5f`, border `#b1b4b6` |
| **Typographic scale** | Defined centrally alongside the palette, so the two page builders agree by construction rather than by two copies of a number staying in step |
| **The Reports page itself** | Real `govuk-frontend` components — `govukButton`, `govuk-heading-xl`, `govuk-caption-l`, the service's own project navigation macro. This part is not an approximation |
| **Typeface** | ⚠️ **Noto Sans (SIL OFL 1.1), not GDS Transport** |

### The font is the whole of the gap — and the code side of it is now closed

Embedding GDS Transport **works, and was measured** against `govuk-frontend@6.4.0`:

| Check | Result |
| --- | --- |
| pdfkit can embed it | **Yes** — fontkit reads WOFF and WOFF2 directly, no conversion needed |
| PDF/UA-1 under veraPDF | **PASS**, on the full report |
| Glyph coverage for this document | Complete — nothing missing, including `²` and `£` |
| Output size | 221.9 kB, slightly **smaller** than the same report in Noto Sans |
| Embedding permission (`fsType`) | **Preview & Print** — the rights holder allowing exactly this |

One defect on the way in: govuk-frontend blanks the font's name table for web delivery, so
pdfkit emits `/BaseFont /CZZZZZ+` with no name after the subset prefix. Injecting a name
table before upload fixes it, and it still passes.

**What blocks it is consent, and the repo is why.** The font's own name table records the
licence as a *"Special license agreement"* with Margaret Calvert and Henrik Kubel, and the
font as *"customised exclusively for the UK Government Digital Services … not commercially
available"*. `DEFRA/bng-metric-backend` is a **public** repository, so committing the files
would publish the font to anyone who clones it.

So the code no longer holds it. Backend commit `ac906a2` reads the report's fonts from a
**private S3 bucket** at startup (`REPORT_FONT_BUCKET`, unset by default — which keeps the
committed Noto Sans and leaves the service behaving exactly as before). That separates the
two exposures:

| Exposure | Fixed by a private bucket? |
| --- | --- |
| The font file in every clone of a public repo | **Yes.** This is the one the licence does not permit |
| A subset inside every generated report | **No, and nothing can** — that is what embedding *is*. It is also the sanctioned case, per the `fsType` bit above |

That does not answer whether GDS permit it. It makes the question a reasonable one to ask,
and holding the font privately is the precondition for asking. **Ask before enabling it in
any environment** — doing it quietly *because* it is now hidden would be a worse position
than the public repo, not a better one.

### One thing GDS does not offer

There is **no GOV.UK Design System pattern for PDF documents**. Everything above is a
faithful translation of a web design system onto a fixed page, not conformance to a
published standard — because no such standard exists to conform to. Anyone reviewing the
output should judge it against the service's own web pages, which is exactly what the
ticket asked for ("resembling the web summary page").

---

## What this leaves on the table

Nothing in these five answers is blocked on engineering. Three things are blocked on
**decisions we cannot make ourselves**, and they gate the rest:

1. **Does OS licensing permit *embedding* their mapping in a downloadable PDF?** A
   different question from showing it in a browser, because a PDF can be forwarded. Must be
   asked of OS directly. Until answered, the lever is the key: no `OS_API_KEY` in an
   environment means no OS mapping in any report it produces.
2. **Which OS plan?** OpenData caps raster at ~1.75 m/px; Premium/PSGA reaches 0.109 m/px.
   No amount of engineering changes this.
3. **GDS Transport, yes or no?** The code is ready and verified; this is now purely
   GDS's consent to embed, and the ask should go to them rather than be settled
   internally.

And two on **people, not tools**: the NVDA and PAC passes.

The full list — including the repo drift that will break CI, and the deployment items that
are unproven rather than unanswerable — is in [`STATUS.md`](STATUS.md).
