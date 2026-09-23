## Scenario corpus: GeoPackages and metric workbooks

`npm run generate:scenarios` builds the whole scenario library in one command.
Every scenario in the bng-library catalogue becomes, in a folder named after
its purpose:

| File | What it is |
| --- | --- |
| `<scenario>-baseline.gpkg` | The baseline GeoPackage to upload |
| `<scenario>-post-intervention.gpkg` | The post-intervention GeoPackage to upload |
| `<scenario>.xlsx` | The Defra metric workbook describing the same site |

The workbooks are recalculated headlessly and their answers — the metric's
own — recorded in `manifest.json`, which is what a service run is compared
against. `index.md` tabulates them, one table per purpose.

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

Every scenario is checked as it is built: the two GeoPackages must share a
redline, the scenario's subject feature must be present, and a net-gain
scenario must land on its expected side of 10% when priced through our own
engine (`bng-library/metric`). With workbooks, the metric's own verdicts are
checked too (see *Scenario expectations*). A failed check is reported and the
command exits non-zero.

### GeoPackages only

`--no-workbooks` skips the workbooks: no template and no LibreOffice are
needed, and it takes a few seconds. The engine and file checks still run.

The fixtures committed to `example-files/permutations/` are this output. To
refresh them:

```sh
npm run generate:scenarios -- --no-workbooks --outdir example-files/permutations --seed 1
```

### Why the answers can be trusted

A corpus built by writing *our* numbers into spreadsheets would only prove
that the service agrees with itself. So the generator writes **inputs only**
into a real copy of the Defra workbook, and never changes a formula. Once the
workbook is recalculated, its figures are the metric's own.

That rule applies to the metric's known defects too. The cumulative-surplus
error (BMD-993) is **not** corrected. `manifest.json` reports that figure as
`uncorrected.areaCumulativeSurplus`, so nobody mistakes it for the corrected
figure.

One scenario, both artefacts: the workbook is written from the
post-intervention GeoPackage, not from a separate description, so the two
cannot drift apart. The mapping follows what the service does with the same
file:

- Areas and lengths are measured from the geometry, as the backend measures
  them. The rounded `Area` and `Length` attributes are not used.
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

  To use a different workbook, pass `--template <path>` or set
  `METRIC_TEMPLATE`. Any Statutory Biodiversity Metric v4 workbook will do,
  including a filled-in example, whose rows are cleared before the scenario's
  are written. The generator checks a fingerprint of header cells before
  writing, so a template with a different layout fails loudly rather than
  taking inputs in the wrong cells.
- **LibreOffice** (`apt-get install libreoffice-calc`, or `brew install
  --cask libreoffice`) to recalculate — or run it all in Docker (below). Point `SOFFICE_PATH` at the binary if
  it is not on `PATH` as `soffice`. One LibreOffice process runs per CPU, and
  each recalculated workbook is exported as CSV and read straight away. On a
  two-core machine a workbook takes about 3.5 seconds, the trading-rule matrix
  under a minute, and the whole catalogue about three minutes.

  With `--no-recalc` the workbooks are written but not recalculated, and
  `manifest.json` has no results. Excel recalculates a generated workbook when
  it is opened, so a human tester needs nothing else.

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

### Reading the results

For each scenario, `manifest.json` records:

| Field | What it holds |
| --- | --- |
| `metric.headline` | Baseline and post-intervention units, net change (units and %), units required and deficit, per habitat type, as *Headline Results* shows them |
| `metric.trading` | Each trading summary's verdict per distinctiveness band |
| `metric.rowWarnings` | Every warning the metric shows on a feature's row (`Check Data ⚠`, `Error - Can not reduce condition ▲`, …), keyed to the feature's reference |
| `metric.sheetWarnings` | Warnings in a sheet's summary block, which apply to the sheet as a whole |
| `rejectedInputs` | Inputs the workbook's own drop-down lists do not offer; see below |
| `checks` | The scenario's declared expectations, checked against the metric's verdict |

**Rejected inputs are worth reading.** The metric's formulas wrap their
lookups in `IFERROR`. So a value the workbook does not know, even one that
differs only by a space, raises nothing: the row shows `Check Data` and
generates no units. The generator therefore reads every drop-down list from
the template itself and checks each row against it. Where the GeoPackage
template and the workbook spell the same category differently (riparian
encroachment, `Minor/No Encroachment` versus `Minor/ No Encroachment`), the
translation is listed explicitly in bng-library's `WORKBOOK_SPELLINGS`.
Anything else is reported, not converted.

