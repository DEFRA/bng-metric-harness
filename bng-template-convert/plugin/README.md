# BNG Template Convert: a QGIS plugin

Three tools that take a site out of the **BNG Service habitat mapping
template** and into the places a Biodiversity Net Gain assessment has to end
up: the Statutory Biodiversity Metric workbook, the older Natural England
template, and the CSV files the Excel GIS import tool reads. One of them also
brings a site back the other way.

Everything runs inside QGIS. There is nothing to install beyond the plugin
itself, no internet connection is used, and no file leaves the machine.

---

## Read this first: start from clean, empty copies

**Two of the three tools write into a file you supply, and both need that file
to be empty.** This is the single most common way a run goes wrong, and it is
worth getting right before anything else.

| Tool | What it needs a clean copy of | Why |
| --- | --- | --- |
| **Export to the Statutory Metric** | a blank Statutory Metric workbook, `Macro_Enabled` or `Macro_Disabled`, straight from the download, with no habitats typed into it | The tool writes habitat rows into the on-site tabs. It refuses to run against a workbook that already holds habitats, rather than overwriting somebody's work |
| **Convert from legacy template** | a fresh, unopened copy of the whole BNG Service template folder | The tool fills the GeoPackage inside it. Filling one that already holds a site mixes two sites together |

**Keep one pristine copy of each, and copy it for every run.** Never point a
tool at the only clean file you have: point it at a copy. The metric workbook
in particular cannot be emptied again once habitats are in it, short of
downloading it afresh.

**Convert to legacy template** is the exception. It writes new files into a
folder you name, so it needs nothing prepared.

**Save your edits before running anything.** All three tools read the
GeoPackage from disk. Edits still sitting in a QGIS edit buffer, with the
pencil still pressed, are not on disk yet and will be missing from the result.
The tools check for this and stop with a message naming the layers to save.

---

## Installing it

1. Open QGIS. Any version from **3.22** onwards works; the long term version
   from qgis.org is the safe choice.
2. **Plugins** → **Manage and Install Plugins...**
3. Choose **Install from ZIP** down the left-hand side.
4. Click the **...** button and select **`bng_template_convert.zip`**.
5. Click **Install Plugin**. A warning about installing from an untrusted
   source is expected. Accept it.
6. Close the dialog.

**To check it installed:** the **Plugins** menu now carries a **BNG Template
Convert** entry holding three tools. The same three also appear in the
**Processing Toolbox** (**Processing** → **Toolbox**, or `Ctrl+Alt+T`) under
**BNG Template Convert**.

**To upgrade:** install the new zip the same way. If the menu still shows an
older set of tools afterwards, uninstall the old version first, install again,
and restart QGIS. The version is shown beside the plugin name in the same
dialog.

---

## The three tools

### Export to the Statutory Metric (Excel)

**Fills a copy of the Statutory Biodiversity Metric workbook straight from
your habitats.** No CSV files, no GIS import tool in between.

| Field | What to put in it |
| --- | --- |
| BNG Service GeoPackage | your site, usually `Layers/BNG Service Layers.gpkg` |
| Blank Statutory Metric workbook | **a clean copy** of `The_Statutory_Metric_Macro_Enabled_1.0.4.xlsm` or `The_Statutory_Metric_Macro_Disabled_1.0.4.xlsx` |
| Filled metric workbook to write | anywhere. It is given the extension of the blank workbook, whatever you type |
| Merge rows with matching values | see below |

**Either version of the metric works.** Natural England publishes it with
macros and without, and the sheets and the calculation are the same in both.
The filled copy keeps the version it was given, so a `Macro_Disabled` blank
gives an `.xlsx` that opens with no macro prompt. Nothing in the calculation
depends on the macros.

**What it fills:** the on-site tabs for area habitats, hedgerows and
watercourses (A, B and C). Every baseline feature lands on the baseline tab.
Each Retained or Enhanced part of it becomes a row of its own, and whatever
post-intervention does not carry forward is one more row, which the metric
counts as lost: the ground under a created parcel, a shortened hedge's missing
length, a feature deleted outright. A watercourse that continues at all
continues at its surveyed length, because re-meandering lengthens a channel
without adding to the baseline. The creation and enhancement tabs are filled
to match, and the watercourse tabs get their encroachment values, without which
the metric gives a watercourse no units.

