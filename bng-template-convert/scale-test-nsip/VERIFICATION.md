# Verifying the template, the plugin and the service at NSIP scale

**Subject:** the synthetic Handsacre to Crewe site in this folder
**Stage:** runbook, for working through at a keyboard
**State:** steps 2 to 8 have been run and their measured values recorded.
All five claims now have a harness, and all five pass. Step 1 is a sanity
check nobody has written up.

This is the practical half of section 6 of the template decision brief. It
turns the five claims made there into things to do, in order, with the number
each step should produce so a pass can be told from a failure. Where a step is
worth a screenshot, it says so and says what the screenshot has to show.

Section 8 covers the biodiversity unit calculation, which is where claims 2
and 3 are settled.

---

## How to read this

Sections 1 and 2 are QGIS, on the site file as it stands. Sections 3 to 6 are
the plugin, one section per feature. Section 7 is the running service.
Section 8 is what remains unbuilt. Section 9 maps every step back to the five
claims, and is the section to read first if the question is whether
this is finished.

Expected values in **bold** have been observed. Everything else is what the
step should produce if it works.

---

## 0. Before you start

| Need | How |
| --- | --- |
| The site file | `hs2-phase2a-subsection/Layers/BNG Service Layers.gpkg`, already generated. `python3 generate.py` rebuilds it in 7 seconds |
| QGIS, with the plugin | Already installed into the default profile. **Restart QGIS**: it was running while the plugin was replaced, so it is still holding the old code |
| The service, running locally | `docker compose up -d` in the backend, then `npm run dev` in the harness |
| A blank metric workbook | `The_Statutory_Metric_Macro_Enabled_1.0.4.xlsm` |
| Excel | Only for section 5 and for the import tool in section 4 |

Close the QGIS project before running anything that writes to the GeoPackage.
QGIS holds a lock on an open project, and a converter run will fail against it.

---

## 1. Open the site and look at it

**Not yet done by anyone. This is the first thing to try.**

1. Open `hs2-phase2a-subsection/BNG Service Habitat Mapping.qgz`.
2. Zoom to the Habitats Baseline layer.

**What to check.** The corridor draws without QGIS stalling. Parcel outlines
are irregular rather than rectangular. Field boundaries carry hedgerows.
Switching to Habitats Post-Intervention shows the sealed works core weaving
down the middle of the land take.

**Worth a screenshot:** the two layers side by side at about 1:15 000, which
is the picture that shows a stakeholder what an NSIP-scale site looks like in
this template. `preview.png` is the same view rendered without QGIS.

**What would count as a failure.** Layers that take more than a few seconds to
draw, rendering artefacts at the joins between parcels, or the attribute table
taking more than a moment to open on 13 682 rows.

**Then check the numbers.** Layer Properties, Information, or the status bar
feature count:

| Layer | Rows |
| --- | --- |
| Habitats Baseline | **11 554** |
| Habitats Post-Intervention | **13 682** |
| Hedgerows Baseline | **1 275** |
| Hedgerows Post-Intervention | **1 469** |
| Watercourses Baseline | **256** |
| Watercourses Post-Intervention | **243** |
| Trees Baseline | **3 600** |
| Trees Post-Intervention | **2 767** |
| Red Line Boundary | **1** |

---

## 2. The four template buttons, at scale

**Run, and three of the four are fine. One is not.** These buttons were
written against a site of a few dozen parcels, and this is the first time any
of them has seen eleven thousand.

| Button | Layer | Measured | Verdict |
| --- | --- | --- | --- |
| 1. Copy baseline to post-intervention | Habitats Post-Intervention | **1 min 28 s**, frozen throughout, copying all 11 554 features fresh. After the rewrite, **about 5 seconds in QGIS** | Fixed |
| 2. Tidy PI refs after splitting | Habitats Post-Intervention | **1 second**, nothing to change | Fine |
| 4. Refresh from baseline | Habitats Post-Intervention | **9 seconds**, nothing to bring in | Fine on this path |
| 3. Rename a ref | Habitats Baseline | not yet timed | |

**Refresh is much faster than expected, and the earlier prediction was
wrong.** An extrapolation from staged-file measurements put it in the minutes
at this row count. It took nine seconds. That figure is for the cheapest path
though, with no baseline change to carry across, so it is a floor rather than
a typical case: time it again after actually editing some baseline parcels.

**The copy has been rewritten, and the diagnosis was not what it looked
like.** The same work headless takes 3.1 seconds, so the minute and a half was
never the data. It was 11 554 separate calls to add one feature to an edit
buffer, each of which tells a 55-layer project that a feature has arrived, and
each of which asks the canvas to redraw. A background thread would have solved
the wrong problem, and touching a map layer off the main thread is unsafe in
QGIS anyway.

