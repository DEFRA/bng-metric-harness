# BNG Service template corpus

<!-- Written by `npm run generate:service-template` from scripts/service-template/recipes.mjs. Edit the recipes, not this file. -->

Fixtures in the **BNG Service template** format (BMD-1081): one GeoPackage
holding both stages, with the lineage that links each post-intervention
feature to its baseline parent, and the template version record. They
mirror the legacy corpus's families in `example-files/`, kept apart from it.

A file named `…-baseline.gpkg` is a **baseline-stage** file: its
post-intervention tables are present and empty. Every other file holds both
stages. **Expected** is the outcome the service should give the file with the
service-template flag on (`SERVICE_TEMPLATE_ENABLED=true`); an error code is
the one the legacy upload gives the same fault.

No generated file marks a habitat irreplaceable unless its **Built from**
names the layer (bng-library's `irreplaceableLayers`): the service refuses an
irreplaceable habitat, so a file meant to trip one check, or none, holds none.

Every file regenerates to the same bytes:

```sh
npm run generate:service-template                                   # every family
npm run generate:service-template -- --only lineage-problems        # one family
npm run generate:service-template -- --only valid/default-site.gpkg # one file
```

A test (`tests/scripts/service-template/corpus.test.mjs`) rebuilds the
whole corpus and compares it with these files byte for byte, but for the
SQLite version each GeoPackage's header records. A bng-library repin that
changes a fixture, or a SQLite (better-sqlite3) upgrade that changes how
files are laid out, fails it until the corpus is regenerated and committed.

**Expected** is the outcome BMD-1081 asks for. Where the service does not
give it yet, the cell says what it does today, so a tester can tell a gap
in the service from a failure.

`npm run check:lineage -- --dir example-files/service-template` passes every file but `malformed/not-a-geopackage.gpkg`, which it reports as unreadable, as it should; `bng-500/BarkingandDagenham2400625FULL.gpkg`, which reports `lineage-parent-missing` (see its row). It skips the legacy-layout file. Each `lineage-problems/` file reports exactly the flaw its name gives.

The `bng-500/` files need the template's converter: the bng-metric-template
sibling (or the checkout `BNG_TEMPLATE_DIR` names) and python3; without them
the generator skips those files and says why. They come from the converter
at commit `073550c`. CI rebuilds them there and requires them to match
byte for byte; the test skips them elsewhere, as a local checkout may be at
another commit.

## permutations/

The scenario corpus, one file per scenario with its baseline-stage file and
its metric workbook, built by `npm run generate:scenarios -- --format
bng-service` rather than from these recipes. See `permutations/index.md`
and `docs/generate-scenarios.md`.

## valid/

Valid files, combined and baseline-stage: each should upload cleanly.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `default-site.gpkg` | The default site, holding both stages and every feature only the new template records: vertical area habitats, comments, an Enhanced tree, habitats that get worse on each layer, a re-meandered and a shorter watercourse, Habitat Refs that repeat, and a habitat on each layer delayed by 30+ years. It marks nothing irreplaceable, as the service refuses an irreplaceable habitat (see `attribute-problems/irreplaceable-*.gpkg`) | accepted | seed 1 |
| `default-site-baseline.gpkg` | The default site's baseline-stage file: the post-intervention tables are present and empty | accepted | seed 1, baseline stage |
| `plain-site.gpkg` | The default site without the template-only features: what the legacy generator draws, in the new format | accepted | seed 1, no template-only features |
| `small-site.gpkg` | A 3-parcel site, holding both stages | accepted | seed 2, 3 parcels |
| `small-site-baseline.gpkg` | The small site's baseline-stage file | accepted | seed 2, 3 parcels, baseline stage |
| `large-site.gpkg` | A 150-parcel site, holding both stages | accepted | seed 3, 150 parcels |
| `large-site-baseline.gpkg` | The large site's baseline-stage file | accepted | seed 3, 150 parcels, baseline stage |
| `duplicate-habitat-ref.gpkg` | Two habitat parcels share one Habitat Ref | accepted since BMD-1058, which lets habitats share a reference | seed 1, 5 parcels, flaw `duplicate-habitat-ref` |
| `tiny-gap.gpkg` | parcels tile the redline except a sub-tolerance gap — file is accepted | accepted: the gap is below the AREA_SUM_MISMATCH tolerance | seed 1, flaw `tiny-gap` |

## spatial-problems/

Valid schema, invalid geometry: each trips one geometry validator. Baseline-stage files, as the legacy family's are, so a broken parcel does not also break its post-intervention lineage.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `self-intersecting-redline-baseline.gpkg` | redline drawn as a bowtie (self-intersecting) | REDLINE_INVALID_GEOMETRY | seed 1, baseline stage, flaw `self-intersecting-redline` |
| `bowtie-parcel-baseline.gpkg` | one habitat parcel drawn as a bowtie | AREA_PARCELS_INVALID_GEOMETRY | seed 1, baseline stage, flaw `bowtie-parcel` |
| `overlapping-parcels-baseline.gpkg` | two habitat parcels overlap each other | PARCEL_OVERLAPS | seed 1, baseline stage, flaw `overlapping-parcels` |
| `parcel-outside-redline-baseline.gpkg` | a habitat parcel placed entirely outside the redline | AREA_PARCELS_OUTSIDE_REDLINE | seed 1, baseline stage, flaw `parcel-outside-redline` |
| `parcel-too-small-baseline.gpkg` | a habitat parcel under the 1 m² minimum area | AREA_PARCELS_TOO_SMALL | seed 1, baseline stage, flaw `parcel-too-small` |
| `hedgerow-outside-baseline.gpkg` | a hedgerow runs from inside to outside the redline | HEDGEROWS_OUTSIDE_REDLINE | seed 1, baseline stage, flaw `hedgerow-outside` |
| `watercourse-outside-baseline.gpkg` | a watercourse runs from inside to outside the redline | WATERCOURSES_OUTSIDE_REDLINE | seed 1, baseline stage, flaw `watercourse-outside` |
| `tree-outside-baseline.gpkg` | a tree is placed outside the redline | TREES_OUTSIDE_REDLINE | seed 1, baseline stage, flaw `tree-outside` |
| `iggi-outside-baseline.gpkg` | an IGGI polygon is placed outside the redline | IGGIS_OUTSIDE_REDLINE | seed 1, baseline stage, flaw `iggi-outside` |
| `area-sum-mismatch-baseline.gpkg` | habitat parcels do not tile the redline | AREA_SUM_MISMATCH | seed 1, baseline stage, flaw `area-sum-mismatch` |
| `redline-not-in-england-baseline.gpkg` | redline placed outside England (Snowdonia, Wales) | REDLINE_OUTSIDE_ENGLAND | seed 1, baseline stage, flaw `redline-not-in-england` |
| `redline-too-large-baseline.gpkg` | redline area exceeds the 100 sq km limit | REDLINE_AREA_TOO_LARGE | seed 1, baseline stage, flaw `redline-too-large` |

## invalid-schema/

Wrong table or column shape, derived from `valid/default-site.gpkg` by SQL: trips schema comparison before any geometry check. Also a legacy-layout file.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `no-area-habitats-baseline-table.gpkg` | The `Area Habitats Baseline` table is absent (contrast `empty-layer/no-habitats.gpkg`, where it is present but empty) | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `no-post-intervention-tables.gpkg` | Every Post-Intervention table is absent: a baseline-stage file keeps them, empty | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `missing-columns-in-area-habitats.gpkg` | `Area Habitats Baseline` has no `Baseline Condition` or `Area` column | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `wrong-column-names-in-area-habitats.gpkg` | `Area Habitats Baseline` names `Baseline Habitat Type` as `Habitat Type`, and `Baseline Condition` as `Condition` | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `wrong-column-data-types-in-area-habitats.gpkg` | `Area Habitats Baseline` declares `Area` as TEXT and `Habitat Ref` as INTEGER | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `wrong-geometry-type-in-area-habitats.gpkg` | `Area Habitats Baseline` declares its geometry LINESTRING; the template's is POLYGON | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `wrong-geometry-type-in-hedgerows.gpkg` | `Hedgerows Baseline` declares its geometry POLYGON; the template's is LINESTRING | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `wrong-geometry-type-in-watercourses.gpkg` | `Watercourses Baseline` declares its geometry POLYGON; the template's is LINESTRING | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `wrong-geometry-type-in-red-line-boundary.gpkg` | `Red Line Boundary` declares its geometry POINT; the template's is POLYGON | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `red-line-boundary-wrong-spatial-reference.gpkg` | `Red Line Boundary` is registered in WGS 84 (srs_id 4326) rather than British National Grid (27700); its coordinates are unchanged | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `wrong-geometry-column-name-in-red-line-boundary.gpkg` | `Red Line Boundary`'s geometry column is named `geometry`; the template's is `geom` | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `no-geometry-column-in-red-line-boundary.gpkg` | `Red Line Boundary` has no geometry column | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `multiple-geometry-columns-in-red-line-boundary.gpkg` | `Red Line Boundary` registers a second, empty geometry column, `geom2` | refused: the file does not match the BNG Service template's schema | `valid/default-site.gpkg`, edited by SQL |
| `legacy-template.gpkg` | A valid file in the legacy (Natural England) template, uploaded where the BNG Service template is expected | refused: the file does not match the BNG Service template's schema (a legacy file, accepted with the service-template flag off) | copy of `example-files/valid/Baseline - complete with area refs.gpkg` |

## empty-layer/

Valid schema, a feature layer present but with no rows.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `no-habitats.gpkg` | Habitats layer present with zero rows | NO_HABITAT_AREAS | seed 1, flaw `no-habitats` |
| `no-hedgerows.gpkg` | Hedgerows layer present with zero rows | (no specific backend error) | seed 1, flaw `no-hedgerows` |
| `no-rivers.gpkg` | Rivers layer present with zero rows | (no specific backend error) | seed 1, flaw `no-rivers` |
| `no-trees.gpkg` | Urban Trees layer present with zero rows | (no specific backend error) | seed 1, flaw `no-trees` |

## attribute-problems/

Valid schema and geometry: an attribute value trips a later validator, or a habitat that gets worse breaks a rule the service refuses.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `distinctiveness-out-of-scope.gpkg` | habitat types whose reference-data distinctiveness is rejected by the BNG Beta service | HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE | seed 1, flaw `distinctiveness-out-of-scope` |
| `missing-habitat-ref.gpkg` | a habitat parcel whose Parcel Ref is only spaces | HABITAT_REF_MISSING | seed 1, flaw `missing-habitat-ref` |
| `habitat-ref-invalid-characters.gpkg` | a habitat parcel whose Parcel Ref holds the character a decoder puts in place of invalid UTF-8 | HABITAT_REF_INVALID_CHARACTERS | seed 1, flaw `habitat-ref-invalid-characters` |
| `advance-delay-both-set.gpkg` | a created habitat carries both advance and delayed creation years | ADVANCE_AND_DELAY_BOTH_SET | seed 1, flaw `advance-delay-both-set` |
| `degrade-advance-missing.gpkg` | a hedgerow that gets worse (Created in its own type, linked to its parent, in a lower condition) has no years created in advance, where the Metric asks for 30 plus | STAGED_DEGRADE_ADVANCE_NOT_30_PLUS | seed 1, flaw `degrade-advance-missing` |
| `degrade-not-worse.gpkg` | a same-type creation that is not worse: a hedgerow Created in its own type, linked to its parent, with 30+ years in advance, in its baseline condition (a 30+ on a row that does not get worse overstates its units) | STAGED_DEGRADE_NOT_WORSE | seed 1, flaw `degrade-not-worse` |
| `degrade-watercourse-retained-and-created.gpkg` | a baseline watercourse has both a Retained and a Created post-intervention part. The template records part of a stretch changing by splitting it at the baseline survey, as the service cannot measure part of a watercourse | STAGED_WATERCOURSE_RETAINED_AND_CREATED | seed 1, flaw `degrade-watercourse-retained-and-created` |
| `degrade-habitat-ref-blank.gpkg` | an area habitat that gets worse has an empty Habitat Ref on its post-intervention row only; its baseline row keeps its ref, so only a check of the post-intervention tables finds it | HABITAT_REF_MISSING | seed 1, flaw `degrade-habitat-ref-blank` |
| `irreplaceable-area-habitat.gpkg` | `valid/default-site.gpkg` with its woodland parcel marked irreplaceable (Irreplaceable Habitat `Yes`) in both stages | refused (BMD-1176). Accepted today: the service does not check irreplaceable habitats yet | seed 1, irreplaceable `habitats` |
| `irreplaceable-tree.gpkg` | `valid/default-site.gpkg` with one Retained tree marked irreplaceable (a veteran tree) in both stages | refused (BMD-1172). Accepted today: the service does not check irreplaceable habitats yet | seed 1, irreplaceable `trees` |

## lineage-problems/

A post-intervention feature names its baseline parent wrongly. `npm run check:lineage` reports each file's own flaw, named in its file name.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `lineage-parent-missing.gpkg` | a Retained area habitat carries no Parent Ref, parent_uuid or parent_geom, so it names no baseline habitat it continues | STAGED_PARENT_LINK_MISSING | seed 1, flaw `lineage-parent-missing` |
| `lineage-parent-unknown.gpkg` | a Retained area habitat names a parent, by Parent Ref and parent_uuid, that is not in the baseline | STAGED_UNKNOWN_PARENT_REF | seed 1, flaw `lineage-parent-unknown` |
| `lineage-parent-wrong.gpkg` | a Retained area habitat names another baseline parcel as its parent, so it lies outside the parent it names | refused. Accepted today: the service compares the parent's shape with the one the row recorded, not with the row's own shape | seed 1, flaw `lineage-parent-wrong` |
| `lineage-parent-geom-mismatch.gpkg` | a Retained area habitat's parent_geom is its parent's shape moved 5 m, as if the baseline changed after the copy | STAGED_BASELINE_DRIFTED | seed 1, flaw `lineage-parent-geom-mismatch` |
| `lineage-parent-geom-missing.gpkg` | a Retained area habitat names its parent by Parent Ref and parent_uuid, but has no parent_geom, so the parent's shape cannot be compared | STAGED_BASELINE_DRIFTED | seed 1, flaw `lineage-parent-geom-missing` |

## incomplete/

A watercourse that gets worse is recorded in a way the service saves as Incomplete rather than refuses.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `degrade-watercourse-advance-not-encroachment.gpkg` | a watercourse whose condition gets worse, with no change of encroachment, is created 10 years in advance, which the Metric allows only where encroachment increases with no other impact | saved as Incomplete, with its years created in advance cleared | seed 1, flaw `degrade-watercourse-advance-not-encroachment` |
| `degrade-watercourse-encroachment-no-advance.gpkg` | a watercourse whose only change is more encroachment has no years created in advance, though the Metric allows 10 or more for it | saved as Incomplete, for want of years created in advance | seed 1, flaw `degrade-watercourse-encroachment-no-advance` |

## version-problems/

The template version record is missing, doubled or unsupported.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `version-record-missing.gpkg` | the GeoPackage has no template version record | TEMPLATE_VERSION_MISSING | seed 1, flaw `version-record-missing` |
| `version-record-duplicated.gpkg` | the GeoPackage has two template version records | TEMPLATE_VERSION_DUPLICATED | seed 1, flaw `version-record-duplicated` |
| `version-unsupported.gpkg` | the template version record names a version the service does not support (the next major version after 1.0) | TEMPLATE_VERSION_UNSUPPORTED | seed 1, flaw `version-unsupported` |

## bng-500/

The legacy `bng-500/` pairs, built from real Defra metric workbooks, converted by the BNG Service template's own converter (`old_to_new.py`, bng-metric-template) as a user converts a legacy file. They are what the converter writes, before the manual steps it leaves to the user (its warnings), so each still holds values the template does not offer; the recipes list them, and the tests pin them.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `BROADLAND_2024_3282.gpkg` | `BROADLAND_2024_3282`, converted. Values the template does not offer in Individual Trees Baseline (Baseline Rural or Urban Tree, Baseline Tree Type); Individual Trees Post-Intervention (Baseline Tree Size, Category, Proposed Rural or Urban Tree, Proposed Tree Size, Proposed Tree Type, Retention Category, Baseline Condition, Baseline Rural or Urban Tree, Baseline Tree Type) | not ready to upload as it stands: the converter's manual steps (its warnings) are still to do | `example-files/bng-500/BROADLAND_2024_3282-baseline.gpkg` and its post-intervention file, converted at bng-metric-template 073550c, seed 1 |
| `BarkingandDagenham2400625FULL.gpkg` | `BarkingandDagenham2400625FULL`, converted. Lineage: `lineage-parent-missing`. Values the template does not offer in Individual Trees Post-Intervention (Baseline Tree Size, Category, Proposed Rural or Urban Tree, Proposed Tree Size, Proposed Tree Type, Retention Category, Proposed Strategic Significance); Watercourses Post-Intervention (Baseline Encroachment into riparian zone, Proposed Encroachment into riparian zone, Baseline Encroachment into Watercourse, Proposed Encroachment into Watercourse) | not ready to upload as it stands: the converter's manual steps (its warnings) are still to do | `example-files/bng-500/BarkingandDagenham2400625FULL-baseline.gpkg` and its post-intervention file, converted at bng-metric-template 073550c, seed 1 |
| `CAMBRIDGE_24_03964_FUL.gpkg` | `CAMBRIDGE_24_03964_FUL`, converted. Values the template does not offer in Area Habitats Post-Intervention (Proposed Strategic Significance); Individual Trees Baseline (Baseline Rural or Urban Tree, Baseline Tree Type); Individual Trees Post-Intervention (Baseline Tree Size, Category, Proposed Rural or Urban Tree, Proposed Tree Size, Proposed Tree Type, Retention Category, Baseline Condition, Baseline Rural or Urban Tree, Baseline Tree Type) | not ready to upload as it stands: the converter's manual steps (its warnings) are still to do | `example-files/bng-500/CAMBRIDGE_24_03964_FUL-baseline.gpkg` and its post-intervention file, converted at bng-metric-template 073550c, seed 1 |
| `Sunderland_24_00723_FU4.gpkg` | `Sunderland_24_00723_FU4`, converted. Values the template does not offer in Area Habitats Baseline (Baseline Habitat Type); Area Habitats Post-Intervention (Habitat created in advance/years); Hedgerows Post-Intervention (Habitat created in advance/years); Individual Trees Baseline (Baseline Rural or Urban Tree, Baseline Tree Type); Individual Trees Post-Intervention (Baseline Tree Size, Category, Proposed Rural or Urban Tree, Proposed Tree Size, Proposed Tree Type, Retention Category, Habitat Created/Enhanced in advance/years); Watercourses Post-Intervention (Baseline Encroachment into riparian zone, Proposed Encroachment into riparian zone) | not ready to upload as it stands: the converter's manual steps (its warnings) are still to do | `example-files/bng-500/Sunderland_24_00723_FU4-baseline.gpkg` and its post-intervention file, converted at bng-metric-template 073550c, seed 1 |
| `Wiltshire_PL_2024_08441.gpkg` | `Wiltshire_PL_2024_08441`, converted. Values the template does not offer in Watercourses Post-Intervention (Baseline Encroachment into riparian zone, Proposed Encroachment into riparian zone, Baseline Encroachment into Watercourse, Proposed Encroachment into Watercourse) | not ready to upload as it stands: the converter's manual steps (its warnings) are still to do | `example-files/bng-500/Wiltshire_PL_2024_08441-baseline.gpkg` and its post-intervention file, converted at bng-metric-template 073550c, seed 1 |

## malformed/

Not a GeoPackage at all.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `not-a-geopackage.gpkg` | A text file with a `.gpkg` extension: not a GeoPackage at all | refused: the file cannot be read as a GeoPackage | copy of `example-files/malformed/Not a valid geopackage.gpkg` |

## filename-problems/

A valid file; only the upload's own file name is invalid.

| File | Covers | Expected | Built from |
| ---- | ------ | -------- | ---------- |
| `default site [invalid chars].gpkg` | `valid/default-site.gpkg` byte for byte; the brackets are invalid in an uploaded file name | refused: the file name has characters `SAFE_FILENAME_RE` forbids | copy of `valid/default-site.gpkg` |

## Gaps

- A natural river left out, and an irreplaceable tree that gets worse: the service refuses either file for another reason first, so a fixture could not show the rule. Natural rivers (Other rivers and streams, High; Priority habitat, V.High) are out of the service's scope, and only canals and ditches may be lost (a culvert left out is refused, STAGED_NATURAL_WATERCOURSE_LOST); an irreplaceable tree is refused whether or not it gets worse (`attribute-problems/irreplaceable-tree.gpkg`).
- Individual trees with varied counts: the template has no Count column, and how several trees are recorded is undecided (BMD-1171, BMD-1172).
- The harness's import-timing scenarios: they edit legacy files, so `permutations/` builds them in the legacy format only.
