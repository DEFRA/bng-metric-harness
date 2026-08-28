# How the PDF export works

A briefing note for BMD-984. Written to be read aloud to people who will not
open the code. `README.md` has the evidence; `PLAN.md` has the proxy design.

## What it does

- Takes the two GeoPackage files a user already uploads (baseline and
  post-intervention) and produces a **printable, screen-reader-structured PDF
  site report**.
- Each report shows the site on an Ordnance Survey map, with habitat parcels
  drawn on top, followed by the habitat tables.
- It is a **working program**, not a design: ~3,000 lines of source, ~740 of
  tests, 52 automated checks that run offline in under a second.

## The pipeline, in six steps

1. **Read** the GeoPackage — it is a SQLite database, so the parcels come out
   as rows: a geometry blob plus habitat type, condition and area.
2. **Decode** the geometry into real-world coordinates (British National Grid
   eastings and northings, in metres).
3. **Decide the frame** — work out the ground area to show, then build a
   *projector*: the one piece of arithmetic that converts metres on the ground
   into points on the page.
4. **Choose the detail level and fetch the map tiles** covering that ground,
   through our own tile proxy.
5. **Draw** — background map first, then the parcels as crisp vector shapes on
   top, then the same treatment again at thumbnail size for each table row.
6. **Write the PDF**, tagging headings, tables and images as it goes so assistive
   technology can navigate the document.

## The moving parts

| Piece | Job |
| --- | --- |
| `gpkg.mjs`, `wkb.mjs`, `geometry.mjs` | read the GeoPackage and interpret its geometry |
| `grid.mjs` | tile arithmetic, and reading OS's own grid definition |
| `projector.mjs` | ground metres → page points, the single source of alignment |
| `map.mjs` | paints tiles and parcels |
| `document.mjs` | page layout, tables, and the accessibility tagging |
| `os-proxy/` | the tile service — the only code that knows the OS API key |
| `png.mjs`, `stub-upstream.mjs` | a fake Ordnance Survey, so everything is testable offline |

## The tile proxy, and why it exists

- The browser map and the PDF both need OS tiles. Rather than two integrations,
  there is **one internal endpoint** both call.
- **The API key lives in exactly one file.** Everything else — including the PDF
  builder — sees an ordinary internal URL and nothing more.
- It **caches** tiles, so neighbouring parcels asking for the same ground cost
  one fetch, not many.
- It **validates** requests, so a malformed one never reaches OS. Without that a
  proxy becomes an open relay onto someone else's paid API.
- It is written as a **portable plugin**: it imports nothing app-specific, so it
  drops into either the frontend or the backend unchanged. That decision is
  deliberately still open.

## Two basemap sources, because OS sells them separately

Ordnance Survey grants API access product-by-product, and the project's key
turned out to hold the **NGD API – Tiles** but not the raster **Maps API**.
(OS's older Vector Tile API serves similar tiles but is marked for
retirement, so the NGD API is the one used.)
So the proxy speaks both:

- **Raster** (`npm run osdemo:raster`): OS renders the map into PNG images and
  the PDF places them. Needs the "OS Maps API" product; the free plan stops at
  zoom 9.
- **Vector** (`npm run osdemo`, the default): OS sends the map as *geometry* —
  building outlines, road centrelines, water polygons — and the PDF draws it
  itself, in the same colours OS uses (extracted from OS's own published
  style). Needs the "OS NGD API – Tiles" product; no zoom ceiling has been
  observed, and the result stays crisp at any print size because nothing is
  an image.

The rest of the pipeline cannot tell them apart, so whichever product a
deployment's key holds, the same PDF comes out.

## Five decisions worth defending

- **Raster map tiles, not vector.** Vector tiles need a graphics renderer that
  is painful to run in our container images; raster PNGs embed into a PDF
  directly. This mirrors what the NRF team does.
- **British National Grid throughout, never reprojected.** Reprojecting
  introduces small errors between the map and the parcels. Keeping one
  coordinate system end to end means the alignment is exact by construction.
- **The grid definition is fetched from Ordnance Survey, never hard-coded.**
  Hard-coded map constants produce a background that looks plausible and is in
  the wrong place — the worst kind of bug, because nobody notices.
- **All map data is fetched before any drawing starts.** The PDF library is
  sequential and stateful; interleaving downloads with drawing corrupts the
  layout silently. An earlier version rendered blank rows for exactly this
  reason.
- **Only one third-party runtime dependency** (`pdfkit`). Less to review, less
  to patch, less to argue about in a security assessment.

## What has been proved

- **The document passes the accessibility standard.** Every build is checked
  automatically against PDF/UA using veraPDF, the industry-standard validator.
  It failed on the first run, for two reasons that were both real and both
  invisible to the eye — one of them a tagging bug that made an entire class of
  content unreadable to assistive technology while looking perfectly normal on
  screen. Both are fixed, and the check now runs on every build so they cannot
  come back unnoticed.

- **The map lines up with the ground.** Verified two ways: internally against a
  purpose-built test background, and externally by confirming that the tile we
  request is byte-for-byte the tile Ordnance Survey's own standards-based
  interface returns for that location.
- **Going through our proxy changes nothing.** The document built through the
  proxy is content-identical to one built without it.
- **It works against the real Ordnance Survey service**, end to end.
- **Speed is not a concern.** The largest example site — 120 parcels, 12 pages —
  builds in under two seconds, so generating a report while the user waits is
  realistic.

## What has not been proved

- **Whether it is genuinely *usable*.** The document now **passes** the
  industry-standard automated check (see below), but passing is necessary, not
  sufficient: no tool can judge whether a description is helpful or the reading
  order sensible. That still needs a screen-reader session. **This remains the
  go/no-go.**
- **Licensing.** Nobody has asked OS whether we may embed their mapping in a
  downloadable PDF. That is a different question from showing it in a browser,
  because a PDF can be forwarded. It must be asked directly.
- **Attribution.** The required wording has to be burned into the page; a PDF
  cannot carry a dynamic credit control.
- **Where it runs** — frontend or backend — is written up but undecided.
- **Deployment.** It has not been built inside the real Alpine container image.

## The one commercial decision

- Our current OS key is on the **free OpenData plan**, which stops at roughly
  **1.75 m per pixel**. At the size of a single parcel the background looks
  soft.
- Sharper mapping (down to 0.11 m per pixel) needs a **Premium / PSGA** plan.
  Defra is a PSGA member, so this is likely a matter of joining an existing
  departmental agreement rather than buying something new.
- **No amount of engineering changes this**, and it should be settled before
  anyone judges the output on appearance.

## Fair warnings

- The parcel-thumbnail backgrounds are on by default, which takes the largest
  example report to about **4.6 MB**. Fine to download, arguably large to email.
  Halving the thumbnail resolution would cut it substantially and be invisible
  at that size.
- This is **spike code**. Parts of it deliberately duplicate `bng-library` so it
  could stay dependency-free; those get deleted if it graduates.