What it does now:

- writes through the data provider in batches of 1 000 rather than one feature
  at a time through the edit buffer, so the project is told twelve times
  instead of 11 554;
- stops the canvas redrawing while a batch is written, and redraws once at the
  end;
- shows a modal progress dialog with a working Cancel button;
- records `parent_geom` at three decimal places, which is all the checksum
  beside it uses, halving that column from 11.6 MB to 5.3 MB across this site;
- reads only the two columns it needs when working out what is already copied,
  rather than dragging every `parent_geom` in the layer through Python;
- refuses to run while the layer has unsaved edits, rather than writing
  underneath them;
- tells an open attribute table what arrived, so it does not have to be
  closed and reopened.

**Cancelling is safe.** Batches already written stay written, and the action
skips anything already copied, so running it again carries on from where it
stopped.

**The attribute table was the cost all along, and it had to be paid back.**
Writing through the provider is fast precisely because it bypasses the
layer's own signals, and an open attribute table is built on a cache that
listens to exactly those signals. So the first version of this rewrite left
the table showing nothing until it was closed and reopened.

Nothing tidy fixes that. Reloading the layer, emitting `dataChanged`,
repainting, updating fields, running an empty edit session, invalidating the
cache and resetting the subset string were each measured, and each left the
table empty. What works is emitting `featureAdded` for the rows the provider
just wrote, which is the signal the table is waiting for. It costs 4.7
seconds for 11 554 rows when a table is open, and 0.02 seconds when none is,
because a signal with no receivers costs nothing.

Measured against this site with an attribute table model attached, standing in
for the dialog: 11 554 features in 7.9 seconds with the table updating itself,
3.4 seconds with no table open, a re-run in 0.4 seconds with nothing to do, and
`parent_checksum` values matching the converter's own for all 11 554 rows.

**Confirmed in QGIS: about 5 seconds, interface responsive, table correct
without reopening.** Against 1 minute 28 seconds frozen.

The remaining checks below have not been run.

Work on a copy. The buttons save as they go and there is no undo:

```sh
cp -R hs2-phase2a-subsection hs2-button-test
```

Open the copy's project, then, from the attribute table's **Actions** button
at the far right of its toolbar:

| # | Button | Layer | What is still to check |
| --- | --- | --- | --- |
| 3 | Rename a ref | Habitats Baseline | Rename one parcel that has several post-intervention children, for example any `AH-` ref with `-1` and `-2` rows. Every child should follow |
| 2 | Tidy PI refs after splitting | Habitats Post-Intervention | Run it against the 1 847 parcels that really are split, and check the suffixes it produces |
| 4 | Refresh from baseline | Habitats Post-Intervention | Edit a handful of baseline parcels first, so it has work to do, and time it again |

Run the buttons on the other habitat types too, which are small enough to be
quick: hedgerows, watercourses and trees.

**Worth a screenshot:** the message bar report each button produces, and the
elapsed time. Those numbers are the answer to whether the template works at
this scale, and one of them is already a finding.

---

## 3. Plugin: convert to the legacy pair

**Run, and it works.** Processing Toolbox, BNG template convert, **Convert to
legacy template**.

- Input: the site GeoPackage
- What to produce: **Legacy GeoPackages only**
- Record lineage in comments: on

Or from a terminal:

```sh
python3 ../new_to_old.py \
    "hs2-phase2a-subsection/Layers/BNG Service Layers.gpkg" -o legacy
```

**Expected:** about **1.4 seconds**, two files totalling **31 MB**, and this
row report:

| | Baseline | Post-intervention |
| --- | --- | --- |
| Habitats | **11 554** | **13 682** |
| Hedgerows | **1 275** | **2 157** |
| Rivers | **256** | **256** |
| Urban Trees | **3 600** | **4 752** |

The post-intervention counts are larger than the staged ones on purpose. The
legacy format has no way to record a removal by absence, so the converter
synthesises a `Lost` row for every feature that has none: **688** hedgerows,
**1 985** trees. It says so in its report.

**Worth a screenshot:** the plugin's log panel showing the row counts and the
warnings, because it is the clearest single picture of what conversion does
and does not carry.

### Opening the result in the legacy QGIS template

**Run, and it works.** The two files are named after the legacy template's own
layer file because they replace it. Its project looks for
`./Layers/Net Gain Habitat Mapping Layers.gpkg` by that exact name, so each
stage needs a template folder of its own.

1. Copy `templates/legacy-ne/` twice, one folder per stage.
2. Put the matching file into each copy's `Layers/` folder and rename it to
   `Net Gain Habitat Mapping Layers.gpkg`, replacing the empty one.
