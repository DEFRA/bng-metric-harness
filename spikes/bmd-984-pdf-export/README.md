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

# Tiles via the real /os-tiles proxy, backed by a stub upstream. No key needed.
node src/cli.mjs --proxy --graticule

# The same proxy against real Ordnance Survey. Put the key in a .env
# (cp .env.example .env) and this needs no environment variables at all:
node src/cli.mjs --os      # or: npm run osdemo

# .env is gitignored. A real environment variable still overrides it, so a
# one-off override works without editing the file:
OS_MAPS_MAX_ZOOM=13 node src/cli.mjs --os

npm run serve:tiles                   # run the proxy on :3100 and poke it
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
| Can the PDF fetch tiles from our own proxy? | Yes — `--proxy` renders **pixel-for-pixel identical** to the direct path |
| Does the PDF need an OS key? | **No.** Only the proxy holds one; the PDF has a URL |

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

3. **Through the proxy** (`--proxy --graticule`) — the same document built with
   tiles fetched over HTTP from the real Hapi plugin, with bounds validation,
   caching, and the grid taken from `/os-tiles/capabilities` rather than a
   constant. The rendered page is **byte-identical** to the direct build, which
   shows the proxy round-trip preserves tile coordinates and reproduces the
   grid exactly.

## The tiles proxy

`src/os-proxy/` — a portable Hapi plugin, following the plan in `PLAN.md`:

```
GET /os-tiles/capabilities         the EPSG:27700 grid, as JSON
GET /os-tiles/{z}/{col}/{row}.png  one raster tile
```

It imports nothing — not Hapi, not ioredis, not a logger — so it mounts in
either sibling as-is and takes its cache and logger by injection. The API key
lives only here; the browser map and the PDF builder both fetch by URL.

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

**7. Tile-index validation must not copy grants-ui's `2^z` bound.** That is
correct for Web Mercator and wrong for EPSG:27700: the British National Grid
matrix is rectangular and does not double cleanly per level. `isTileInGrid`
uses the per-level `MatrixWidth`/`MatrixHeight` from capabilities, with a
finite fallback so an unbounded index can never reach OS.

**8. Never read map metadata off a tile object.** The graticule interval was
originally taken from the tile the synthetic source returned. Through the
proxy — and with any real OS basemap — that property is absent, so the overlay
silently stopped drawing and the visual proof *disabled itself without
failing*. Both sides now derive the interval from the grid and zoom.
Regression-tested, because a proof that can quietly switch itself off is worse
than no proof.

## Against real Ordnance Survey

Run on 2026-08-26 with an OpenData-plan key. The upstream half — the only part
that had never executed — now has.

| Check | Result |
| --- | --- |
| `GetCapabilities` parses | **Yes** — real origin `-238375, 1376256`, tile 256 px, 14 levels |
| Parsed grid vs the spike's constants | **Identical**, to the resolution |
| Matrix dimensions are 2^z | **No** — z0 is 5x7, not 1x1. Confirms `isTileInGrid` was right not to copy grants-ui's `2^z` bound |
| `z/col/row` is OS's own tile addressing | **Yes** — byte-identical PNGs from the ZXY and WMTS `GetTile` endpoints at three separate tiles |
| PDF builds end to end through the proxy | **Yes** — 24 real tiles, `out/os-real.pdf` |

The third row is the registration proof against real data. The synthetic
basemap shows the maths is self-consistent; this shows the tile the spike asks
for *is* the tile OS's own standards-based addressing returns for that matrix
cell, and that cell is defined by the `TopLeftCorner` and `ScaleDenominator`
the parser reads. Nothing is eyeballed.

### The finding that actually matters: the plan caps resolution

An OpenData-plan key returns `403` with

```xml
<ExceptionText>A Premium Plan is required to access Premium Data</ExceptionText>
```

for **every EPSG:27700 tile above zoom 9**, while `GetCapabilities` succeeds.
Probed level by level:

| | free (OpenData) | premium |
| --- | --- | --- |
| `EPSG:27700` | z0-**z9** — 1.75 m/px | z10-z13 — down to 0.109 m/px |
| `EPSG:3857` | z0-**z16** — ~1.5 m/px at GB latitudes | z17+ |

So **~1.75 m/px is the free ceiling**, and switching to Web Mercator does not
escape it (~1.5 m/px) while costing exact registration. For a site plan of a
few hectares that is coarse: the PDF builds and registers correctly, but the
basemap is soft at parcel scale.

**This is a procurement question, not an engineering one.** Defra is a PSGA
member, so the likely answer is an existing departmental Premium project rather
than a new key — worth resolving before anyone judges the output quality.

Three things changed in response, all small:

- `OS_MAPS_MAX_ZOOM` — the *plan* ceiling, separate from the product's. Unset
  means "whatever the product allows", so it never silently throws away
  resolution a Premium key has paid for.
- `/os-tiles/capabilities` publishes the effective `maxZoom`, and `pickZoom`
  clamps to it. A client picks a zoom it can actually fetch without knowing
  anything about OS plans — the same reasoning that keeps the key out of it.
- `401` and `403` are no longer conflated. They are different problems: 401 is
  the key or the missing product, 403 is the plan. The 403 message names
  `OS_MAPS_MAX_ZOOM` because that, not a new key, is usually the fix.

Without the clamp the failure mode is a burst of ~24 opaque 403s and no
document.


## Deliberate limitations

- **No real OS basemap.** No API key was available, so the upstream half of
  the proxy — the actual calls to `api.os.uk` — **has never been executed**.
  Everything downstream of it is exercised against a stub that mimics OS's
  capabilities document and tile URLs. The grid must come from
  `gridFromWmtsCapabilities`; never hard-code an origin, because one out by a
  tile looks plausible and is wrong.
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
| `src/tiles.mjs` | synthetic + proxy-backed tile sources |
| `src/os-proxy/plugin.mjs` | the portable Hapi tiles plugin |
| `src/os-proxy/upstream.mjs` | the only module that knows the API key exists |
| `src/os-proxy/cache.mjs` | memory cache, plus NRF's Redis shape |
| `src/os-proxy/stub-upstream.mjs` | a fake api.os.uk, so the proxy is testable without a key |
| `src/env.mjs` | loads a gitignored `.env` via Node's built-in loader; real env vars win |

`wkb.mjs`, `geometry.mjs` and parts of `gpkg.mjs` duplicate
`bng-library/gpkg-io` and exist only so the spike has zero dependencies. If
this graduates, delete them and use the library.

## Next steps

1. Run **veraPDF** against `out/site-summary.pdf`. This is the go/no-go.
2. Build and run inside the real **Alpine** image.
3. ~~Get an OS API key and run `--os`.~~ **Done — see "Against real Ordnance
   Survey" below.** The upstream seam is closed; the open question it raised is
   the plan ceiling, which is a procurement decision, not a code one.
4. Screen-reader pass (NVDA) — machine checks do not prove usable reading order.
5. Decide where generation runs. Compute is not the constraint — the largest
   example site (120 parcels, 12 pages) builds in **0.38 s** — so a synchronous
   request is viable. With a real OS basemap the cost becomes *network*: ~30
   tile fetches per site map through the CDP proxy. Measure that before ruling
   out a synchronous response, and cache tiles across maps.
