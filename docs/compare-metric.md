## Comparing the service with the metric

`npm run compare:metric` checks the service's figures against the Statutory
Biodiversity Metric's own answers for the same site (BMD-1036). Every scenario
in the scenario corpus is imported through the backend's upload pipeline. What
the service computes is then compared, figure by figure and exactly, with what
the recalculated metric workbook computes for the same GeoPackage pair.

```sh
npm run compare:metric                           # the whole corpus
npm run compare:metric -- --only trading-rules   # a purpose, or scenario ids
npm run compare:metric -- --corpus ~/my-test-spreadsheets   # any folder of scenarios
```

It runs the backend checked out beside this repo, in process, so the backend
needs `npm run install:be` first; `BNG_BACKEND_DIR` names another checkout (a
worktree of a backend branch, say). The report is written to
`metric-comparison/` in this repo:

| File | What it is |
| --- | --- |
| `report.html` | A short summary, in this order: the Met / Not met answers that differ from the metric, the values that differ for no known reason, the known causes of the rest, and what the service doesn't implement yet. Then each scenario, which opens to its full list of differences. Values are shown to 4 decimal places with their unit, and each difference is the service's value less the metric's, in the same unit |
| `report.xlsx` | Every difference at full precision: a summary sheet, a guide to the units and columns, then one row per scenario, per difference and per figure not implemented, each with a frozen, filterable header and real numbers to sort by |
| `report.md` | The same, as Markdown |
| `summary.md` | The report without each scenario's detail (the CI job summary) |
| `report.json` | Every result, for tooling |

**Every value names its unit.** Each discrepancy carries its unit: habitat, hedgerow or watercourse units, % of baseline units for a net change, or Met / Not met for a verdict. A difference is in the same unit, except that two percentages differ by percentage points. Each per-feature row also gives the size the feature was priced on by each side, in ha or km, and the metric's strategic significance multiplier. Both reports open with a guide to every unit and column; in the spreadsheet it is the *Guide* sheet.

**It reports; it does not judge.** Differences never make the command or a
build fail. The report is there for people to decide what, if anything, needs
doing. A scenario the service throws an error on is reported too, as *Import
failed in the service* with the error, and the run carries on with the rest:
a crash in the service is a finding like any other.

### What is compared

| What | Figures |
| --- | --- |
| Unit calculations per feature | Each feature's baseline, retained, enhanced and created units, matched by reference (A-1 to C-3 in the workbook) |
| Unit totals | Baseline, post-intervention and net change, for each module |
| Net gain | Net change (%) and the 10% verdict, for each module the site has |
| Trading rules figures | Each habitat's net change, the Medium broad habitat totals, Medium surplus and deficit, Low net change and the cumulative figure (area and watercourse) |
| Trading rules statuses | Met / Not met for each distinctiveness band |

**The comparison is exact.** Both sides carry 15 significant figures: the
engine rounds every result to that, and LibreOffice exports the recalculated
values at that precision. Each number is taken to 15 significant figures, and
then the two must be equal. Every discrepancy is reported with both values, the
difference (service less metric), and that difference as a share of the
metric's value.

**What the service does not do yet** is reported separately from the
discrepancies, with the metric's value. These are hedgerow trading rules, and
the Very High and High band trading rules. Once the service produces one of
those figures, it is compared like any other.

**Known causes.** A feature's units are its size times its multipliers. So
where the service's figure is exactly the metric's rescaled to the service's
size, or with a multiplier the service does not apply divided out, the report
names the cause. The discrepancy still counts, but the ones with no explanation
stand out.

### Where each part lives

```mermaid
flowchart LR
  subgraph harness[bng-metric-harness]
    gen["npm run generate:scenarios<br>GeoPackage pairs + workbooks,<br>recalculated with LibreOffice"]
    corpus["example-files/permutations<br>GeoPackage pairs + workbooks<br>saved with their answers"]
    import["importGeoPackagePair<br>the backend's upload pipeline,<br>in process"]
    cli["npm run compare:metric<br>report.html / .xlsx / .md / .json"]
    ci["CI: pull requests and weekly<br>job summary + artifact"]
  end
  subgraph library[bng-library]
    reader["workbook-writer<br>readMetricResults: headline,<br>per-feature units, trading figures"]
    compare["metric-compare<br>figures, comparison,<br>service gaps, causes, report"]
  end
  subgraph backend[bng-metric-backend]
    pipeline["upload pipeline<br>validation, extraction,<br>enrichment, schema"]
  end
  gen --> reader
  reader --> corpus
  pipeline --> import
  corpus --> import --> compare
  compare --> cli --> ci
```

- **The metric's answers.** `generate:scenarios` (this repo) writes each
  scenario's workbook, recalculates it with LibreOffice and saves it with its
  calculated values in. The save is normalised, so the same workbook saved
  twice gives the same bytes and Excel has nothing to repair. The comparison
  reads the answers straight from the workbook, with bng-library's own reader:
  the headline figures, every feature's units (with the size and strategic
  significance multiplier they were priced on), and the trading summaries'
  figures. It needs no manifest, and neither LibreOffice nor the Defra template.
- **The scenarios.** They're any folder of files named
  `<name>-baseline.gpkg`, `<name>-post-intervention.gpkg` and `<name>.xlsx`, side
  by side, including hand-built test spreadsheets, not just generated ones.
  - **Values.** A workbook saved from Excel carries its values and is read as
    it is. One saved with formulas only is recalculated first when LibreOffice
    is installed; otherwise it's reported as unreadable.
  - **Feature references.** A hand-built workbook compares feature by feature
    only where its rows' references match the GeoPackages' feature references.
    Totals, net gain and trading are compared regardless.
