# Example GeoPackages

Curated `.gpkg` fixtures for manual testing and for exercising the upload
journeys by hand. They are grouped by **the scenario family they cover**, not by
where they came from:

| Directory             | Covers                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `valid/`              | Structurally and geometrically valid — should upload cleanly               |
| `spatial-problems/`   | Valid schema, invalid geometry — trips a geometry validator                |
| `invalid-schema/`     | Wrong table/column shape — trips schema comparison before geometry checks  |
| `empty-layer/`        | Valid schema, a feature layer present but with zero rows                   |
| `attribute-problems/` | Valid schema and geometry — attribute values trip a later validator        |
| `bng-500/`            | Built from real Defra metric workbooks in the BNG500 corpus                |
| `malformed/`          | Not a GeoPackage at all                                                    |
| `filename-problems/`  | A valid GeoPackage; only the upload's own filename is invalid              |

Stage (`Baseline` / `Post-intervention`) is a filename prefix rather than a
directory level, so a family can be read in one listing.

These files are **the harness's own copies**. `journey-tests`, `backend` and
`prototype` each keep separate copies of their fixtures; those are not kept in
sync with this directory, and some already differ byte-for-byte despite sharing
a filename. Nothing in the harness reads this directory — it is a reference
corpus for humans.

Regenerate reproducible fixtures with `npm run generate:gpkg` (see
`docs/generate-test-data.md`). The `--flaw <name>` vocabulary in
`scripts/gen-gpkg.mjs` is the authoritative scenario list; the "Flaw" column
below gives the flag that reproduces a file where one exists.

Every fixture here stays within the beta's distinctiveness scope (V.Low, Low,
Medium) apart from the two deliberate exceptions noted below —
`attribute-problems/Baseline - habitat distinctiveness out of scope.gpkg`, which
exists to trip the check, and `bng-500/`, which is real survey data. A fixture
that carries an out-of-scope habitat trips
`HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE`, and because that error is reported ahead
of the geometry errors it masks whatever the fixture was built to demonstrate.
The generator enforces this by drawing from the in-scope type pools; note that
every `Wetland` habitat type is High or V.High, so no in-scope fixture can carry
one.

## valid/

| File                                             | Covers                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `Baseline - complete with area refs.gpkg`        | The canonical happy-path baseline. 3 habitats, 2 hedgerows, 1 river, 1 RLB, area refs populated. **Has no Urban Trees layer** — see Gaps. |
| `Baseline - complete but null area refs.gpkg`    | Identical to the above except `Habitats."Parcel Ref"`, which holds the literal **string** `"Null"` on all 3 rows — not SQL `NULL`. **Probably not what was intended** — see Open questions. |
| `Baseline - three rlb polygons.gpkg`             | RLB layer holds 3 polygons rather than 1. **Classification unconfirmed** — see Open questions.      |
| `Post-intervention - complete.gpkg`              | Happy-path post-intervention. 12 habitats + RLB only; no hedgerow/river/tree layers.               |
| `Post-intervention - complete (bng-500 variant).gpkg` | Structurally identical to the above (12 habitats + RLB) but different bytes. **Suspected stale duplicate** — see Open questions. Was `Post-intervention - complete, bng-500 variant.gpkg`; the comma is invalid in an uploaded filename (`SAFE_FILENAME_RE`) — see `filename-problems/`. |
| `Baseline - retained hedgerow.gpkg` / `Post-intervention - retained hedgerow.gpkg` | A hedgerow retained through the intervention. Baseline 3 habitats / 2 hedgerows; post-intervention 12 habitats / 3 hedgerows. The pair shares one RLB. |
| `Baseline - retained watercourse.gpkg` / `Post-intervention - retained watercourse.gpkg` | A watercourse retained through the intervention. Both stages carry all five layers (20 habitats, 6 hedgerows, 1 river, 10 trees) and share one RLB. |
| `Baseline - IGGI habitat.gpkg` / `Post-intervention - IGGI habitat.gpkg` | The only fixture carrying an **IGGI** parcel — `Intertidal hard structures - Artificial hard structures with integrated greening of grey infrastructure (IGGI)`, V.Low, Retained — alongside two ordinary in-scope area habitats (Urban / Bioswale, Sparsely vegetated land / Other inland rock and scree). All five layers (3 habitats, 3 hedgerows, 2 rivers, 5 trees, 1 RLB); the pair shares one RLB and passes `scripts/check-gpkg-pair.mjs`. Reproduced by the command under this table. Note IGGI scores 0 units — V.Low is worth 0 in the area distinctiveness table. |
| `Baseline - all unit and intervention types.gpkg` / `Post-intervention - all unit and intervention types.gpkg` | All five layers (120 habitats, 40 hedgerows, 8 rivers, 60 trees, 1 RLB) with every retention category on habitats, hedgerows **and** watercourses. Habitat areas tile the RLB exactly (517,339 m²) and every distinctiveness is in scope. The pair shares one RLB and passes `scripts/check-gpkg-pair.mjs`. Predates the created-linear fix, so its created hedgerows and watercourses carry `Lost` and are dropped on upload — use `created linear features` below for a post-fix pair; see Gaps. |
| `Baseline - created linear features.gpkg` / `Post-intervention - created linear features.gpkg` | Purpose-built for the created-linear-features fix (BMD-891), generated from the fixed `bng-library`. All five layers (55 habitats, 18 hedgerows, 3 rivers, 27 trees, 1 RLB). The post-intervention file carries a created **and** a lost feature in every linear class — hedgerows (Created 4, Enhanced 2, Lost 5, Retained 7), rivers (one each of Created / Enhanced / Lost) and Urban Trees (1 `Newly Planted` created tree alongside Enhanced / Lost / Retained). Every `Created` linear row uses the NE template's placeholder baseline (`To be created` / `Newly Planted` and `N/A` throughout) with real proposed values, so it survives upload and produces units, while the `Lost` rows are still dropped — demonstrating **AC1** (created hedgerow / watercourse / tree survives) and **AC2** (removed one still ignored, told apart) across all three classes in one upload. Distinctiveness is in scope; the pair shares one RLB and passes `scripts/check-gpkg-pair.mjs`. |
| `Baseline - tiny gap between parcels.gpkg`    | Two parcels tile the RLB except a 0.32 m² unsnapped gap — below the 0.5 m² `AREA_SUM_MISMATCH` tolerance, so the file is **accepted**. Positive control proving hairline gaps between parcels do not fail validation. Flaw: `tiny-gap`. |

