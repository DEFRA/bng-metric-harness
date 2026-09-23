## Synthetic metric workbooks (BMD-1011)

`npm run generate:workbooks` builds a QA corpus for checking the service's
results against the Statutory Biodiversity Metric itself. Every scenario in the
permutations catalogue becomes three files:

| File | What it is |
| --- | --- |
| `<scenario>-baseline.gpkg` | The baseline GeoPackage to upload |
| `<scenario>-post-intervention.gpkg` | The post-intervention GeoPackage to upload |
| `<scenario>.xlsx` | The Defra metric workbook describing the same site |

The workbook's answers are recalculated headlessly and recorded in
`manifest.json`, which is what a service run is compared against. A table of
them is written to `index.md`.

```sh
npm run generate:workbooks -- --template "/path/to/metric v4.xlsx"
# → test-data/workbooks/<scenario>-baseline.gpkg
# → test-data/workbooks/<scenario>-post-intervention.gpkg
# → test-data/workbooks/<scenario>.xlsx
# → test-data/workbooks/manifest.json   (the metric's results, per scenario)
# → test-data/workbooks/index.md        (human-readable table)
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

- **The metric template.** Pass it with `--template <path>` or set
  `METRIC_TEMPLATE`. Any Statutory Biodiversity Metric v4 workbook will do,
  including a filled-in example; its rows are cleared before the scenario's
  are written. The generator checks a fingerprint of header cells before
  writing, so a template with a different layout fails loudly rather than
  taking inputs in the wrong cells.
- **LibreOffice** (`apt-get install libreoffice-calc`, or `brew install
  --cask libreoffice`) to recalculate. Point `SOFFICE_PATH` at the binary if
  it is not on `PATH` as `soffice`. Each workbook takes about ten seconds, so
  the full catalogue takes around five minutes.

  With `--no-recalc` the workbooks are written but not recalculated, and
  `manifest.json` has no results. Excel recalculates a generated workbook when
  it is opened, so a human tester needs nothing else.

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

### Scenario expectations

The `invalid-interventions` and `trading-rules` scenarios isolate their subject
feature by generating the other layers empty. They also declare what the
metric should make of it:

| Field | Meaning |
| --- | --- |
| `expectGain` | `met` or `unmet`: the area net gain against the workbook's target |
| `expectMetricWarnings` | Text of warnings the metric must raise on the subject feature |
| `expectTradingBreaches` | Distinctiveness bands whose trading rule must fail, per habitat type |
| `expectRejectedInputs` | Subject inputs the workbook must not accept, as `sheet.field` |

If a check fails, the command exits non-zero. A scenario that no longer
demonstrates what it claims to is caught before anyone compares a service run
against it.

### Options

| Option | Meaning |
| --- | --- |
| `--template PATH` | The metric v4 workbook to write into (default `$METRIC_TEMPLATE`) |
| `--outdir DIR` | Output folder (default `test-data/workbooks`) |
| `--only PURPOSE` | One purpose only |
| `--scenario ID` | One scenario only (repeatable) |
| `--seed N` | Run seed. Defaults to a random seed, which is recorded in the manifest so a run can be repeated |
| `--no-recalc` | Write the workbooks without recalculating them |
| `--list` | Print the catalogue and exit |

A rerun into the same folder first removes the files that the previous run's
manifest lists. Nothing else in the folder is touched.

### From the prototype

Everything except recalculation lives in bng-library. `generatePermutations({
workbookTemplate })` returns each scenario's workbook alongside its
GeoPackage pair, with no LibreOffice involved, so the prototype can offer the
workbooks for download.
