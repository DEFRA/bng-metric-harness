# BMD-984 — Spike: PDF Exports — status report

**As at 1 September 2026.** Written from the code on the BMD-984 branches after pulling
every repo. Companion documents: [`README.md`](README.md) (the evidence),
[`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) (the stakeholder briefing), [`PLAN.md`](PLAN.md)
(the tiles-proxy design), and `bng-metric-backend/docs/site-report.md` (the shipped
implementation).

## In one paragraph

The spike is **done and then some**. It answered every question the ticket asked, and the
answers were good enough that the work was then **productionised**: the report is now a
real backend route reading real PostGIS geometry, a real frontend Reports page, and a
Playwright journey test. What is left is not exploration — it is (a) two commercial /
licensing answers only Ordnance Survey and Defra can give, (b) a human accessibility pass
that no tool can do, and (c) a short list of tidy-ups where the three repos have drifted
apart while the work moved.

## Where the work lives

| Repo | Branch | PR | State |
| --- | --- | --- | --- |
| `bng-metric-harness` | `spike/bmd-984-pdf-exports` | — (no PR) | 12 commits, 26–28 Aug. The standalone spike under `spikes/bmd-984-pdf-export/` |
| `bng-metric-backend` | `BMD-984-pdf-site-report` | [#297](https://github.com/DEFRA/bng-metric-backend/pull/297) | **Open, titled "DRAFT"**, no review, **no CI or SonarCloud run**. ~11.5k insertions, of which ~4.3k is hand-written source — see [What the line count is](#what-the-line-count-is) |
| `bng-metric-frontend` | `BMD-984-pdf-site-report` | [#248](https://github.com/DEFRA/bng-metric-frontend/pull/248) | Open, **approved** (jbfarrar, 28 Aug) — but on commit `9b33dce`, one commit behind the head. CI + Sonar green on that commit |
| `bng-metric-journey-tests` | `BMD-984-pdf-site-report` | — (no PR) | 1 commit: flow doc, page object, 2 specs |

## Against the ticket's acceptance points

| Asked for | Status | Where |
| --- | --- | --- |
| Rich data output resembling the web summary page | **Done.** Page 1: site heading, key-figures table, two site maps, legend. Page 2+: one row per parcel | `backend/src/services/report/pdf/{summary-page,habitat-pages}.js` |
| GDS styles where possible | **Partial.** Layout, palette and tone follow GOV.UK; the typeface is **Noto Sans, not GDS Transport**. Embedding GDS Transport is now built and verified (PDF/UA-1 PASS) behind `REPORT_FONT_BUCKET` — what remains is purely the licensing answer | `pdf/page-furniture.js`, `services/report/fonts.js` |
| A map, proving we can do it | **Done, against real Ordnance Survey**, end to end, through our own tile proxy | `pdf/map.js`, `services/os-tiles/` |
| Habitat layering: baseline **and** post-intervention | **Done** — the two site maps sit side by side on page 1, each with its own habitat styling | `summary-page.js` |
| OS data via API, rasterised render with data on top | **Done, and exceeded.** Two interchangeable sources: OS Maps API rasters (`?basemap=raster`) *and* OS NGD API – Tiles vector geometry drawn as PDF paths (`?basemap=vector`, the default and the product our key actually holds) | `pdf/tile-source.js`, `pdf/mvt.js`, `pdf/ngd-light-style.js` |
| Symbology — "don't worry too much" | Deliberately plain; NGD labels are omitted because the report's tables carry the facts | `pdf/vector-style.js` |
| **Extra:** mini-map per habitat (not trees) for post-intervention | **Done.** One thumbnail per row, from the `habitats` layer only; trees, hedgerows and watercourses are separate layers and are not given rows | `habitat-pages.js` |
| Accessibility: keyboard + screen reader | **Machine-verified, not human-verified.** The PDF **passes PDF/UA-1** under veraPDF. NVDA and PAC are still outstanding and remain the go/no-go | `docs/site-report.md` |

## What was actually built

**1. The spike itself** — `spikes/bmd-984-pdf-export/`, ~11.9k lines, one runtime
dependency (`pdfkit`). Reads the harness's own `example-files/valid/*.gpkg`, nothing
mocked. Hand-rolled GeoPackage/WKB reader, PNG encoder, MVT decoder and WMTS grid parser,
all so the no-native-dependencies claim holds. **Re-verified today: `npm test` → 72/72
pass, `npm run build` → a 222 kB, 2-site-map, 20-row, 112-tile PDF in under a second.**

**2. A shared OS tiles proxy** — a portable Hapi plugin (`/os-tiles/capabilities`,
`/os-tiles/{z}/{col}/{row}.png`) that both a future browser map and the PDF builder fetch
through. The API key lives in exactly one module; everything else sees an internal URL.
Now shipped in the backend as `src/plugins/os-tiles.js` + `src/services/os-tiles/`, and it
is **not registered at all without a key**, so a keyless environment produces the same
correct report on a plain ground.

**3. The production backend route** — `GET /projects/{projectId}/report.pdf?basemap=vector|raster`.
Geometry from PostGIS (the copy the user has *since edited*, not the uploaded GeoPackage);
numbers from the project JSONB document, so the report cannot disagree with the screen it
was generated from. Visibility-checked, 404 with no baseline, logs ms / bytes / tiles.
**165 tests** across 18 files, including an integration test and a registration
(map-alignment) proof.

**4. The frontend** — a passthrough route (`/projects/{id}/report.pdf`, session token out,
PDF bytes back, `content-disposition: attachment`) plus a new **Reports page**
(`/projects/{id}/reports`) added last in the project side navigation, with the download as
its primary action. 19 tests.

**5. Journey tests** — a `downloadSiteReport()` page helper and two specs that prove a real
browser saves a real PDF of a plausible size.

## What the line count is

The backend PR's ~11.5k insertions are a diff count, not 11.5k lines of hand-written
logic. As it stands after the library swap below:

| Category                                                   | Lines |  Share |
| ---------------------------------------------------------- | ----: | -----: |
| Hand-written source                                        | 4,297 |  37.5% |
| Tests                                                      | 3,075 |  26.8% |
| Test fixtures (synthetic tiles, site models, tile writer)  |   805 |   7.0% |
| **Machine-generated OS style data** (`ngd-light-style.js`) | 2,418 |  21.1% |
| Docs (`docs/site-report.md`, font licence)                 |   346 |   3.0% |
| Build tooling (`extract-ngd-style.js`)                      |   203 |   1.8% |
| Lockfile / manifest                                        |   312 |   2.7% |
| **Total**                                                  | 11,456 |       |

A fifth of it is a data file distilled from Ordnance Survey's own published
`light-27700` style by `tools/extract-ngd-style.js`, committed deliberately so builds and
tests need no network and a style revision arrives as a reviewable diff.

Nor is it all new. The backend is largely this spike re-homed — `projector` and `grid`
arrived near-verbatim, and `mvt` did too until it was replaced by a library — with
roughly 2,600 lines that are genuinely backend-only:
the route, the PostGIS reads, the document-to-geometry join, and the split of the spike's
single 715-line `document.mjs` into per-page modules.

## Libraries adopted, and the ones rejected

After the spike proved the approach, three hand-written pieces were replaced with
libraries (backend commit `e1da5fc`, **-403 lines of production code**):

| Was                              | Now                                       | Note                                                                                                     |
| -------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `mvt.js`, 440 lines              | `@mapbox/vector-tile` + `pbf`, 85 lines   | The spike had already verified its decoder byte-for-byte against this library, which is what made it safe |
| `envelope.js` coordinate walking | `@turf/bbox`                              | Bounding boxes only — turf's measurement functions are geodesic and wrong in EPSG:27700                   |
| `cache.js`, 80 lines             | `@hapi/catbox-memory` via `server.cache()` | Already in hapi's dependency tree; Redis becomes a provisioning change, not a code change                 |
| tile writer (fixtures)           | `@maplibre/vt-pbf`                        | Test-only, so decode stays proven by round-trip                                                           |

Rejected, with the reason recorded so it is not re-litigated:

- **OpenLayers' `WMTSCapabilities`** produces an identical grid from OS's document — that
  was checked — but needs `DOMParser` and `Node` globals in Node, so ~55 MB of dependency
  (jsdom + ol) to delete ~90 lines.
- **`@mapbox/tilebelt`** is Web Mercator only, which is the projection this report does
  not use.
- **`pdfmake`** wraps pdfkit declaratively but exposes no structure-tree API, so it cannot
  produce a tagged document.
- **`@maplibre/maplibre-gl-style-spec`** could remove the 2,418-line generated style, but
  trades "committed data, no network at build, style changes arrive as a reviewable diff"
  for an 11 MB runtime dependency. Open question, not a decision.
- **Headless Chromium (Puppeteer) rendering the GOV.UK page** would delete most of the
  layout code and is the obvious-looking answer, but Chrome's tagging is not PDF/UA — no
  `pdfuaid` XMP identifier, no `/Scope` or `/Headers` on tables, no `/Alt` on a
  canvas-rendered map — and PDF/UA is the acceptance criterion.
- **`@maplibre/maplibre-gl-native`** would delete the map drawing entirely, but is a
  node-gyp addon with no Alpine/musl prebuilds, and costs the exact 27700 registration.

**The spike itself is deliberately left alone.** Its value is as a record that this can be
done with one dependency and no native code; adding libraries to it would falsify its own
README and save nothing, since nobody maintains it. Its duplicated `wkb.mjs` /
`geometry.mjs` / `gpkg.mjs` were always marked for deletion on graduation, and the backend
already does not use them — it reads PostGIS.

## Evidence, and what it cost

| Claim | How it was proved |
| --- | --- |
| Tagged PDF/UA-1 conformance | veraPDF (`verapdf/cli` image) — **PASS** on 20- and 120-parcel examples, with and without a real OS basemap. It **failed first**: 512 untagged-content violations from drawing before opening the marked-content sequence, and unembedded base-14 fonts. Both invisible on screen |
| Basemap and habitats register exactly | Three ways: arithmetic (tiles abut to 1e-9 pt), visual (a graticule at round EPSG:27700 coordinates), and externally — the tile we ask for is **byte-identical** to the one OS's own WMTS `GetTile` returns |
| The proxy changes nothing | A document built through the proxy is byte-identical to one built without it |
| Real OS works | Ran 26 Aug against a live key: capabilities parsed, grid matched the constants, 24 real tiles, PDF out |
| Speed is not the constraint | 120 parcels / 12 pages in **0.38 s** in the spike; 50 parcels from real PostGIS in **~190 ms / 184 kB** in the backend |
| Areas from geometry match the file | To <1 m² across all 20 parcels — which independently validates the hand-rolled WKB decoder |

Findings worth carrying forward are written up in `README.md`; the two that will bite
anyone who touches this code are **all tile I/O must finish before any drawing starts**
(pdfkit is sequential and stateful; an `await` mid-draw silently corrupts layout *and*
reading order) and **open the marked-content sequence before drawing into it**.

---

# Further work

## A. Decisions we cannot make ourselves — these gate everything else

1. **Does OS licensing permit *embedding* their mapping in a downloadable PDF?**
   Different question from showing it in a browser, because a PDF can be forwarded. Must
   be asked of OS directly. Until answered the lever is the key: no `OS_API_KEY` in an
   environment means no OS mapping in any report it produces. **Blocks turning the basemap
   on in any real environment.**
2. **Which OS plan?** Our key is OpenData, which caps the *raster* flavour at ~1.75 m/px
   (403 above z9) — soft at parcel scale. Premium/PSGA reaches 0.109 m/px. Defra is a PSGA
   member, so this is likely joining an existing departmental project rather than buying
   anything. **No amount of engineering changes this; settle it before anyone judges the
   output on appearance.** (The vector flavour has shown no such ceiling, which is a strong
   argument for keeping vector as the default.)
3. **Confirm the required attribution wording.** Both `OS_MAPS_ATTRIBUTION` and
   `OS_MAPS_ATTRIBUTION_SHORT` are currently our own provisional strings.
4. **GDS Transport instead of Noto Sans — ask GDS, not ourselves.** The engineering is
   done: backend commit `ac906a2` reads the report's fonts from a private S3 bucket
   (`REPORT_FONT_BUCKET`, unset by default), so the font never enters this or any other
   **public** repository. Verified against `govuk-frontend@6.4.0` — fontkit reads its
   WOFF/WOFF2 directly, glyph coverage is complete, output is *smaller* than Noto Sans,
   and the full report still **passes PDF/UA-1**. The font's `fsType` bit is
   *Preview & Print embedding*, so embedding a subset in a generated document is the use
   its own permission bits allow. What is left is consent: the font's name table records
   the licence as a "Special license agreement" with Margaret Calvert and Henrik Kubel,
   held by GDS, and the font as "customised exclusively for the UK Government Digital
   Services … not commercially available". **Ask GDS before setting the variable in any
   environment.** One defect to fix on the way in: govuk-frontend blanks the name table,
   so a name must be injected into the objects before they are uploaded or the PDF names
   the font `/CZZZZZ+` with nothing after the prefix.
5. **Is BMD-984 now closed as a spike, with the productionised code tracked under a
   delivery ticket?** The backend PR is a spike PR carrying production code and is still
   titled DRAFT. That mismatch is why it has no reviewer.

## B. Accessibility — the go/no-go

6. **NVDA screen-reader pass, and PAC.** A veraPDF PASS is necessary, not sufficient:
   roughly a third of PDF/UA's failure conditions are human judgement. veraPDF was
   perfectly happy with alt text reading "1 watercourses". Reading order, table
   navigation and thumbnail descriptions need a person.
7. **Keyboard access on the new Reports page.** The page is standard GOV.UK markup so this
   should be a formality, but `src/server/project-reports/` has **no `accessibility.test.js`**,
   while `project-summary`, `projects` and `area-baseline` all do. Add one.

## C. Repo drift introduced while the work moved — cheap, and will break CI

8. **The journey tests target a section the frontend has since deleted.** Commit `06106bc`
   moved the download off the project summary onto the Reports page, but
   `journey-tests/test/pages/project-summary.page.js` still looks for a "Download site
   report" heading there and two specs assert on it. **Those specs will fail.** Retarget
   them at `/projects/{id}/reports`.
9. **The journey flow doc is out of date on two counts** — it describes the summary-page
   section, and it says the basemap is "switched off (`REPORT_BASEMAP`, default false)".
   `REPORT_BASEMAP` was **removed** in backend commit `122d1a0`; the basemap is now on
   whenever a key is present.
10. **The spike README's "Deliberate limitations" section is stale.** It still says "No
    real OS basemap … has never been executed" and "veraPDF not run", both of which later
    sections of the same file contradict. Anyone reading top-down will draw the wrong
    conclusion.
11. **Frontend PR #248's approval predates its head commit** (approved on `9b33dce`; head
    is `06106bc`), and its title still says "from the project summary". Re-request review
    and retitle.
12. **Backend PR #297 has had no CI and no SonarCloud run at all** — the only check is a
    skipped Dependabot auto-merge. Nothing has been linted, tested or scanned in CI for
    ~11.5k lines of diff. Take it out of DRAFT (or push an empty commit) to get the checks running,
    then run `/check-sonar-pr`.

## D. Deployment and operations — unproven

13. **Build and run inside the real Alpine 3.23/musl image.** `pdfkit` has no native
    dependencies so this should be a formality, but it is a go/no-go and should be
    confirmed, not assumed.
14. **Provision `OS_API_KEY` as a CDP secret per environment** (explicitly *not*
    `cdp-app-config`), and set `OS_MAPS_MAX_ZOOM=9` in any environment on an OpenData key
    if raster is ever enabled. It deliberately does not default to 9.
15. **Measure the network cost through the CDP egress proxy.** Compute is not the
    constraint; ~30 tile fetches per site map (hundreds with thumbnails) through the
    platform proxy is. Measure before committing to a synchronous response.
16. **Decide whether the process-local tile cache is enough.** The backend has no Redis;
    per-instance caching already collapses the repeats *within* one report, which is most
    of them. `get`/`set` in `services/os-tiles/cache.js` is the seam if cross-instance
    reuse turns out to matter; NRF's `tile-cache.js` is the shape to copy.
17. **Report size.** With parcel thumbnails the largest example reaches ~4.6 MB — fine to
    download, arguably large to email. Halving the thumbnail target DPI (currently 150)
    would be invisible at 18 mm square and is the first lever, ahead of dropping the
    thumbnail basemap.

## E. Product questions the spike surfaced but did not answer

18. **Should the report cover the whole project or one unit type?** Today the habitat pages
    show post-intervention habitats when present, otherwise baseline — hedgerows,
    watercourses and trees appear on the maps but get no rows.
19. **Is a Reports page the right home**, and does anything else belong on it? It was built
    to have room for future documents.
20. **Should the user be able to choose the basemap flavour**, or is `?basemap=` purely an
    internal comparison tool? It is currently not exposed in the UI at all.
21. **The hand-built habitat table has `/Scope` but no `/Headers`** — pdfkit only emits
    those inside `doc.table()`, which cannot hold a drawing in a cell. Worth revisiting if
    the NVDA pass finds the table hard to navigate.
22. **If the spike graduates further**, delete the duplicated `wkb.mjs`/`geometry.mjs`/parts
    of `gpkg.mjs` and use `bng-library/gpkg-io`. They exist only so the spike could stay
    dependency-free.