The IGGI pair is the one fixture here with an exact recipe. `--pair` derives the
baseline half from the post-intervention half, so both stages share a redline;
`--habitat` pins the first parcel to a habitat the random pools never draw (they
are inland-only). Rename the two timestamped outputs to the names above:

```sh
npm run generate:gpkg -- --size 3 --pair --outdir example-files/valid \
  --habitat "Intertidal hard structures - Artificial hard structures with integrated greening of grey infrastructure (IGGI)"
```

The other two parcels are randomised, so a regenerated pair will not carry the
same two companion habitats — only the IGGI parcel is guaranteed.

## spatial-problems/

Each file is a minimal fixture targeting one geometry validator.

| File                                          | Covers                                                | Flaw                        | Error code                       |
| --------------------------------------------- | ------------------------------------------------------ | --------------------------- | -------------------------------- |
| `Baseline - self intersecting redline.gpkg`   | RLB drawn as a bowtie                                   | `self-intersecting-redline` | `REDLINE_INVALID_GEOMETRY`       |
| `Baseline - bowtie parcel.gpkg`               | One habitat parcel drawn as a bowtie                    | `bowtie-parcel`             | `AREA_PARCELS_INVALID_GEOMETRY`  |
| `Baseline - overlapping parcels.gpkg`         | Two habitat parcels overlap each other                  | `overlapping-parcels`       | `PARCEL_OVERLAPS`                |
| `Baseline - parcel outside redline.gpkg`      | A habitat parcel sits entirely outside the RLB          | `parcel-outside-redline`    | `AREA_PARCELS_OUTSIDE_REDLINE`   |
| `Baseline - parcel too small.gpkg`            | One habitat parcel is smaller than the 1 m² minimum area | `parcel-too-small`          | `AREA_PARCELS_TOO_SMALL`         |
| `Baseline - area sum mismatch.gpkg`           | Habitat parcels do not tile the RLB — total parcel area ≠ RLB area  | `area-sum-mismatch`         | `AREA_SUM_MISMATCH`              |
| `Baseline - hedgerow outside.gpkg`            | A hedgerow lies outside the RLB                         | `hedgerow-outside`          | `HEDGEROWS_OUTSIDE_REDLINE`      |
| `Baseline - watercourse outside.gpkg`         | A river lies outside the RLB                            | `watercourse-outside`       | `WATERCOURSES_OUTSIDE_REDLINE`   |
| `Baseline - tree outside.gpkg`                | An urban tree sits outside the RLB                      | `tree-outside`              | `TREES_OUTSIDE_REDLINE`          |
| `Baseline - iggi outside.gpkg`                | Carries a non-standard `iggis` layer, which the baseline template schema does not list, so the file is rejected as an unexpected layer **before** the spatial check runs. `IGGIS_OUTSIDE_REDLINE` is currently unreachable via upload — see Gaps. | `iggi-outside` | `GPKG_UNEXPECTED_FEATURE_LAYER` |
| `Baseline - redline not in england.gpkg`      | RLB placed outside England                              | `redline-not-in-england`    | `REDLINE_OUTSIDE_ENGLAND`        |