- **Where the committed scenarios live.** They're only in this repo's
  `example-files/permutations/`, each GeoPackage pair beside its workbook.
  Neither the library nor the backend carries a copy, so no library consumer
  pulls in test data. `--corpus` names another folder.
- **The comparison.** bng-library's `metric-compare` turns each side into
  comparable figures and compares them.
- **The service's answers.** `importGeoPackagePair`
  (`scripts/metric-comparison/`) runs the same code the backend's validate
  route does, in the same order, without S3, the worker pool or a database.
  That code is the format gate, the GEOS geometry checks, the data-quality
  checks, feature IDs, sizing, extraction, enrichment and the schema. It is
  the backend's own: each module is imported from the backend checkout, and
  resolves its dependencies, the engine included, from the backend's
  `node_modules` at the version the backend pins. Nothing is copied, so the
  comparison measures what the service would deploy. It returns the body
  `GET /projects/{id}` would return. The whole corpus runs in a few seconds.
  - The backend exports what the import calls (`runDataQualityChecks`,
    `layersForUpload`, `extractAndValidateDocument`, `saveHandlersForConfig`,
    DEFRA/bng-metric-backend#417). A backend that predates them fails with a
    message saying so.
  - **Without an installed backend** the command stops with a pointer to
    `npm run bootstrap` and `npm run install:be`, and the comparison's tests
    (`tests/scripts/metric-comparison/`) skip.

### Why it lives in the harness

The figures under test come from three repos: the scenarios and the metric's
answers here, the engine in bng-library, and the extraction and enrichment in
the backend. The harness is where the three already meet, with the scenarios
committed and the siblings checked out beside it, so the comparison lives here
and imports the backend rather than the backend fetching the scenarios. The
backend keeps only the few exports the import needs.

- **Every pull request** here (`check-pull-request.yml`) checks the backend
  out beside the harness, installs it, and runs `npm run compare:metric`, in a
  job of its own beside the Sonar scan. A
  pull request whose branch also exists in the backend uses that branch, so a
  scenario change here and a backend change can be tested together before
  either is merged. Otherwise, it's the backend's `main`. The summary goes on
  the job summary. The full report (`report.html` and `report.xlsx`) goes in
  the `metric-comparison` artifact.
- **Every Monday** the same workflow's schedule re-runs it against the
  backend's `main`, so a change that reached the service since is in that
  week's report. A backend change does not trigger it; to see a backend
  branch's report, run it locally with `BNG_BACKEND_DIR`, or open a harness
  pull request from a branch of the same name.
- The comparison never fails the workflow. When it cannot run (a failed clone
  or install, or a backend that predates its exports), its job shows the
  failure, but it is marked `continue-on-error`, so the pull request check
  and the Sonar scan are unaffected. What it finds never fails anything.
- `npm run test:scripts` checks that the comparison itself runs, not what it
  finds.
- bng-library's own CI tests the comparator, the workbook reader and the
  reports.

### Failing a build later

For now nothing fails. When some differences should fail a build (a new
discrepancy, say, or any in trading statuses), bng-library already has what a
gate needs. `knownDiscrepanciesFrom(results)` records a run's discrepancies,
with both values. `findRegressions(results, known)` lists every way a later run
differs from that record: a new or changed discrepancy, one that has gone, or a
change of outcome.

### Refreshing the corpus

After changing the scenario catalogue, the workbook reader, or the metric
template, regenerate it and commit the result here:

```sh
npm run lib:link                     # use the local bng-library
npm run generate:scenarios -- --outdir example-files/permutations --seed 1
npm run compare:metric               # compares the new corpus at once
```

### What the first run found

On the seed-1 corpus of 37 scenarios:

- 29 scenarios have discrepancies.
- `invalid-area-advance-and-delay` is refused by the service, as expected.
- The other 7 scenarios built on invalid data are accepted by the service. They
  are reported as "Accepted, though its data is invalid", with their
  discrepancies, because the service should have refused them.
- 551 of 1,813 comparable figures match exactly.
- 540 figures are not implemented in the service yet.

Of the 578 per-feature discrepancies, 562 have a known cause:

| Cause | Discrepancies | |
| --- | --- | --- |
| Sizes rounded before pricing | 347 (+141 with the next) | The backend rounds each area to the whole m² and each length to the whole m (`Math.round(feature.sizeMetres)`) before pricing. The metric prices the measured size. The effect is small (a median of 0.0004%, up to 0.9% on the shortest features), but it is not exact. |
| Strategic significance not applied | 74 (+141 with the above) | The engine prices every feature at a strategic significance multiplier of 1 (`BASELINE_STRATEGIC_SIGNIFICANCE_MULTIPLIER`). The metric applies 1.1 or 1.15, so affected features are 9.1% or 13.0% lower in the service. This is enough to flip a net gain verdict: `intervention-hedgerow-retained` is Met in the service at 10.01% and Not met in the metric at 9.09%. |

The 16 without a known cause are worth investigating first:

- **Created trees** (`T005` in 13 scenarios). The workbook reads a year of
  advance creation from the tree's row that the service does not, and prices the
  tree's time to target as "30+" where the service has "30". One of the tree
  advance/delay columns is read differently on the two sides.
- **An enhanced tree**, `intervention-area-enhanced` T001. The service prices it
  6.5% lower than the metric.
- **A created habitat**, `intervention-watercourse-retained` H006. The service
  prices it 7.4% higher than the metric.
- **`invalid-area-trading-down`** H001. The metric computes nothing for this
  enhancement (it breaks the trading-down rule), while the service prices it.
  That is expected until enhancement rules are validated, which is out of scope
  for BMD-1036.
