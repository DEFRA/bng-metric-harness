# GeoPackage validation explained

Every rule the BNG Metric service applies to an uploaded GeoPackage: what each one checks, and which example file demonstrates it.

**This document is generated.** Editing it directly will be undone by the next run — change the generator instead, by running `/geopackage-validation-explainer` in `bng-metric-harness`. It reflects backend `6ef6442`, frontend `50d5c34` and bng-library `af307d5`, on `BMD-958-Geopackage-Filename-Character-Validation` (backend, frontend) and `main` (bng-library), and was generated on 2026-08-24.

For how biodiversity units are calculated once a file is accepted, see [rules-engine-explained.md](rules-engine-explained.md).

## How to read this

Every rule below **rejects the upload**: nothing is saved and the file must be corrected and uploaded again. Separately, an accepted file can still contain features that score zero and show as **Incomplete**, when a habitat or condition is not recognised. Those are not upload rules and are not listed here, so a clean upload is not confirmation that every feature was understood.

Two things worth knowing before using the table:

- **The structural rules run first and stop the upload.** Nothing in the geometry or habitat-data groups is reached until the file format, layer, column and coordinate-system rules all pass. Expect to fix a file in two rounds rather than one.
- **What you see on screen often does not identify the rule.** Of 51 rules, 15 have a message of their own, 5 show a placeholder, and 31 fall back to a generic message about layer and column names. Each row records which applies.

Example files are paths under `example-files/` in this repository, worked out by running the real validation gate over every fixture and recording which rule it reports. That directory is a reference corpus for people, not something the service reads, and `journey-tests` and `backend` keep their own separate copies — so a rule with an example file here is not necessarily covered by an automated test.

## The rules

### File name

| Rule and example file | What it checks |
| --- | --- |
| `INVALID_FILENAME` — *filename-problems/Baseline [invalid chars].gpkg* | The name of the uploaded file contains a character the service does not accept, or is longer than the allowed length. Letters, numbers, spaces, full stops, underscores, hyphens and round brackets all pass, and the name has to begin with a letter or number; nothing inside the file is looked at. The user sees its own message. |

### File format

| Rule and example file | What it checks |
| --- | --- |
| `GPKG_INVALID_FILE` — *malformed/Not a valid geopackage.gpkg* | The upload cannot be opened as a database at all. Usually something that is not a GeoPackage — a shapefile, a zip, a spreadsheet — or a .gpkg truncated by an interrupted copy. The user sees a generic message. |
| `GPKG_NOT_A_GEOPACKAGE` — *no geopackage fixture* | The file opens as a database but is not stamped as a GeoPackage. Typically a SpatiaLite or plain SQLite database given a .gpkg name; the stamp is inside the file, so renaming the extension does not help. The user sees a generic message. |
| `GPKG_MISSING_SYSTEM_TABLE` — *no geopackage fixture* | One of the GeoPackage's own internal housekeeping tables is absent, so the file is broken at the format level rather than merely wrong. Reported once per missing table. The user sees a generic message. |

### Layers

| Rule and example file | What it checks |
| --- | --- |
| `GPKG_MISSING_LAYER` — *invalid-schema/Baseline - no habitats table (three rlb polygons).gpkg; invalid-schema/Baseline - no habitats table.gpkg; invalid-schema/Post-intervention - no geometry column in RLB layer.gpkg* | A layer the template requires is absent. Habitats and Red Line Boundary are both required; a layer that exists under a different name counts as missing. The user sees a generic message. |
| `GPKG_UNEXPECTED_FEATURE_LAYER` — *spatial-problems/Baseline - iggi outside.gpkg* | The file carries a vector mapping layer the template does not list — a constraints layer, a site plan, a working copy. Raster and tile layers are not examined, so an embedded basemap is not caught. The user sees a generic message. |

### Coordinate reference system