## invalid-schema/

Wrong table or column shape. These fail schema comparison, which runs before
geometry validation — so a schema fixture never reaches the geometry validators.

| File                                                          | Covers                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Baseline - no habitats table.gpkg`                           | Habitats table absent entirely (contrast `empty-layer/`, where it exists but is empty). |
| `Baseline - no habitats table (three rlb polygons).gpkg`      | As above, combined with a 3-polygon RLB. Was `... table, three rlb polygons.gpkg`; the comma is invalid in an uploaded filename (`SAFE_FILENAME_RE`) — see `filename-problems/`. |
| `Baseline - missing columns in Habitats.gpkg`                 | Habitats is missing expected columns.                                        |
| `Baseline - wrong column names in Habitats.gpkg`              | Habitats columns are misnamed.                                               |
| `Baseline - missing and wrong column names in Habitats.gpkg`  | Both of the above at once.                                                   |
| `Baseline - wrong column data types in Habitats.gpkg`         | Habitats columns carry the wrong SQLite types.                               |
| `Baseline - wrong geometry type in Habitats.gpkg`             | `Habitats.geom` declared `LINESTRING`; schema expects `MULTIPOLYGON`. Was `Baseline - habitats with incorrect geometry.gpkg`. |
| `Baseline - wrong geometry type in Hedgerows.gpkg`            | `Hedgerows.geom` declared `POLYGON`; schema expects `LINESTRING`. Was `Baseline - hedgerow incorrect geometry.gpkg`. |
| `Baseline - wrong geometry type in Rivers.gpkg`               | `Rivers.geom` declared `POLYGON`; schema expects `LINESTRING`. Was `Baseline - watercourse incorrect geometry.gpkg`. |
| `Baseline - rlb has wrong spatial reference.gpkg`             | RLB declares `srs_id` 99999 instead of 27700. **Not minimal** — see below.   |
| `Post-intervention - wrong geometry column name in RLB layer.gpkg` | RLB geometry column named `geom`; schema expects `geometry`. Was `Post-intervention - incorrect geom column name.gpkg`. |
| `Post-intervention - no geometry column in RLB layer.gpkg`    | RLB layer registers no geometry column at all.                               |
| `Post-intervention - multiple geometry columns in RLB layer.gpkg` | RLB registers two geometry columns (`geom` + `geom2`). **Not minimal.**  |
| `Post-intervention - wrong geometry type in RLB layer.gpkg`   | RLB geometry declared `POINT`; schema expects `POLYGON`. Was `Post-intervention - wrong geometry in RLB layer.gpkg`. **Not minimal.** |

The three renamed `wrong geometry type in …` files previously read as "incorrect
geometry", which suggested invalid geometry (a geometry-validator concern). They
are in fact wrong *declared* geometry types, caught by schema comparison. The old
names put them in the wrong family.

## empty-layer/

Schema is intact; one feature layer is present but holds zero rows.

| File                                          | Covers                                                              | Flaw            | Error code         |
| --------------------------------------------- | -------------------------------------------------------------------- | --------------- | ------------------ |
| `Baseline - no habitats (full site).gpkg`     | Habitats empty on a full-size site (0 habitats, 16 hedgerows, 3 rivers, 25 trees). Was `Baseline - no habitats, full site.gpkg`; the comma is invalid in an uploaded filename (`SAFE_FILENAME_RE`) — see `filename-problems/`. | `no-habitats` | `NO_HABITAT_AREAS` |
| `Baseline - no habitats (minimal site).gpkg`  | Habitats empty on a minimal site (0 habitats, 2 hedgerows, 1 river, no trees). Same scenario as above at a different scale — see Gaps. Renamed for the same reason as the file above. | `no-habitats` | `NO_HABITAT_AREAS` |
| `Baseline - no hedgerows.gpkg`                | Hedgerows layer present, zero rows.                                  | `no-hedgerows`  | none specific      |
| `Baseline - no watercourses.gpkg`             | Rivers layer present, zero rows.                                     | `no-rivers`     | none specific      |
| `Baseline - no rlb polygons.gpkg`             | RLB layer present, zero rows.                                        | —               | none specific      |

The two "no habitats" files were previously `Baseline - no habitats.gpkg` and
`Baseline - no habitats polygons.gpkg`, which named the same scenario twice with
no way to tell them apart.

## attribute-problems/

Schema and geometry are both valid; attribute values trip a later validator.

| File                                                    | Covers                                                                 | Flaw                           | Error code                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------ | -------------------------------------- |
| `Baseline - habitat distinctiveness out of scope.gpkg`  | Habitat rows carry out-of-scope distinctiveness values.                 | `distinctiveness-out-of-scope` | `HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE` |
| `Baseline - duplicate habitat ref.gpkg`                 | Two habitat rows share a reference.                                     | `duplicate-habitat-ref`        | `DUPLICATE_HABITAT_REF`                |
| `Post-intervention - missing proposed habitat data.gpkg` | 1 of 12 parcels has null Proposed Habitat Type / Condition / Distinctiveness; 2 of 12 have null creation-delay values. Was `Post-intervention (missing data) - fails validation.gpkg`, which named no validator. **Not minimal.** | — | — |
| `Post-intervention - advance and delay both set.gpkg`    | One created habitat parcel (H001) carries both advance (2) and delayed (3) creation years — the statutory metric forbids the pair. Upload as the post-intervention half after any valid baseline; the check runs per file, so the baseline pairing doesn't matter. | `advance-delay-both-set` | `ADVANCE_AND_DELAY_BOTH_SET` |

## bng-500/

Baseline / post-intervention pairs generated from real Defra metric workbooks in
the **BNG500 corpus** — the external `abitatdotdev/bng-metrics` collection of
real submitted metric workbooks, which the generator downloads and caches in
`.cache/bng500/`. The folder keeps the corpus name because that is what the
files are: BNG500 output, not hand-built examples.

Generated via `npm run generate:gpkg -- --from <workbook>`. Site names are real.
Each pair's baseline and post-intervention share byte-identical RLB geometry
(verified across all five pairs), so they model the two-stage journey — as do
the two `valid/retained *` pairs. `scripts/check-gpkg-pair.mjs` validates pair
coherence.

Row counts below are habitats / hedgerows / rivers / trees. Layer population
varies by site — these are real sites, so empty layers are genuine, not flaws:

| Pair                              | Baseline    | Post-intervention | Covers                                       |
| --------------------------------- | ----------- | ----------------- | -------------------------------------------- |
| `BROADLAND_2024_3282-*`           | 1/0/0/1     | 4/1/0/2           | Broadland — "Oakwood Regional Development". Smallest site; habitat creation and a new hedgerow. |
| `BarkingandDagenham2400625FULL-*` | 2/0/2/0     | 4/1/2/1           | Barking and Dagenham — hedgerow and tree created from nothing. |
| `CAMBRIDGE_24_03964_FUL-*`        | 4/1/0/2     | 9/1/0/3           | Cambridge — habitat count more than doubles.  |
| `Sunderland_24_00723_FU4-*`       | 26/18/2/1   | 33/13/2/1         | Sunderland — large site; hedgerow count *falls* (18 → 13). |
| `Wiltshire_PL_2024_08441-*`       | 37/27/11/0  | 36/34/11/0        | Wiltshire — largest site; 11 watercourses, no trees. |

Each pair has a `-baseline.gpkg` and a `-post-intervention.gpkg`. The files
previously carried a shared `-20260603` datestamp, dropped because it was
identical across all ten and recorded nothing useful.

**Three of the five pairs cannot complete an upload.** Barking and Dagenham,
Sunderland and Wiltshire all contain High or Very High distinctiveness habitats
— mostly `Other rivers and streams` (High), `Priority habitat` (V.High) and the
`… with trees` / `… associated with bank or ditch` hedgerow types — so the
backend rejects them with `HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE`. This is real
surveyed ecology, not a fixture defect, so the files are deliberately left as
they are: they record how much of a real submission falls outside beta scope.
Only BROADLAND and Cambridge are uploadable end to end.

Note the folder is `bng-500/` while the generator's cache is `.cache/bng500/`
and the code spells the corpus "BNG500" throughout — the hyphen here is
deliberate and does not need reconciling.

## malformed/

| File                          | Covers                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `Not a valid geopackage.gpkg` | 26 bytes, not a SQLite database. Exercises the file-format check before any GeoPackage parsing. |

## filename-problems/

The check here is on the upload's own filename (`SAFE_FILENAME_RE` in
`backend/src/validation/project-shared-schemas.js`), not on anything inside the
file — the file below is otherwise a valid GeoPackage. This is a Joi check on
the upload metadata rather than the validation gate, so it has no generator
flaw and cannot be reproduced with `npm run generate:gpkg`; the file was
built by copying a valid fixture and renaming it.

| File                             | Covers                                                        | Flaw | Error code         |
| --------------------------------- | -------------------------------------------------------------- | ---- | ------------------- |
| `Baseline [invalid chars].gpkg`  | Filename contains characters outside the allowed set (`[` `]`) | —    | `INVALID_FILENAME`  |

## Fixtures that are not minimal

Four fixtures trip a validator in addition to the one they are named for,
because their RLB geometry column is named `geom` where the reference schema
(`backend/src/validation/reference/gpkg-template.schema.json`)
requires `geometry`. Schema comparison runs first, so **the validator that fires
may not be the one the fixture is named for**:

- `invalid-schema/Baseline - rlb has wrong spatial reference.gpkg`
- `invalid-schema/Post-intervention - multiple geometry columns in RLB layer.gpkg`
- `invalid-schema/Post-intervention - wrong geometry type in RLB layer.gpkg`
- `attribute-problems/Post-intervention - missing proposed habitat data.gpkg`

For the three `invalid-schema/` files this only muddies *which* schema error fires. For
the `attribute-problems/` one it is more serious: it is filed as an attribute fixture but
will fail schema comparison and never reach the attribute validator.

## Gaps

Positive coverage is thin relative to negative coverage:

- **The "complete" baseline is not complete.** `valid/Baseline - complete with area refs.gpkg` has no Urban Trees layer — four of five. No fixture in `valid/` has all five layers populated. Fixtures that do exist (`spatial-problems/`, `attribute-problems/Baseline - habitat distinctiveness out of scope.gpkg`) are all deliberately flawed, so there is no clean five-layer baseline to upload.
- **The "complete" pair is not a pair.** The two `valid/` "complete" files are different shapes (3 habitats + no trees vs 12 habitats + RLB only) and do not share an RLB, so they cannot model the two-stage journey. The `retained hedgerow` / `retained watercourse` pairs and `bng-500/` do.
- **Positive controls for the geometry validators are thin.** Most geometric flaws have a negative fixture and no valid twin — near-miss positives (parcels sharing an exact boundary, a hedgerow ending precisely on the RLB, a site just under the area limit) would catch a validator that fires unconditionally.
- **No in-scope counterpart** to `attribute-problems/Baseline - habitat distinctiveness out of scope.gpkg`.
- **Two flaws have no fixture**: `redline-too-large`, `no-trees`.
- **`IGGIS_OUTSIDE_REDLINE` is unreachable via upload.** The spatial engine computes it, but `iggis` is not in the baseline template schema, so any file carrying that layer is rejected as `GPKG_UNEXPECTED_FEATURE_LAYER` before the spatial checks run. `Baseline - iggi outside.gpkg` therefore demonstrates the unexpected-layer rejection, not the outside-redline check. Reaching the check needs `iggis` added to the template schema (backend).
- **No post-intervention fixture for `AREA_PARCELS_TOO_SMALL`.** The old `Post-intervention - slivers.gpkg` was dropped when the derived-sliver check was replaced by the too-small-parcel check. `bng-library` can now derive a baseline twin from a flawed synthetic file (`deriveBaselineFromSynthetic`), so a shared-redline pair is producible — but the derived baseline inherits the too-small parcel and is rejected by the same check, so the pair still cannot model an accepted baseline followed by a rejected post-intervention upload. `Baseline - parcel too small.gpkg` covers the rule.
- **Two `valid/` post-intervention fixtures predate the created-linear fix (BMD-891).** Their created hedgerows and watercourses carry `Retention Category = Lost`, which the backend strips from the hedgerow, watercourse and tree layers — the `Lost` → `Created` mapping applies to area habitats only — so they render from the file but are dropped on upload. `bng-library` now persists `Created` with the NE template's `To be created` / `N/A` baseline columns, which the backend accepts and calculates units from, and the four baseline fixtures that carried the same rows have been regenerated. These two could not be:
  - `Post-intervention - all unit and intervention types.gpkg` — needed synthetic created-watercourse support (BMD-845), which the pinned `bng-library` now provides; it can be regenerated but has not yet been.
  - `Post-intervention - retained watercourse.gpkg` — carries a single river, which the generator cannot produce (`MIN_RIVER_COUNT` is 2), and is half of an RLB-sharing pair, so it has no reproducible recipe. Its watercourse type and encroachment values are asserted on by name in the journey tests, and both are drawn at random per run.

  Both still await a coordinated refresh. See `docs/ne-template-linear-retention.md`. A separate purpose-built `valid/Baseline - created linear features.gpkg` / `Post-intervention - created linear features.gpkg` pair now gives positive, post-fix upload coverage of created **hedgerows, watercourses and trees** (created + lost of each in one file), independent of those two refreshes.
- **Duplicate scenario**: the two `empty-layer/` "no habitats" files cover the same scenario at different scales; one is probably enough.

## Fixture shapes

Several unrelated shapes are mixed throughout, and a file's name does not reveal
which it is. This matters: two fixtures whose names differ by one word may be
built on completely different sites.

| Shape                       | Layers                                          | Used by                                                                 |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| **Minimal, no trees**       | 3 habitats, 2 hedgerows, 1 river, **Urban Trees absent** | `valid/Baseline - complete *`, `valid/Baseline - three rlb polygons.gpkg`, `valid/Baseline - retained hedgerow.gpkg`, all of `invalid-schema/` (baseline), `empty-layer/Baseline - no habitats (minimal site).gpkg`, `empty-layer/Baseline - no rlb polygons.gpkg` |
| **Small, all five layers**  | 1–5 habitats, 1–3 hedgerows, 1–2 rivers, 1–5 trees | all of `spatial-problems/` (baseline), `attribute-problems/Baseline - duplicate habitat ref.gpkg` |
| **Full-size, all five layers** | 50 habitats, 16 hedgerows, 3 rivers, 25 trees | `attribute-problems/Baseline - habitat distinctiveness out of scope.gpkg`, `empty-layer/Baseline - no habitats (full site).gpkg`, `- no hedgerows.gpkg`, `- no watercourses.gpkg` |
| **Post-intervention**       | 12 habitats + RLB; hedgerow/river/tree layers **absent** | every `Post-intervention - *` fixture except the two `valid/retained *` ones |
| **Retained pair**           | watercourse: 20 habitats, 6 hedgerows, 1 river, 10 trees at both stages. hedgerow: 12 habitats, 3 hedgerows, no river/tree layers post-intervention | `valid/*retained watercourse.gpkg`, `valid/Post-intervention - retained hedgerow.gpkg` |

Reproducibility splits along family, not shape: `spatial-problems/`, `empty-layer/` and
`attribute-problems/` map onto `--flaw` names and can be regenerated. **No `invalid-schema/`
fixture can be** — the generator has no schema flaw family, so all fourteen are
unreproducible one-offs.

## Open questions

- **Is `valid/Baseline - complete but null area refs.gpkg` doing what its name says?** Its `Habitats."Parcel Ref"` values are the three-character string `"Null"`, not SQL `NULL`; every other column matches the "complete with area refs" fixture exactly. Two problems follow. If the intent was to cover *absent* refs, the fixture does not do it and a genuine SQL-`NULL` fixture is needed. And because all three rows share the same value, it may trip `DUPLICATE_HABITAT_REF` — in which case it does not belong in `valid/` at all. It is filed as valid pending a decision.
- **Is a multi-polygon RLB valid?** `valid/Baseline - three rlb polygons.gpkg` is filed as valid on the assumption it is; if not, it belongs in `spatial-problems/` or `invalid-schema/`. `invalid-schema/Baseline - no habitats table (three rlb polygons).gpkg` is filed on its habitats-table flaw regardless.
- **Is `valid/Post-intervention - complete (bng-500 variant).gpkg` needed?** It is structurally identical to `valid/Post-intervention - complete.gpkg` but differs byte-for-byte. It was kept rather than deleted pending a decision. A byte-identical copy of `Baseline - complete with area refs.gpkg` was removed from the same directory.
