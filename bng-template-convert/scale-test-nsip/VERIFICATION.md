# Verifying the template, the plugin and the service at NSIP scale

**Subject:** the synthetic Handsacre to Crewe site in this folder
**Stage:** runbook, for working through at a keyboard
**State:** steps 2 to 7 have been run and their measured values recorded.
Step 1 is a sanity check nobody has written up, and step 8 is not built.

This is the practical half of section 6 of the template decision brief. It
turns the five claims made there into things to do, in order, with the number
each step should produce so a pass can be told from a failure. Where a step is
worth a screenshot, it says so and says what the screenshot has to show.

It does not cover the biodiversity unit calculation itself. That is claim 3,
it is the one claim nothing here tests, and section 8 says what it needs.

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
| 1. Copy baseline to post-intervention | Habitats Post-Intervention | **1 min 28 s**, copying all 11 554 features fresh after the post-intervention layer was emptied | **Too slow, and it blocks QGIS completely for the whole time** |
| 2. Tidy PI refs after splitting | Habitats Post-Intervention | **1 second**, nothing to change | Fine |
| 4. Refresh from baseline | Habitats Post-Intervention | **9 seconds**, nothing to bring in | Fine on this path |
| 3. Rename a ref | Habitats Baseline | not yet timed | |

**Refresh is much faster than expected, and the earlier prediction was
wrong.** An extrapolation from staged-file measurements put it in the minutes
at this row count. It took nine seconds. That figure is for the cheapest path
though, with no baseline change to carry across, so it is a floor rather than
a typical case: time it again after actually editing some baseline parcels.

**The copy is the one to fix.** A minute and a half with a frozen interface
reads as a crash to anyone who has not been told to expect it, and a surveyor
on a large site will run it more than once. Two things would change that
without changing what it does: run it in a background task so QGIS stays
responsive and shows progress, and write the features in one batched
transaction rather than feature by feature. Neither is a template redesign.

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

**Run, and it works, with a hard limit.** Processing Toolbox, **Export to the
Statutory Metric (Excel)**.

Run it twice, once with **Merge rows with matching values** off and once on.

**Expected:** both produce a workbook of about **3.5 MB**, and both warn.
Consolidation cuts what the sheets are asked to hold:

| Sheet | Rows needed, not consolidated | Consolidated | Sheet holds |
| --- | --- | --- | --- |
| A-1 On-Site Habitat Baseline | **6 377** | **1 619** | 248 |
| A-2 On-Site Habitat Creation | **7 305** | **389** | 248 |
| A-3 On-Site Habitat Enhancement | **1 468** | **1 468** | 248 |
| B-1 On-Site Hedge Baseline | **1 409** | **332** | 248 |

Enhancement rows are never merged, deliberately: the enhancement sheet is
positional against the baseline sheet, and merging would silently apply the
wrong target to the wrong parcel.

**So the finding here is unambiguous. A site this size does not fit in the
Statutory Metric, consolidated or not.** It needs splitting into roughly seven
geographic sections even after consolidation. That is a property of the
workbook, not of either template, and it applies equally whichever template
Natural England settles on. It is worth saying out loud in the results,
because it is the real ceiling on NSIP-scale BNG and it is not one the service
can lift.

**Worth a screenshot:** the two warning lists side by side.

**Then open the consolidated workbook in Excel**, let it recalculate, and
check that the on-site habitat sheets carry sensible values as far as row 248.
Irreplaceable habitat is never written to the workbook and has to be entered
by hand; the export says so.

---

## 6. Plugin: convert back, and round trip

**Run, and it works.** Processing Toolbox, **Convert from legacy template**,
pointing at the two files section 3 produced.

```sh
python3 ../old_to_new.py \
    --baseline "legacy/BNG Service Layers - Baseline.gpkg" \
    --post-intervention "legacy/BNG Service Layers - Post-Intervention.gpkg" \
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
   `legacy/BNG Service Layers - Baseline.gpkg`.
3. Then upload `legacy/BNG Service Layers - Post-Intervention.gpkg`.

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
    "legacy/BNG Service Layers - Baseline.gpkg" baseline
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

## 8. What is still missing, and what it would take

| Claim | State | What it needs |
| --- | --- | --- |
| 1. Nothing is lost | **Shown.** Counts survive the round trip, both files validate | Nothing |
| 2. Nothing is altered | **Not started** | Write down the transformation list first: hectares to square metres, rounding to whole units, dropped lineage keys, dropped irreplaceable flags, dropped vertical areas, synthesised and re-dropped Lost rows, repeated refs on split hedgerows. Then a field-by-field diff that asserts every difference found is on that list |
| 3. The answer does not move | **Not started, and it is the one that matters** | Put the staged file and the converted pair through the unit calculation and compare the totals. The service already has every piece: it enriches each document with units and then sums them. A third reading comes free from the metric workbook in section 5, on the sections small enough to fit |
| 4. It is repeatable | **Shown.** Two conversions give identical rows in every layer | Bytes differ because SQLite lays pages out differently; that is worth a sentence in the results, not work |
| 5. It finishes | **Shown, and the ceilings are found.** Conversion about a second, validation seven to nine, three separate 248-row limits, and a template button that blocks QGIS for a minute and a half | Decide what to do about the validation timeout and the blocking copy. Neither is a template question |

Claim 2 is cheap and comes first. It is also the prerequisite for claim 3:
comparing unit totals before knowing which value changes are intended tells
you a number moved but not whether it should have.

---

## 9. Which step covers which claim

| Step | Claim | Screenshot worth taking |
| --- | --- | --- |
| 1. Open in QGIS | none, it is a sanity check | Baseline and post-intervention side by side |
| 2. The four buttons | 5, at the template end | Done. The copy taking 1 min 28 s with QGIS frozen |
| 3. Convert to legacy | 1, 5 | The log panel with counts and warnings |
| 4. CSVs and consolidation | 1, 5, and all of section 3.4 | 4 222 rows against 4 145 |
| 5. Metric workbook | 5 | The two warning lists |
| 6. Round trip | 1, 4 | The counts returning unchanged |
| 7. The service | 5 | The upload that timed out |
| 8. Units | 2, 3 | Not built |
