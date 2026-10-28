## Scenario corpus: GeoPackages and metric workbooks

`npm run generate:scenarios` builds the whole scenario library in one command.
Every scenario in the bng-library catalogue
(`src/permutations/scenarios.json`) becomes, in a folder named after its
purpose:

| File | What it is |
| --- | --- |
| `<scenario>-baseline.gpkg` | The baseline GeoPackage to upload |
| `<scenario>-post-intervention.gpkg` | The post-intervention GeoPackage to upload |
| `<scenario>.xlsx` | The Defra metric workbook describing the same site |

The workbooks are recalculated headlessly and saved with their calculated
values in, so the metric's own answers can be read straight from each workbook:
by a tester opening it, and by `npm run compare:metric`, which compares them
with the service (see [compare-metric.md](compare-metric.md)).
`manifest.json` records each scenario's headline results and checks for
`index.md`, which tabulates them, one table per purpose.

```sh
npm run generate:scenarios
# → test-data/scenarios/<purpose>/<scenario>-baseline.gpkg
# → test-data/scenarios/<purpose>/<scenario>-post-intervention.gpkg
# → test-data/scenarios/<purpose>/<scenario>.xlsx
# → test-data/scenarios/manifest.json   (the metric's results, per scenario)
# → test-data/scenarios/index.md        (human-readable tables)

npm run generate:scenarios -- --only trading-rules   # one purpose
npm run generate:scenarios -- --no-workbooks         # GeoPackages only
npm run generate:scenarios -- --list                 # print the catalogue
```

The catalogue covers intervention types, conditions, strategic significance,
met / unmet 10% net gain, trading rules (see the matrix below), advance and
delay years, data completeness, and invalid interventions. Each row of
`index.md` names the feature a tester should open to exercise the scenario.

**Only a file named `invalid-…` holds invalid data.** A scenario that
deliberately contains data the metric rejects (an enhancement that lowers
condition, a culvert enhanced, proposed data left blank) has an id starting
`invalid-`, so its files do too, and it states which errors it expects.
Every other scenario is valid throughout, including the features the
generator fills in at random around the one being tested. See *Valid and
invalid data*.

Every scenario is checked as it is built: the two GeoPackages must share a
redline, the scenario's subject feature must be present, and a net-gain
scenario must land on its expected side of 10% when priced through our own
engine (`bng-library/metric`). With workbooks, the metric's own verdicts are
checked too (see *Scenario expectations*), and every workbook is linted for
the faults Excel would "repair" on opening (see *Opening the workbooks in
Excel*). A failed check is reported and the command exits non-zero.

### The BNG Service template format

`--format bng-service` writes each scenario in the BNG Service QGIS template's
format (BMD-1080) instead of the legacy pair: **one GeoPackage holding both
stages**, and its **baseline-stage file** (the same tables, Post-Intervention
empty), with the metric workbook as before:

```sh
npm run generate:scenarios -- --format bng-service --outdir example-files/service-template/permutations --seed 1
# → example-files/service-template/permutations/<purpose>/<scenario>.gpkg
# → example-files/service-template/permutations/<purpose>/<scenario>-baseline.gpkg
# → example-files/service-template/permutations/<purpose>/<scenario>.xlsx
```

bng-library draws each scenario natively, from the same seed derivation as the
legacy corpus: no legacy file is written. A scenario holds exactly what it
pins: none of the vertical habitats, comments or habitats that get worse a
default synthetic site adds. The engine's net-gain check, the workbook and the
checks all read the combined file, so the workbook describes the file a user
would upload. Each scenario is also checked for lineage (`checkLineage`: every
post-intervention feature names its parent), and each valid one against the
template's own drop-downs (`checkTemplateValues`); an `invalid-` scenario
breaks a rule on purpose, so it is not.

The BNG Service corpus holds the library's catalogue, less any scenario that
lists only other formats (`trees-count-above-one`, until tree counts are
decided). The harness's three import-timing scenarios stay legacy only: they
work by editing a legacy file after it is generated.

`example-files/service-template/permutations/` holds a full run at seed 1,
refreshed with the command above. `manifest.json` records the format, and a
filtered run is refused in a folder holding the other format.
`npm run compare:metric` still reads the legacy corpus in
`example-files/permutations/`.

### GeoPackages only

`--no-workbooks` skips the workbooks: no template and no LibreOffice are
needed, and it takes a few seconds. The engine and file checks still run.