Random filler features in the older scenarios regularly produce inputs that
the metric's lists do not offer. The synthetic generator allows them; the
metric does not. Examples: a culvert in anything but Poor condition, an
enhanced culvert, and a non-native hedgerow in Moderate condition. Each one is
a place where the service and the metric may part company.

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
| `trading-trade-up` | Low replaced by Medium: met | Low replaced by Medium: met | culvert replaced by a ditch: met |
| `trading-low-for-low` | Low replaced by Low in another broad habitat: met | Very Low replaced by Low: met | — |
| `trading-lost-to-development` | Low built over: **Low breached** | Very Low removed: **Very Low breached** | — |
| `trading-lower-deficit-covered-from-above` | Low deficit, Medium surplus: met | Low deficit, Medium surplus: met | — |
| `trading-higher-deficit-not-covered-from-below` | Medium deficit, Low surplus: **Medium breached**, Low met | Medium deficit, Low surplus: **Medium breached**, Low met | — |
| `trading-surplus-in-another-broad-habitat` | grassland surplus, heathland deficit: **Medium breached** | — | — |
| `trading-low-to-medium` | Low enhanced to Medium, with random other layers | | |

Every rule is a test of units as well as of habitat: `trading-too-few-units`
and `trading-wrong-habitat` separate the two. `trading-higher-deficit-not-covered-from-below`
is also the case the published metric's cumulative surplus gets wrong
(BMD-993), which `manifest.json` reports as `uncorrected.areaCumulativeSurplus`.

High and Very High distinctiveness habitats are not covered: the service
rejects them at upload. The verdicts hold across run seeds — each was checked
over six — so `--seed` changes geometry, not outcomes.

One thing the matrix deliberately leaves out: a culvert replaced by another
culvert. The watercourse Low rule reads "better distinctiveness habitat
required", but the recalculated metric meets it whenever the new culvert brings
enough units, which depends on the random line lengths. A service that
enforces the wording would disagree with the metric on such a file.

### Scenario expectations

The `invalid-interventions` and `trading-rules` scenarios isolate their subject
feature by generating the other layers empty. They also declare what the
metric should make of it:

| Field | Meaning |
| --- | --- |
| `expectGain` | `met` or `unmet`: the area net gain against the workbook's target |
| `expectMetricWarnings` | Text of warnings the metric must raise on the subject feature |
| `expectTrading` | Each distinctiveness band's trading-rule verdict, `met` or `breached`, per habitat type |
| `expectRejectedInputs` | Subject inputs the workbook must not accept, as `sheet.field` |

If a check fails, the command exits non-zero. A scenario that no longer
demonstrates what it claims to is caught before anyone compares a service run
against it.

### Options

| Option | Meaning |
| --- | --- |
| `--only PURPOSE` | One purpose only |
| `--scenario ID` | One scenario only (repeatable) |
| `--outdir DIR` | Output folder (default `test-data/scenarios`) |
| `--seed N` | Run seed, for byte-identical GeoPackages. Defaults to a random seed, which is recorded in the manifest so a run can be repeated. Each scenario derives its own seed from it, so a fixture reproduces however many scenarios you run |
| `--centre E,N` | Red Line Boundary centre, BNG/EPSG:27700 (default `530000,180000`) |
| `--no-workbooks` | GeoPackages only: no template, no LibreOffice |
| `--no-recalc` | Write the workbooks without recalculating them |
| `--template PATH` | The metric v4 workbook to write into (default `$METRIC_TEMPLATE`, else the published tool) |
| `--download-template` | Download the published template into the cache and exit |
| `--list` | Print the catalogue and exit |

A rerun into the same folder first replaces the purpose folders it
regenerates. Nothing else in the folder is touched. LibreOffice's scratch
space is a `.recalc-*` folder inside the output folder, removed when the run
ends.

### From the prototype

Everything except recalculation lives in bng-library. `generatePermutations({
workbookTemplate })` returns each scenario's workbook alongside its
GeoPackage pair, with no LibreOffice involved, so the prototype can offer the
workbooks for download.