| Rule and example file | What it checks |
| --- | --- |
| `GPKG_BASELINE_SRS_ID` — *invalid-schema/Baseline - rlb has wrong spatial reference.gpkg* | A layer is not in British National Grid (EPSG:27700), or no usable coordinate system number can be read for it. Latitude and longitude and Web Mercator are both rejected. Reported once per layer. The user sees a generic message. |
| `GPKG_BASELINE_GPKG_SRS_INCONSISTENT` — *no geopackage fixture* | The file records one layer's coordinate system in two places and the two disagree. A GIS package will display such a layer without complaint. The user sees a generic message. |

### Geometry registration and declared type

| Rule and example file | What it checks |
| --- | --- |
| `GPKG_BASELINE_CONTENTS_DATA_TYPE` — *no geopackage fixture* | A layer is registered as something other than a vector mapping layer. Believed unreachable in practice: only layers already registered as mapping layers are ever examined. The user sees a generic message. |
| `GPKG_BASELINE_INVALID_GEOMETRY_COLUMN_NAME` — *no geopackage fixture* | The column holding a layer's shapes has a name containing something other than letters, digits and underscores. The name itself is not compared against the template — only its validity. The user sees a generic message. |
| `GPKG_BASELINE_MULTIPLE_GEOMETRY_COLUMNS` — *invalid-schema/Post-intervention - multiple geometry columns in RLB layer.gpkg* | A layer has more than one column holding shapes, either in its registration or in the table itself. Usually the result of a merge or join carrying a second geometry across. The user sees a generic message. |
| `GPKG_BASELINE_GEOMETRY_TYPE_NAME` — *invalid-schema/Baseline - wrong geometry type in Habitats.gpkg; invalid-schema/Baseline - wrong geometry type in Hedgerows.gpkg; invalid-schema/Baseline - wrong geometry type in Rivers.gpkg; invalid-schema/Post-intervention - wrong geometry type in RLB layer.gpkg* | A layer's declared shape type differs from the template, regardless of what was actually drawn. Habitats must be declared MultiPolygon and Red Line Boundary Polygon — the two required layers want opposite things. The user sees a generic message. |
| `GPKG_BASELINE_GEOMETRY_REGISTRATION_MISSING` — *no geopackage fixture* | A layer is listed as a mapping layer but the file never records which of its columns holds the shapes, so no GIS tool can draw it. Applies to the optional layers; the two required layers have their own rules. The user sees a generic message. |
| `GPKG_HABITATS_NO_GEOMETRY_COLUMN` — *no geopackage fixture* | The same missing registration, reported specifically for the Habitats layer. The user sees a generic message. |
| `GPKG_RLB_NO_GEOMETRY_COLUMN` — *no geopackage fixture* | The same missing registration, reported specifically for the Red Line Boundary layer. The user sees a generic message. |

### Columns

| Rule and example file | What it checks |
| --- | --- |
| `GPKG_BASELINE_MISSING_COLUMN` — *invalid-schema/Baseline - missing and wrong column names in Habitats.gpkg; invalid-schema/Baseline - missing columns in Habitats.gpkg; invalid-schema/Baseline - wrong column names in Habitats.gpkg* | A column the template defines is absent, which includes any template column that has been renamed. Reported once per missing column per layer, so a stripped-down layer produces many at once. The user sees a generic message. |
| `GPKG_BASELINE_COLUMN_SQLITE_TYPE` — *invalid-schema/Baseline - wrong column data types in Habitats.gpkg; invalid-schema/Baseline - wrong geometry type in Habitats.gpkg; invalid-schema/Baseline - wrong geometry type in Hedgerows.gpkg; invalid-schema/Baseline - wrong geometry type in Rivers.gpkg* | A column exists with the right name but holds the wrong kind of value — text where a number is expected, or the reverse. Column length is never compared, so a text field of any size passes. The user sees a generic message. |
| `GPKG_BASELINE_COLUMN_NOT_NULL` — *no geopackage fixture* | A column's must-always-have-a-value setting differs from the template. Only the row identifier is required to carry one, so this fires either because it lost that setting or because another column gained it. The user sees a generic message. |
| `GPKG_BASELINE_COLUMN_PRIMARY_KEY` — *no geopackage fixture* | The column acting as the layer's unique row identifier is not the one the template expects. The user sees a generic message. |