### The committed fixtures

`example-files/permutations/` holds a full run at seed 1: each scenario's
GeoPackage pair and its metric workbook, saved with the metric's answers in it,
with `manifest.json` and `index.md` summarising them. A tester can open the
workbook beside the files they upload without generating anything, and the
metric comparison reads its answers from the same workbooks. To
refresh them:

```sh
npm run generate:scenarios -- --outdir example-files/permutations --seed 1
```

The output is byte-reproducible, so a refresh only changes the files whose
scenario, template or library changed. LibreOffice itself does not save the
same workbook to the same bytes twice, so each workbook's source (the workbook
as written, before recalculation) is fingerprinted in `manifest.json`
(`workbookSource`): a workbook whose source is unchanged since the last run is
kept exactly as it was, not recalculated again. Delete a workbook to force it
to be recalculated. Each save is also normalised — LibreOffice's made-up
identifiers renumbered, and the references it leaves to parts it dropped
removed — so Excel has nothing to repair on opening. The workbooks are about
3.7 MB each on disk.

### Imported timing validation (BMD-1060)

The harness extends the library catalogue in `scripts/scenarios/catalogue.mjs`
with import-specific timing cases. Its synthetic generator uses the legacy
`Lost` label for Created area replacements; the harness changes those generated
PI labels to `Created` after deriving the separate baseline half. Baseline
attributes, geometry and valid advance/delay values remain intact.
This is a temporary adapter for the pinned library. Follow-up work should fix
its generator label, move the timing recipes into its catalogue, and remove the
harness relabel/overrides together. Until then, genuine raw `Lost` area coverage
is confined to `import-timing/invalid-timing-retained-lost`, which explicitly
restores Lost rows across all four layers and asserts their saved behaviour.

The workbook reads both halves of the pair so that changing a PI label does not
remove the original baseline loss. For every generated PI row, expected
calculation inputs follow AC3/AC5 independently of the backend. Lost area
replacements follow the Created rules: valid advance/delay values are retained
and used for pricing. For Created/Enhanced rows, including Lost area replacements,
conflicting positive values are both nulled; missing required timing also leaves
the row unpriced under BMD-1070. Retained timing is redundant: it is saved null
and pricing uses no advance/delay credit. Lost hedgerows, watercourses and trees
remain absent from PI; their baseline loss remains. The GeoPackage keeps its raw
values. Changes to the workbook inputs are recorded in `workbookTimingChanges`;
no calculated service result is copied into it.

`expectedImport` separately requires acceptance, the exact saved timing values,
and the expected status. Incomplete timing cases also require null units; valid
Lost area timing, such as H002's advance 4 / delay 0, must remain populated.
Lost hedgerows, watercourses and trees must remain absent from PI. The comparison
fails if those assertions fail, then compares every workbook figure normally.
Raw-invalid filenames remain `invalid-...`; their successful cleansing is an
explicit contract rather than a blanket exception.

The `import-timing` purpose covers Created/Enhanced conflicting and missing
timing, valid and incomplete Lost area replacement timing, Retained redundant
timing, and excluded Lost linear/tree rows. The existing advance/difficulty
scenarios retain genuine Created controls with advance credit, and the raw
conflicting area/tree scenarios now expect acceptance.

### Why the answers can be trusted

A corpus built by writing *our* numbers into spreadsheets would only prove
that the service agrees with itself. So the generator writes **inputs only**
into a real copy of the Defra workbook. Once the workbook is recalculated, its
figures are the metric's own.

### Known bugs in the metric are corrected

The one exception to leaving the formulas alone: the published metric has
known bugs, which the service corrects. A workbook that kept them would
disagree with the service on every site they touch, and those expected
discrepancies would hide the real ones. So each known bug is corrected in
the one formula that makes it, and every other formula stays Defra's own.

The corrections are listed in `METRIC_CORRECTIONS` (bng-library's
`workbook-writer`). Each names the cell, the formula Defra published and the
formula written in its place. `manifest.json` repeats them under
`corrections`. If the template's formula in that cell isn't the published one
the correction expects, for example because a newer Defra release changed it,
the run stops. It doesn't patch a formula nobody has checked.