3. Open `Net Gain Habitat Mapping.qgz` in that folder.

**Confirmed: the converted 11 554 parcel site opens in the legacy template and
draws correctly.** That is the end-to-end proof that a site of this size
survives the round trip into the format Natural England's own tooling reads.

**Worth a screenshot:** the legacy template open on the converted site. It is
the single most persuasive image in the whole exercise, because it is the
thing the divergence argument is about.

---

## 4. Plugin: the import tool CSVs, consolidation and irreplaceable habitat

**Run, and it works.** This is the section that matters most to section 3.4 of
the brief.

### 4a. Without consolidation, which is the default

Same algorithm, What to produce: **GIS import tool CSVs only**, both new
tick-boxes left as they come.

**Expected:** `Habitats.csv` **13 682** rows, `Hedgerows.csv` **2 157**,
`Rivers.csv` **256**, plus `Irreplaceable habitats.csv` with **314** rows, and
a warning that each file is far over the import tool's 248-row limit.

### 4b. With consolidation on

Tick **CSVs: merge rows with matching values**, leave **keep irreplaceable
habitat in its own rows** ticked.

**Expected:**

| File | Rows before | Rows after |
| --- | --- | --- |
| Habitats.csv | 13 682 | **4 222** |
| Hedgerows.csv | 2 157 | **198** |
| Rivers.csv | 256 | **106** |

Hedgerows and rivers now fit inside 248. Habitats does not, and the plugin
says so.

**The arithmetic must not move.** Summing the size column before and after
gives **31 840 375** square metres, **411 018** metres of hedgerow and
**111 031** metres of watercourse, both times. Check it:

```sh
python3 - <<'PY'
import csv
for name, col in [("Habitats", "Area"), ("Hedgerows", "Length"),
                  ("Rivers", "Length")]:
    for folder in ("csv-out", "csv-consolidated"):
        rows = list(csv.DictReader(
            open(f"{folder}/GIS import tool CSVs/{name}.csv",
                 encoding="utf-8-sig")))
        print(f"{folder:16s} {name:10s} {len(rows):6d} rows  "
              f"{sum(float(r[col] or 0) for r in rows):.0f}")
PY
```

### 4c. The irreplaceable habitat case, which is the point of all this

**Expected:** of the 4 222 consolidated habitat rows, **169** carry a
`Parcel Ref` ending `-IRR` and a comment reading
`IRREPLACEABLE HABITAT, do not merge with other rows`.

The comparison worth making, and worth a screenshot, is what happens without
that protection. Tick **merge irreplaceable** off in the plugin (or pass
`--merge-irreplaceable`) and the file drops to **4 145** rows. The 77 rows
that disappear are groups that mixed flagged and unflagged parcels, and
**215 of the 314 irreplaceable rows** are absorbed into rows that then read as
ordinary habitat. The largest such group is **92 parcels**.

**Two numbers on one screen, 4 222 against 4 145, is the whole of section 3.4
made concrete.**

### 4d. Through the actual import tool

**Not yet done. Needs Excel.**

Open the GIS import tool, and on each of its Habitats, Hedges and Rivers tabs
use Import GIS CSV Data to load the matching file from `csv-consolidated`.

- Hedgerows and Rivers should load whole, at 198 and 106 rows.
- Habitats will not: 4 222 rows against a 248-row tool.
- **Do not press Consolidate Data.** The tool cannot see the irreplaceable
  flag, and pressing it undoes what 4b protected. Worth a screenshot both
  ways, because that is the demonstration that the protection is real and that
  it depends on a user not pressing one button.

**What this step is really testing** is whether the import tool route survives
at this scale at all. On the evidence so far it does not: the site has to be
cut into roughly 17 geographic sections before its habitats fit, and each
section is then a separate import and a separate metric.

---

## 5. Plugin: export to the Statutory Metric workbook

**Run, and it works, once the site is small enough.**

### What this route actually is

**It does not use the CSVs, and the GIS import tool is not involved.** That is
worth saying because it is the natural assumption. There are three ways out of
the service template and this is the third: the plugin opens a blank copy of
the metric workbook, writes cell values straight into its on-site sheets, and
saves the result. The CSVs in section 4 feed the import tool, which is a
separate route to the same spreadsheet.

An `.xlsm` is a zip of XML, so no Excel and no library is needed. Every cell
it fills already exists in the sheet as an empty, styled cell, so filling one
replaces a value in place and nothing else moves. Macros, sheet protection and
every other part are copied through untouched, and the workbook is marked for
a full recalculation when Excel next opens it.