### Shapes present and of the right kind

| Rule and example file | What it checks |
| --- | --- |
| `NO_REDLINE` — *no geopackage fixture* | No red line boundary reached the geometry stage. In ordinary use the equivalent structural rule fires first; both are shown to the user as the same message. The user sees its own message. |
| `GPKG_RLB_NO_POLYGON` — *empty-layer/Baseline - no rlb polygons.gpkg* | The Red Line Boundary layer contains no area shape. Rows with nothing drawn, and rows holding a line or point, do not count towards the total. The user sees its own message. |
| `GPKG_RLB_TOO_MANY_POLYGONS` — *valid/Baseline - three rlb polygons.gpkg* | The Red Line Boundary layer holds more than one row. What is counted is rows, not separate pieces of land, so a site of several detached areas stored as one multi-part feature passes. The user sees its own message. |
| `NO_HABITAT_AREAS` — *empty-layer/Baseline - no habitats (full site).gpkg; empty-layer/Baseline - no habitats (minimal site).gpkg* | The Habitats layer contains no area shape at all. Also fires when every shape in the layer is the wrong kind, which reads as though the layer were empty. The user sees its own message. |
| `GPKG_HABITATS_WRONG_GEOMETRY_TYPE` — *no geopackage fixture* | The Habitats layer holds at least one valid area shape and also something that is not one — a stray line or point mixed into the same layer. The user sees a generic message. |
| `GPKG_HEDGEROWS_NO_LINESTRING_GEOMETRY` — *no geopackage fixture* | The Hedgerows layer has rows but not one usable line among them. An entirely empty optional layer passes; a layer of rows with nothing drawn does not. The user sees a generic message. |
| `GPKG_HEDGEROWS_WRONG_GEOMETRY_TYPE` — *no geopackage fixture* | The Hedgerows layer holds at least one valid line and also something that is not a line. The user sees a generic message. |
| `GPKG_RIVERS_NO_LINESTRING_GEOMETRY` — *no geopackage fixture* | The Rivers layer has rows but not one usable line among them, on the same terms as Hedgerows. The user sees a generic message. |
| `GPKG_RIVERS_WRONG_GEOMETRY_TYPE` — *no geopackage fixture* | The Rivers layer holds at least one valid line and also something that is not a line. The user sees a generic message. |

### Unreadable shape data

| Rule and example file | What it checks |
| --- | --- |
| `GPKG_RLB_UNREADABLE_GEOMETRY` — *no geopackage fixture* | A row in the Red Line Boundary layer holds shape data that cannot be interpreted at all — truncated or corrupt, rather than badly drawn. One such row stops the rest of that layer's checks. The user sees a generic message. |
| `GPKG_HABITATS_UNREADABLE_GEOMETRY` — *no geopackage fixture* | A row in the Habitats layer holds shape data that cannot be interpreted at all. The user sees a generic message. |
| `GPKG_HEDGEROWS_UNREADABLE_GEOMETRY` — *no geopackage fixture* | A row in the Hedgerows layer holds shape data that cannot be interpreted at all. The user sees a generic message. |
| `GPKG_RIVERS_UNREADABLE_GEOMETRY` — *no geopackage fixture* | A row in the Rivers layer holds shape data that cannot be interpreted at all. The user sees a generic message. |

### Valid shapes

| Rule and example file | What it checks |
| --- | --- |
| `REDLINE_INVALID_GEOMETRY` — *spatial-problems/Baseline - self intersecting redline.gpkg* | The red line boundary is recognisable as an area but is not a legal one — most often a bowtie where the outline crosses itself, leaving no consistent answer to what is inside the site. Only the first fault is reported, with its map location. The user sees its own message. |
| `AREA_PARCELS_INVALID_GEOMETRY` — *spatial-problems/Baseline - bowtie parcel.gpkg* | A habitat parcel is not a legal area shape, for the same reasons. Unlike the boundary check, every offending parcel is named, up to fifty. The user sees its own message. |