| Bug | Cell | Published | Corrected |
| --- | --- | --- | --- |
| The Medium deficit is netted off the Medium surplus before it is offered to the Low band. The trading rules don't let one Medium broad habitat make good another, so the deficit must be offset by trading up and shouldn't also shrink what the Low band may use. The metric then reports the Low rule breached on sites where the service reports it met. | Trading Summary Area Habitats `K91`, the "Cumulative surplus of units" feeding `K123`, `K125` and the Low verdict `G8` | `K90+K88` | `IF(K90>0,K90,0)+K88` |

The corrected sum is the Medium surplus carried down whole, plus any higher
distinctiveness surplus left once the Medium deficit has been offset. It is
the same sum the metric's own hedgerow summary makes (`I31`), and it matches
the service's figure (bng-library `calculateAreaHabitatTradingRules`,
`low.cumulativeAvailability`). `manifest.json` reports the corrected figure as
`corrected.areaCumulativeSurplus`.

`trading-low-deficit-covered-beside-medium-deficit` is the scenario the bug
decides. With the correction the metric reports its area Low rule met, as the
service does. The published formula reports it breached. That was checked
over six seeds.

One scenario, both artefacts: the workbook is written from the
GeoPackage pair, not from a separate description, so the two
cannot drift apart. The mapping follows what the service does with the same
file:

- Areas and lengths are measured from the geometry with `bng-library/measure`,
  the same functions the backend prices with, and left unrounded, as the metric
  prices them. The rounded `Area` and `Length` attributes are not used.
- An area habitat marked `Lost` is a creation. Its baseline row is lost, and its
  proposed habitat is created on the same land (A-1 plus A-2).
- A lost hedgerow, watercourse or tree is simply lost. A created one has no
  baseline row.
- `Location` is free text to the service, so every feature is on-site.

### What you need

- **Nothing, for the metric template.** By default the generator uses the
  calculation tool Defra publishes on GOV.UK (*The Statutory Metric*, macro-free
  `.xlsx`, release 1.0.4). It downloads it on first use, checks it against a
  pinned checksum, and keeps it in the gitignored `.cache/metric-template/`.
  Every scenario's verdict was validated against this release; it gives the
  same results as the filled-in example workbook the work began with.

  To use a different workbook, put it in the gitignored `./workbooks/` and pass
  `--template workbooks/<name>.xlsx` or set `METRIC_TEMPLATE` (the path must be
  inside the harness). Any Statutory Biodiversity Metric v4 workbook will do,
  including a filled-in example, whose rows are cleared before the scenario's
  are written. The generator checks a fingerprint of header cells before
  writing, so a template with a different layout fails loudly rather than
  taking inputs in the wrong cells.
- **LibreOffice** (`apt-get install libreoffice-calc`, or `brew install
  --cask libreoffice`) to recalculate — or run it all in Docker (below). Point `SOFFICE_PATH` at the binary if
  it is not on `PATH` as `soffice`. One LibreOffice process runs per CPU, and
  each recalculated workbook is saved over itself with its values in, then
  read straight away. On a
  two-core machine a workbook takes about 3.5 seconds, the trading-rule matrix
  under a minute, and the whole catalogue about three minutes.

  With `--no-recalc` the workbooks are written but not recalculated: they
  hold formulas only, and `manifest.json` has no results. Excel recalculates a
  generated workbook when it is opened, so a human tester needs nothing else.
  The metric comparison recalculates them itself when LibreOffice is
  installed.

### Running in Docker

To avoid installing LibreOffice on your host, run the same command in a
container (needs Docker Desktop or Engine). There is nothing to copy or
download first:

```sh
npm run generate:scenarios:docker                        # the whole catalogue
npm run generate:scenarios:docker -- --only trading-rules
```

The image (`Dockerfile.scenarios`, about 1 GB) is built on the first run and
cached after that. The build downloads the published metric template into the
image, checksum-checked, so a run needs no network. Output lands in
`./test-data/`, as it does outside Docker.

To use a different template, put it in `./workbooks/` (mounted read-only and
gitignored) and pass its
container path:

```sh
npm run generate:scenarios:docker -- --template /app/workbooks/MyMetric.xlsx
```

The image uses the same LibreOffice release (25.x) the results were validated
against. A run in the container gives byte-identical files and identical
results to the same run on the host.

**Known limits of the Docker approach.**

- **`--outdir` must stay under `/app/test-data`**, the only writable mount.
  Anywhere else, the files are lost when the container exits.