**A site part-way through works.** The baseline tabs always hold the whole
baseline layer, so the baseline figures are right as soon as the baseline is
drawn. Anything not yet carried forward to post-intervention counts as lost, so
the post-intervention figures are only as finished as that layer, and the log
says when a post-intervention layer is empty. A value the metric needs and a
layer leaves blank is written as a blank. The log lists every one, layer by
layer and column by column, because the metric then leaves that row out of its
totals or shows *Check Data* in place of a total.

**What it does not fill:** individual trees, whose size the metric works out
from a band lookup rather than from the map; the off-site tabs, which have a
different layout; and the separate **Irreplaceable Habitats** sheet. Those go
in by hand, and the tool says so every time it runs.

**Irreplaceable habitat is half filled, and the half that is filled is the one
that changes the numbers.** The Yes or No flag against every on-site baseline
habitat row is written from the template's own `Irreplaceable Habitat` column.
The metric needs it: a blank there produces *Confirm irreplaceable habitat
status*, and a flag that disagrees with the habitat type produces
*Irreplaceable habitat* or *Cannot be Irreplaceable*. Filling it is what stops
those appearing.

What is left for you is the **Irreplaceable Habitats** sheet, and two of the
things it asks for are not on the map at all:

| The sheet asks for | Why it is not filled |
| --- | --- |
| Irreplaceable habitat name | The template records a Yes or No flag, not which irreplaceable habitat a parcel is. The two are different vocabularies |
| Bespoke compensation agreed? | A planning outcome, settled with the consenting body rather than drawn |
| Area at baseline, retained, enhanced, lost | These could be worked out from the map, and are simply not written yet |

**Watercourses carry no flag at all.** The metric has an irreplaceable column
on its on-site watercourse baseline sheet, but the template has no such column
on watercourses, so there is nothing to write. Hedgerows have no column on
either side.

**Open the result in Excel and let it recalculate.** Macros, where the
workbook has them, and sheet protection are carried over untouched. With the
macro version, Excel may show a message about trusted document settings after
you enable content, which is expected.

**A site too large for one workbook is written as several.** Every sheet in
the metric holds 248 rows, and 246 on the enhancement tabs. A site needing more
is dealt evenly into numbered workbooks, each a complete and valid metric for
its own share of the site, and an enhancement always stays in the same workbook
as the baseline parcel it improves. **Add the unit totals across the set.** A
net gain percentage read off one workbook describes only the part of the site
that workbook holds.

**Merge rows with matching values** does what the import tool's *Consolidate
Data* button does: rows agreeing on everything but size become one row with the
sizes added together. No total moves, because units scale with size. Use it to
fit a large site into fewer workbooks. It costs the parcel-by-parcel audit
trail, so it is off by default. Irreplaceable habitat is never merged with
habitat that is not irreplaceable.

### Convert to legacy template (for the older service)

**Splits the single BNG Service GeoPackage into the two GeoPackages the older
Biodiversity Metric service expects**, a baseline file and a post-intervention
file, which you upload one after the other. It can also write the three CSV
files the Excel GIS import tool reads.

| Field | What to put in it |
| --- | --- |
| BNG Service GeoPackage | your site |
| Folder to write into | any folder; the files are created in it |
| What to produce | **Legacy GeoPackages**, **GIS import tool CSVs**, or both |
| Record lineage in comments | leave ticked |

**Things the legacy format cannot hold are listed as warnings when it
finishes. Read them.** Vertical area habitats have no legacy layer at all, so
their biodiversity units are missing from a legacy calculation. Irreplaceable
habitat has no legacy column, so the flag is dropped.

**Record lineage in comments** writes each feature's parent reference into the
legacy Comment column. The older service ignores it, but it lets the companion
tool restore the links exactly if the site is ever converted back. Leave it
ticked unless the comment column has to stay untouched.

**Individual trees are not in the CSVs.** The import tool cannot read tree
points at all, so trees have to be typed into the metric by hand. They are
still in the GeoPackages.