### How the shapes fit together

| Rule and example file | What it checks |
| --- | --- |
| `PARCEL_OVERLAPS` — *spatial-problems/Baseline - overlapping parcels.gpkg* | Two habitat parcels claim the same ground. Parcels that merely touch along a shared edge always pass. An overlap is tolerated up to 0.5 m². The user sees its own message. |
| `SLIVERS_OUTSIDE_REDLINE` — *no geopackage fixture* | Habitat parcel material escaping past the boundary, measured on the parcels as a whole rather than per parcel. Reports a location rather than naming a parcel. Tolerance 0.5 m². The user sees its own message. |
| `AREA_PARCELS_OUTSIDE_REDLINE` — *spatial-problems/Baseline - parcel outside redline.gpkg* | A single habitat parcel escaping past the boundary. Measures escaping area rather than testing containment, so parcels sharing an edge with the boundary are not flagged. Tolerance 0.5 m². The user sees its own message. |
| `HEDGEROWS_OUTSIDE_REDLINE` — *spatial-problems/Baseline - hedgerow outside.gpkg* | Hedgerow length falling outside the boundary. The tolerance is a total across every excursion, not an allowance per excursion. Tolerance 0.1 m. The user sees its own message. |
| `WATERCOURSES_OUTSIDE_REDLINE` — *spatial-problems/Baseline - watercourse outside.gpkg* | Watercourse length falling outside the boundary, on the same terms as hedgerows. Tolerance 0.1 m. The user sees its own message. |
| `IGGIS_OUTSIDE_REDLINE` — *no geopackage fixture* | Green infrastructure area escaping past the boundary. Unreachable in ordinary use, and demonstrably so: that layer is not in the template, so the fixture built to exercise this rule is rejected as an unexpected layer before the containment check runs. Tolerance 0.5 m². The user sees a placeholder. |
| `TREES_OUTSIDE_REDLINE` — *spatial-problems/Baseline - tree outside.gpkg* | A tree sits outside the boundary. Unlike the line rules this is a straight-line distance per tree, so a tree inside or exactly on the boundary passes. Tolerance 0.1 m. The user sees a placeholder. |
| `AREA_SUM_MISMATCH` — *spatial-problems/Baseline - area sum mismatch.gpkg* | The total area of the habitat parcels differs from the boundary area. The tolerance is absolute rather than proportional, so large sites are harder to pass. Both totals are plain sums, so a gap and an overlap of similar size cancel out and the check stays silent. Tolerance 0.5 m². The user sees a placeholder. |
| `REDLINE_OUTSIDE_ENGLAND` — *spatial-problems/Baseline - redline not in england.gpkg* | Part of the boundary falls outside a reference outline of England. That outline is heavily generalised, so genuinely English coastal and border sites can fail it. Tolerance 0.5 m². The user sees a placeholder. |
| `REDLINE_AREA_TOO_LARGE` — *no geopackage fixture* | The boundary encloses more land than any real site plausibly would, so in practice this catches a coordinate system error or a stray vertex. The cap is 100 km². The user sees a placeholder. |
| `AREA_PARCELS_TOO_SMALL` — *spatial-problems/Baseline - parcel too small.gpkg* | A single habitat parcel covers less ground than the smallest area a genuine parcel is expected to occupy, marking it as a stray digitising artefact rather than a real habitat. It is judged on area alone, so a long, thin parcel passes as long as its total footprint is large enough. The minimum parcel area is 1 m². The user sees its own message. |

### Habitat data