- **It uses the bng-library version pinned in `package.json`,** not a
  `npm run lib:link`ed checkout, because the container installs its own
  dependencies.
- **On Linux, the container writes as uid 1000** (the image's `node` user). If
  your user has a different uid, make `test-data/` writable for it.
- **Speed follows Docker's CPU allowance.** One LibreOffice process runs per
  CPU the container can see; on Docker Desktop that is the number set in its
  resource settings.

LibreOffice does not recalculate an `.xlsx` on load by default. It hands back
the values the file was saved with, which looks exactly like success. The
generator seeds a private LibreOffice profile that forces recalculation. As a
second guard, it strips every cached value from the workbook it writes, so a
workbook that was never recalculated reads as empty rather than stale.

### Opening the workbooks in Excel

Excel checks a workbook's structure more strictly than LibreOffice or any
spreadsheet library. A fault they read straight past makes Excel offer to
"repair" the file, and a workbook that needs repairing is not one a tester
should trust. So every workbook is linted as it is written, with
`lintWorkbook` from `bng-library/workbook-writer`. It checks for:

- a cached value that does not fit its cell's type, such as a space in a
  numeric cell;
- an entry in `xl/calcChain.xml`, Excel's list of formula cells, for a cell
  that no longer holds a formula;
- a broken shared formula, rows or cells out of order, and missing parts or
  content types.

The lint is recorded as a check (`workbook opens in Excel without repair
(lint)`). A workbook with any fault fails the run, and `manifest.json` lists
every fault under the scenario's `lintIssues`. Excel does not publish its
repair rules, so the lint covers the faults this generator can introduce,
not every file Excel might refuse. After a change to the workbook writer,
open a few workbooks in Excel as well.

### Reading the results

For each scenario, `manifest.json` records:

| Field | What it holds |
| --- | --- |
| `metric.headline` | Baseline and post-intervention units, net change (units and %), units required and deficit, per habitat type, as *Headline Results* shows them |
| `metric.trading` | Each trading summary's verdict per distinctiveness band |
| `metric.rowWarnings` | Every warning the metric shows on a feature's row (`Check Data ⚠`, `Error - Can not reduce condition ▲`, …), keyed to the feature's reference |
| `metric.sheetWarnings` | Warnings in a sheet's summary block, which apply to the sheet as a whole |
| `rejectedInputs` | Inputs the workbook's own drop-down lists do not offer; see below |
| `checks` | The scenario's declared expectations, checked against the metric's verdict, and the workbook lint |
| `lintIssues` | Only when the lint fails: every fault, as `{ rule, part, ref, message }` |

**Rejected inputs are worth reading.** The metric's formulas wrap their
lookups in `IFERROR`. So a value the workbook does not know, even one that
differs only by a space, raises nothing: the row shows `Check Data` and
generates no units. The generator therefore reads every drop-down list from
the template itself and checks each row against it. Where the GeoPackage
template and the workbook spell the same category differently (riparian
encroachment, `Minor/No Encroachment` versus `Minor/ No Encroachment`), the
translation is listed explicitly in bng-library's `WORKBOOK_SPELLINGS`.
Anything else is reported, not converted.

In a scenario not named `invalid-`, any rejected input fails the run (see
*Valid and invalid data*). In an `invalid-` one, the scenario says which
inputs must be rejected.

### The trading-rule matrix

`--only trading-rules` builds the scenarios that test the trading rules: 12
scenarios, 24 files to upload. Area habitats, hedgerows and watercourses trade
independently, so most scenarios carry a case for each, and each scenario
states the verdict of every band in play:

| Scenario | Area habitats | Hedgerows | Watercourses |
| --- | --- | --- | --- |
| `trading-all-met` | nothing lost: all met | nothing lost: all met | nothing lost: all met |
| `trading-like-for-like` | Medium replaced by the same broad habitat, enough units: met | Medium replaced by Medium: met | ditch replaced by a ditch: met |
| `trading-too-few-units` | Medium replaced one-for-one by the same broad habitat: **Medium breached** | Medium replaced by a late, poor Medium: **Medium breached** | ditch replaced by a late, poor ditch: **Medium breached** |
| `trading-wrong-habitat` | Medium grassland replaced by more Medium heathland: **Medium breached** | Medium replaced by Low: **Medium breached** | ditch replaced by a canal: **Medium breached** |
| `trading-trade-down` | Medium replaced by Low: **Medium breached** | Low replaced by Very Low: **Low breached** | ditch replaced by a culvert: **Medium breached** |
| `trading-trade-up` (legacy only) | Low replaced by Medium: met | Low replaced by Medium: met | culvert replaced by a ditch: met |
| `trading-trade-up-without-watercourse` (BNG Service only) | Low replaced by Medium: met | Low replaced by Medium: met | — (the template cannot record a lost culvert) |
| `trading-low-for-low` | Low replaced by Low in another broad habitat: met | Very Low replaced by Low: met | — |
| `trading-lost-to-development` | Low built over: **Low breached** | Very Low removed: **Very Low breached** | — |
| `trading-lower-deficit-covered-from-above` | Low deficit, Medium surplus: met | Low deficit, Medium surplus: met | — |
| `trading-higher-deficit-not-covered-from-below` | Medium deficit, Low surplus: **Medium breached**, Low met | Medium deficit, Low surplus: **Medium breached**, Low met | — |
| `trading-surplus-in-another-broad-habitat` | grassland surplus, heathland deficit: **Medium breached** | — | — |
| `trading-low-deficit-covered-beside-medium-deficit` | Low grassland enhanced into Medium grassland, Medium heathland built over: **Medium breached**, Low met (the published metric wrongly reports **Low breached**; see *Known bugs in the metric are corrected*) | — | — |
| `trading-low-to-medium` | Low enhanced to Medium, with random other layers | | |

Every rule is a test of units as well as of habitat: `trading-too-few-units`
and `trading-wrong-habitat` separate the two.

High and Very High distinctiveness habitats are not covered: the service
rejects them at upload. The verdicts hold across run seeds — each was checked
over six — so `--seed` changes geometry, not outcomes.

One thing the matrix deliberately leaves out: a culvert replaced by another
culvert. The watercourse Low rule reads "better distinctiveness habitat
required", but the recalculated metric meets it whenever the new culvert brings
enough units, which depends on the random line lengths. A service that
enforces the wording would disagree with the metric on such a file.

### Adding or changing a scenario

The scenarios are configuration, not code. They live in one JSON file in
bng-library, `src/permutations/scenarios.json`, and the harness builds
whatever it holds. To add, change or remove a scenario, edit that file; its
fields are documented in bng-library's README under *Scenario catalogue*.

The file is checked when it is loaded. A misspelt field or an override the
generator does not recognise stops the run with the exact place in the file,
rather than being silently ignored. To try a change here before it is
released:

```sh
npm run lib:link                                       # use ../bng-library
npm run generate:scenarios -- --scenario <id>          # build just that one
```

When the change is merged in bng-library, bump the `bng-library` pin in
`package.json`. If the committed fixtures in `example-files/permutations/`
should follow, refresh them as shown under *The committed fixtures*, and update the
trading-rule table above if the matrix changed.

### Valid and invalid data

A scenario tests one feature, its subject. The generator fills the rest of
the site with random features, and those are drawn from what the metric
itself accepts, using its reference tables: a condition the habitat can
have, a creation in a condition it can be created in, an enhancement that
improves on the baseline and that the metric can make, encroachment that
does not worsen. Culverts and non-native hedgerows, which the metric does not
let you enhance, are never enhanced.

So invalid data only appears where a scenario pins it, and such a scenario
is named for it:

| Scenario | Holds invalid data | Checked |
| --- | --- | --- |
| id starts `invalid-` | Yes, deliberately | The errors it declares are raised on its subject |
| any other | No | *valid data*: no metric error on any row and no rejected input |

A metric error is a row warning marked ▲ (`Error - Can not reduce condition
▲`, `Not Possible ▲`), a `Check Data` warning, or an Excel error value. A ⚠
`Check details …` note, such as asking for evidence that habitat created in
advance is in place, is advice about valid data and does not count. Two
hidden columns are ignored because their messages are not about the input:
A-1's broken "Succession" check and A-2's "Time to Poor condition" helper,
which shows `Not Possible` for any habitat with no Poor condition.

The catalogue enforces the naming: an `invalid-` scenario that declares no
expected errors, or any other scenario that declares some, stops the load.
The valid-data check needs the recalculated workbook, so `--no-workbooks`
and `--no-recalc` skip it.

### Scenario expectations

The `invalid-interventions` and `trading-rules` scenarios isolate their subject
feature by generating the other layers empty. They, and the `advance-delay`
scenarios, also declare what the metric should make of it:

| Field | Meaning |
| --- | --- |
| `expectGain` | `met` or `unmet`: the area net gain against the workbook's target |
| `expectMetricWarnings` | Text of warnings the metric must raise on the subject feature; `invalid-` scenarios only |
| `expectTrading` | Each distinctiveness band's trading-rule verdict, `met` or `breached`, per habitat type |
| `expectRejectedInputs` | Subject inputs the workbook must not accept, as `sheet.field`; `invalid-` scenarios only |
| `expectUnitOrder` | Features whose units at one stage must fall strictly in the order listed |
| `expectUnitsEqual` | Features whose units at one stage must all be the same |
| `expectTimeToTarget` | The final time to target condition (years, or `"30+"`) and its multiplier the metric must give each created or enhanced feature listed |

If a check fails, the command exits non-zero. A scenario that no longer
demonstrates what it claims to is caught before anyone compares a service run
against it.

### Options

| Option | Meaning |
| --- | --- |
| `--only PURPOSE` | One purpose only, merged into the existing corpus (see below) |
| `--scenario ID` | One scenario only (repeatable), merged into the existing corpus (see below) |
| `--outdir DIR` | Output folder (default `test-data/scenarios`); must be inside the harness |
| `--format F` | `legacy` (default): a baseline / post-intervention pair per scenario; `bng-service`: per scenario, one BNG Service GeoPackage holding both stages and its baseline-stage file, drawn natively (see above) |
| `--seed N` | Run seed, for byte-identical GeoPackages. Defaults to a random seed, which is recorded in the manifest so a run can be repeated; a filtered run defaults to the existing corpus's seed. Each scenario derives its own seed from it, so a fixture reproduces however many scenarios you run |
| `--centre E,N` | Red Line Boundary centre, BNG/EPSG:27700 (default `530000,180000`) |
| `--no-workbooks` | GeoPackages only: no template, no LibreOffice |
| `--no-recalc` | Write the workbooks without recalculating them |
| `--template PATH` | The metric v4 workbook to write into (default `$METRIC_TEMPLATE`, else the published tool); must be inside the harness |
| `--download-template` | Download the published template into the cache and exit |
| `--list` | Print the catalogue and exit |

A full rerun into the same folder first replaces the purpose folders it
regenerates, so a scenario dropped from the catalogue doesn't linger. Nothing
else in the folder is touched.

A filtered run (`--only` or `--scenario`) replaces only the files of the
scenarios it builds, and merges their entries into the `manifest.json` and
`index.md` already in the folder. Everything else in the corpus stays as it
was, and the manifest still describes all of it. Without `--seed`, a filtered
run takes the existing corpus's seed. It refuses to run, and changes nothing,
if it would be made differently from the corpus: another seed, another
template, `--no-workbooks` or `--no-recalc` where the corpus has them the
other way, or different metric corrections. Run the full set instead, or give
it a fresh `--outdir`. LibreOffice's scratch
space is a `.recalc-*` folder inside the output folder, removed when the run
ends.

### From the prototype

Everything except recalculation lives in bng-library. `generatePermutations({
workbookTemplate })` returns each scenario's workbook alongside its
GeoPackage pair, with no LibreOffice involved, so the prototype can offer the
workbooks for download.

### BMD-1070: incomplete habitat calculations

The import timing scenarios retain their raw GeoPackage values. Their manifest
contracts assert the saved timing and require null units with Incomplete status
when required timing is missing or conflicting on Created/Enhanced habitats,
including original Lost area replacements. Valid Lost area timing is retained
and priced. Retained habitats save redundant timing as null and calculate
without timing credit. Lost linear features and trees remain absent from PI.

The workbook treats blank timing cells as zero, so an incomplete Created or
Enhanced row, including a Lost area replacement, is left unpriced by blanking
its required condition in the workbook input projection. The row remains in position so enhancement pairing is preserved;
its baseline row and loss/allocation remain. The manifest records this projection.
This is an independent input policy,
not a copied service result or a discrepancy exemption. Numerical comparisons
still cover every calculated figure; regression tests reject fabricated zero
units and perturb a separate valid feature to check comparison sensitivity.

Projected blanks are recorded separately from rejected inputs in the manifest
and index. Only the exact declared null projection cells are excluded from
vocabulary errors; unexpected missing values and populated invalid values still
fail the scenario checks.