### The limit, and why a section is needed

**Each sheet holds 248 rows.** That is the same number as the import tool, and
the full NSIP site is far past it: 6 377 baseline rows unmerged, 1 619 merged.
So the full site cannot be entered in one metric, and the published guidance
says what to do about it, which is to split the site into geographic sections.

`generate.py --fraction` builds one such section of the same scheme, from the
southern end, with the feature density unchanged:

```sh
python3 generate.py --fraction 0.12
```

That writes `hs2-phase2a-subsection-12pc/`: 6.7 km of corridor, 379 hectares,
1 362 baseline parcels. Roughly an eighth of the scheme, which is about as
much as one metric will take.

### Filling the metric from that section

In QGIS, either **Plugins → BNG Template Convert → Export to the Statutory
Metric**, or the Processing Toolbox under **BNG Template Convert → BNG
template conversion**. If the Plugins menu shows only the two converters,
QGIS is running a copy of the plugin from before this tool was added to it:
reinstall and restart.

| Field | What to put in it |
| --- | --- |
| BNG Service GeoPackage | `hs2-phase2a-subsection-12pc/Layers/BNG Service Layers.gpkg` |
| Blank Statutory Metric workbook | `reference/The_Statutory_Metric_Macro_Enabled_1.0.4.xlsm` |
| Filled metric workbook to write | anywhere, ending `.xlsm` |
| Merge rows with matching values | **on** |

Or from a terminal:

```sh
python3 ../to_metric.py \
    "hs2-phase2a-subsection-12pc/Layers/BNG Service Layers.gpkg" \
    --metric "../reference/The_Statutory_Metric_Macro_Enabled_1.0.4.xlsm" \
    -o "metric-out/Section 1 - consolidated.xlsm" --consolidate
```

**Expected, and this is the pass mark: no warnings at all.**

| Sheet | Rows written | Sheet holds |
| --- | --- | --- |
| A-1 On-Site Habitat Baseline | **239** | 248 |
| A-2 On-Site Habitat Creation | **182** | 248 |
| A-3 On-Site Habitat Enhancement | **135** | 248 |
| B-1 On-Site Hedge Baseline | **65** | 248 |
| C-1 On-Site WaterC' Baseline | **15** | 248 |

4 628 cells written, in about 20 seconds.

**Then open it in Excel and let it recalculate.** Check the on-site habitat
tabs carry habitat names, sizes and conditions against the rows you expect,
and that the metric's own headline units are populated rather than showing an
error. **Worth a screenshot:** tab A-1 filled, because a filled metric is the
end of the whole chain.

### The contrasts worth running

**Without merging, the same section overflows.** Untick the box and it needs
783 baseline rows and 923 creation rows against 248 each, and says so per
sheet. That is the demonstration of why the option exists.

**The full site overflows even merged**, at 1 619 baseline rows. Run it to see
the warning, not to get a usable workbook.

**Two mistakes are caught rather than half-done.** Pointing it at the `.xlsb`
GIS import tool stops with a message saying so, and pointing it at a workbook
that already holds a site refuses rather than overwriting it.

### What it never fills

Individual trees, whose size the metric derives from a band lookup rather than
from the map; the off-site tabs, which carry allocation columns and a
different layout; and irreplaceable habitats. The export says so every time it
runs. Those go in by hand, and on this site that means 428 trees and 266
parcels of ancient woodland.

## 6. Plugin: convert back, and round trip

**Run, and it works.** Processing Toolbox, **Convert from legacy template**,
pointing at the two files section 3 produced.

```sh
python3 ../old_to_new.py \
    --baseline "legacy/Net Gain Habitat Mapping Layers - Baseline.gpkg" \
    --post-intervention "legacy/Net Gain Habitat Mapping Layers - Post-intervention.gpkg" \
    -o roundtrip
```

**Expected: about 2.3 seconds, and every count back exactly as it started:**
11 554, 13 682, 1 275, 1 469, 256, 243, 3 600, 2 767.

The 688 hedgerow, 13 watercourse and 1 985 tree `Lost` rows the forward
conversion invented are dropped again, because the staged template records a
removal by leaving the feature out. That is a declared transformation, not a
loss, and the report names every reference it dropped.

**This is claim 1 satisfied for the round trip**, at least at the level of
counts. Comparing values field by field is claim 2 and is section 8.

---

## 7. The running service

**Run, and it works, and it is close to a limit.**

1. Start the stack, sign in, create a project.
2. On the task list choose **On-site baseline habitats** and upload
   `legacy/Net Gain Habitat Mapping Layers - Baseline.gpkg`.