| Rule and example file | What it checks |
| --- | --- |
| `HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE` — *attribute-problems/Baseline - habitat distinctiveness out of scope.gpkg* | A habitat falls in the High or Very High distinctiveness band, which this service does not yet handle. Applies to area habitats, hedgerows and watercourses, and to habitats proposed as well as existing. Around half of all area habitat types are affected, and an ordinary river or stream always is. The user sees its own message. |
| `DUPLICATE_HABITAT_REF` — *attribute-problems/Baseline - duplicate habitat ref.gpkg* | Two rows in the Habitats layer share a parcel reference. Blank references are ignored, and matching is exact, so references differing only by capitalisation or a trailing space are treated as distinct. The user sees a generic message. |
| `ADVANCE_AND_DELAY_BOTH_SET` — *attribute-problems/Post-intervention - advance and delay both set.gpkg* | One feature carries both advance years and delay years, which the statutory metric forbids as they are opposite directions on the same timeline. Applies to area habitats, hedgerows and watercourses; urban trees are excluded because the service does not read those columns on that layer. The user sees its own message. |

### Service faults, not your file

| Rule and example file | What it checks |
| --- | --- |
| `SIZING_FAILED` — *no geopackage fixture* | The database call that measures habitat sizes failed, after the file had already passed every check. Nothing about the upload was wrong. The user sees a generic message. |
| `INVALID_FILE_METADATA` — *no geopackage fixture* | Covers two unrelated situations. The file size or upload reference reported for the upload is outside the allowed bounds, which is the reader's to fix. Or the record built internally from an already-valid file failed its own schema, which is not. The user sees a generic message. |
| `VALIDATION_FAILED` — *no geopackage fixture* | An unexpected fault anywhere in the validation run. Every real rule violation returns its own code instead, so this always indicates a service problem rather than a file problem. The user sees a generic message. |
## Coverage

| Measure | Count |
| --- | --- |
| Rules that can reject an upload | 51 |
| With a message written for them | 15 |
| Showing a placeholder message | 5 |
| Falling back to a generic message | 31 |
| With an example .gpkg in this repository | 25 |
| With a generator flaw that reproduces them | 16 |

**26 of 51 rules have no example file.** Almost all are structural — the file format, layer, column and coordinate-system rules — which is also the group the user is told least about. The generator has no schema flaw family, so those fixtures cannot be produced with `npm run generate:gpkg` and would have to be built by hand.

68 `.gpkg` files in `example-files/` are not mapped to any rule. Most are valid fixtures or real survey data rather than rule demonstrations, so that is expected rather than a gap.

## Known gaps recorded by this run

- The green infrastructure containment rule cannot fire. Running the real gate over the fixture built to exercise it shows the file rejected as an unexpected layer instead, because that layer is not in the template — so the containment check is never reached. One layer-type rule also cannot fail, because only layers already of the required type are examined.
- `example-files/README.md` states that the green infrastructure fixture demonstrates the containment rule. It does not, per the above, and the entry is stale.
- One fixture filed under `invalid-schema/` passes validation entirely: the one named for a wrong geometry column name. Column names are not compared against the template, only their syntactic validity, so there is nothing for it to trip.
- The `Water course enhancement through meanders` layer is permitted by the template but never read, so no spatial rule is applied to anything in it.
- Advance and delay values on the Urban Trees layer are silently discarded rather than merely unvalidated, because the column names on that layer differ from the ones the service reads. A five-year head start recorded there earns no credit and produces no warning.
- The message shown for a gap between parcels tells the reader to redraw the parcel. There is no such parcel — the fault is a gap between two of them.
- A file with exactly one fault gets the least informative message, because the specific technical detail is only listed when there is more than one error.

## Where this comes from

| Repository | Commit | Supplies |
| --- | --- | --- |
| bng-metric-backend | `6ef6442` | The rules, and the message each one raises |
| bng-metric-frontend | `50d5c34` | What the user is shown for each rule |
| bng-library | `af307d5` | The generator flaws that reproduce fixtures |

Rule descriptions are held in `references/rule-descriptions.json` in the skill; the rule list, message status and fixture mapping are extracted from the three repositories on every run.