**A site part-way through converts.** The baseline file always holds the whole
baseline. The post-intervention file holds what has been drawn, so until
post-intervention is finished it does not cover the red line, and the older
service refuses it; the log says which parcels are missing. The CSVs are
different, because the import tool builds the metric's baseline from them
alone: every baseline parcel not yet carried forward gets a *Lost* row there,
as removed hedgerows and watercourses always have, so the baseline stays
complete. Values the metric needs and your layers leave blank are listed in
the log, layer by layer, and travel into the legacy files and the CSVs as
blanks.

**To open a converted file in the legacy QGIS template**, take a copy of the
whole legacy template folder for that stage, put the file in its `Layers`
folder and rename it to `Net Gain Habitat Mapping Layers.gpkg`, replacing the
empty one. The project looks for that exact name, so the baseline and the
post-intervention file need a folder each.

### Convert from legacy template (into the BNG Service template)

**Joins a legacy baseline and post-intervention pair back into one BNG Service
GeoPackage.**

| Field | What to put in it |
| --- | --- |
| Legacy baseline GeoPackage | the baseline file |
| Legacy post-intervention GeoPackage | the post-intervention file, or leave blank for baseline only |
| Existing template GeoPackage to fill | **a clean copy** of the template's `Layers/BNG Service Layers.gpkg` |
| ...or write a new GeoPackage here | leave blank if filling a template |

**Filling a clean copy of the whole template folder is the useful way to run
it.** Open that copy's project afterwards and the habitats are there, with all
the template's styling and drop-downs. Leaving both destination fields set the
other way gives a plain GeoPackage with no project around it.

**Lineage.** The legacy files never recorded which baseline feature each
post-intervention feature came from. This tool links what it can prove, from
matching references or from breadcrumbs left by the companion tool, and
deliberately leaves the rest blank so the service works them out from the
shapes and says which ones it inferred. The log reports how many were linked.

**A partial site comes back exactly as it went out.** A baseline with nothing
in post-intervention, or a post-intervention layer only partly drawn, returns
with the same rows and the same parent links, and blanks stay blank. The log
lists any value the metric needs that the legacy files left blank.

**Afterwards you must** fill in Irreplaceable Habitat, which has no legacy
column, and add any vertical area habitats such as green walls.

---

## Reading the log

Every tool writes to the **Log** tab of its dialog, in three parts:

- **Rows** — how many features went into each layer or sheet. Check these
  against what you expected.
- **Notes** — transformations that are meant to happen, such as loss rows
  written on the way out to legacy and dropped again on the way back.
- **Warnings** — things to look at before relying on the result.

**A warning is not a failure.** Most of them describe something the older
format cannot carry. The ones worth acting on say so plainly.

---

## If something goes wrong

| What you see | What it means |
| --- | --- |
| *These layers have unsaved edits* | Something is still in edit mode. Press the pencil to save and turn editing off, then run again |
| *already holds habitat data* | The metric workbook is not a clean copy. Start from a fresh download |
| *is not a readable Statutory Metric workbook* | The `.xlsb` GIS import tool was given instead of the metric. They are different files |
| *Cannot find the GeoPackage* | The path has moved, or the site folder has been split up |
| Only two tools in the menu | An older version of the plugin is installed. Uninstall it, install this one, restart QGIS |
| A metric row or total reads `Check Data` | A value it needs was blank in your layers. The log's *CHECK THIS* lines name each one. If none do, report it: every value the tools write is checked against the workbook's own lookups before release |

---

## What is inside

Pure Python, standard library only. No GDAL, no network, no third-party
packages. The four conversion modules also run from a command line without
QGIS, which is how they are tested:

```
python3 new_to_old.py  INPUT.gpkg -o OUT_DIR [--format gpkg|csv|both] [--consolidate]
python3 old_to_new.py  --baseline BASE.gpkg [--post-intervention PI.gpkg] -o OUT_DIR
python3 to_metric.py   INPUT.gpkg --metric METRIC.xlsm|.xlsx -o OUT [--consolidate]
```

Add `--dry-run` to the first two to see the report without writing anything.