3. Then upload `legacy/Net Gain Habitat Mapping Layers - Post-intervention.gpkg`.

**Expected:** both accepted. **Worth a screenshot:** the project summary
showing both tasks completed, with an 11 554 parcel baseline behind it.

**Watch the clock, and repeat the post-intervention upload a few times.**
Validation is allowed 10 seconds on a worker thread, after which it is
abandoned and the upload fails. Measured on an idle laptop the
post-intervention file takes **7.3 to 8.0 seconds**; with other work running,
**7.8 to 9.3 seconds**; and one run during this exercise **crossed the line
and was killed**.

**A screenshot of that failure is more valuable than a screenshot of the
success.** The honest finding is not that a site this size is slow, it is that
it fails intermittently, and the same file uploaded twice can give two
different answers.

The same check without the interface:

```sh
node verify/validate-legacy.mjs \
    "legacy/Net Gain Habitat Mapping Layers - Baseline.gpkg" baseline
```

**Expected:** `valid true`, and a summed parcel area of
**31 840 368.775235** square metres from both the baseline file and the
post-intervention file. Identical to six decimal places across 3 184 hectares
is what "the parcels reassemble exactly" means.

Then browse the habitat list and a few habitat detail pages, to check the
service stays usable with eleven thousand parcels behind it rather than the
few hundred it has been exercised with. **Worth a screenshot** if any page is
visibly slow.

---

## 8. Claims 2 and 3

Both now have a harness, and both pass. Run them after any conversion:

```sh
python3 verify/claim2_nothing_altered.py
node verify/claim3-answer-does-not-move.mjs
```

### Claim 2, nothing is altered

`verify/claim2_manifest.py` is the transformation list, written from the
documented behaviour rather than read out of the converter, because a list
derived from the code it checks would agree with any bug that code contains.
It names every column on both sides as carried, transformed by a stated rule,
dropped for a stated reason, or invented from a stated source.

`verify/claim2_nothing_altered.py` holds the converter to it. Rows are paired
by position and the pairing is proved by comparing geometry, so attributes are
only ever compared between two features that are the same feature. A column
appearing or disappearing on either side fails the check on its own, which is
the drift this is really guarding against.

**It passes across all eight layer pairs and the red line boundary, roughly
34 000 rows.** Writing it found one thing: a created hedgerow or tree has no
parent, so it carries its own reference rather than a parent's. The manifest
said parent's reference and was wrong, and the rule is now stated properly.

### Claim 3, the answer does not move

`verify/claim3-answer-does-not-move.mjs` puts the same site through the
biodiversity unit calculation twice, once as the staged file and once as the
legacy pair converted from it. Both readings call the same calculator, the one
the service itself uses. Nothing reuses the converter, so a mistake in the
conversion cannot cancel itself out: the only thing the two readings share is
the arithmetic, and the only thing that differs is where each value was read.

An exact match is not the pass mark and would be suspicious. The staged file
holds hectares and metres as measured, legacy holds whole square metres and
whole metres, so rounding has to move the answer a little. The pass mark is
that it moves no further than rounding can explain.

| | Staged | Legacy | Difference |
| --- | --- | --- | --- |
| Baseline units | 16 051.4515 | 16 051.4146 | **0.000230%** |
| Post-intervention units | 15 291.6926 | 15 291.6465 | **0.000302%** |
| Net change | -4.733272% | -4.733341% | **0.000069 percentage points** |

**34 846 rows, every one priced on both sides, and the answer moves by seven
hundred-thousandths of a percentage point.** That is the whole of claim 3.

Two things it found in the test data rather than the converter, both since
fixed. A newly planted tree was recorded with no condition, which the metric
cannot price, so 1 152 of them counted for nothing. And some enhancements
went to a condition no better than the parcel already had, which the metric's
time-to-target table has no entry for. Both were silent until the calculation
was actually run against the data, which is the argument for running it.

---

## 9. Which step covers which claim

| Step | Claim | Screenshot worth taking |
| --- | --- | --- |
| 1. Open in QGIS | none, it is a sanity check | Baseline and post-intervention side by side |
| 2. The four buttons | 5, at the template end | Done. The copy taking 1 min 28 s with QGIS frozen |
| 3. Convert to legacy, and open it in the legacy template | 1, 5 | The legacy template open on the converted site |
| 4. CSVs and consolidation | 1, 5, and all of section 3.4 | 4 222 rows against 4 145 |
| 5. Metric workbook | 5 | The two warning lists |
| 6. Round trip | 1, 4 | The counts returning unchanged |
| 7. The service | 5 | The upload that timed out |
| 8. Claims 2 and 3 | 2, 3 | The two harness summaries |
