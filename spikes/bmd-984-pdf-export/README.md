# BMD-984 spike — accessible PDF export with mapped habitats

A working proof that we can generate a rich, **tagged (PDF/UA-targeted)** site
summary PDF containing a full-site map with habitat layers, plus a zoomed
mini-map per habitat parcel — in pure JavaScript, with no native dependencies.

Everything here reads the harness's own `example-files/valid/*.gpkg`. Nothing
is mocked.

## Run it

```sh
cd spikes/bmd-984-pdf-export
npm install

npm run build                 # out/site-summary.pdf
npm test                      # 26 tests, no network

node src/cli.mjs --graticule          # the registration proof (see below)
node src/cli.mjs --habitat-basemap    # basemap behind each parcel thumbnail
node src/cli.mjs --baseline <f.gpkg> --post <f.gpkg> --out <f.pdf>
```

## What it proves

| Question | Answer |
| --- | --- |
| Can pure-JS produce a tagged PDF? | Yes — `Document/Sect/H1/H2/P/Table/TR/TH/TD/Figure`, `/Alt`, `/BBox`, `/Scope`, `/Headers`, `/Lang`, XMP `pdfuaid:part 1` |
| Can we draw habitat geometry as vectors? | Yes — 20 parcels, hedgerows, watercourses, trees, red line |
| Can a raster basemap sit under it, aligned? | Yes, exactly — see the graticule proof |
| Mini-map per habitat in a table? | Yes — 20 rows, each a tagged `TD > Figure` with alt text |
| Native dependencies? | **None.** `pdfkit` only |
| Output size | 134 kB for 3 pages / 22 maps (204 kB with thumbnail basemaps) |
| Does it scale? | 120 parcels → 12 pages, 774 kB, **0.38 s** end to end |

## The registration proof

The claim is that basemap tiles and habitat geometry **cannot** land in
different places, because both are positioned by the same `projector.toPage`
call. A map tile is not an arbitrary picture — it covers an exact, known
rectangle of ground — so a tile corner and a habitat vertex are the same kind
of thing: an EPSG:27700 coordinate.

This is proven two ways, both offline:

1. **Arithmetic** (`test/registration.test.mjs`) — adjacent tiles abut to
   within 1e-9 pt, the covering set really covers the extent, a round-numbered
   coordinate lands where the tile paints it, and a deliberately too-coarse
   zoom changes nothing about alignment.

2. **Visual** (`--graticule`) — the synthetic basemap paints its grid at round
   EPSG:27700 coordinates *in tile pixel space*; the overlay draws the same
   coordinates *through the projector*. At 600 dpi the red dashed vector lines
   sit exactly on the grey raster lines, across tile boundaries. Against a real
   OS basemap the equivalent check is the 1 km National Grid, which OS renders
   itself.

The synthetic basemap is deliberately better than real OS tiles for this: the
expected answer is known exactly rather than eyeballed.

## Findings worth carrying into the build

**1. `doc.table()` needs `structParent`, or it silently produces no table
structure.** Wrapping it in `doc.struct('Table', () => doc.table(...))` looks
right and renders identically — and emits a `Table` element containing zero
rows. Caught by counting `/S /TD` in the output, not by looking at the page.
Pass `structParent: <element>` instead.

**2. `scope` on table cells is supported but undocumented.** Values are
`'Row' | 'Column' | 'Both'`. Setting it also makes pdfkit emit `/Headers`,
linking each data cell to the headers that describe it — which is what a
screen reader announces. Not in `docs/accessibility.md`; found in the source.

**3. All tile I/O must complete before any drawing.** pdfkit drawing is
sequential and stateful (cursor, current page, open marked-content sequence).
An `await` mid-draw lets other work interleave and silently corrupts both
layout and reading order. The first `--habitat-basemap` implementation rendered
completely blank rows for exactly this reason. Fixed by splitting `fetchTiles`
(async) from `drawBasemap` (sync).

**4. Aspect-ratio mismatch is the alignment bug you will actually hit**, not
tile maths. If the land extent and the frame are different shapes, x and y get
different scales and geometry drifts against the basemap. `makeProjector`
*throws* rather than silently squashing.

**5. `pdfkit` has built-in tables** (since 0.17.0) and they are
accessibility-aware. My earlier advice that pdfkit means hand-building every
table was out of date. Hand-laying is still needed where a cell must contain a
drawing — `doc.table()` cells take text, not graphics — which is why the
habitat table is hand-built.

**6. Areas computed from the geometry match the file to <1 m²** across all 20
parcels (`test/gpkg.test.mjs`), which independently validates the hand-rolled
WKB decoder.

## Deliberate limitations

- **No real OS basemap.** No API key was available. `osTileSource` is written
  to the documented URL shape but **has never been executed**. The grid must
  come from `gridFromWmtsCapabilities` — never hard-code an origin; one out by
  a tile looks plausible and is wrong.
- **veraPDF not run.** No Java in this environment. The structure markers are
  all present and `qpdf --check` is clean, but *machine-checked PDF/UA
  conformance is still outstanding* and is the single most important next step.
- **Not run on Alpine.** The harness runs Debian here; the real containers are
  Alpine 3.23/musl. pdfkit has no native dependencies so this should be a
  formality — but it is the go/no-go and should be confirmed, not assumed.
- **The hand-built habitat table has `/Scope` but no `/Headers`** — pdfkit only
  generates those inside `doc.table()`.
- **Helvetica, not GDS Transport.** Font licensing for embedding in a generated
  PDF needs confirming.
- **Reads the GeoPackage, not the database.** Wrong source for production: the
  backend already holds this geometry as `geometry(..., 27700)` in PostGIS, and
  that is the copy users have since edited. Swapping to `ST_AsGeoJSON` changes
  only `src/gpkg.mjs`.

## Layout

| File | Role |
| --- | --- |
| `src/projector.mjs` | **the world → page transform.** The piece worth reading first |
| `src/grid.mjs` | tile matrix maths; WMTS capabilities parsing |
| `src/map.mjs` | tile fetch/draw, geometry drawing, graticule, scale bar |
| `src/document.mjs` | the tagged document: structure tree, tables, figures |
| `src/gpkg.mjs` | GeoPackage reader (`node:sqlite`, no better-sqlite3) |
| `src/wkb.mjs` | GeoPackage Binary + WKB decoder (no wkx) |
| `src/geometry.mjs` | envelopes, areas, lengths |
| `src/png.mjs` | minimal PNG encoder (`node:zlib`) for synthetic tiles |
| `src/tiles.mjs` | synthetic + OS tile sources |

`wkb.mjs`, `geometry.mjs` and parts of `gpkg.mjs` duplicate
`bng-library/gpkg-io` and exist only so the spike has zero dependencies. If
this graduates, delete them and use the library.

## Next steps

1. Run **veraPDF** against `out/site-summary.pdf`. This is the go/no-go.
2. Build and run inside the real **Alpine** image.
3. Get an **OS API key**, fetch the real grid from GetCapabilities, and confirm
   the 1 km National Grid check against a real basemap.
4. Screen-reader pass (NVDA) — machine checks do not prove usable reading order.
5. Decide where generation runs. Compute is not the constraint — the largest
   example site (120 parcels, 12 pages) builds in **0.38 s** — so a synchronous
   request is viable. With a real OS basemap the cost becomes *network*: ~30
   tile fetches per site map through the CDP proxy. Measure that before ruling
   out a synchronous response, and cache tiles across maps.
